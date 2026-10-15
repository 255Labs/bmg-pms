// Occupancy audit test: one hotel day in Dar es Salaam with camera sightings, door openings, check-ins,
// check-outs and payments, then the findings, their reports and clearing them. Run: node tests/audit.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra); } };

const db = new PGlite({ extensions: { btree_gist }, parsers: { 1082: (v) => v } });
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

const OWNER = '50000000-0000-0000-0000-000000000001', DESK = '50000000-0000-0000-0000-000000000002', ACC = '50000000-0000-0000-0000-000000000003';
await db.exec(`insert into auth.users values ('${OWNER}','gm@uh.tz'),('${DESK}','desk@uh.tz'),('${ACC}','acc@uh.tz')`);
const as = (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`);
const val = async (sql, p = []) => Object.values((await db.query(sql, p)).rows[0] ?? {})[0];
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const err = async (sql, p = []) => { try { await db.query(sql, p); return ''; } catch (e) { return String(e.message); } };
const J = (x) => JSON.stringify(x);

await as(OWNER);
const P = await val(`select pms_create_property('Unreal Homes','UH','GM',$1::jsonb)`, [J([{ name: 'Room', base_rate: 150000, rooms: ['101', '102', '103', '104', '105', '106', '107'] }])]);
await db.query(`select pms_set_member($1,'desk@uh.tz','front_desk','Desk')`, [P]);
await db.query(`select pms_set_member($1,'acc@uh.tz','accountant','Accounts')`, [P]);
await as(null);
const room = {};
for (const r of await q(`select id, number from pms_rooms where property_id=$1`, [P])) room[r.number] = r.id;
const RT = await val(`select id from pms_room_types where property_id=$1`, [P]);
await db.query(`update pms_properties set business_date='2026-10-11' where id=$1`, [P]);

// people, bookings and money (written straight in, as the front desk screens would have done)
let resNo = 100, folioNo = 500;
const stay = async (num, arrival, departure, status, cin, cout, { rate = 150000, company = false } = {}) => {
  const g = await val(`insert into pms_guests(property_id, first_name, last_name) values ($1,'Guest',$2) returning id`, [P, num]);
  const co = company ? await val(`insert into pms_companies(property_id, name) values ($1,'Acme Ltd') returning id`, [P]) : null;
  const r = await val(`insert into pms_reservations(property_id, res_no, guest_id, arrival, departure, status, company_id) values ($1,$2,$3,$4,$5,'confirmed',$6) returning id`, [P, ++resNo, g, arrival, departure, co]);
  const s = await val(`insert into pms_stays(property_id, reservation_id, room_type_id, room_id, arrival, departure, rate, status, checked_in_at, checked_out_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [P, r, RT, room[num], arrival, departure, rate, status, cin, cout]);
  const f = await val(`insert into pms_folios(property_id, folio_no, reservation_id, stay_id, guest_id) values ($1,$2,$3,$4,$5) returning id`, [P, ++folioNo, r, s, g]);
  return { s, f };
};
const line = (f, type, amount, day = '2026-10-10') => db.query(`insert into pms_folio_lines(property_id, folio_id, line_type, category, description, amount, business_date, payment_method)
  values ($1,$2,$3,$4,$5,$6,$7,$8)`, [P, f, type, type === 'charge' ? 'room' : 'payment', type, amount, day, type === 'payment' ? 'cash' : null]);

