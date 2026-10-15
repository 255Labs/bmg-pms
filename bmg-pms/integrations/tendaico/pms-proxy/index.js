// Deploy this inside the TENDA ICO Supabase project:  supabase functions deploy pms-proxy
// Secrets there:  BMG_PMS_URL=https://<pms-ref>.supabase.co/functions/v1/pos-gateway   BMG_PMS_KEY=bmgpms_...
// The till calls it with the cashier's normal Tenda ICO login (JWT checked by Supabase), so only signed-in
// staff can charge rooms and the PMS key never reaches the browser.
//
//   supabase.functions.invoke('pms-proxy', { body: { action: 'guests', q: '33' } })
//   supabase.functions.invoke('pms-proxy', { body: { action: 'charge', billRef, stayId, room, amount, outlet, items } })
//   supabase.functions.invoke('pms-proxy', { body: { action: 'void', billRef, reason } })
import { createPmsClient, PmsError } from '../bmgPmsClient.js';

const pms = createPmsClient({ baseUrl: Deno.env.get('BMG_PMS_URL'), apiKey: Deno.env.get('BMG_PMS_KEY') });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type' };
const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...cors } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const b = await req.json();
    if (b.action === 'guests') return reply(200, await pms.guests(b.q ?? ''));
    if (b.action === 'charge') return reply(200, await pms.chargeToRoom(b));
    if (b.action === 'void') return reply(200, await pms.voidCharge(b.billRef, b.reason));
    return reply(400, { error: 'action must be guests, charge or void' });
  } catch (e) {
    return e instanceof PmsError ? reply(e.status || 502, { error: e.message, code: e.code }) : reply(500, { error: 'Server error' });
  }
});
