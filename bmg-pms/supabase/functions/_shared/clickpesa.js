// ClickPesa mobile money collection (USSD push). API: https://docs.clickpesa.com
//   POST /third-parties/generate-token          headers client-id, api-key  → { success, token: "Bearer …" } (valid 1 hour)
//   POST /third-parties/payments/initiate-ussd-push-request   { amount, currency, orderReference, phoneNumber[, checksum] }
//   GET  /third-parties/payments/{orderReference}            → [ { status, collectedAmount, id, … } ]
// Checksum (only when a checksum key is set on the ClickPesa account): HMAC-SHA256 of the payload as compact JSON
// with keys sorted at every level, hex.
// A webhook is treated only as a nudge: the payment is confirmed by asking ClickPesa for the status, so a forged
// or replayed webhook can never put money on a folio.
import { http, runJobs, secret } from './util.js';

export const PRODUCTION = 'https://api.clickpesa.com';
export const SANDBOX = 'https://api-sandbox.clickpesa.com';

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

export async function checksum(key, payload) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(JSON.stringify(sortKeys(payload))));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clickpesaClient({ fetchFn, baseUrl = PRODUCTION, clientId, apiKey, checksumKey }) {
  if (!clientId || !apiKey) throw new Error('CLICKPESA_CLIENT_ID and CLICKPESA_API_KEY are not set');
  const base = baseUrl.replace(/\/$/, '');
  let token = null;
  const auth = async () => {
    if (token) return token;
    const res = await http(fetchFn, `${base}/third-parties/generate-token`, { method: 'POST', headers: { 'client-id': clientId, 'api-key': apiKey } });
    if (!res.ok || !res.body?.token) throw new Error(`ClickPesa login failed: HTTP ${res.status} ${res.body?.message ?? ''}`.trim());
    token = res.body.token.startsWith('Bearer ') ? res.body.token : `Bearer ${res.body.token}`;
    return token;
  };
  return {
    async ussdPush({ amount, phone, orderReference, currency = 'TZS' }) {
      const payload = { amount: String(amount), currency, orderReference, phoneNumber: phone };
      if (checksumKey) payload.checksum = await checksum(checksumKey, payload);
      return http(fetchFn, `${base}/third-parties/payments/initiate-ussd-push-request`, { method: 'POST', headers: { authorization: await auth() }, json: payload });
    },
    async status(orderReference) {
      return http(fetchFn, `${base}/third-parties/payments/${encodeURIComponent(orderReference)}`, { headers: { authorization: await auth() } });
    },
  };
}

const clientFor = (env, cfg, fetchFn) => clickpesaClient({
  fetchFn, baseUrl: secret(env, 'CLICKPESA_BASE_URL', cfg?.code) ?? PRODUCTION,
  clientId: secret(env, 'CLICKPESA_CLIENT_ID', cfg?.code), apiKey: secret(env, 'CLICKPESA_API_KEY', cfg?.code),
  checksumKey: secret(env, 'CLICKPESA_CHECKSUM_KEY', cfg?.code),
});

// Ask ClickPesa what happened to one order and record it. Returns the database's verdict.
export async function settle({ rpc, client, property, orderRef }) {
  const res = await client.status(orderRef);
  const row = Array.isArray(res.body) ? res.body[0] : res.body?.data?.[0] ?? res.body;
  await rpc('pms_svc_log', { p_property: property, p_provider: 'clickpesa', p_direction: 'out', p_action: 'payment_status', p_ok: res.ok || res.status === 404,
    p_status: res.status, p_request: { order_ref: orderRef }, p_response: row ?? null, p_error: res.ok || res.status === 404 ? null : JSON.stringify(res.body).slice(0, 500) });
  if (res.status === 404 || !row?.status) return { result: 'waiting' };
  if (!res.ok) throw new Error(`ClickPesa status HTTP ${res.status}`);
  return rpc('pms_svc_payment_result', { p_order_ref: orderRef, p_status: String(row.status), p_collected: row.collectedAmount != null ? Number(row.collectedAmount) : null,
    p_txn: row.id ? String(row.id) : null, p_raw: row });
}