const s101 = await stay('101', '2026-10-09', '2026-10-11', 'checked_in', '2026-10-09T14:05:00+03:00', null);
await line(s101.f, 'charge', 150000, '2026-10-09'); await line(s101.f, 'payment', -150000, '2026-10-09');
const s103 = await stay('103', '2026-10-10', '2026-10-12', 'confirmed', null, null);
const s104 = await stay('104', '2026-10-10', '2026-10-11', 'checked_in', '2026-10-10T20:00:00+03:00', null);
await line(s104.f, 'payment', -150000);
const s105 = await stay('105', '2026-10-08', '2026-10-10', 'checked_out', '2026-10-08T13:00:00+03:00', '2026-10-10T10:00:00+03:00');
await line(s105.f, 'charge', 300000, '2026-10-09'); await line(s105.f, 'payment', -250000, '2026-10-10');
const s107 = await stay('107', '2026-10-08', '2026-10-12', 'checked_in', '2026-10-08T15:00:00+03:00', null);
await line(s107.f, 'charge', 150000, '2026-10-08'); await line(s107.f, 'charge', 150000, '2026-10-09');
const s106c = await stay('106', '2026-10-05', '2026-10-09', 'checked_out', '2026-10-05T14:00:00+03:00', '2026-10-09T09:00:00+03:00', { company: true });
await line(s106c.f, 'charge', 600000, '2026-10-08');
await db.query(`insert into pms_stay_passcodes(property_id, stay_id, room_id, lock_id, passcode, valid_from, valid_to, status) values ($1,$2,$3,'5101','482915','2026-10-09T14:00:00+03:00','2026-10-11T11:00:00+03:00','issued')`, [P, s101.s, room['101']]);

// integrations: locks on every room, cameras on room doors and the entrance; housekeeping's code is staff
await db.query(`insert into pms_integrations(property_id, provider, enabled, config) values ($1,'ttlock',true,'{"staff_usernames":["hk.asha"]}'),($1,'hikvision',true,'{}'),($1,'sms',true,'{}')`, [P]);
for (const n of Object.keys(room)) await db.query(`insert into pms_external_ids(property_id, provider, entity, entity_id, external_id) values ($1,'ttlock','room',$2,$3)`, [P, room[n], '5' + n]);
await db.query(`insert into pms_external_ids(property_id, provider, entity, entity_id, external_id) values ($1,'hikvision','room',$2,'2')`, [P, room['102']]);
await db.exec(readFileSync(join(root, 'supabase/migrations/26_occupancy_audit.sql'), 'utf8'));   // re-run: old room mappings become zones
ok('room mappings made before zones become room zones', (await val(`select count(*) from pms_camera_zones where property_id=$1 and channel='2' and kind='room' and room_id=$2`, [P, room['102']])) == 1);
await db.query(`insert into pms_camera_zones(property_id, device, channel, name, kind, room_id) values
  ($1,'',  '5','Room 105 door','room',$2), ($1,'','6','Room 106 door','room',$3), ($1,'08:cc:81:16:ff:14','9','Front entrance','entrance',null)`, [P, room['105'], room['106']]);
ok('a room zone must name its room, other zones must not', (await err(`insert into pms_camera_zones(property_id, channel, name, kind) values ($1,'7','Bad','room')`, [P])).includes('check'));

const door = (n, t, username, method = 'passcode', id = Math.random()) => ({ record_id: String(id), lock_id: '5' + n, time_ms: Date.parse(t), record_type: 4, method, success: true, username });
await db.query(`select pms_svc_ingest_door_events($1,$2::jsonb)`, [P, J([
  door('101', '2026-10-10T09:00:00+03:00', '482915'),                // the guest, with the code the PMS issued
  door('102', '2026-10-10T23:12:00+03:00', '111222'),                // nobody booked; a code the PMS never issued
  door('103', '2026-10-10T15:00:00+03:00', '777888'),                // the booking was never checked in
  door('104', '2026-10-10T14:00:00+03:00', 'Mr Four', 'card'),       // six hours before check-in
  door('106', '2026-10-10T11:00:00+03:00', 'hk.asha', 'card'),       // housekeeping
])]);
const cam = (device, channel, time, target = 'human', extra = {}) => ({ device, channel, event_type: 'vmd', time, target, hits: 4, ended: null, ...extra });
const stored = await val(`select pms_svc_ingest_camera_events($1,$2::jsonb)`, [P, J([
  cam('08:cc:81:16:ff:14', '2', '2026-10-10T23:10:00+03:00'),        // person at room 102 (vacant)
  cam('08:cc:81:16:ff:14', '2', '2026-10-10T23:40:00+03:00', 'vehicle'),
  cam('', '5', '2026-10-10T15:00:00+03:00', 'human', { ended: '2026-10-10T15:00:40+03:00' }),   // room 105, five hours after check-out
  cam('', '6', '2026-10-10T11:04:00+03:00'),                         // room 106, just after housekeeping opened it
  cam('08:cc:81:16:ff:14', '9', '2026-10-10T08:00:00+03:00'), cam('08:cc:81:16:ff:14', '9', '2026-10-10T12:00:00+03:00'), cam('08:cc:81:16:ff:14', '9', '2026-10-10T19:30:00+03:00'),
])]);
ok('sightings are stored once each, with their zone and room', stored === 7 && (await val(`select count(*) from pms_camera_events where property_id=$1 and zone_id is not null`, [P])) == 7);
ok('a vehicle is kept but not counted as a person', (await val(`select person from pms_camera_events where target='vehicle'`)) === false);
ok('the entrance camera has no room', (await val(`select count(*) from pms_camera_events c join pms_camera_zones z on z.id=c.zone_id where z.kind='entrance' and c.room_id is null`)) == 3);

