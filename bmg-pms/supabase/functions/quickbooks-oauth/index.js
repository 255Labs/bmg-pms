// QuickBooks connection, called three ways:
//   POST {action:'start', property_id}     signed-in user → { url } of the QuickBooks sign-in page
//   GET  ?code=…&state=…&realmId=…          QuickBooks sends the browser back here after sign-in → saves tokens, back to the app
//   POST {action:'accounts', property_id}   signed-in user → the company's chart of accounts, for mapping
// The caller's own session decides whether they may (ability "Connect and send to QuickBooks").
import { createClient } from 'npm:@supabase/supabase-js@2';
import { env, rpc } from '../_shared/deno.js';
import { authorizeUrl, exchangeCode, listAccounts, companyName } from '../_shared/quickbooks.js';

const origins = (env.APP_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const corsFor = (origin) => ({
  'access-control-allow-origin': origins.length ? (origins.includes(origin) ? origin : origins[0]) : '*', vary: 'origin',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS',
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const appUrl = () => (origins[0] ?? '').replace(/\/$/, '');

Deno.serve(async (req) => {
  const cors = corsFor(req.headers.get('origin') ?? '');
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...cors } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);

  // ---- the browser comes back from QuickBooks
  if (req.method === 'GET') {
    const back = (q) => Response.redirect(`${appUrl()}/#/accounting?${q}`, 302);
    try {
      if (url.searchParams.get('error')) return back('qbo=cancelled');
      const st = await rpc('pms_svc_qbo_consume_state', { p_state: url.searchParams.get('state') ?? '' });
      const code = url.searchParams.get('code'), realm = url.searchParams.get('realmId');
      if (!st || !code || !realm) return back('qbo=expired');
      const t = await exchangeCode(fetch, env, code);
      const environment = env.QBO_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
      const conn = { property_id: st.property_id, realm_id: realm, environment, access_token: t.access, access_expires_at: t.accessExpires, refresh_token: t.refresh };
      const name = await companyName({ rpc, fetchFn: fetch, env, conn }).catch(() => null);
      await rpc('pms_svc_qbo_save', { p_property: st.property_id, p_realm: realm, p_env: environment, p_access: t.access, p_access_expires: t.accessExpires,
        p_refresh: t.refresh, p_refresh_expires: t.refreshExpires, p_company: name, p_user: st.user_id });
      return back('qbo=connected');
    } catch (e) {
      console.error(e);
      return back('qbo=failed');
    }
  }
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  // ---- signed-in staff
  try {
    const { action, property_id } = await req.json();
    if (!UUID.test(String(property_id ?? ''))) return reply(400, { error: 'property_id is required' });
    const asUser = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false } });
    if (action === 'start') {
      const { data: state, error } = await asUser.rpc('pms_qbo_begin', { p_property: property_id, p_return_url: null });
      if (error) return reply(403, { error: error.message });
      return reply(200, { url: authorizeUrl(env, state) });
    }
    if (action === 'accounts') {
      const { error } = await asUser.rpc('pms_qbo_status', { p_property: property_id });
      if (error) return reply(403, { error: error.message });
      const conn = ((await rpc('pms_svc_qbo_connections', {})) ?? []).find((c) => c.property_id === property_id);
      if (!conn) return reply(400, { error: 'Connect QuickBooks first' });
      return reply(200, { accounts: await listAccounts({ rpc, fetchFn: fetch, env, conn }) });
    }
    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    console.error(e);
    return reply(500, { error: String(e.message ?? e) });
  }
});
