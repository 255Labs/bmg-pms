// Receives batches from the on-site relay (tools/hikvision-relay). Body: { property_id?, events: [...] }
// Header x-relay-key: the property's relay key (Integrations → Hikvision), or the legacy shared HIKVISION_RELAY_KEY.
import { env, rpc } from '../_shared/deno.js';
import { json } from '../_shared/util.js';
import { handleIngest } from '../_shared/ingest.js';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (Number(req.headers.get('content-length') ?? 0) > 5_000_000) return json({ error: 'Batch too large' }, 413);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Body must be JSON' }, 400); }
  try {
    const out = await handleIngest({ headers: req.headers, body, rpc, env });
    return json(out.body, out.status);
  } catch (e) {
    console.error(e);
    return json({ error: 'Server error' }, 500);
  }
});
