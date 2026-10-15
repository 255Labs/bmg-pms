// Scheduled every 5 minutes: sends queued suppliers, bills, payments and daily journals to each property's QuickBooks.
import { env, rpc, cronAllowed } from '../_shared/deno.js';
import { runQuickBooks } from '../_shared/quickbooks.js';
import { json } from '../_shared/util.js';

Deno.serve(async (req) => {
  if (!cronAllowed(req)) return json({ error: 'Forbidden' }, 403);
  try {
    return json(await runQuickBooks({ rpc, fetchFn: fetch, env, log: console.log }));
  } catch (e) {
    console.error(e);
    return json({ error: String(e.message ?? e) }, 500);
  }
});
