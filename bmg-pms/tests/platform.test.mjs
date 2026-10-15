// Platform test: Tenda ICO gateway + client, Channex restrictions, integration health, eZee import.
// Everything runs against the real migrations on PGlite. Run: node tests/platform.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePosRequest, errorStatus } from '../supabase/functions/_shared/posgateway.js';
import { handleIngest } from '../supabase/functions/_shared/ingest.js';
import { buildAriValues } from '../supabase/functions/_shared/channex.js';
import { createPmsClient } from '../integrations/tendaico/bmgPmsClient.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra); } };

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

const OWNER = '11111111-1111-1111-1111-111111111111', DESK = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users values ('${OWNER}','owner@bmg.co.tz'), ('${DESK}','desk@bmg.co.tz')`);
const as = (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`);
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const fails = async (sql, p, match) => { try { await db.query(sql, p); return false; } catch (e) { return !match || String(e.message).includes(match); } };
await as(OWNER);
const P = (await one(`select pms_create_property('Unreal Homes','UH','Balati',$1::jsonb) id`,
  [JSON.stringify([{ name: 'Single', base_rate: 200000, rooms: ['331', '332', '333', '334'] }, { name: 'Double', base_rate: 300000, rooms: ['335', '340'] }])])).id;
await db.exec(`update pms_properties set business_date = '2026-10-12' where id = '${P}'`);
await db.query(`select pms_set_member($1, 'desk@bmg.co.tz', 'front_desk')`, [P]);
const id = async (sql, p) => (await one(sql, p)).id;
const SGL = await id(`select id from pms_room_types where property_id=$1 and name='Single'`, [P]);
const DBL = await id(`select id from pms_room_types where property_id=$1 and name='Double'`, [P]);
const RO = await id(`select id from pms_rate_plans where property_id=$1 and name='Room Only'`, [P]);
const room = (n) => id(`select id from pms_rooms where property_id=$1 and number=$2`, [P, n]);