console.log('Running the audit');
await as(OWNER);
await db.query(`select pms_audit_settings($1,'{"alert_phones":["0754000111"]}'::jsonb)`, [P]);
await db.query(`select pms_audit_run($1,'2026-10-10','2026-10-10')`, [P]);
const F = async () => q(`select f.*, r.number from pms_audit_findings f left join pms_rooms r on r.id=f.room_id where f.property_id=$1 order by r.number, f.kind`, [P]);
let fs = await F();
const has = (num, kind) => fs.find((f) => f.number === num && f.kind === kind);
ok('room 101: the guest with the code the PMS issued, paid up: nothing to see', !fs.some((f) => f.number === '101'), J(fs.map((f) => [f.number, f.kind])));
ok('room 102: a person and a door code with nobody booked in → used while vacant (high)', has('102', 'used_while_vacant')?.severity === 'high'
  && has('102', 'used_while_vacant').evidence.people_seen === 1 && has('102', 'used_while_vacant').evidence.door_opens === 1);
ok('…the vehicle is not counted as a person', has('102', 'used_while_vacant').evidence.people_seen === 1);
ok('…the code was never issued by the PMS → unknown code', has('102', 'unknown_code')?.evidence.codes?.[0] === '111222');
ok('…at risk: one night at the room rate', Number(has('102', 'used_while_vacant').amount_at_risk) === 150000);
ok('room 103: the door opened but the booking was never checked in', has('103', 'not_checked_in')?.stay_id === s103.s);
ok('room 104: opened six hours before check-in', has('104', 'before_check_in')?.severity === 'medium');
ok('room 105: a person five hours after check-out', has('105', 'after_check_out')?.stay_id === s105.s);
ok('…and checked out owing 50,000', Number(has('105', 'checked_out_unpaid')?.amount_at_risk) === 50000 && has('105', 'checked_out_unpaid').severity === 'high');
ok('room 106: housekeeping\'s code and the person seen just after are staff, not a finding', !fs.some((f) => f.number === '106' && f.kind !== 'checked_out_unpaid'));
ok('…and the company stay that left owing is not flagged (billed to the company)', !fs.some((f) => f.number === '106'));
ok('room 107: in house two nights with nothing paid', Number(has('107', 'in_house_unpaid')?.amount_at_risk) === 300000);
ok('…and no door or camera activity all day', has('107', 'occupied_no_activity')?.severity === 'low');
ok('the titles say it plainly', has('102', 'used_while_vacant').title === 'Room 102: used while no guest was booked in');
const sms = Number(await val(`select count(*) from pms_sms_out where property_id=$1 and kind='audit_alert'`, [P]));
const highs = fs.filter((f) => f.severity === 'high').length;
ok('each new high finding texts the managers on the alert list', sms === highs && highs === 5, `${sms} sms, ${highs} high`);

console.log('Running it again');
const before = fs.length;
await db.query(`select pms_audit_run($1,'2026-10-10','2026-10-10')`, [P]);
fs = await F();
ok('re-running finds the same things, no duplicates and no second text', fs.length === before && Number(await val(`select count(*) from pms_sms_out where kind='audit_alert'`)) === sms);

