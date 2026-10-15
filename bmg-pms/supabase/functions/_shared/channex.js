// Channex channel manager adapter.
// Docs: https://docs.channex.io — auth header `user-api-key`; ARI via POST /availability and
// POST /restrictions; bookings via GET /booking_revisions/feed and POST /booking_revisions/:id/ack.
import { http, runJobs, secret, toRanges } from './util.js';

export const DEFAULT_BASE = 'https://staging.channex.io/api/v1';

export function channexClient({ fetchFn, baseUrl = DEFAULT_BASE, apiKey }) {
  if (!apiKey) throw new Error('CHANNEX_API_KEY is not set');
  const headers = { 'user-api-key': apiKey, accept: 'application/json' };
  const base = baseUrl.replace(/\/$/, '');
  return {
    availability: (values) => http(fetchFn, `${base}/availability`, { method: 'POST', headers, json: { values } }),
    restrictions: (values) => http(fetchFn, `${base}/restrictions`, { method: 'POST', headers, json: { values } }),
    feed: (propertyId) => http(fetchFn, `${base}/booking_revisions/feed?filter[property_id]=${encodeURIComponent(propertyId)}&order[inserted_at]=asc`, { headers }),
    ack: (revisionId) => http(fetchFn, `${base}/booking_revisions/${encodeURIComponent(revisionId)}/ack`, { method: 'POST', headers }),
    roomTypes: (propertyId) => http(fetchFn, `${base}/room_types?filter[property_id]=${encodeURIComponent(propertyId)}&pagination[limit]=100`, { headers }),
    ratePlans: (propertyId) => http(fetchFn, `${base}/rate_plans?filter[property_id]=${encodeURIComponent(propertyId)}&pagination[limit]=100`, { headers }),
  };
}

// Snapshot rows → Channex value objects, merged into date ranges to keep requests small
export function buildAriValues(snapshot, channexPropertyId) {
  const availability = toRanges(snapshot.availability ?? [], (a) => a.room_type_id, (a) => a.availability)
    .map((r) => ({ property_id: channexPropertyId, room_type_id: r.key, date_from: r.date_from, date_to: r.date_to, availability: r.value }));
  // rate and restrictions travel together; equal neighbouring days collapse into one range
  const sig = (r) => JSON.stringify([Number(r.rate).toFixed(2), Number(r.min_stay ?? 1), !!r.stop_sell, !!r.cta, !!r.ctd, r.max_stay == null ? null : Number(r.max_stay)]);
  const restrictions = toRanges((snapshot.rates ?? []).filter((r) => Number(r.rate) > 0 || r.stop_sell), (r) => r.rate_plan_id, sig)
    .map((r) => {
      const [rate, minStay, stopSell, cta, ctd, maxStay] = JSON.parse(r.value);
      const v = { property_id: channexPropertyId, rate_plan_id: r.key, date_from: r.date_from, date_to: r.date_to,
        min_stay_arrival: minStay, max_stay: maxStay ?? 0, stop_sell: stopSell, closed_to_arrival: cta, closed_to_departure: ctd };
      if (Number(rate) > 0) v.rate = rate;
      return v;
    });
  return { availability, restrictions };
}

// Revisions from the feed come wrapped as {id, type, attributes}
export const unwrapRevision = (item) => ({ ...(item.attributes ?? item), id: item.attributes?.id ?? item.id });

