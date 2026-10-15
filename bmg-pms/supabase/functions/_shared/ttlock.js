// TTLock Open Platform adapter (Cloud API v3: euopen.sciener.com / open.ttlock.com).
// Login: POST /oauth2/token, form client_id, client_secret, grant_type=password, username, password (MD5).
// Writes (keyboardPwd add / change / delete) are form POSTs; lists (lock/list, lockRecord/list) are GETs.
// Every call carries clientId, accessToken and date (ms). Times are milliseconds.
import { md5 } from './md5.js';
import { http, runJobs, secret } from './util.js';

export const DEFAULT_BASE = 'https://euapi.ttlock.com';

// Record types from the Cloud API (unlock record list). Anything else is stored as "type N".
export const METHOD = {
  1: 'app', 4: 'passcode', 7: 'card', 8: 'fingerprint', 9: 'wrist strap', 10: 'mechanical key', 11: 'locked by app',
  12: 'gateway', 29: 'force alarm', 30: 'door closed', 31: 'door opened', 32: 'opened from inside', 33: 'locked by fingerprint',
  34: 'locked by passcode', 35: 'locked by card', 36: 'locked by key', 37: 'remote', 44: 'tamper alarm', 45: 'auto lock',
  46: 'unlock key', 47: 'locked by key', 48: 'wrong passcode alarm', 49: 'hotel card', 55: 'key fob', 57: 'QR code', 63: 'passage mode',
};

const check = (res, what) => {
  if (!res.ok) throw new Error(`TTLock ${what} HTTP ${res.status}`);
  if (res.body && res.body.errcode !== undefined && res.body.errcode !== 0) throw new Error(`TTLock ${what}: ${res.body.errmsg ?? res.body.errcode}`);
  return res.body;
};

export function ttlockClient({ fetchFn, baseUrl = DEFAULT_BASE, clientId, clientSecret, username, password, now = () => Date.now() }) {
  if (!clientId || !clientSecret || !username || !password) throw new Error('TTLock credentials are not set');
  const base = baseUrl.replace(/\/$/, '');
  let token = null;
  const auth = async () => {
    if (token) return token;
    const res = await http(fetchFn, `${base}/oauth2/token`, {
      method: 'POST', form: { client_id: clientId, client_secret: clientSecret, grant_type: 'password', username, password: md5(password) },
    });
    const body = check(res, 'login');
    if (!body?.access_token) throw new Error('TTLock login returned no access token');
    token = body.access_token;
    return token;
  };
  const call = async (path, params, what, method = 'POST') => {
    const accessToken = await auth();
    const all = { clientId, accessToken, ...params, date: now() };
    if (method === 'GET') return check(await http(fetchFn, `${base}${path}?${new URLSearchParams(Object.entries(all).map(([k, v]) => [k, String(v)]))}`), what);
    return check(await http(fetchFn, `${base}${path}`, { method: 'POST', form: all }), what);
  };
  return {
    auth,
    locks: (pageNo = 1) => call('/v3/lock/list', { pageNo, pageSize: 100 }, 'lock list', 'GET'),
    records: (lockId, startDate, endDate, pageNo = 1) => call('/v3/lockRecord/list', { lockId, startDate, endDate, pageNo, pageSize: 100 }, 'lock records', 'GET'),
    addPasscode: (lockId, keyboardPwd, name, startDate, endDate) =>
      call('/v3/keyboardPwd/add', { lockId, keyboardPwd, keyboardPwdName: name, keyboardPwdType: 3, startDate, endDate, addType: 2 }, 'add passcode'),
    changePeriod: (lockId, keyboardPwdId, startDate, endDate) =>
      call('/v3/keyboardPwd/change', { lockId, keyboardPwdId, startDate, endDate, changeType: 2 }, 'change passcode'),
    deletePasscode: (lockId, keyboardPwdId) => call('/v3/keyboardPwd/delete', { lockId, keyboardPwdId, deleteType: 2 }, 'delete passcode'),
  };
}

// 6 digits, no runs like 123456 or repeats like 111111
export function makePasscode(rand = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n) {
  for (;;) {
    const p = Array.from({ length: 6 }, () => rand(10)).join('');
    if (/^(\d)\1+$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p) || p.startsWith('0')) continue;
    return p;
  }
}

export const toEvent = (r) => ({
  record_id: String(r.recordId), lock_id: String(r.lockId), time_ms: Number(r.lockDate ?? r.serverDate),
  record_type: Number(r.recordType), method: METHOD[r.recordType] ?? `type ${r.recordType}`,
  success: r.success === undefined ? true : Number(r.success) === 1, username: r.username || r.keyboardPwd || null,
  passcode: r.keyboardPwd ? String(r.keyboardPwd) : null,   // the code typed, so the audit can tell PMS codes from others
});

// Pull door records for every mapped lock since the stored cursor
export async function syncRecords({ rpc, client, property, lockIds, cursor = {}, now = Date.now() }) {
  const newCursor = { ...cursor };
  let stored = 0;
  for (const lockId of lockIds) {
    const start = cursor[lockId] ?? now - 24 * 3600 * 1000;
    let page = 1, pages = 1, latest = start;
    const events = [];
    do {
      const body = await client.records(lockId, start, now, page);
      for (const r of body?.list ?? []) {
        const ev = toEvent(r);
        events.push(ev);
        latest = Math.max(latest, ev.time_ms);
      }
      pages = Number(body?.pages ?? 1);
      page += 1;
    } while (page <= pages && page <= 50);
    if (events.length) stored += await rpc('pms_svc_ingest_door_events', { p_property: property, p_events: events });
    newCursor[lockId] = latest + 1;
  }
  await rpc('pms_svc_merge_config', { p_property: property, p_provider: 'ttlock', p_patch: { cursor: newCursor, last_sync: new Date(now).toISOString() } });
  return stored;
}

