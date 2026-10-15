// Camera events from the on-site relay. Each property's relay should use its own key
// (Integrations → Hikvision → Create relay key); the key decides which property the events belong to.
// The older shared HIKVISION_RELAY_KEY still works but trusts the property id in the body.
import { sameSecret } from './util.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleIngest({ headers, body, rpc, env }) {
  const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]) ?? '';
  const key = String(get('x-relay-key')).trim();
  if (!key) return { status: 401, body: { error: 'Missing relay key' } };
  const events = body?.events;
  if (!Array.isArray(events)) return { status: 400, body: { error: 'events must be a list' } };
  let property = body?.property_id ? String(body.property_id) : null;
  if (property && !UUID.test(property)) return { status: 400, body: { error: 'property_id is not valid' } };

  if (env.HIKVISION_RELAY_KEY && sameSecret(key, env.HIKVISION_RELAY_KEY)) {
    if (!property) return { status: 400, body: { error: 'property_id is required with the shared key' } };
  } else {
    const found = await rpc('pms_svc_api_key_check', { p_key: key, p_provider: 'hikvision' });
    const who = Array.isArray(found) ? found[0] : found;
    if (!who?.property_id) return { status: 403, body: { error: 'Unknown or revoked relay key' } };
    if (property && property !== who.property_id) return { status: 403, body: { error: 'This key belongs to another property' } };
    property = who.property_id;
  }
  const batch = events.slice(0, 5000);
  const stored = await rpc('pms_svc_ingest_camera_events', { p_property: property, p_events: batch });
  await rpc('pms_svc_log', { p_property: property, p_provider: 'hikvision', p_direction: 'in', p_action: 'camera_events', p_ok: true,
    p_status: 200, p_request: { received: events.length }, p_response: { stored }, p_error: null });
  return { status: 200, body: { ok: true, received: events.length, stored } };
}