const rpc = async (fn, args = {}) => {
  await as(null);
  const keys = Object.keys(args);
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
  const res = await db.query(`select * from ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, vals);
  return res.fields.length === 1 && res.fields[0].name === fn ? res.rows[0]?.[fn] : res.rows;
};

// an in-house guest in 332
await as(OWNER);
const g = (await one(`select pms_create_reservation($1,'{"first_name":"Fred","last_name":"Mutiso"}'::jsonb,'2026-10-12','2026-10-15',$2::jsonb) r`,
  [P, JSON.stringify([{ room_id: await room('332') }])])).r;
const STAY = (await one(`select id from pms_stays where reservation_id=$1`, [g.reservation_id])).id;
await db.query(`update pms_rooms set hk_status='clean' where property_id=$1`, [P]);
await db.query(`select pms_check_in($1)`, [STAY]);
const FOLIO = (await one(`select id from pms_folios where stay_id=$1`, [STAY])).id;
const balance = async () => Number((await one(`select balance from pms_folio_balances where folio_id=$1`, [FOLIO])).balance);

// ---------------------------------------------------------------- API keys
console.log('API keys');
await as(DESK);
ok('front desk cannot make API keys', await fails(`select pms_create_api_key($1,'Restaurant till')`, [P], 'cannot perform'));
await as(OWNER);
const k = (await one(`select pms_create_api_key($1,'Restaurant till') k`, [P])).k;
ok('a key is returned once, with a recognisable prefix', /^bmgpms_[0-9a-f]{64}$/.test(k.key) && k.prefix === k.key.slice(0, 14));
const stored = await one(`select key_hash from pms_api_keys where id=$1`, [k.id]);
ok('only the SHA-256 of the key is stored', stored.key_hash.length === 64 && !stored.key_hash.includes(k.key.slice(7, 20)));
ok('the key unlocks its own property', (await rpc('pms_svc_api_key_check', { p_key: k.key }))[0]?.property_id === P);
ok('a wrong key unlocks nothing', (await rpc('pms_svc_api_key_check', { p_key: k.key.slice(0, -1) + (k.key.endsWith('0') ? '1' : '0') })).length === 0);

// ---------------------------------------------------------------- gateway
console.log('\nTenda ICO gateway');
const req = (method, path, body, key = k.key, query = {}) => handlePosRequest({ method, path, query, headers: { authorization: `Bearer ${key}` }, body, rpc });
ok('no key → 401', (await handlePosRequest({ method: 'GET', path: '/health', headers: {}, rpc })).status === 401);
ok('health names the property', (await req('GET', '/health')).body.property_id === P);
const list = await req('GET', '/guests', null, k.key, { q: '33' });
ok('guest search by room finds the in-house guest', list.status === 200 && list.body.guests.length === 1 && list.body.guests[0].room === '332');
ok('guest search by surname works', (await req('GET', '/guests', null, k.key, { q: 'muti' })).body.guests[0]?.stay_id === STAY);
const before = await balance();
const c1 = await req('POST', '/charges', { bill_ref: 'TND-1001', stay_id: STAY, room: '332', amount: 25000, outlet: 'Restaurant', items: [{ name: 'Pilau', qty: 1, amount: 25000 }] });
ok('charge to room → 201 and lands on the folio', c1.status === 201 && (await balance()) === before + 25000);
const c2 = await req('POST', '/charges', { bill_ref: 'TND-1001', stay_id: STAY, room: '332', amount: 25000 });
ok('the same bill sent again → 200, charged once', c2.status === 200 && c2.body.duplicate === true && (await balance()) === before + 25000);
const c3 = await req('POST', '/charges', { bill_ref: 'TND-1001', stay_id: STAY, room: '332', amount: 30000 });
ok('the same bill with a different amount → 409 CONFLICT', c3.status === 409 && c3.body.code === 'CONFLICT');
const c4 = await req('POST', '/charges', { bill_ref: 'TND-1002', stay_id: STAY, room: '331', amount: 5000 });
ok('stale room number → 409 ROOM_MISMATCH', c4.status === 409 && c4.body.code === 'ROOM_MISMATCH');
await as(OWNER);
const fut = (await one(`select pms_create_reservation($1,'{"first_name":"Later"}'::jsonb,'2026-10-20','2026-10-21',$2::jsonb) r`, [P, JSON.stringify([{ room_type_id: SGL }])])).r;
const futStay = (await one(`select id from pms_stays where reservation_id=$1`, [fut.reservation_id])).id;
const c5 = await req('POST', '/charges', { bill_ref: 'TND-1003', stay_id: futStay, amount: 5000 });
ok('a guest who has not arrived → 409 NOT_IN_HOUSE', c5.status === 409 && c5.body.code === 'NOT_IN_HOUSE');
ok('zero amount → 400', (await req('POST', '/charges', { bill_ref: 'TND-1004', stay_id: STAY, amount: 0 })).status === 400);
const line = await one(`select source, category, reference, description from pms_folio_lines where id=$1`, [c1.body.folio_line_id]);
ok('folio line shows the outlet, the bill and source pos', line.source === 'pos' && line.category === 'fnb' && line.reference === 'tendaico:TND-1001' && line.description.includes('Restaurant'));
const v1 = await req('POST', '/charges/TND-1001/void', { reason: 'Wrong room' });
ok('same-day void → 200 and the balance drops back', v1.status === 200 && (await balance()) === before);
ok('void twice is harmless', (await req('POST', '/charges/TND-1001/void', { reason: 'again' })).body.duplicate === true);
ok('void needs a reason', (await req('POST', '/charges/TND-1001x/void', {})).status === 400);
await req('POST', '/charges', { bill_ref: 'TND-1005', stay_id: STAY, room: '332', amount: 8000 });
await db.query(`update pms_properties set business_date='2026-10-13' where id=$1`, [P]);
const v2 = await req('POST', '/charges/TND-1005/void', { reason: 'late' });
ok('void after the day closed → 409 DAY_CLOSED', v2.status === 409 && v2.body.code === 'DAY_CLOSED');
await db.query(`update pms_properties set business_date='2026-10-12' where id=$1`, [P]);
const logged = await one(`select count(*) filter (where ok) good, count(*) filter (where not ok) bad from pms_integration_log where property_id=$1 and provider='tendaico'`, [P]);
ok('every gateway call is in the integration log', Number(logged.good) >= 3 && Number(logged.bad) >= 3);
ok('error text maps to a status', errorStatus('pms_svc_pos_charge: CONFLICT: x')?.status === 409 && errorStatus('boom') === null);
ok('absurd amounts are refused before they reach a folio', (await req('POST', '/charges', { bill_ref: 'X-1', stay_id: '00000000-0000-0000-0000-000000000000', amount: 5e9 })).status === 400);
ok('odd bill references are refused', (await req('POST', '/charges', { bill_ref: "1'; drop table x", stay_id: '00000000-0000-0000-0000-000000000000', amount: 10 })).status === 400);
ok('a malformed void path is a 400, not a crash', (await req('POST', '/charges/%E0%A4%A/void', { reason: 'x' })).status === 400);
await as(OWNER);
await db.query(`select pms_revoke_api_key($1)`, [k.id]);
ok('a revoked key → 401', (await req('GET', '/health')).status === 401);

// ---------------------------------------------------------------- Tenda ICO client

console.log('\nCamera relay keys');
await as(OWNER);
const relayA = (await one(`select pms_create_api_key($1,'Relay PC','hikvision') k`, [P])).k;
const ingest = (key, body) => handleIngest({ headers: { 'x-relay-key': key }, body, rpc, env: {} });
ok('a relay key posts events for its own property', (await ingest(relayA.key, { events: [] })).status === 200);
ok('but not for another property', (await ingest(relayA.key, { property_id: '00000000-0000-0000-0000-000000000001', events: [] })).status === 403);
ok('a till key cannot post camera events', (await ingest(k.key, { events: [] })).status === 403);
ok('no key, no entry', (await ingest('', { events: [] })).status === 401);

console.log('\nTenda ICO client');
await as(OWNER);
const k2 = (await one(`select pms_create_api_key($1,'Bar till') k`, [P])).k;
let flaky = 1;
const bridge = async (url, init) => {
  const u = new URL(url);
  if (u.pathname.endsWith('/charges') && flaky-- > 0) return { ok: false, status: 502, json: async () => ({ error: 'Bad gateway' }) };
  const out = await handlePosRequest({ method: init.method, path: u.pathname.replace('/functions/v1/pos-gateway', ''), query: Object.fromEntries(u.searchParams),
    headers: init.headers, body: init.body ? JSON.parse(init.body) : null, rpc });
  return { ok: out.status < 300, status: out.status, json: async () => out.body };
};
const pms = createPmsClient({ baseUrl: 'https://pms.example/functions/v1/pos-gateway', apiKey: k2.key, fetchFn: bridge, sleep: async () => {} });
const b0 = await balance();
const cc = await pms.chargeToRoom({ billRef: 'BAR-77', stayId: STAY, room: '332', amount: 10000, outlet: 'Pool bar' });
ok('client retries a 502 with the same bill and charges once', cc.status === 'posted' && (await balance()) === b0 + 10000);
let err = null;
try { await pms.chargeToRoom({ billRef: 'BAR-78', stayId: futStay, amount: 1000 }); } catch (e) { err = e; }
ok('client surfaces the PMS reason', err?.status === 409 && err?.code === 'NOT_IN_HOUSE');

// ---------------------------------------------------------------- Channex restrictions
console.log('\nChannex restrictions');
await as(OWNER);
await db.query(`insert into pms_integrations(property_id,provider,enabled,config) values ($1,'channex',true,'{"property_id":"cx"}')`, [P]);
await db.query(`insert into pms_external_ids(property_id,provider,entity,entity_id,external_id) values ($1,'channex','room_type',$2,'cx-sgl')`, [P, SGL]);
await db.query(`insert into pms_channex_rate_map values ($1,$2,$3,'cx-sgl-ro')`, [P, SGL, RO]);
await db.query(`delete from pms_jobs where property_id=$1`, [P]);
await db.query(`select pms_set_restrictions($1,$2,$3,'2026-12-24','2026-12-26', 3, false, false, true)`, [P, SGL, RO]);
await db.query(`select pms_set_restrictions($1,$2,$3,'2026-12-31','2026-12-31', 1, true)`, [P, SGL, RO]);
ok('setting restrictions queues a channel update', Number((await one(`select count(*) n from pms_jobs where property_id=$1 and provider='channex'`, [P])).n) >= 1);
await as(DESK);
ok('front desk cannot change restrictions', await fails(`select pms_set_restrictions($1,$2,$3,'2026-12-01','2026-12-01', 2)`, [P, SGL, RO], 'cannot perform'));
const snap = await rpc('pms_svc_ari_snapshot', { p_property: P, p_from: '2026-12-23', p_to: '2027-01-02' });
const ari = buildAriValues(snap, 'cx');
const xmas = ari.restrictions.find((x) => x.date_from === '2026-12-24');
ok('Christmas carries min stay 3 and closed to departure as one range', xmas?.date_to === '2026-12-26' && xmas.min_stay_arrival === 3 && xmas.closed_to_departure === true && xmas.rate === '200000.00');
const nye = ari.restrictions.find((x) => x.date_from === '2026-12-31');
ok('New Year’s Eve is stop-sold for that rate plan', nye?.stop_sell === true && nye.date_to === '2026-12-31');
ok('plain days collapse into ranges', ari.restrictions.length === 5, JSON.stringify(ari.restrictions.map((x) => [x.date_from, x.date_to])));
await as(OWNER);
await db.query(`select pms_set_restrictions($1,$2,$3,'2026-12-24','2026-12-31', 1, false, false, false)`, [P, SGL, RO]);
ok('setting defaults clears the dates', Number((await one(`select count(*) n from pms_rate_restrictions where property_id=$1`, [P])).n) === 0);

// ---------------------------------------------------------------- health
console.log('\nIntegration health');
await as(OWNER);
const health = async () => Object.fromEntries((await db.query(`select * from pms_integration_health($1)`, [P])).rows.map((r) => [r.provider, r]));
let h = await health();
ok('services not switched on show as off', h.ttlock.status === 'off' && h.fiscal.status === 'off');
ok('Tenda ICO is on once a key exists, and healthy after use', h.tendaico.enabled && h.tendaico.status === 'ok');
ok('Channex with no successful contact yet is amber', h.channex.status === 'warning');
await db.query(`insert into pms_integration_log(property_id,provider,direction,action,ok,status_code) values ($1,'channex','out','availability',true,200)`, [P]);
await db.query(`update pms_jobs set created_at = now() - interval '20 minutes' where property_id=$1 and status='queued'`, [P]);
h = await health();
ok('tasks waiting 20 minutes turn amber', h.channex.status === 'warning' && h.channex.detail.includes('waiting'));
await db.query(`update pms_jobs set status='failed', last_error='HTTP 500' where property_id=$1 and provider='channex'`, [P]);
h = await health();
ok('a failed task turns red', h.channex.status === 'error' && h.channex.failed_jobs >= 1);

// ---------------------------------------------------------------- eZee import
console.log('\neZee import');
await as(OWNER);
const gi = (await one(`select pms_import_guests($1,$2::jsonb,'guests.csv') r`, [P, JSON.stringify([
  { first_name: 'Asha', last_name: 'Juma', phone: '+255 713 000 111', email: 'asha@example.com' },
  { first_name: 'Fred', last_name: 'Mutiso', phone: '0713-000-222' },
  { first_name: 'Asha', last_name: 'Juma', phone: '+255713000111' },
  { email: 'noname@example.com' },
])])).r;
ok('guests import, duplicates by phone skipped, bad rows reported', gi.imported === 2 && gi.skipped === 1 && gi.failed === 1 && gi.rows[3].message.includes('No name'));
await as(DESK);
ok('front desk cannot import', await fails(`select pms_import_guests($1,'[]'::jsonb)`, [P], 'cannot perform'));
await as(OWNER);
await db.query(`insert into pms_integrations(property_id,provider,enabled,config) values ($1,'fiscal',true,'{}') on conflict do nothing`, [P]);
const fiscalBefore = Number((await one(`select count(*) n from pms_fiscal_receipts where property_id=$1`, [P])).n);
const rows = [
  { ezee_no: '5001', first_name: 'Ritha', last_name: 'Ambonisye', phone: '+255754000333', arrival: '2026-10-09', departure: '2026-10-14', room: '333', rate: '200000', status: 'In House', balance: '350000' },
  { ezee_no: '5002', first_name: 'Joseph', last_name: 'Chitinka', arrival: '2026-10-20', departure: '2026-10-23', room_type: 'double', rate: '280000', deposit: '100000' },
  { ezee_no: '5003', first_name: 'Anna', arrival: '2026-10-25', departure: '2026-10-26', room_type: 'Suite' },
  { ezee_no: '5004', first_name: 'Old', arrival: '2026-10-01', departure: '2026-10-05', room_type: 'Single' },
  { ezee_no: '5005', first_name: 'Credit', arrival: '2026-10-11', departure: '2026-10-13', room: '334', status: 'checked in', balance: '-50000' },
];
const ri = (await one(`select pms_import_reservations($1,$2::jsonb,'ezee-arrivals.csv') r`, [P, JSON.stringify(rows)])).r;
ok('reservations: 3 imported, unknown room type and past stay rejected', ri.imported === 3 && ri.failed === 2, JSON.stringify(ri.rows));
ok('the error names the missing room type', ri.rows.find((x) => x.ref === '5003').message.includes('Suite'));
const ih = await one(`select s.status, s.arrival::text a, r.status rs, r.external_ref from pms_stays s join pms_reservations r on r.id=s.reservation_id where r.external_ref='ezee:5001'`);
ok('in-house guest keeps the eZee arrival date and is checked in', ih.status === 'checked_in' && ih.a === '2026-10-09' && ih.rs === 'checked_in');
const ihBal = await one(`select b.balance from pms_folio_balances b join pms_folios f on f.id=b.folio_id join pms_reservations r on r.id=f.reservation_id where r.external_ref='ezee:5001'`);
ok('their eZee balance is brought forward', Number(ihBal.balance) === 350000);
const crBal = await one(`select b.balance from pms_folio_balances b join pms_folios f on f.id=b.folio_id join pms_reservations r on r.id=f.reservation_id where r.external_ref='ezee:5005'`);
ok('a guest in credit keeps the credit', Number(crBal.balance) === -50000);
const dep = await one(`select b.balance, s.rate from pms_folio_balances b join pms_folios f on f.id=b.folio_id join pms_stays s on s.id=f.stay_id join pms_reservations r on r.id=f.reservation_id where r.external_ref='ezee:5002'`);
ok('future booking keeps its eZee rate and deposit', Number(dep.balance) === -100000 && Number(dep.rate) === 280000);
ok('imported money does not create new fiscal receipts', Number((await one(`select count(*) n from pms_fiscal_receipts where property_id=$1`, [P])).n) === fiscalBefore);
ok('a returning guest is matched by phone', Number((await one(`select count(*) n from pms_guests where property_id=$1 and last_name='Ambonisye'`, [P])).n) === 1);
const again = (await one(`select pms_import_reservations($1,$2::jsonb,'ezee-arrivals.csv') r`, [P, JSON.stringify(rows)])).r;
ok('running the same file again imports nothing twice', again.imported === 0 && again.skipped === 3);
ok('each run is recorded', Number((await one(`select count(*) n from pms_import_runs where property_id=$1`, [P])).n) === 3);
ok('room 333 is now occupied for the overlap check', await fails(`select pms_create_reservation($1,'{"first_name":"X"}'::jsonb,'2026-10-12','2026-10-13',$2::jsonb)`, [P, JSON.stringify([{ room_id: await room('333') }])]));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
