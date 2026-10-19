// Called from Integrations by a signed-in owner or manager: lists Channex room types / rate plans
// or TTLock locks, so mapping is picked from a list. Body: { property_id, provider: 'channex' | 'ttlock' }
import { createClient } from 'npm:@supabase/supabase-js@2';
import { env, rpc } from '../_shared/deno.js';
import { channexClient, DEFAULT_BASE as CHANNEX_BASE } from '../_shared/channex.js';
import { ttlockClient, DEFAULT_BASE as TTLOCK_BASE } from '../_shared/ttlock.js';
import { channexCatalog, ttlockLocks } from '../_shared/catalog.js';
import { corsFor, parseOrigins, secret } from '../_shared/util.js';

// APP_ORIGINS (comma-separated, e.g. https://pms.bmggroup.co.tz) limits which sites may call this from a browser
const origins = parseOrigins(env.APP_ORIGINS);
let cors = {};
const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...cors } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  cors = corsFor(origins, req.headers.get('origin') ?? '');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  try {
    const { property_id, provider } = await req.json();
    if (!UUID.test(String(property_id ?? '')) || !['channex', 'ttlock'].includes(provider)) return reply(400, { error: 'property_id and provider (channex or ttlock) are required' });
    // the caller's own session decides whether they may look
    const asUser = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false } });
    const { data: allowed } = await asUser.rpc('pms_can_manage_integrations', { p_property: property_id });
    if (!allowed) return reply(403, { error: 'Only owners and managers can do this' });
    const cfg = (await rpc('pms_svc_enabled', { p_provider: provider }))?.find((p) => p.property_id === property_id)?.config ?? {};

    if (provider === 'channex') {
      if (!cfg.property_id) return reply(400, { error: 'Save the Channex property ID first' });
      const c = channexClient({ fetchFn: fetch, baseUrl: secret(env, 'CHANNEX_BASE_URL', cfg.code) ?? CHANNEX_BASE, apiKey: secret(env, 'CHANNEX_API_KEY', cfg.code) });
      const [rt, rp] = await Promise.all([c.roomTypes(cfg.property_id), c.ratePlans(cfg.property_id)]);
      if (!rt.ok || !rp.ok) return reply(502, { error: `Channex answered HTTP ${rt.ok ? rp.status : rt.status}` });
      return reply(200, channexCatalog(rt.body, rp.body));
    }
    if (provider === 'ttlock') {
      const c = ttlockClient({ fetchFn: fetch, baseUrl: secret(env, 'TTLOCK_BASE_URL', cfg.code) ?? TTLOCK_BASE,
        clientId: secret(env, 'TTLOCK_CLIENT_ID', cfg.code), clientSecret: secret(env, 'TTLOCK_CLIENT_SECRET', cfg.code),
        username: secret(env, 'TTLOCK_USERNAME', cfg.code), password: secret(env, 'TTLOCK_PASSWORD', cfg.code) });
      const locks = [];
      for (let page = 1, pages = 1; page <= pages && page <= 20; page++) {
        const body = await c.locks(page);
        locks.push(...ttlockLocks(body));
        pages = Number(body?.pages ?? 1);
      }
      return reply(200, { locks });
    }
    return reply(400, { error: 'provider must be channex or ttlock' });
  } catch (e) {
    console.error(e);
    return reply(500, { error: 'Could not load the list. Check the integration log.' });
  }
});
