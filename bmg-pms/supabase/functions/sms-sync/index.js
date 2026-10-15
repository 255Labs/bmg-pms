// Scheduled every minute: send queued guest SMS (door codes, messages from the desk) through Beem.
import { env, rpc, cronAllowed } from '../_shared/deno.js';
import { runSms } from '../_shared/sms.js';
import { json } from '../_shared/util.js';

Deno.serve(async (req) => {
  if (!cronAllowed(req)) return json({ error: 'Forbidden' }, 403);
  try {
    return json({ jobs: await runSms({ rpc, fetchFn: fetch, env, log: console.log }) });
  } catch (e) {
    console.error(e);
    return json({ error: String(e.message ?? e) }, 500);
  }
});