export function passcodeHandlers({ rpc, clientFor }) {
  return {
    issue_passcode: async (job) => {
      const ctx = await rpc('pms_svc_passcode_context', { p_stay: job.payload.stay_id });
      if (!ctx || ctx.status !== 'checked_in') return { skipped: 'Guest no longer checked in' };
      if (!ctx.lock_id) return { skipped: `Room ${ctx.room} has no lock mapped` };
      if (ctx.passcodes.some((p) => p.status === 'issued' && p.room_id === ctx.room_id)) return { skipped: 'Already issued' };
      const client = clientFor(job.property_id);
      const code = makePasscode();
      const from = Date.parse(ctx.valid_from) - 3600 * 1000, to = Date.parse(ctx.valid_to);
      try {
        const body = await client.addPasscode(ctx.lock_id, code, `${ctx.guest} (room ${ctx.room})`.slice(0, 50), Math.min(from, Date.now()), to);
        await rpc('pms_svc_record_passcode', { p_stay: ctx.stay_id, p_lock: ctx.lock_id, p_passcode: code, p_pwd_id: String(body.keyboardPwdId ?? ''),
          p_from: new Date(Math.min(from, Date.now())).toISOString(), p_to: new Date(to).toISOString(), p_status: 'issued', p_error: null });
        return { room: ctx.room, issued: true };
      } catch (e) {
        await rpc('pms_svc_record_passcode', { p_stay: ctx.stay_id, p_lock: ctx.lock_id, p_passcode: code, p_pwd_id: null,
          p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString(), p_status: 'failed', p_error: e.message });
        throw e;
      }
    },
    revoke_passcode: async (job) => {
      const ctx = await rpc('pms_svc_passcode_context', { p_stay: job.payload.stay_id });
      const targets = (ctx?.passcodes ?? []).filter((p) => p.status === 'issued' && (!job.payload.room_id || p.room_id === job.payload.room_id));
      const client = clientFor(job.property_id);
      for (const p of targets) {
        if (p.provider_pwd_id) await client.deletePasscode(p.lock_id, p.provider_pwd_id);
        await rpc('pms_svc_update_passcode', { p_id: p.id, p_status: 'revoked', p_valid_to: null, p_error: null });
      }
      return { revoked: targets.length };
    },
    extend_passcode: async (job) => {
      const ctx = await rpc('pms_svc_passcode_context', { p_stay: job.payload.stay_id });
      const client = clientFor(job.property_id);
      let n = 0;
      for (const p of (ctx?.passcodes ?? []).filter((x) => x.status === 'issued' && x.provider_pwd_id)) {
        await client.changePeriod(p.lock_id, p.provider_pwd_id, Date.parse(ctx.valid_from) - 3600 * 1000, Date.parse(ctx.valid_to));
        await rpc('pms_svc_update_passcode', { p_id: p.id, p_status: 'issued', p_valid_to: ctx.valid_to, p_error: null });
        n++;
      }
      return { extended: n };
    },
  };
}

export async function runTTLock({ rpc, fetchFn, env, log = () => {} }) {
  const props = await rpc('pms_svc_enabled', { p_provider: 'ttlock' });
  const clients = {};
  const clientFor = (propertyId) => {
    if (clients[propertyId]) return clients[propertyId];
    const p = props.find((x) => x.property_id === propertyId);
    const code = p?.config?.code;
    clients[propertyId] = ttlockClient({
      fetchFn, baseUrl: secret(env, 'TTLOCK_BASE_URL', code) ?? DEFAULT_BASE,
      clientId: secret(env, 'TTLOCK_CLIENT_ID', code), clientSecret: secret(env, 'TTLOCK_CLIENT_SECRET', code),
      username: secret(env, 'TTLOCK_USERNAME', code), password: secret(env, 'TTLOCK_PASSWORD', code),
    });
    return clients[propertyId];
  };
  const report = [];
  for (const p of props ?? []) {
    try {
      const locks = await rpc('pms_svc_lock_ids', { p_property: p.property_id });
      const n = await syncRecords({ rpc, client: clientFor(p.property_id), property: p.property_id, lockIds: locks ?? [], cursor: p.config?.cursor ?? {} });
      await rpc('pms_svc_log', { p_property: p.property_id, p_provider: 'ttlock', p_direction: 'in', p_action: 'lock_records', p_ok: true, p_status: 200, p_request: { locks: (locks ?? []).length }, p_response: { stored: n }, p_error: null });
      report.push({ property: p.property_name, stored: n });
    } catch (e) {
      await rpc('pms_svc_log', { p_property: p.property_id, p_provider: 'ttlock', p_direction: 'in', p_action: 'lock_records', p_ok: false, p_status: null, p_request: null, p_response: null, p_error: e.message });
      report.push({ property: p.property_name, error: e.message });
    }
  }
  const jobs = await runJobs({ rpc, provider: 'ttlock', handlers: passcodeHandlers({ rpc, clientFor }), log });
  return { properties: report, jobs };
}
