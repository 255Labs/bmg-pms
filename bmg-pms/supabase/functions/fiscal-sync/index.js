// Scheduled every minute: send pending fiscal receipts to the VFD provider.
import { env, rpc, cronAllowed } from '../_shared/deno.js';
import { runFiscal } from '../_shared/fiscal.js';
import { json } from '../_shared/util.js';

Deno.serve(async (req) => {
  if (!cronAllowed(req)) return json({ error: 'Forbidden' }, 403);
  try {
    return json({ jobs: await runFiscal({ rpc, fetchFn: fetch, env, log: console.log }) });
  } catch (e) {
    console.error(e);
    return json({ error: String(e.message ?? e) }, 500);
  }
});
