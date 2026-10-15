// BMG PMS client for Tenda ICO. Works in Deno, Node 18+ and browsers (plain fetch).
// Use it server-side (see pms-proxy/) so the API key stays out of the till's browser.
//
//   const pms = createPmsClient({ baseUrl: 'https://<pms-ref>.supabase.co/functions/v1/pos-gateway', apiKey });
//   const { guests } = await pms.guests('33');                    // search by room or name
//   await pms.chargeToRoom({ billRef: sale.id, stayId, room: '332', amount: 25000, outlet: 'Restaurant', items });
//   await pms.voidCharge(sale.id, 'Wrong room');
//
// chargeToRoom retries network errors and 5xx with the SAME billRef; the PMS charges a bill once, however often it is sent.

export class PmsError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function createPmsClient({ baseUrl, apiKey, fetchFn = globalThis.fetch, retries = 3, timeoutMs = 15000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!baseUrl || !apiKey) throw new Error('baseUrl and apiKey are required');
  const base = baseUrl.replace(/\/$/, '');

  async function call(method, path, body, attempt = 0) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchFn(base + path, {
        method, signal: ctrl.signal,
        headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      clearTimeout(t);
      if (attempt < retries) { await sleep(500 * 2 ** attempt); return call(method, path, body, attempt + 1); }
      throw new PmsError(0, 'NETWORK', `Could not reach the PMS: ${e.message ?? e}`);
    }
    clearTimeout(t);
    const data = await res.json().catch(() => ({}));
    if (res.status >= 500 && attempt < retries) { await sleep(500 * 2 ** attempt); return call(method, path, body, attempt + 1); }
    if (!res.ok) throw new PmsError(res.status, data.code ?? null, data.error ?? `PMS error ${res.status}`);
    return data;
  }

  return {
    health: () => call('GET', '/health'),
    guests: (q = '') => call('GET', `/guests${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    chargeToRoom: ({ billRef, stayId, room, amount, category = 'fnb', outlet, description, items }) =>
      call('POST', '/charges', { bill_ref: String(billRef), stay_id: stayId, room, amount, category, outlet, description, items }),
    voidCharge: (billRef, reason) => call('POST', `/charges/${encodeURIComponent(billRef)}/void`, { reason }),
  };
}
