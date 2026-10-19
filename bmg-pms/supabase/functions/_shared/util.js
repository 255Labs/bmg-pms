// Shared helpers for the integration workers. No Deno or Node specifics here,
// so the same code runs in Supabase Edge Functions and in the Node tests.

// Secret lookup with optional per-property override: NAME_<CODE> beats NAME
// A secret left empty counts as not set, so blank lines in supabase/secrets.env never override the defaults
export function secret(env, name, code) {
  const val = (k) => { const v = env[k]; return typeof v === 'string' && v.trim() === '' ? undefined : v; };
  const own = code ? val(`${name}_${String(code).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`) : undefined;
  return own ?? val(name);
}

export async function http(fetchFn, url, { method = 'GET', headers = {}, json, form, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const init = { method, headers: { ...headers }, signal: ctrl.signal };
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers['content-type'] = 'application/json'; }
  if (form !== undefined) { init.body = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString(); init.headers['content-type'] = 'application/x-www-form-urlencoded'; }
  try {
    const res = await fetchFn(url, init);
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 2000) }; }
    return { ok: res.ok, status: res.status, body };
  } finally { clearTimeout(t); }
}

// Collapse per-day values into ranges: [{date, v}] → [{date_from, date_to, v}] (date_to inclusive)
export function toRanges(items, keyOf, valueOf) {
  const out = [];
  const sorted = [...items].sort((a, b) => (keyOf(a) + a.date).localeCompare(keyOf(b) + b.date));
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && last.key === keyOf(it) && last.value === valueOf(it) && nextDay(last.date_to) === it.date) {
      last.date_to = it.date;
    } else {
      out.push({ key: keyOf(it), value: valueOf(it), date_from: it.date, date_to: it.date });
    }
  }
  return out;
}

export function nextDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Run every claimed job through a handler and report back to the database
export async function runJobs({ rpc, provider, handlers, limit = 20, log = () => {} }) {
  const jobs = await rpc('pms_svc_claim_jobs', { p_provider: provider, p_limit: limit });
  const results = [];
  for (const job of jobs ?? []) {
    const handler = handlers[job.kind];
    try {
      if (!handler) throw new Error(`No handler for ${job.kind}`);
      const result = await handler(job);
      await rpc('pms_svc_finish_job', { p_job: job.id, p_ok: true, p_error: null, p_result: result ?? null });
      results.push({ id: job.id, kind: job.kind, ok: true });
    } catch (e) {
      await rpc('pms_svc_finish_job', { p_job: job.id, p_ok: false, p_error: String(e?.message ?? e).slice(0, 1000), p_result: null });
      log(`job ${job.id} ${job.kind} failed: ${e?.message ?? e}`);
      results.push({ id: job.id, kind: job.kind, ok: false, error: String(e?.message ?? e) });
    }
  }
  return results;
}

export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Constant-time-ish comparison for shared secrets
export function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// APP_ORIGINS → clean origins. Forgives common slips ("http://https://site/", a trailing slash) and drops anything
// that is not https (plain http only for localhost), so a bad value can never open the door wider.
export function parseOrigins(raw) {
  return String(raw ?? '').split(',')
    .map((s) => s.trim().replace(/^https?:\/\/(?=https?:\/\/)/i, '').replace(/\/+$/, '').toLowerCase())
    .filter((s) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(s) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(s));
}

// CORS for browser calls: only the app's own origins are allowed. Nothing set → nobody (never "*").
export function corsFor(origins, origin, methods = 'POST, OPTIONS') {
  return {
    'access-control-allow-origin': origins.includes(String(origin ?? '').toLowerCase()) ? origin : (origins[0] ?? 'null'), vary: 'origin',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', 'access-control-allow-methods': methods,
  };
}
