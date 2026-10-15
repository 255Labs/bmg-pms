// Scheduled every minute: send mobile money requests to guests' phones, then check the ones still waiting.
// Also runs BMG subscription billing: invoices, past-due and locks, owners' subscription payments.
import { env, rpc, cronAllowed } from '../_shared/deno.js';
import { runPayments, runBilling } from '../_shared/clickpesa.js';
import { json } from '../_shared/util.js';

Deno.serve(async (req) => {
  if (!cronAllowed(req)) return json({ error: 'Forbidden' }, 403);
  try {
    const out = {};
    try { out.guests = await runPayments({ rpc, fetchFn: fetch, env, log: console.log }); } catch (e) { console.error(e); out.guests = { error: String(e.message ?? e) }; }
    try { out.billing = await runBilling({ rpc, fetchFn: fetch, env, log: console.log }); } catch (e) { console.error(e); out.billing = { error: String(e.message ?? e) }; }
    return json(out, out.guests?.error && out.billing?.error ? 500 : 200);
  } catch (e) {
    console.error(e);
    return json({ error: String(e.message ?? e) }, 500);
  }
});
