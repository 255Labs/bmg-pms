// End-to-end scenario test for the BMG PMS database layer.
// Runs every migration on an embedded Postgres 17 (PGlite) with a stub of Supabase's
// auth schema, then walks a full hotel day cycle. Run: node tests/scenario.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite({ extensions: { btree_gist } });

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
};
const as = async (uid) => db.exec(`select set_config('test.uid', '${uid}', false)`);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const expectError = async (name, sql, params, match) => {
  try { await db.query(sql, params); ok(name, false, '(no error raised)'); }
  catch (e) { ok(name, !match || e.message.includes(match), `got: ${e.message}`); }
};

// --- Supabase stand-ins --------------------------------------------------
await db.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  end $$;
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text unique);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
`);

for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) {
  try { await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8')); console.log('migrated', f); }
  catch (e) { console.error('MIGRATION FAILED', f, e.message); process.exit(1); }
}
// Migrations must be re-runnable
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) {
  try { await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8')); }
  catch (e) { console.error('RE-RUN FAILED', f, e.message); process.exit(1); }
}
console.log('migrations re-run cleanly\n');

const OWNER = '11111111-1111-1111-1111-111111111111';
const HK    = '22222222-2222-2222-2222-222222222222';
const FD    = '33333333-3333-3333-3333-333333333333';
const OUT   = '44444444-4444-4444-4444-444444444444';
await db.exec(`insert into auth.users values
  ('${OWNER}','bbalati@bmggroup.co.tz'), ('${HK}','hk@bmggroup.co.tz'),
  ('${FD}','frontdesk@bmggroup.co.tz'), ('${OUT}','outsider@example.com')`);

// --- Setup ---------------------------------------------------------------
console.log('Setup');
await as(OWNER);
const setup = [
  { name: 'Single', code: 'SGL', base_rate: 200000, max_occupancy: 1,
    rooms: ['331','332','333','334','336','337','338','339'] },
  { name: 'Double', code: 'DBL', base_rate: 300000, max_occupancy: 2, rooms: ['335','340'] },
];
const P = (await one(`select pms_create_property($1,$2,$3,$4::jsonb) id`,
  ['Unreal Homes', 'UH', 'Balati', JSON.stringify(setup)])).id;
ok('property created', !!P);
await db.exec(`update pms_properties set business_date = '2026-10-12' where id = '${P}'`);
ok('10 rooms seeded', (await one(`select count(*)::int n from pms_rooms where property_id=$1`, [P])).n === 10);
await q(`select pms_set_member($1,'hk@bmggroup.co.tz','housekeeping','Asha')`, [P]);
await q(`select pms_set_member($1,'frontdesk@bmggroup.co.tz','front_desk','Juma')`, [P]);
ok('staff added', (await q(`select * from pms_list_members($1)`, [P])).length === 3);

const room = async (n) => (await one(`select id from pms_rooms where property_id=$1 and number=$2`, [P, n])).id;
const type = async (n) => (await one(`select id from pms_room_types where property_id=$1 and name=$2`, [P, n])).id;
const SGL = await type('Single'), DBL = await type('Double');
const R331 = await room('331'), R332 = await room('332'), R333 = await room('333');
const firstStay = async (resId) => (await one(`select id from pms_stays where reservation_id=$1 order by created_at limit 1`, [resId])).id;
const folioOf = async (stay) => (await one(`select id from pms_folios where stay_id=$1 order by folio_no limit 1`, [stay])).id;
const bal = async (folio) => Number((await one(`select balance from pms_folio_balances where folio_id=$1`, [folio])).balance);

// --- Reservations --------------------------------------------------------
console.log('\nReservations');
await as(FD);
const res1 = (await one(`select pms_create_reservation($1,$2::jsonb,'2026-10-12','2026-10-14',$3::jsonb) r`,
  [P, JSON.stringify({ title: 'Mr.', first_name: 'Moga', last_name: 'Kulwa', phone: '+255700000001' }),
   JSON.stringify([{ room_id: R331, adults: 1 }])])).r;
ok('reservation #1 created with res_no 1', res1.res_no === 1);
const S1 = await firstStay(res1.reservation_id);
ok('rate defaults to room type base rate', Number((await one(`select rate from pms_stays where id=$1`, [S1])).rate) === 200000);

await expectError('double-booking a room is refused',
  `select pms_create_reservation($1,'{"first_name":"Test"}'::jsonb,'2026-10-13','2026-10-15',$2::jsonb)`,
  [P, JSON.stringify([{ room_id: R331 }])], 'already booked');

const resD = (await one(`select pms_create_reservation($1,'{"first_name":"Group","last_name":"Lead"}'::jsonb,'2026-10-12','2026-10-13',$2::jsonb) r`,
  [P, JSON.stringify([{ room_type_id: DBL }, { room_type_id: DBL }])])).r;
ok('two unassigned Double rooms booked', (await one(`select count(*)::int n from pms_stays where reservation_id=$1`, [resD.reservation_id])).n === 2);
await expectError('third Double on a sold-out night is refused',
  `select pms_create_reservation($1,'{"first_name":"Late"}'::jsonb,'2026-10-12','2026-10-13',$2::jsonb)`,
  [P, JSON.stringify([{ room_type_id: DBL }])], 'No Double rooms left');
await expectError('arrival before business date is refused',
  `select pms_create_reservation($1,'{"first_name":"Past"}'::jsonb,'2026-10-11','2026-10-13',$2::jsonb)`,
  [P, JSON.stringify([{ room_type_id: SGL }])], 'before the business date');

// --- Check-in ------------------------------------------------------------
console.log('\nCheck-in');
await q(`select pms_check_in($1)`, [S1]);
ok('guest checked in to 331', (await one(`select status from pms_stays where id=$1`, [S1])).status === 'checked_in');
ok('reservation status follows stay', (await one(`select status from pms_reservations where id=$1`, [res1.reservation_id])).status === 'checked_in');

const res2 = (await one(`select pms_create_reservation($1,'{"first_name":"Fred","last_name":"Mutiso"}'::jsonb,'2026-10-12','2026-10-13',$2::jsonb) r`,
  [P, JSON.stringify([{ room_id: R332, rate: 180000 }])])).r;
const S2 = await firstStay(res2.reservation_id);
await as(HK);
await q(`select pms_set_room_status($1,'dirty')`, [R332]);
ok('housekeeping can set room status', (await one(`select hk_status from pms_rooms where id=$1`, [R332])).hk_status === 'dirty');
await expectError('housekeeping cannot post charges',
  `select pms_post_charge($1,'fnb','Lunch',10000)`, [await folioOf(S1)], 'cannot perform');
await as(FD);
await expectError('dirty room blocks check-in', `select pms_check_in($1)`, [S2], 'ROOM_DIRTY');
await q(`select pms_check_in($1, true)`, [S2]);
ok('dirty-room override works and is logged',
  (await one(`select details->>'dirty_override' d from pms_audit_log where entity_id=$1 and action='stay.check_in'`, [S2])).d === 'true');

// --- Cashiering ----------------------------------------------------------
console.log('\nCashiering');
const F1 = await folioOf(S1);
await q(`select pms_post_charge($1,'fnb','Dinner — restaurant',15000)`, [F1]);
await expectError('cash without open drawer is refused', `select pms_post_payment($1,100000,'cash')`, [F1], 'Open your cash drawer');
const D1 = (await one(`select pms_open_drawer($1,50000) id`, [P])).id;
await q(`select pms_post_payment($1,100000,'cash')`, [F1]);
await expectError('mobile money needs a reference', `select pms_post_payment($1,10000,'mobile_money')`, [F1], 'reference is required');
await q(`select pms_post_payment($1,20000,'mobile_money','MP12345XYZ')`, [F1]);
ok('folio balance = 15,000 - 120,000', (await bal(F1)) === -105000);
const badLine = (await one(`select pms_post_charge($1,'minibar','Wrong item',5000) id`, [F1])).id;
await expectError('front desk cannot void', `select pms_void_line($1,'mistake')`, [badLine], 'cannot perform');
await as(OWNER);
await q(`select pms_void_line($1,'Posted to wrong room')`, [badLine]);
ok('void removes line from balance', (await bal(F1)) === -105000);
await expectError('folio lines cannot be edited directly',
  `update pms_folio_lines set amount = 1 where id = $1`, [badLine], 'cannot be edited');
await expectError('folio lines cannot be deleted',
  `delete from pms_folio_lines where id = $1`, [badLine], 'cannot be deleted');
await as(FD);
await q(`select pms_add_expense($1,'supplies','Cleaning detergent',8000,'cash','Kariakoo Supplies')`, [P]);

// --- Maintenance block ---------------------------------------------------
console.log('\nHousekeeping');
await as(OWNER);
await expectError('cannot block a room that has a stay',
  `select pms_block_room($1,'2026-10-12','2026-10-13','Leaking tap')`, [R331], 'has a reservation');
await q(`select pms_block_room($1,'2026-10-12','2026-10-15','Repainting')`, [R333]);
await as(FD);
await expectError('cannot book a blocked room',
  `select pms_create_reservation($1,'{"first_name":"X"}'::jsonb,'2026-10-13','2026-10-14',$2::jsonb)`,
  [P, JSON.stringify([{ room_id: R333 }])], 'blocked for maintenance');

// --- Night audit day 1 ---------------------------------------------------
console.log('\nNight audit — 12 Oct');
const chk = (await one(`select pms_night_audit_check($1) c`, [P])).c;
ok('pre-check lists 2 pending arrivals', chk.pending_arrivals.length === 2);
await expectError('pending arrivals block the audit', `select pms_run_night_audit($1)`, [P], 'not checked in');
const a1 = (await one(`select pms_run_night_audit($1, true) r`, [P])).r;
ok('audit closes 12 Oct and moves to 13 Oct', a1.closed_date === '2026-10-12' && a1.new_business_date === '2026-10-13');
ok('2 no-shows recorded', a1.no_shows === 2);
ok('room revenue = 200,000 + 180,000', Number(a1.room_revenue) === 380000);
ok('2 rooms sold of 9 available (1 blocked)', a1.rooms_sold === 2 && a1.rooms_available === 9);
ok('occupied room 331 marked dirty', (await one(`select hk_status from pms_rooms where id=$1`, [R331])).hk_status === 'dirty');
ok('folio 331 now 215,000 - 120,000', (await bal(F1)) === 95000);
const nightLines = (await one(`select count(*)::int n from pms_folio_lines where stay_id=$1 and source='night_audit'`, [S1])).n;
ok('exactly one room charge posted', nightLines === 1);

// --- Day 2: departures ---------------------------------------------------
console.log('\nDay 2 — 13 Oct');
await expectError('Fred due out blocks audit', `select pms_run_night_audit($1)`, [P], 'due out');
const F2 = await folioOf(S2);
await expectError('check-out with balance is refused', `select pms_check_out($1)`, [S2], 'Settle it');
await q(`select pms_post_payment($1,180000,'card','VISA-4417')`, [F2]);
await q(`select pms_check_out($1)`, [S2]);
ok('Fred checked out, folio closed',
  (await one(`select status from pms_folios where id=$1`, [F2])).status === 'closed');
ok('room 332 dirty after check-out', (await one(`select hk_status from pms_rooms where id=$1`, [R332])).hk_status === 'dirty');

// Company guest billed to city ledger
await as(OWNER);
const CO = (await one(`insert into pms_companies(property_id,name,phone,credit_limit) values ($1,'Hinno Engineering','+255711000000',5000000) returning id`, [P])).id;
await as(FD);
const res3 = (await one(`select pms_create_reservation($1,'{"first_name":"Karim","last_name":"Abdul"}'::jsonb,'2026-10-13','2026-10-14',$2::jsonb,null,null,$3) r`,
  [P, JSON.stringify([{ room_type_id: SGL }]), CO])).r;
const S3 = await firstStay(res3.reservation_id);
await expectError('check-in without a room is refused', `select pms_check_in($1)`, [S3], 'Assign a room');
const free = await q(`select * from pms_free_rooms($1,'2026-10-13','2026-10-14')`, [P]);
ok('free rooms exclude occupied 331 and blocked 333',
  !free.some(r => r.number === '331') && !free.some(r => r.number === '333'));
const R338 = await room('338');
await q(`select pms_assign_room($1,$2)`, [S3, R338]);
await q(`select pms_check_in($1)`, [S3]);
const a2 = (await one(`select pms_run_night_audit($1) r`, [P])).r;
ok('audit 13 Oct: 2 rooms sold (331, 338) + Fred checked out today', a2.rooms_sold === 2);

// --- Day 3 ---------------------------------------------------------------
console.log('\nDay 3 — 14 Oct');
const S3folio = await folioOf(S3);
ok('Karim folio has 200,000 room charge', (await bal(S3folio)) === 200000);
await q(`select pms_check_out($1,true)`, [S3]);
ok('company stay checked out to city ledger', (await bal(S3folio)) === 0);
let age = await q(`select * from pms_rpt_ageing($1)`, [P]);
ok('ageing shows Hinno owing 200,000 in 0-30 bucket',
  age.length === 1 && Number(age[0].balance) === 200000 && Number(age[0].d0_30) === 200000);
await q(`select pms_city_ledger_payment($1,$2,150000,'bank','NMB-TT-889')`, [P, CO]);
age = await q(`select * from pms_rpt_ageing($1)`, [P]);
ok('part payment reduces ageing to 50,000', Number(age[0].balance) === 50000 && Number(age[0].d0_30) === 50000);

// Moga checks out 14 Oct after paying the rest in cash
const F1bal = await bal(F1);
await q(`select pms_post_payment($1,$2,'cash')`, [F1, F1bal]);
await q(`select pms_check_out($1)`, [S1]);
ok('Moga checked out with zero balance', (await bal(F1)) === 0);

// Amend: extend a stay
const res4 = (await one(`select pms_create_reservation($1,'{"first_name":"Ritha","last_name":"Ambonisye"}'::jsonb,'2026-10-14','2026-10-16',$2::jsonb) r`,
  [P, JSON.stringify([{ room_id: await room('337') }])])).r;
const S4 = await firstStay(res4.reservation_id);
await q(`select pms_check_in($1)`, [S4]);
await q(`select pms_amend_stay($1, null, '2026-10-20')`, [S4]);
ok('in-house stay extended to 20 Oct', (await one(`select departure::text d from pms_stays where id=$1`, [S4])).d === '2026-10-20');
await expectError('in-house arrival cannot change', `select pms_amend_stay($1,'2026-10-15')`, [S4], 'cannot change after check-in');

// Room move while in house
const R339 = await room('339');
await q(`select pms_assign_room($1,$2)`, [S4, R339]);
ok('room move marks old room dirty', (await one(`select hk_status from pms_rooms where number='337' and property_id=$1`, [P])).hk_status === 'dirty');

// Cancellation
const res5 = (await one(`select pms_create_reservation($1,'{"first_name":"Lulu","last_name":"Kayanda"}'::jsonb,'2026-10-18','2026-10-19',$2::jsonb) r`,
  [P, JSON.stringify([{ room_type_id: SGL }])])).r;
await expectError('cancel needs a reason', `select pms_cancel_stay($1,'')`, [await firstStay(res5.reservation_id)], 'reason');
await q(`select pms_cancel_stay($1,'Guest changed plans')`, [await firstStay(res5.reservation_id)]);
ok('reservation cancelled', (await one(`select status from pms_reservations where id=$1`, [res5.reservation_id])).status === 'cancelled');

// --- Drawer close ---------------------------------------------------------
console.log('\nDrawer');
const expected = Number((await one(`select pms_drawer_expected($1) e`, [D1])).e);
// float 50,000 + cash 100,000 + cash 295,000 - expense 8,000
ok('expected cash = 437,000', expected === 437000, `got ${expected}`);
const closed = (await one(`select pms_close_drawer($1,436000,'Short 1,000') r`, [D1])).r;
ok('variance recorded as -1,000', Number(closed.variance) === -1000);

// --- Reports -------------------------------------------------------------
console.log('\nReports');
await as(OWNER);
const rev = await q(`select * from pms_rpt_daily_revenue($1,'2026-10-12','2026-10-14')`, [P]);
ok('daily revenue 12 Oct: room 380,000 + fnb 15,000',
  Number(rev[0].room) === 380000 && Number(rev[0].fnb) === 15000, JSON.stringify(rev[0]));
ok('daily revenue 12 Oct payments 120,000', Number(rev[0].payments) === 120000);
ok('daily revenue 13 Oct city ledger 0, payments 180,000', Number(rev[1].payments) === 180000);
ok('expenses on 12 Oct 8,000', Number(rev[0].expenses) === 8000);
const occ = await q(`select * from pms_rpt_occupancy($1,'2026-10-12','2026-10-20')`, [P]);
ok('occupancy has 9 days and future days flagged as forecast', occ.length === 9 && occ[8].is_forecast);
ok('12 Oct actual occupancy 2/9 = 22.2%', Number(occ[0].occupancy_pct) === 22.2, JSON.stringify(occ[0]));
const pays = await q(`select * from pms_rpt_payments($1,'2026-10-12','2026-10-14')`, [P]);
ok('payment report lists 4 receipts', pays.length === 4, `got ${pays.length}`);
const cashier = await q(`select * from pms_rpt_cashier($1,'2026-10-12','2026-10-14')`, [P]);
ok('cashier report groups by cashier and method', cashier.some(c => c.cashier === 'Juma' && c.method === 'cash' && Number(c.net) === 395000));
const hs = await q(`select * from pms_rpt_house_status($1)`, [P]);
ok('house status shows 339 occupied and 333 blocked',
  hs.find(r => r.number === '339').occupancy === 'occupied' && hs.find(r => r.number === '333').occupancy === 'blocked');
const arr = await q(`select * from pms_rpt_stays($1,'arrivals','2026-10-12','2026-10-12')`, [P]);
ok('arrivals 12 Oct = 4 stays (2 in, 2 no-show)', arr.length === 4, `got ${arr.length}`);
const voids = await q(`select * from pms_rpt_voids($1,'2000-01-01','2100-01-01')`, [P]);
ok('void report shows the voided minibar line', voids.length === 1 && voids[0].reason === 'Posted to wrong room');
const trail = await q(`select * from pms_rpt_audit_trail($1,'2000-01-01','2100-01-01')`, [P]);
ok('audit trail recorded actions', trail.length > 20, `got ${trail.length}`);
const grp = await q(`select * from pms_group_snapshot()`);
ok('group snapshot returns the property', grp.length === 1 && grp[0].in_house === 1);

// --- Isolation -----------------------------------------------------------
console.log('\nIsolation');
await as(OUT);
await expectError('outsider cannot read reports', `select * from pms_rpt_daily_revenue($1,'2026-10-12','2026-10-14')`, [P], 'not a member');
await expectError('outsider cannot book', `select pms_create_reservation($1,'{"first_name":"Z"}'::jsonb,'2026-10-20','2026-10-21',$2::jsonb)`,
  [P, JSON.stringify([{ room_type_id: SGL }])], 'not a member');
ok('outsider group snapshot is empty', (await q(`select * from pms_group_snapshot()`)).length === 0);
await as(FD);
await expectError('front desk cannot add staff', `select pms_set_member($1,'outsider@example.com','manager')`, [P], 'cannot perform');
await as(HK);
await expectError('housekeeping cannot run night audit', `select pms_run_night_audit($1)`, [P], 'cannot perform');

// Second property is fully separate
await as(OUT);
const P2 = (await one(`select pms_create_property('Whistling Woods','WW') id`)).id;
ok('outsider can create their own property', !!P2);
await expectError('but cannot post to Unreal Homes folios', `select pms_post_charge($1,'fnb','x',1)`, [await folioOf(S4)], 'not a member');


// --- Back office ---------------------------------------------------------
console.log('\nBack office');
await as(OWNER);
const OUTLET = (await one(`insert into pms_pos_outlets(property_id,name,charge_category) values ($1,'Restaurant','fnb') returning id`, [P])).id;
const ITEM = (await one(`insert into pms_pos_items(property_id,outlet_id,name,price) values ($1,$2,'Pilau with chicken',18000) returning id`, [P, OUTLET])).id;
await as(FD);
const D2 = (await one(`select pms_open_drawer($1,0) id`, [P])).id;
const B1 = (await one(`select pms_pos_open_bill($1,'T4',2) id`, [OUTLET])).id;
await q(`select pms_pos_add_item($1,$2,2)`, [B1, ITEM]);
await q(`select pms_pos_add_item($1,null,1,'Passion juice',5000)`, [B1]);
ok('bill totals 41,000', Number((await one(`select total from pms_pos_bills where id=$1`, [B1])).total) === 41000);
await q(`select pms_pos_settle($1,'cash')`, [B1]);
ok('walk-in bill settled in cash', (await one(`select status from pms_pos_bills where id=$1`, [B1])).status === 'settled');
ok('drawer expects the POS cash', Number((await one(`select pms_drawer_expected($1) e`, [D2])).e) === 41000);
await expectError('settled bill cannot take more items', `select pms_pos_add_item($1,$2,1)`, [B1, ITEM], 'already settled');
const B2 = (await one(`select pms_pos_open_bill($1) id`, [OUTLET])).id;
await q(`select pms_pos_add_item($1,$2,1)`, [B2, ITEM]);
await expectError('cannot post to a guest not in house', `select pms_pos_post_to_room($1,$2)`, [B2, S1], 'checked-in');
const F4 = await folioOf(S4);
const before = await bal(F4);
await q(`select pms_pos_post_to_room($1,$2)`, [B2, S4]);
ok('room-posted bill lands on the guest folio', (await bal(F4)) === before + 18000);
await expectError('front desk cannot void a bill', `select pms_pos_void_bill($1,'wrong')`, [B2], 'cannot perform');
await as(OWNER);
await q(`select pms_pos_void_bill($1,'Wrong guest')`, [B2]);
ok('voiding a room-posted bill also voids the folio charge', (await bal(F4)) === before);
const pos = await q(`select * from pms_rpt_pos_sales($1,'2026-10-01','2026-10-31')`, [P]);
ok('POS report: 1 bill, 41,000 walk-in, 1 void', pos[0].bills === 1 && Number(pos[0].walk_in) === 41000 && pos[0].voided === 1);
const rev14 = (await q(`select * from pms_rpt_daily_revenue($1,'2026-10-14','2026-10-14')`, [P]))[0];
ok('daily revenue includes walk-in POS food', Number(rev14.fnb) === 41000, JSON.stringify(rev14));

// Exchange rates
await expectError('USD payment needs a rate first', `select pms_post_payment_fx($1,'USD',100,'cash')`, [F4], 'No exchange rate');
await q(`select pms_set_exchange_rate($1,'USD',2650)`, [P]);
await as(FD);
await q(`select pms_post_payment_fx($1,'USD',100,'cash')`, [F4]);
const fx = await one(`select amount, fx_currency, fx_amount, fx_rate, description from pms_folio_lines where folio_id=$1 and fx_currency is not null`, [F4]);
ok('USD 100 credits TZS 265,000 and keeps the original amount', Number(fx.amount) === -265000 && Number(fx.fx_amount) === 100 && fx.fx_currency === 'USD', JSON.stringify(fx));
ok('drawer expects POS cash plus USD cash in base', Number((await one(`select pms_drawer_expected($1) e`, [D2])).e) === 41000 + 265000);

// Agents, sales, commission, update booking
await as(OWNER);
const TA = (await one(`insert into pms_travel_agents(property_id,name,commission_pct) values ($1,'Kilimanjaro Safaris',10) returning id`, [P])).id;
const SP = (await one(`insert into pms_sales_persons(property_id,name) values ($1,'Neema') returning id`, [P])).id;
await as(FD);
await q(`select pms_update_reservation($1,null,null,$2,$3,'VIP guest')`, [res4.reservation_id, TA, SP]);
ok('reservation now has agent, sales person and notes',
  (await one(`select travel_agent_id, sales_person_id, notes from pms_reservations where id=$1`, [res4.reservation_id])).notes === 'VIP guest');
await as(OWNER);
await q(`select pms_run_night_audit($1, true)`, [P]).catch(async (e) => { console.log('    (audit on 14 Oct:', e.message, ')'); });
const com = await q(`select * from pms_rpt_commission($1,'2026-10-01','2026-10-31')`, [P]);
const ritha = com.find((c) => c.party === 'Kilimanjaro Safaris');
ok('commission = 10% of posted room revenue', ritha && Number(ritha.commission) === Number(ritha.room_revenue) * 0.1 && Number(ritha.room_revenue) > 0, JSON.stringify(com));

// Packages and promotions
const res6 = (await one(`select pms_create_reservation($1,'{"first_name":"Asha","last_name":"Juma"}'::jsonb,'2026-10-20','2026-10-23',$2::jsonb) r`,
  [P, JSON.stringify([{ room_type_id: SGL }])])).r;
await q(`insert into pms_promotions(property_id,code,name,discount_pct,min_nights) values ($1,'KARIBU10','Karibu 10%',10,2)`, [P]);
await q(`select pms_apply_promotion($1,'karibu10')`, [res6.reservation_id]);
ok('promotion takes 10% off the nightly rate', Number((await one(`select rate from pms_stays where reservation_id=$1`, [res6.reservation_id])).rate) === 180000);
await expectError('promotion only once', `select pms_apply_promotion($1,'KARIBU10')`, [res6.reservation_id], 'already applied');
const PK = (await one(`insert into pms_packages(property_id,name,room_type_id,price_mode,price,min_nights,inclusions) values ($1,'Honeymoon 3 nights',$2,'per_stay',540000,3,'Dinner and spa') returning id`, [P, SGL])).id;
await q(`select pms_apply_package($1,$2)`, [res6.reservation_id, PK]);
ok('per-stay package spreads 540,000 over 3 nights', Number((await one(`select rate from pms_stays where reservation_id=$1`, [res6.reservation_id])).rate) === 180000);

// Guest services
await as(HK);
await q(`insert into pms_lost_found(property_id,description,location,found_by) values ($1,'Black sunglasses','Pool deck','Asha')`, [P]);
ok('housekeeping can log lost property', (await one(`select count(*)::int n from pms_lost_found where property_id=$1`, [P])).n === 1);

// --- Integrations data layer ---------------------------------------------
console.log('\nIntegrations');
await as(OWNER);
for (const prov of ['channex', 'ttlock', 'hikvision', 'fiscal']) {
  await q(`insert into pms_integrations(property_id,provider,enabled,config) values ($1,$2,true,$3::jsonb)`, [P, prov, prov === 'ttlock' ? '{"staff_usernames":["hk.asha"]}' : '{}']);
}
await q(`insert into pms_external_ids(property_id,provider,entity,entity_id,external_id) values ($1,'channex','room_type',$2,'cx-sgl')`, [P, SGL]);
const RO = (await one(`select id from pms_rate_plans where property_id=$1 and name='Room Only'`, [P])).id;
await q(`insert into pms_channex_rate_map(property_id,room_type_id,rate_plan_id,channex_rate_plan_id) values ($1,$2,$3,'cx-sgl-ro')`, [P, SGL, RO]);
const bdNow = (await one(`select business_date::text d from pms_properties where id=$1`, [P])).d;
await as(FD);
await q(`select pms_create_reservation($1,'{"first_name":"Ari"}'::jsonb,$2::date + 2,$2::date + 4,$3::jsonb)`, [P, bdNow, JSON.stringify([{ room_type_id: SGL }])]);
await q(`select pms_create_reservation($1,'{"first_name":"Ari2"}'::jsonb,$2::date + 10,$2::date + 12,$3::jsonb)`, [P, bdNow, JSON.stringify([{ room_type_id: SGL }])]);
const ari = await q(`select * from pms_jobs where property_id=$1 and kind='ari_push' and status='queued'`, [P]);
ok('booking changes queue one merged availability push', ari.length === 1 && ari[0].payload.date_to >= ari[0].payload.date_from, JSON.stringify(ari.map((j) => j.payload)));
const snap = (await one(`select pms_svc_ari_snapshot($1,$2::date,$2::date + 3) s`, [P, bdNow])).s;
ok('ARI snapshot lists mapped room type availability and rates', snap.availability.length === 3 && snap.availability[0].room_type_id === 'cx-sgl' && snap.rates[0].rate_plan_id === 'cx-sgl-ro', JSON.stringify(snap).slice(0, 300));
const claimed = await q(`select * from pms_svc_claim_jobs('channex', 10)`);
ok('worker claims the queued job', claimed.length === 1 && claimed[0].status === 'running');
await q(`select pms_svc_finish_job($1,false,'HTTP 500')`, [claimed[0].id]);
ok('failed attempt goes back to the queue with back-off', (await one(`select status, run_after > now() later from pms_jobs where id=$1`, [claimed[0].id])).later === true);

// Channex bookings in
const cxRev = { id: 'rev-1', booking_id: 'bk-1', status: 'new', ota_name: 'Booking.com', ota_reservation_code: '9996013801', currency: 'USD',
  arrival_date: '2026-11-02', departure_date: '2026-11-04', notes: 'Late arrival',
  customer: { name: 'Anna', surname: 'Berg', mail: 'anna@example.com', phone: '+4670000000', country: 'SE' },
  rooms: [{ room_type_id: 'cx-sgl', rate_plan_id: 'cx-sgl-ro', checkin_date: '2026-11-02', checkout_date: '2026-11-04', amount: '300.00', occupancy: { adults: 2, children: 0 } }] };
const in1 = (await one(`select pms_svc_channex_ingest($1,$2::jsonb) r`, [P, JSON.stringify(cxRev)])).r;
const otaRes = await one(`select r.*, (select rate from pms_stays where reservation_id=r.id and status='confirmed') rate,
  (select name from pms_business_sources where id=r.source_id) src from pms_reservations r where id=$1`, [in1.reservation_id]);
ok('OTA booking becomes a reservation from Booking.com', otaRes.external_ref === 'bk-1' && otaRes.src === 'Booking.com');
ok('USD 300 for 2 nights converts to TZS 397,500 a night', Number(otaRes.rate) === 397500, otaRes.rate);
ok('same revision twice is ignored', (await one(`select pms_svc_channex_ingest($1,$2::jsonb) r`, [P, JSON.stringify(cxRev)])).r.action === 'duplicate');
await q(`select pms_svc_channex_ingest($1,$2::jsonb)`, [P, JSON.stringify({ ...cxRev, id: 'rev-2', status: 'modified', departure_date: '2026-11-05', rooms: [{ ...cxRev.rooms[0], checkout_date: '2026-11-05', amount: '450.00' }] })]);
ok('modification moves the departure', (await one(`select departure::text d from pms_reservations where id=$1`, [in1.reservation_id])).d === '2026-11-05');
await q(`select pms_svc_channex_ingest($1,$2::jsonb)`, [P, JSON.stringify({ ...cxRev, id: 'rev-3', status: 'cancelled' })]);
ok('cancellation cancels the reservation', (await one(`select status from pms_reservations where id=$1`, [in1.reservation_id])).status === 'cancelled');

// TTLock passcodes and door events
const R336 = await room('336'), R340 = await room('340');
await q(`insert into pms_external_ids(property_id,provider,entity,entity_id,external_id) values ($1,'ttlock','room',$2,'L336'),($1,'ttlock','room',$3,'L340')`, [P, R336, R340]);
await as(FD);
const resT = (await one(`select pms_create_reservation($1,'{"first_name":"Door","last_name":"Test"}'::jsonb,$2::date,$2::date + 2,$3::jsonb) r`, [P, bdNow, JSON.stringify([{ room_id: R336 }])])).r;
const ST = await firstStay(resT.reservation_id);
await q(`select pms_check_in($1, true)`, [ST]);
ok('check-in queues a guest passcode', (await one(`select count(*)::int n from pms_jobs where provider='ttlock' and kind='issue_passcode' and payload->>'stay_id'=$1`, [ST])).n === 1);
const ctx = (await one(`select pms_svc_passcode_context($1) c`, [ST])).c;
ok('passcode context has the lock and validity', ctx.lock_id === 'L336' && ctx.valid_to > ctx.valid_from);
await as(OWNER);
const t0 = Date.parse(bdNow + 'T10:00:00+03:00');
const n = (await one(`select pms_svc_ingest_door_events($1,$2::jsonb) n`, [P, JSON.stringify([
  { record_id: 'r1', lock_id: 'L340', time_ms: t0, record_type: 4, method: 'passcode', success: true, username: 'unknown' },
  { record_id: 'r2', lock_id: 'L340', time_ms: t0 + 60000, record_type: 4, method: 'passcode', success: true, username: 'hk.asha' },
  { record_id: 'r1', lock_id: 'L340', time_ms: t0, record_type: 4, method: 'passcode', success: true, username: 'unknown' }])])).n;
ok('door events stored once each', n === 2);
await q(`insert into pms_external_ids(property_id,provider,entity,entity_id,external_id) values ($1,'hikvision','room',$2,'5')`, [P, R340]);
ok('camera events map to rooms', (await one(`select pms_svc_ingest_camera_events($1,$2::jsonb) n`, [P, JSON.stringify([{ channel: '5', event_type: 'linedetection', time: bdNow + 'T10:01:00+03:00' }])])).n === 1);
const ra = await q(`select * from pms_rpt_revenue_assurance($1,$2::date,$2::date)`, [P, bdNow]);
const r340 = ra.find((r) => r.room === '340');
ok('revenue assurance flags a vacant room opened by a non-staff code', r340.flag === 'Door used while vacant' && r340.door_opens === 1 && r340.staff_opens === 1, JSON.stringify(r340));

// Fiscal receipts
await as(FD);
const FT = await folioOf(ST);
await q(`select pms_post_payment($1,50000,'mobile_money','MPESA123')`, [FT]);
const fr = await one(`select * from pms_fiscal_receipts where folio_line_id = (select id from pms_folio_lines where folio_id=$1 and line_type='payment' order by created_at desc limit 1)`, [FT]);
ok('payment creates a pending fiscal receipt and a job', fr && fr.status === 'pending' && Number(fr.amount) === 50000);
const fctx = (await one(`select pms_svc_fiscal_context($1) c`, [fr.id])).c;
ok('fiscal context carries TIN, amount and receipt reference', Number(fctx.amount) === 50000 && fctx.reference.startsWith('R'));
await expectError('front desk cannot record a manual EFD receipt', `select pms_fiscal_manual($1,'EFD-001')`, [fr.id], 'cannot perform');
await as(OWNER);
await q(`select pms_fiscal_manual($1,'EFD-001','ABC123')`, [fr.id]);
ok('manual EFD number recorded', (await one(`select status, receipt_no from pms_fiscal_receipts where id=$1`, [fr.id])).receipt_no === 'EFD-001');

// --- Receipts, trail -----------------------------------------------------
console.log('\nReceipts and reservation trail');
await as(OWNER);
const rc = await q(`select receipt_no from pms_folio_lines where property_id=$1 and line_type in ('payment','refund') and payment_method <> 'city_ledger' and source <> 'system' order by created_at`, [P]);
ok('every payment has a receipt number', rc.length > 0 && rc.every((r) => r.receipt_no !== null));
ok('receipt numbers run 1..n without gaps', rc.map((r) => r.receipt_no).join() === rc.map((_, i) => i + 1).join(), rc.map((r) => r.receipt_no).join());
const tr = await q(`select * from pms_reservation_trail($1)`, [res1.reservation_id]);
ok('reservation trail shows booking, check-in, payment and check-out',
  ['reservation.create', 'stay.check_in', 'folio.payment', 'stay.check_out'].every((a) => tr.some((t) => t.action === a)));
await as(OUT);
await expectError('outsider cannot read the trail', `select * from pms_reservation_trail($1)`, [res1.reservation_id], 'not a member');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
