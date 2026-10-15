// Channex calls this when a booking arrives; we pull the feed straight away instead of
// waiting for the next scheduled run. URL: …/channex-webhook?token=<CHANNEX_WEBHOOK_TOKEN>&property=<pms property id>
import { env, rpc } from '../_shared/deno.js';
import { runChannex } from '../_shared/channex.js';
import { json, sameSecret } from '../_shared/util.js';

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!sameSecret(url.searchParams.get('token') ?? '', env.CHANNEX_WEBHOOK_TOKEN ?? '')) return json({ error: 'Forbidden' }, 403);
  const property = url.searchParams.get('property');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(property ?? '')) return json({ error: 'property is required' }, 400);
  try {
    const payload = await req.json().catch(() => null);
    await rpc('pms_svc_log', { p_property: property, p_provider: 'channex', p_direction: 'in', p_action: 'webhook', p_ok: true,
      p_status: 200, p_request: payload, p_response: null, p_error: null });
    const result = await runChannex({ rpc, fetchFn: fetch, env, onlyProperty: property, log: console.log });
    return json({ ok: true, result });
  } catch (e) {
    console.error(e);
    return json({ error: 'Will retry' }, 500);
  }
});