console.log('Fixing and clearing');
await as(null);
await db.query(`update pms_stays set status='checked_in', checked_in_at='2026-10-10T14:50:00+03:00' where id=$1`, [s103.s]);
await line(s105.f, 'payment', -50000, '2026-10-11');
await as(OWNER);
await db.query(`select pms_audit_run($1,'2026-10-10','2026-10-10')`, [P]);
fs = await F();
ok('checked in at 14:50 after all: the 15:00 opening is explained and the finding goes', !has('103', 'not_checked_in'));
ok('the balance paid the next day: the money finding goes', !has('105', 'checked_out_unpaid') && !!has('105', 'after_check_out'));
await as(DESK);
const F102 = has('102', 'used_while_vacant').id;
ok('the front desk cannot clear findings', (await err(`select pms_audit_resolve($1,'false_alarm','looks fine')`, [F102])).length > 0);
ok('…nor read the timeline', (await err(`select * from pms_audit_timeline($1,$2,'2026-10-10')`, [P, room['102']])).length > 0);
await as(OWNER);
ok('clearing needs a reason', (await err(`select pms_audit_resolve($1,'loss','')`, [F102])).includes('Say what was found'));
await db.query(`select pms_audit_resolve($1,'charged','Walk-in at night, posted 150,000 to folio and collected cash')`, [F102]);
await db.query(`select pms_audit_run($1,'2026-10-10','2026-10-10')`, [P]);
const after = (await q(`select * from pms_audit_findings where id=$1`, [F102]))[0];
ok('a cleared finding keeps its outcome when the audit runs again', after.status === 'charged' && after.resolved_by === OWNER && /Walk-in/.test(after.resolution));
ok('clearing is in the audit trail', (await val(`select count(*) from pms_audit_log where property_id=$1 and action='audit.charged'`, [P])) == 1);

console.log('Reports');
const tl = await q(`select * from pms_audit_timeline($1,$2,'2026-10-10')`, [P, room['105']]);
ok('timeline for room 105: checked out, then a person seen five hours later for 40 s', tl[0].what === 'Checked out' && tl.some((x) => x.what === 'Person seen' && /40 s/.test(x.detail)));
const daily = (await q(`select * from pms_rpt_audit_daily($1,'2026-10-10','2026-10-10')`, [P]))[0];
ok('daily: 3 people at the entrance, 4 guest door openings, people in 2 rooms', daily.entrance_people === 3 && daily.guest_door_opens === 4 && daily.people_in_rooms === 2, J(daily));
ok('daily: rooms sold and rooms used', daily.rooms_occupied === 4 && daily.rooms_with_activity === 5, J(daily));
ok('daily: findings, high ones, still open, and money at risk', daily.findings === fs.length && daily.high >= 2 && daily.open_findings === fs.length - 1, J(daily));
const sum = await q(`select * from pms_rpt_audit_summary($1,'2026-10-01','2026-10-31')`, [P]);
ok('summary by kind and outcome', sum.find((s) => s.kind === 'used_while_vacant').charged === 1 && sum.reduce((n, s) => n + s.found, 0) === fs.length);
await as(ACC);
ok('the accountant can read the reports', (await q(`select * from pms_rpt_audit_daily($1,'2026-10-10','2026-10-10')`, [P])).length === 1);
ok('…but not clear findings', (await err(`select pms_audit_resolve($1,'open',null)`, [F102])).length > 0);

console.log('Settings and the package');
await as(OWNER);
ok('allowances are checked', (await err(`select pms_audit_settings($1,'{"late_minutes":"lots"}'::jsonb)`, [P])).includes('whole number'));
await db.query(`select pms_audit_settings($1,'{"late_minutes":360}'::jsonb)`, [P]);
await db.query(`select pms_audit_run($1,'2026-10-10','2026-10-10')`, [P]);
ok('with six hours allowed after check-out, room 105\'s visitor at 15:00 is no longer flagged', !(await F()).some((f) => f.number === '105' && f.kind === 'after_check_out'));
await as(null);
await db.query(`update pms_property_addons set enabled=false where property_id=$1 and key='revenue_assurance'`, [P]);
await as(OWNER);
ok('without the revenue assurance add-on the audit does not run', (await err(`select pms_audit_run($1,'2026-10-10','2026-10-10')`, [P])).includes('not part'));
await as(null);
ok('the scheduled run skips it too', (await val(`select pms__audit_run_all()`)) === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
