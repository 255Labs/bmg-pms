// Middleware test: the real integration adapters run against the real database (PGlite)
// with fake Channex, TTLock and VFD servers in place of the internet.
// Run: node tests/middleware.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { md5 } from '../supabase/functions/_shared/md5.js';
import { runChannex, buildAriValues } from '../supabase/functions/_shared/channex.js';
import { runTTLock, makePasscode } from '../supabase/functions/_shared/ttlock.js';
import { runFiscal, fill, vfdTarget } from '../supabase/functions/_shared/fiscal.js';
import { parseAlerts, usable } from '../supabase/functions/_shared/hikvision.js';
import { toRanges } from '../supabase/functions/_shared/util.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra); } };

// ---------------------------------------------------------------- pure helpers
console.log('Helpers');
ok('md5 of empty string', md5('') === 'd41d8cd98f00b204e9800998ecf8427e');
ok('md5 of "abc"', md5('abc') === '900150983cd24fb0d6963f7d28e17f72');
ok('md5 of a long password', md5('The quick brown fox jumps over the lazy dog') === '9e107d9d372bb6826bd81d3542a419d6');
const r = toRanges([{ date: '2026-10-01', k: 'a', v: 2 }, { date: '2026-10-02', k: 'a', v: 2 }, { date: '2026-10-03', k: 'a', v: 1 }, { date: '2026-10-01', k: 'b', v: 5 }], (x) => x.k, (x) => x.v);
ok('consecutive equal days merge into ranges', r.length === 3 && r[0].date_to === '2026-10-02');
const codes = Array.from({ length: 200 }, () => makePasscode());
ok('passcodes are 6 digits with no runs or repeats', codes.every((c) => /^[1-9]\d{5}$/.test(c) && !/^(\d)\1+$/.test(c) && !'0123456789'.includes(c)));
const thrown = (f) => { try { f(); return null; } catch (e) { return e.message; } };
ok('the VFD key is never sent over plain http', /https/.test(thrown(() => vfdTarget('http://vfd.example/x', { VFD_ALLOWED_HOSTS: 'vfd.example' }))));
ok('nor to a host that is not allow-listed', /not in VFD_ALLOWED_HOSTS/.test(thrown(() => vfdTarget('https://evil.example/x', { VFD_ALLOWED_HOSTS: 'vfd.example' }))));
ok('nor anywhere until the allow-list is set', /VFD_ALLOWED_HOSTS/.test(thrown(() => vfdTarget('https://vfd.example/x', {}))));
ok('VFD template fills nested values', JSON.stringify(fill({ a: '{{x.y}}', b: 'Ref {{r}}', c: ['{{n}}'] }, { x: { y: 5 }, r: 'R1', n: 2 })) === '{"a":5,"b":"Ref R1","c":[2]}');
const xml = `--boundary\r\nContent-Type: application/xml\r\n\r\n<?xml version="1.0"?><EventNotificationAlert version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<ipAddress>192.168.1.64</ipAddress><macAddress>44:19:b6:00:00:01</macAddress><channelID>5</channelID>
<dateTime>2026-10-12T10:01:02+03:00</dateTime><activePostCount>1</activePostCount><eventType>linedetection</eventType>
<eventState>active</eventState><eventDescription>Line crossing alarm</eventDescription></EventNotificationAlert>\r\n--boundary\r\n
<EventNotificationAlert><ipAddress>192.168.1.64</ipAddress><channelID>1</channelID><dateTime>2026-10-12T10:02:00+03:00</dateTime><eventType>videoloss</eventType><eventState>inactive</eventState></EventNotificationAlert>`;
const alerts = usable(parseAlerts(xml));
ok('Hikvision XML parsed, heartbeat dropped', alerts.length === 1 && alerts[0].channel === '5' && alerts[0].event_type === 'linedetection');

// ---------------------------------------------------------------- database
const db = new PGlite({ extensions: { btree_gist } });
await db.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text unique);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;`);
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));

const OWNER = '11111111-1111-1111-1111-111111111111';
await db.exec(`insert into auth.users values ('${OWNER}','owner@bmg.co.tz')`);
const as = (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`);
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
await as(OWNER);
const P = (await one(`select pms_create_property('Unreal Homes','UH','Balati',$1::jsonb) id`,
  [JSON.stringify([{ name: 'Single', base_rate: 200000, rooms: ['331', '332', '333'] }, { name: 'Double', base_rate: 300000, rooms: ['335'] }])])).id;
