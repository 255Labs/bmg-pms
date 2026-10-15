// Scheduled every 2 minutes: pull new OTA bookings and push queued availability/rate changes.
import { env, rpc, cronAllowed } from '../_shared/deno.js';
import { runChannex } from '../_shared/channex.js';
import { json } from '../_shared/util.js';

Deno.serve(async (req) => {
  if (!cronAllowed(req)) return json({ error: 'Forbidden' }, 403);
  try {
    return json(await runChannex({ rpc, fetchFn: fetch, env, log: console.log }));
  } catch (e) {
    console.error(e);
    return json({ error: String(e.message ?? e) }, 500);
  }
});