export async function pullBookings({ rpc, client, property, channexPropertyId, log = () => {} }) {
  const res = await client.feed(channexPropertyId);
  await rpc('pms_svc_log', { p_property: property, p_provider: 'channex', p_direction: 'in', p_action: 'booking_feed', p_ok: res.ok,
    p_status: res.status, p_request: null, p_response: { count: res.body?.data?.length ?? 0, meta: res.body?.meta ?? null }, p_error: res.ok ? null : JSON.stringify(res.body).slice(0, 500) });
  if (!res.ok) throw new Error(`Channex feed HTTP ${res.status}`);
  const out = [];
  for (const item of res.body?.data ?? []) {
    const rev = unwrapRevision(item);
    try {
      const r = await rpc('pms_svc_channex_ingest', { p_property: property, p_rev: rev });
      const ack = await client.ack(rev.id);
      if (!ack.ok) log(`ack ${rev.id} failed: HTTP ${ack.status}`);
      await rpc('pms_svc_log', { p_property: property, p_provider: 'channex', p_direction: 'in', p_action: `booking_${rev.status}`, p_ok: true,
        p_status: ack.status, p_request: { revision_id: rev.id, ota: rev.ota_name, code: rev.ota_reservation_code }, p_response: r, p_error: null });
      out.push({ revision: rev.id, ...r });
    } catch (e) {
      // not acknowledged → Channex serves it again next pull
      await rpc('pms_svc_log', { p_property: property, p_provider: 'channex', p_direction: 'in', p_action: `booking_${rev.status}`, p_ok: false,
        p_status: null, p_request: { revision_id: rev.id }, p_response: null, p_error: String(e.message ?? e) });
      out.push({ revision: rev.id, error: String(e.message ?? e) });
    }
  }
  return out;
}

export async function pushAri({ rpc, client, property, channexPropertyId, dateFrom, dateTo }) {
  const snapshot = await rpc('pms_svc_ari_snapshot', { p_property: property, p_from: dateFrom, p_to: dateTo });
  const { availability, restrictions } = buildAriValues(snapshot, channexPropertyId);
  const result = {};
  for (const [name, values, call] of [['availability', availability, client.availability], ['restrictions', restrictions, client.restrictions]]) {
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500);
      const res = await call(chunk);
      await rpc('pms_svc_log', { p_property: property, p_provider: 'channex', p_direction: 'out', p_action: name, p_ok: res.ok,
        p_status: res.status, p_request: { count: chunk.length, from: dateFrom, to: dateTo }, p_response: res.body, p_error: res.ok ? null : JSON.stringify(res.body).slice(0, 500) });
      if (!res.ok) throw new Error(`Channex ${name} HTTP ${res.status}`);
      result[name] = (result[name] ?? 0) + chunk.length;
    }
  }
  return result;
}

// One worker pass for every property with Channex enabled
export async function runChannex({ rpc, fetchFn, env, onlyProperty, log = () => {} }) {
  const props = await rpc('pms_svc_enabled', { p_provider: 'channex' });
  const report = [];
  for (const p of props ?? []) {
    if (onlyProperty && p.property_id !== onlyProperty) continue;
    const channexPropertyId = p.config?.property_id;
    if (!channexPropertyId) { report.push({ property: p.property_name, skipped: 'No Channex property ID in settings' }); continue; }
    const client = channexClient({ fetchFn, baseUrl: secret(env, 'CHANNEX_BASE_URL', p.config?.code) ?? DEFAULT_BASE, apiKey: secret(env, 'CHANNEX_API_KEY', p.config?.code) });
    const bookings = await pullBookings({ rpc, client, property: p.property_id, channexPropertyId, log }).catch((e) => ({ error: e.message }));
    report.push({ property: p.property_name, bookings });
  }
  const jobs = await runJobs({
    rpc, provider: 'channex', log,
    handlers: {
      ari_push: async (job) => {
        const p = (props ?? []).find((x) => x.property_id === job.property_id);
        if (!p?.config?.property_id) throw new Error('No Channex property ID in settings');
        const client = channexClient({ fetchFn, baseUrl: secret(env, 'CHANNEX_BASE_URL', p.config?.code) ?? DEFAULT_BASE, apiKey: secret(env, 'CHANNEX_API_KEY', p.config?.code) });
        return pushAri({ rpc, client, property: job.property_id, channexPropertyId: p.config.property_id, dateFrom: job.payload.date_from, dateTo: job.payload.date_to });
      },
      pull_bookings: async () => ({ done: true }), // the pull above already ran this pass
    },
  });
  return { properties: report, jobs };
}