await db.exec(`update pms_properties set business_date = '2026-10-12', tin = '123-456-789' where id = '${P}'`);
const SGL = (await one(`select id from pms_room_types where property_id=$1 and name='Single'`, [P])).id;
const RO = (await one(`select id from pms_rate_plans where property_id=$1 and name='Room Only'`, [P])).id;
const R331 = (await one(`select id from pms_rooms where property_id=$1 and number='331'`, [P])).id;
await db.query(`insert into pms_integrations(property_id,provider,enabled,config) values
  ($1,'channex',true,'{"property_id":"cx-prop"}'), ($1,'ttlock',true,'{}'), ($1,'fiscal',true,'{"url":"https://vfd.example/api/receipts","response_map":{"receipt_no":"data.rctNum","verification_code":"data.rctvCode","verify_url":"data.qr"}}')`, [P]);
await db.query(`insert into pms_external_ids(property_id,provider,entity,entity_id,external_id) values ($1,'channex','room_type',$2,'cx-sgl'), ($1,'ttlock','room',$3,'5001')`, [P, SGL, R331]);
await db.query(`insert into pms_channex_rate_map values ($1,$2,$3,'cx-sgl-ro')`, [P, SGL, RO]);

// rpc() as the Edge Functions call it (named arguments, service context)
const rpc = async (fn, args = {}) => {
  await as(null);
  const keys = Object.keys(args);
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
  const res = await db.query(`select * from ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, vals);
  return res.fields.length === 1 && res.fields[0].name === fn ? res.rows[0]?.[fn] : res.rows;
};

// ---------------------------------------------------------------- fake internet
const calls = [];
let vfdFail = false;
const feed = [{ type: 'booking_revision', id: 'rev-1', attributes: { id: 'rev-1', property_id: 'cx-prop', booking_id: 'bk-1', status: 'new',
  ota_name: 'Booking.com', ota_reservation_code: '9996013801', currency: 'TZS', arrival_date: '2026-10-20', departure_date: '2026-10-22',
  customer: { name: 'Anna', surname: 'Berg', mail: 'anna@example.com', phone: '+46700000000', country: 'SE' },
  rooms: [{ room_type_id: 'cx-sgl', rate_plan_id: 'cx-sgl-ro', checkin_date: '2026-10-20', checkout_date: '2026-10-22', amount: '400000.00', occupancy: { adults: 2, children: 0 } }] } }];
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = init.body ? (init.headers['content-type'] === 'application/json' ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : null;
  calls.push({ host: u.host, path: u.pathname, search: u.search, body, headers: init.headers });
  const reply = (status, obj) => ({ ok: status < 300, status, text: async () => JSON.stringify(obj) });
  if (u.host === 'staging.channex.io') {
    if (init.headers['user-api-key'] !== 'cx-key') return reply(401, { errors: { title: 'Unauthorized' } });
    if (u.pathname.endsWith('/booking_revisions/feed')) return reply(200, { data: feed.splice(0), meta: { total: 1 } });
    if (u.pathname.endsWith('/ack')) return reply(200, { meta: { message: 'Success' } });
    if (u.pathname.endsWith('/availability') || u.pathname.endsWith('/restrictions')) return reply(200, { data: [], meta: { message: 'Success', warnings: [] } });
  }
  if (u.host === 'euapi.ttlock.com') {
    // strict like the real Cloud API v3: snake_case login, GET for lists, form POST for writes
    if (u.pathname === '/oauth2/token') {
      if (init.method !== 'POST' || body.client_id !== 'cid' || body.client_secret !== 'csec' || body.grant_type !== 'password') return reply(200, { errcode: 10001, errmsg: 'invalid client' });
      return body.password === md5('door-pass') ? reply(200, { access_token: 'tok', expires_in: 7776000 }) : reply(200, { errcode: 10007, errmsg: 'invalid account or invalid password' });
    }
    const isList = ['/v3/lockRecord/list', '/v3/lock/list'].includes(u.pathname);
    if (isList !== ((init.method ?? 'GET') === 'GET')) return reply(405, { errcode: -1, errmsg: 'method not allowed' });
    const params = isList ? Object.fromEntries(u.searchParams) : body;
    if (params.accessToken !== 'tok' || params.clientId !== 'cid' || !params.date) return reply(200, { errcode: 10003, errmsg: 'invalid token' });
    if (u.pathname === '/v3/lockRecord/list') return reply(200, { list: [
      { recordId: 9001, lockId: 5001, recordType: 4, success: 1, username: 'guest code', lockDate: Date.parse('2026-10-12T09:00:00+03:00') },
      { recordId: 9002, lockId: 5001, recordType: 7, success: 1, username: 'hk.asha', lockDate: Date.parse('2026-10-12T11:00:00+03:00') },
      { recordId: 9003, lockId: 5001, recordType: 45, success: 1, username: null, lockDate: Date.parse('2026-10-12T11:01:00+03:00') }], pageNo: 1, pages: 1 });
    if (u.pathname === '/v3/keyboardPwd/add') return reply(200, { keyboardPwdId: 777 });
    if (u.pathname === '/v3/keyboardPwd/change' || u.pathname === '/v3/keyboardPwd/delete') return reply(200, { errcode: 0, errmsg: 'none error message' });
  }
  if (u.host === 'vfd.example') return vfdFail ? reply(500, { error: 'down' }) : reply(200, { data: { rctNum: 'VFD-000123', rctvCode: 'ABC9XYZ', qr: 'https://verify.tra.go.tz/ABC9XYZ' } });
  return reply(404, { error: 'unknown endpoint ' + url });
};
const env = { CHANNEX_API_KEY: 'cx-key', TTLOCK_CLIENT_ID: 'cid', TTLOCK_CLIENT_SECRET: 'csec', TTLOCK_USERNAME: '255700000000', TTLOCK_PASSWORD: 'door-pass', VFD_ALLOWED_HOSTS: 'vfd.example' };

// ---------------------------------------------------------------- Channex
console.log('\nChannex');
await as(OWNER);
await db.query(`select pms_create_reservation($1,'{"first_name":"Walk","last_name":"In"}'::jsonb,'2026-10-12','2026-10-14',$2::jsonb)`, [P, JSON.stringify([{ room_type_id: SGL }])]);
const c1 = await runChannex({ rpc, fetchFn: fakeFetch, env });
const otaRes = await one(`select * from pms_reservations where external_ref='bk-1'`);
ok('feed booking created as a reservation', !!otaRes && otaRes.arrival.toISOString().startsWith('2026-10-20'));
ok('revision acknowledged to Channex', calls.some((c) => c.path.endsWith('/booking_revisions/rev-1/ack')));
const avail = calls.filter((c) => c.path.endsWith('/availability')).flatMap((c) => c.body.values);
ok('availability pushed as date ranges for the mapped room type', avail.length > 0 && avail.every((v) => v.property_id === 'cx-prop' && v.room_type_id === 'cx-sgl' && v.date_from && v.date_to));
const first = avail.find((v) => v.date_from === '2026-10-12');
ok('availability on 12 Oct reflects the walk-in booking (3 rooms − 1)', first && first.availability === 2, JSON.stringify(avail.slice(0, 3)));
const rates = calls.filter((c) => c.path.endsWith('/restrictions')).flatMap((c) => c.body.values);
ok('rates pushed as decimal strings', rates.length > 0 && rates[0].rate === '200000.00' && rates[0].rate_plan_id === 'cx-sgl-ro');
ok('channex job finished', c1.jobs.every((j) => j.ok) && c1.jobs.some((j) => j.kind === 'ari_push'), JSON.stringify(c1));
ok('integration log written', Number((await one(`select count(*) n from pms_integration_log where provider='channex' and ok`)).n) >= 3);
const bad = await runChannex({ rpc, fetchFn: fakeFetch, env: { ...env, CHANNEX_API_KEY: 'wrong' } });
ok('wrong API key reported, not crashing', bad.properties[0].bookings.error?.includes('401'));

// ---------------------------------------------------------------- TTLock
console.log('\nTTLock');
await as(OWNER);
const resT = (await one(`select pms_create_reservation($1,'{"first_name":"Lulu","last_name":"Kayanda"}'::jsonb,'2026-10-12','2026-10-15',$2::jsonb) r`, [P, JSON.stringify([{ room_id: R331 }])])).r;
const stay = (await one(`select id from pms_stays where reservation_id=$1`, [resT.reservation_id])).id;
await db.query(`select pms_check_in($1, true)`, [stay]);
const t1 = await runTTLock({ rpc, fetchFn: fakeFetch, env });
const pc = await one(`select * from pms_stay_passcodes where stay_id=$1`, [stay]);
ok('guest passcode issued on the room lock', pc && pc.status === 'issued' && pc.lock_id === '5001' && pc.provider_pwd_id === '777' && /^\d{6}$/.test(pc.passcode), JSON.stringify(t1));
const addCall = calls.find((c) => c.path === '/v3/keyboardPwd/add');
ok('passcode sent via gateway with millisecond validity', addCall.body.addType === '2' && Number(addCall.body.endDate) > Number(addCall.body.startDate));
ok('door records stored and mapped to room 331', Number((await one(`select count(*) n from pms_door_events where room_id=$1`, [R331])).n) === 3);
ok('auto-lock events are stored but do not count as door openings', (await one(`select count(*) filter (where is_open) o, count(*) filter (where not is_open) c from pms_door_events where room_id=$1`, [R331])).c == 1);
ok('TTLock login uses client_id and grant_type=password', calls.some((c) => c.path === '/oauth2/token' && c.body?.grant_type === 'password'));
ok('unlock records are fetched with GET and query parameters', calls.some((c) => c.path === '/v3/lockRecord/list' && c.search.includes('lockId=5001') && c.search.includes('accessToken=tok')));
ok('record cursor saved for next pull', !!(await one(`select config->'cursor'->>'5001' c from pms_integrations where property_id=$1 and provider='ttlock'`, [P])).c);
await as(OWNER);
await db.query(`select pms_amend_stay($1, null, '2026-10-16')`, [stay]);
await runTTLock({ rpc, fetchFn: fakeFetch, env });
ok('extending the stay extends the passcode', calls.some((c) => c.path === '/v3/keyboardPwd/change'));
await as(OWNER);
const f = (await one(`select id from pms_folios where stay_id=$1`, [stay])).id;
const balNow = Number((await one(`select balance from pms_folio_balances where folio_id=$1`, [f])).balance);
if (balNow > 0) await db.query(`select pms_post_payment($1,$2,'bank','TT-1')`, [f, balNow]);
await db.query(`update pms_stays set departure='2026-10-13' where id=$1`, [stay]);
await db.query(`update pms_properties set business_date='2026-10-13' where id=$1`, [P]);
await db.query(`update pms_stays set departure='2026-10-14' where id=$1`, [stay]);
await db.query(`select pms_check_out($1)`, [stay]).catch((e) => console.log('   checkout:', e.message));
await runTTLock({ rpc, fetchFn: fakeFetch, env });
ok('check-out revokes the passcode', (await one(`select status from pms_stay_passcodes where id=$1`, [pc.id])).status === 'revoked');
const badLock = await runTTLock({ rpc, fetchFn: fakeFetch, env: { ...env, TTLOCK_PASSWORD: 'nope' } });
ok('bad TTLock password reported clearly', badLock.properties[0].error?.includes('invalid account'));

// ---------------------------------------------------------------- Revenue assurance
console.log('\nRevenue assurance');
await as(OWNER);
const room = async (n) => (await one(`select id from pms_rooms where property_id=$1 and number=$2`, [P, n])).id;
await db.query(`update pms_integrations set config = config || '{"staff_usernames":["hk.asha"]}' where property_id=$1 and provider='ttlock'`, [P]);
await db.query(`insert into pms_door_events(property_id,provider_record_id,lock_id,room_id,event_time,success,username) values
  ($1,'ra-1','L332',$2,'2026-10-11 22:10+03',true,'unknown'),($1,'ra-2','L333',$3,'2026-10-11 10:00+03',true,'hk.asha')`, [P, await room('332'), await room('333')]);
const ra = (await db.query(`select room, flag, day::text d from pms_rpt_revenue_assurance($1,'2026-10-11','2026-10-13')`, [P])).rows;
ok('guest code used on a vacant room is flagged', ra.some((x) => x.room === '332' && x.d === '2026-10-11' && x.flag === 'Door used while vacant'));
ok('housekeeping code on a vacant room is not flagged', !ra.some((x) => x.room === '333' && x.d === '2026-10-11' && x.flag));
ok('the unfinished business day is never flagged for no activity', !ra.some((x) => x.d === '2026-10-13' && x.flag === 'Occupied but no activity'));

// ---------------------------------------------------------------- Fiscal
console.log('\nFiscal receipts');
await as(OWNER);
const resF = (await one(`select pms_create_reservation($1,'{"first_name":"Fiscal"}'::jsonb,'2026-10-13','2026-10-14',$2::jsonb) r`, [P, JSON.stringify([{ room_type_id: SGL }])])).r;
const ff = (await one(`select f.id from pms_folios f where f.reservation_id=$1`, [resF.reservation_id])).id;
await db.query(`select pms_post_payment($1,100000,'card','VISA-1')`, [ff]);
await runFiscal({ rpc, fetchFn: fakeFetch, env });
const rc = await one(`select * from pms_fiscal_receipts where amount=100000`);
ok('receipt issued with the VFD number and verification code', rc.status === 'issued' && rc.receipt_no === 'VFD-000123' && rc.verification_code === 'ABC9XYZ');
const vfdCall = calls.find((c) => c.host === 'vfd.example');
ok('VFD request carries TIN and amount', vfdCall.body.tin === '123-456-789' && Number(vfdCall.body.total) === 100000);
vfdFail = true;
await as(OWNER);
await db.query(`select pms_post_payment($1,50000,'card','VISA-2')`, [ff]);
const fr = await runFiscal({ rpc, fetchFn: fakeFetch, env });
ok('provider outage marks receipt failed and retries later', fr[0].ok === false && (await one(`select status from pms_fiscal_receipts where amount=50000`)).status === 'failed'
  && (await one(`select status from pms_jobs where provider='fiscal' order by id desc limit 1`)).status === 'queued');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
