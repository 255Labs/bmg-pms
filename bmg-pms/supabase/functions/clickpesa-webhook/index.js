// ClickPesa payment webhook: https://<ref>.supabase.co/functions/v1/clickpesa-webhook?token=<CLICKPESA_WEBHOOK_TOKEN>
// The body is only a nudge; the payment is confirmed by asking ClickPesa (see _shared/clickpesa.js).
import { env, rpc } from '../_shared/deno.js';
import { handleWebhook } from '../_shared/clickpesa.js';
import { json, sameSecret } from '../_shared/util.js';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!sameSecret(token, env.CLICKPESA_WEBHOOK_TOKEN ?? '')) return json({ error: 'Forbidden' }, 403);
  try {
    const out = await handleWebhook({ rpc, fetchFn: fetch, env, body: await req.json().catch(() => null) });
    return json(out.body, out.status);
  } catch (e) {
    console.error(e);
    return json({ error: 'Will retry' }, 500);   // ClickPesa retries; the minute poll also catches it
  }
});
