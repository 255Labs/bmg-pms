// Gateway for outside POS systems (Tenda ICO). Pure: takes a request description and an rpc,
// returns { status, body }. The Edge Function in pos-gateway/ wraps it; tests call it directly.
//
//   GET  /health                      → which property this key belongs to
//   GET  /guests?q=332                → in-house guests a bill can be charged to
//   POST /charges                     → charge a bill to a room   { bill_ref, stay_id, room, amount, category?, outlet?, description?, items? }
//                                       category: fnb (default), recreation, spa, tours, events, laundry, minibar, transport, damage, other
//   POST /charges/<bill_ref>/void     → undo it, same business day only   { reason }
//
// Auth: "Authorization: Bearer <key>" (or "x-api-key"). Keys are made under Integrations → Tenda ICO.
// Sending the same bill_ref twice returns the first result and never charges twice, so a POS can retry safely.

const CODES = { BAD_REQUEST: 400, NOT_FOUND: 404, NOT_IN_HOUSE: 409, ROOM_MISMATCH: 409, CONFLICT: 409, DAY_CLOSED: 409 };

export function errorStatus(message) {
  const m = /^(?:[a-z_]+: )?([A-Z_]+): (.*)$/s.exec(String(message ?? ''));
  return m && CODES[m[1]] ? { status: CODES[m[1]], code: m[1], message: m[2] } : null;
}

export function keyFrom(headers) {
  const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]) ?? '';
  const auth = get('authorization');
  if (/^bearer /i.test(auth)) return auth.slice(7).trim();
  return String(get('x-api-key')).trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_CHARGE = 100_000_000;   // a single bill above this is almost certainly a typo

export function checkCharge(b, amount) {
  if (!/^[\w.:\-\/#]{1,64}$/.test(String(b.bill_ref))) return 'bill_ref must be 1–64 letters, digits or . : - / #';
  if (!UUID.test(String(b.stay_id))) return 'stay_id is not valid';
  if (amount <= 0 || amount > MAX_CHARGE) return `amount must be between 0 and ${MAX_CHARGE.toLocaleString('en')}`;
  if (Math.round(amount * 100) !== amount * 100) return 'amount has more than two decimals';
  return null;
}

const cleanItem = (i) => ({ name: String(i?.name ?? '').slice(0, 80), qty: Number(i?.qty) || 0, amount: Number(i?.amount) || 0 });

export async function handlePosRequest({ method, path, query = {}, headers, body, rpc, source = 'tendaico' }) {
  const key = keyFrom(headers);
  if (!key) return { status: 401, body: { error: 'Missing API key' } };
  const found = await rpc('pms_svc_api_key_check', { p_key: key, p_provider: source });
  const who = Array.isArray(found) ? found[0] : found;
  if (!who?.property_id) return { status: 401, body: { error: 'Unknown or revoked API key' } };
  const property = who.property_id;
  const route = path.replace(/^\/+|\/+$/g, '').split('/');
  const log = (action, ok, status, request, response, error) => rpc('pms_svc_log', {
    p_property: property, p_provider: source, p_direction: 'in', p_action: action, p_ok: ok, p_status: status,
    p_request: request, p_response: response, p_error: error,
  }).catch(() => {});

  try {
    if (method === 'GET' && route[0] === 'health') {
      return { status: 200, body: { ok: true, property_id: property, key: who.key_name } };
    }
    if (method === 'GET' && route[0] === 'guests') {
      const q = (query.q ?? '').toString().trim().slice(0, 40) || null;
      const rows = await rpc('pms_svc_pos_inhouse', { p_property: property, p_query: q });
      return { status: 200, body: { guests: (rows ?? []).map((g) => ({ stay_id: g.stay_id, room: g.room, guest: g.guest, departure: g.departure })) } };
    }
    if (method === 'POST' && route[0] === 'charges' && route.length === 1) {
      const b = body ?? {};
      const amount = Number(b.amount);
      if (!b.bill_ref || !b.stay_id || !Number.isFinite(amount)) {
        return { status: 400, body: { error: 'bill_ref, stay_id and amount are required' } };
      }
      const bad = checkCharge(b, amount);
      if (bad) return { status: 400, body: { error: bad, code: 'BAD_REQUEST' } };
      const r = await rpc('pms_svc_pos_charge', {
        p_property: property, p_source: source, p_ref: String(b.bill_ref), p_stay: b.stay_id, p_room: b.room ? String(b.room).slice(0, 20) : null,
        p_amount: amount, p_category: b.category ?? 'fnb', p_outlet: b.outlet ? String(b.outlet).slice(0, 60) : null,
        p_description: b.description ? String(b.description).slice(0, 200) : null,
        p_items: Array.isArray(b.items) ? b.items.slice(0, 200).map(cleanItem) : null,
      });
      const status = r.duplicate ? 200 : 201;
      await log('room_charge', true, status, { bill_ref: b.bill_ref, room: b.room, amount }, r, null);
      return { status, body: r };
    }
    if (method === 'POST' && route[0] === 'charges' && route[2] === 'void' && route[1]) {
      let ref;
      try { ref = decodeURIComponent(route[1]); } catch { return { status: 400, body: { error: 'Bad bill reference' } }; }
      if (String(body?.reason ?? '').length > 200) return { status: 400, body: { error: 'Keep the reason under 200 characters' } };
      const r = await rpc('pms_svc_pos_void', { p_property: property, p_source: source, p_ref: ref, p_reason: body?.reason ?? '' });
      await log('room_charge_void', true, 200, { bill_ref: ref, reason: body?.reason }, r, null);
      return { status: 200, body: r };
    }
    return { status: 404, body: { error: `No route for ${method} /${route.join('/')}` } };
  } catch (e) {
    const known = errorStatus(e.message);
    const status = known?.status ?? 500;
    await log(route[0] === 'charges' ? (route[2] === 'void' ? 'room_charge_void' : 'room_charge') : route[0], false, status,
      { path, bill_ref: body?.bill_ref ?? route[1] ?? null }, null, String(e.message ?? e).slice(0, 500));
    return { status, body: known ? { error: known.message, code: known.code } : { error: 'Server error' } };
  }
}
