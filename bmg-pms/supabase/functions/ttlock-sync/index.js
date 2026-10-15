// Scheduled every 5 minutes: pull door records and issue / extend / revoke guest passcodes.
import { env, rpc, cronAllowed } from '../_shared/deno.js';
import { runTTLock } from '../_shared/ttlock.js';
import { json } from '../_shared/util.js';

Deno.serve(async (req) => {
  if (!cronAllowed(req)) return json({ error: 'Forbidden' }, 403);
  try {
    return json(await runTTLock({ rpc, fetchFn: fetch, env, log: console.log }));
  } catch (e) {
    console.error(e);
    return json({ error: String(e.message ?? e) }, 500);
  }
});