// One worker pass: send queued requests to guests' phones, then check every request still waiting.
export async function runPayments({ rpc, fetchFn, env, log = () => {} }) {
  const props = await rpc('pms_svc_enabled', { p_provider: 'clickpesa' });
  const cfgOf = (id) => props.find((p) => p.property_id === id)?.config ?? {};
  const clients = {};
  const client = (id) => (clients[id] ??= clientFor(env, cfgOf(id), fetchFn));

  const jobs = await runJobs({ rpc, provider: 'clickpesa', log, handlers: {
    ussd_push: async (job) => {
      const r = await rpc('pms_svc_payment_request', { p_request: job.payload.request_id });
      if (!r || r.status !== 'queued') return { skipped: r ? `Request is ${r.status}` : 'Request not found' };
      const res = await client(r.property_id).ussdPush({ amount: Math.round(Number(r.amount)), phone: r.phone, orderReference: r.order_ref, currency: r.currency });
      await rpc('pms_svc_log', { p_property: r.property_id, p_provider: 'clickpesa', p_direction: 'out', p_action: 'ussd_push', p_ok: res.ok,
        p_status: res.status, p_request: { order_ref: r.order_ref, amount: r.amount, phone: r.phone.replace(/\d{4}$/, '****') }, p_response: res.body,
        p_error: res.ok ? null : JSON.stringify(res.body).slice(0, 500) });
      if (res.ok) {
        await rpc('pms_svc_payment_sent', { p_request: r.id, p_ok: true, p_provider_status: res.body?.status ?? 'PROCESSING', p_txn: res.body?.id ?? null, p_error: null });
        return { sent: r.order_ref };
      }
      const why = res.body?.message ?? res.body?.error ?? `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
        // ClickPesa turned this request down (bad number, amount): tell the desk, do not retry
        await rpc('pms_svc_payment_sent', { p_request: r.id, p_ok: false, p_provider_status: 'REJECTED', p_txn: null, p_error: String(why) });
        return { rejected: String(why) };
      }
      throw new Error(`ClickPesa USSD push: ${why}`);
    },
  } });

  const open = await rpc('pms_svc_open_payment_requests', {});
  const checked = [];
  for (const o of open ?? []) {
    try { checked.push({ order_ref: o.order_ref, ...(await settle({ rpc, client: client(o.property_id), property: o.property_id, orderRef: o.order_ref })) }); }
    catch (e) { log(`status ${o.order_ref}: ${e.message}`); checked.push({ order_ref: o.order_ref, error: e.message }); }
  }
  return { jobs, checked };
}

// Webhook: take only the order reference from the body, then confirm with ClickPesa directly.
export async function handleWebhook({ rpc, fetchFn, env, body }) {
  const ref = body?.data?.orderReference ?? body?.orderReference;
  if (!ref || !/^[A-Za-z0-9]{6,40}$/.test(ref)) return { status: 400, body: { error: 'No order reference' } };
  if (await rpc('pms_svc_is_billing_order', { p_order_ref: ref })) {
    return { status: 200, body: await settleBilling({ rpc, client: platformClient(env, fetchFn), orderRef: ref }) };
  }
  const property = await rpc('pms_svc_payment_property', { p_order_ref: ref });
  if (!property) return { status: 200, body: { ignored: 'Not a PMS order' } };
  const props = await rpc('pms_svc_enabled', { p_provider: 'clickpesa' });
  const cfg = props.find((p) => p.property_id === property)?.config ?? {};
  const out = await settle({ rpc, client: clientFor(env, cfg, fetchFn), property, orderRef: ref });
  return { status: 200, body: out };
}

// ---------------------------------------------------------------------------------------------------------------
// BMG subscriptions: properties pay BMG for the PMS. Same ClickPesa API, but BMG's own account:
// CLICKPESA_CLIENT_ID_PLATFORM / CLICKPESA_API_KEY_PLATFORM (falling back to CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY).
// Subscription order references start with "SUB"; guest payments start with "BMG".
export const platformClient = (env, fetchFn) => clientFor(env, { code: 'PLATFORM' }, fetchFn);

export async function settleBilling({ rpc, client, orderRef }) {
  const res = await client.status(orderRef);
  const row = Array.isArray(res.body) ? res.body[0] : res.body?.data?.[0] ?? res.body;
  if (res.status === 404 || !row?.status) return { result: 'waiting' };
  if (!res.ok) throw new Error(`ClickPesa status HTTP ${res.status}`);
  return rpc('pms_svc_billing_result', { p_order_ref: orderRef, p_status: String(row.status),
    p_collected: row.collectedAmount != null ? Number(row.collectedAmount) : null, p_txn: row.id ? String(row.id) : null });
}

// One pass: issue invoices / update standing (locks and unlocks), push owners' payment requests, check the open ones.
export async function runBilling({ rpc, fetchFn, env, log = () => {} }) {
  const run = await rpc('pms_svc_billing_run', {});
  const queued = (await rpc('pms_svc_billing_queued', {})) ?? [];
  const open = (await rpc('pms_svc_billing_open', {})) ?? [];
  if (!queued.length && !open.length) return { run, sent: [], checked: [] };
  let client;
  try { client = platformClient(env, fetchFn); } catch (e) {
    for (const q of queued) await rpc('pms_svc_billing_sent', { p_order_ref: q.order_ref, p_ok: false, p_error: 'Mobile money is not set up on the BMG platform yet' });
    return { run, error: e.message };
  }
  const sent = [];
  for (const q of queued) {
    try {
      const res = await client.ussdPush({ amount: Math.round(Number(q.amount)), phone: q.phone, orderReference: q.order_ref, currency: q.currency });
      if (res.ok) { await rpc('pms_svc_billing_sent', { p_order_ref: q.order_ref, p_ok: true }); sent.push({ order_ref: q.order_ref, sent: true }); continue; }
      const why = String(res.body?.message ?? res.body?.error ?? `HTTP ${res.status}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
        await rpc('pms_svc_billing_sent', { p_order_ref: q.order_ref, p_ok: false, p_error: why });
        sent.push({ order_ref: q.order_ref, rejected: why });
      } else { log(`billing push ${q.order_ref}: ${why}`); sent.push({ order_ref: q.order_ref, retry: why }); }   // stays queued, next pass retries
    } catch (e) { log(`billing push ${q.order_ref}: ${e.message}`); sent.push({ order_ref: q.order_ref, error: e.message }); }
  }
  const checked = [];
  for (const o of open) {
    try { checked.push({ order_ref: o.order_ref, ...(await settleBilling({ rpc, client, orderRef: o.order_ref })) }); }
    catch (e) { log(`billing status ${o.order_ref}: ${e.message}`); checked.push({ order_ref: o.order_ref, error: e.message }); }
  }
  return { run, sent, checked };
}
