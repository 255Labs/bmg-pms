// Activities test: gym, pool, pool table, spa and tours on the POS — timers, memberships, door check-ins,
// room charges under the right department, the report, and Tenda ICO charges for activities.
// Run: node tests/activities.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  create table auth.users (id uuid primary key, email text unique, created_at timestamptz default now(), last_sign_in_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;`);
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));

const OWNER = '11111111-1111-1111-1111-111111111111', DESK = '22222222-2222-2222-2222-222222222222', HK = '44444444-4444-4444-4444-444444444444';
await db.exec(`insert into auth.users(id,email) values ('${OWNER}','owner@bmg.co.tz'),('${DESK}','desk@bmg.co.tz'),('${HK}','hk@bmg.co.tz')`);
const as = (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`);
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const val = async (sql, p = []) => Object.values(await one(sql, p))[0];
const err = async (sql, p = []) => { try { await db.query(sql, p); return ''; } catch (e) { return String(e.message); } };

await as(OWNER);
const P = await val(`select pms_create_property('Pumzika Beach Resort','PBR','Balati',$1::jsonb)`, [JSON.stringify([{ name: 'Villa', base_rate: 350000, rooms: ['101', '102'] }])]);
await db.exec(`update pms_properties set business_date = '2026-10-13' where id = '${P}'`);
await db.query(`select pms_set_member($1,'desk@bmg.co.tz','front_desk')`, [P]);
await db.query(`select pms_set_member($1,'hk@bmg.co.tz','housekeeping')`, [P]);

console.log('Facilities');
const outlet = (name, type, cat) => val(`insert into pms_pos_outlets(property_id,name,outlet_type,charge_category) values ($1,$2,$3,$4) returning id`, [P, name, type, cat]);
const GAMES = await outlet('Games room', 'games', 'recreation');
const GYM = await outlet('Gym', 'gym', 'recreation');
const POOL = await outlet('Swimming pool', 'pool', 'recreation');
const SPA = await outlet('Spa', 'spa', 'spa');
const TOURS = await outlet('Excursions', 'tours', 'tours');
ok('outlets carry a facility type and their own department', !!GAMES && !!SPA && !!TOURS);
ok('unknown facility types are refused', (await err(`insert into pms_pos_outlets(property_id,name,outlet_type) values ($1,'Casino','casino')`, [P])).includes('outlet_type_check'));
const item = (o, name, price, extra = {}) => val(
  `insert into pms_pos_items(property_id,outlet_id,name,price,item_type,duration_minutes,min_units,grace_minutes,resources,validity_days,visits_included)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
  [P, o, name, price, extra.type ?? 'product', extra.block ?? null, extra.min ?? 1, extra.grace ?? 0, extra.resources ?? null, extra.days ?? null, extra.visits ?? null]);
const TABLE = await item(GAMES, 'Pool table (30 min)', 5000, { type: 'timed', block: 30, grace: 5, resources: ['Table 1', 'Table 2'] });
const MONTH = await item(GYM, 'Gym · monthly', 150000, { type: 'membership', days: 30 });
const DAYPASS = await item(GYM, 'Gym · day pass', 15000, { type: 'service' });
const TENPASS = await item(POOL, 'Pool · 10 swims', 60000, { type: 'membership', days: 60, visits: 10 });
const MASSAGE = await item(SPA, 'Swedish massage 60 min', 80000, { type: 'service' });
const SNORKEL = await item(TOURS, 'Mnemba snorkelling trip', 120000, { type: 'service' });
const e1 = await err(`insert into pms_pos_items(property_id,outlet_id,name,price,item_type) values ($1,$2,'Court',1,'timed')`, [P, GAMES]); ok('a timed item needs its block length', e1.includes('timed_check'), e1);
ok('a membership needs how many days it lasts', (await err(`insert into pms_pos_items(property_id,outlet_id,name,price,item_type) values ($1,$2,'Gym',1,'membership')`, [P, GYM])).includes('membership_check'));

console.log('\nPool table by the clock');
await as(DESK);
await db.query(`select pms_open_drawer($1, 0)`, [P]);
const B1 = await val(`select pms_pos_open_bill($1,'Mr Baraka')`, [GAMES]);
ok('a timer needs to know which table', (await err(`select pms_pos_start_timer($1,$2)`, [B1, TABLE])).includes('Choose which one'));
const T1 = await val(`select pms_pos_start_timer($1,$2,'Table 1')`, [B1, TABLE]);
ok('starting the clock charges the minimum straight away', Number(await val(`select total from pms_pos_bills where id=$1`, [B1])) === 5000);
const B2 = await val(`select pms_pos_open_bill($1,'Team B')`, [GAMES]);
ok('a table in use cannot be started twice', (await err(`select pms_pos_start_timer($1,$2,'Table 1')`, [B2, TABLE])).includes('already in use'));
const T2 = await val(`select pms_pos_start_timer($1,$2,'Table 2')`, [B2, TABLE]);
ok('another table runs at the same time', !!T2);
ok('the live board lists both running tables', Number(await val(`select count(*) from pms_pos_running($1)`, [P])) === 2);
ok('a bill cannot be paid while its clock runs', (await err(`select pms_pos_settle($1,'cash')`, [B1])).includes('Stop the timer for Table 1'));
await db.query(`update pms_pos_bill_items set started_at = now() - interval '47 minutes' where id=$1`, [T1]);
const stop1 = await one(`select pms_pos_stop_timer($1) r`, [T1]);
ok('47 minutes with 5 grace = 2 blocks of 30', stop1.r.blocks === 2 && Number(stop1.r.amount) === 10000, JSON.stringify(stop1.r));
ok('the bill follows the clock', Number(await val(`select total from pms_pos_bills where id=$1`, [B1])) === 10000);
ok('a stopped timer cannot be stopped again', (await err(`select pms_pos_stop_timer($1)`, [T1])).includes('not running'));
await db.query(`select pms_pos_settle($1,'cash')`, [B1]);
ok('then it is paid like any bill (cash into the drawer)', (await val(`select status from pms_pos_bills where id=$1`, [B1])) === 'settled');
await db.query(`update pms_pos_bill_items set started_at = now() - interval '33 minutes' where id=$1`, [T2]);
ok('33 minutes with 5 grace stays one block', (await one(`select pms_pos_stop_timer($1) r`, [T2])).r.blocks === 1);
const T3 = await val(`select pms_pos_start_timer($1,$2,'Table 1')`, [B2, TABLE]);
ok('a freed table can start again', !!T3);
await db.query(`update pms_pos_bill_items set started_at = now() - interval '2 minutes' where id=$1`, [T3]);
ok('a quick game is still the minimum', (await one(`select pms_pos_stop_timer($1) r`, [T3])).r.blocks === 1);

console.log('\nCharging activities to the room');
await as(OWNER);
const r = await one(`select pms_create_reservation($1,'{"first_name":"Amina","last_name":"Said"}'::jsonb,'2026-10-13','2026-10-16',$2::jsonb) r`,
  [P, JSON.stringify([{ room_id: await val(`select id from pms_rooms where property_id=$1 and number='101'`, [P]) }])]);
const STAY = await val(`select id from pms_stays where reservation_id=$1`, [r.r.reservation_id]);
await db.query(`select pms_check_in($1)`, [STAY]);
await as(DESK);
await db.query(`select pms_pos_post_to_room($1,$2)`, [B2, STAY]);
const line = await one(`select category, amount from pms_folio_lines where stay_id=$1 and source <> 'night_audit' and line_type='charge' order by created_at desc limit 1`, [STAY]);
ok('pool table charged to the room under recreation', line.category === 'recreation' && Number(line.amount) === 10000, JSON.stringify(line));
const B3 = await val(`select pms_pos_open_bill($1,'Amina')`, [SPA]);
await db.query(`select pms_pos_add_item($1,$2,1,null,null)`, [B3, MASSAGE]);
const moves = Number(await val(`select count(*) from pms_stock_moves where property_id=$1`, [P]));
await db.query(`select pms_pos_post_to_room($1,$2)`, [B3, STAY]);
ok('a massage posts to the folio as spa', (await val(`select category from pms_folio_lines where reference=$1`, ['POS ' + await val(`select bill_no from pms_pos_bills where id=$1`, [B3])])) === 'spa');
ok('services take no stock', Number(await val(`select count(*) from pms_stock_moves where property_id=$1`, [P])) === moves);
ok('front desk can post recreation, tours and events charges by hand', !!(await val(`select pms_post_charge((select id from pms_folios where stay_id=$1 limit 1),'tours','Village walk',25000)`, [STAY])));

console.log('\nGym and pool memberships');
const B4 = await val(`select pms_pos_open_bill($1,null)`, [GYM]);
ok('a membership cannot be tapped in without a name', (await err(`select pms_pos_add_item($1,$2,1,null,null)`, [B4, MONTH])).includes('Sell membership'));
ok('the name is required', (await err(`select pms_pos_add_membership($1,$2,'  ')`, [B4, MONTH])).includes('member'));
await db.query(`select pms_pos_add_membership($1,$2,'Neema Mushi','0713000444')`, [B4, MONTH]);
ok('no member exists until the bill is paid', Number(await val(`select count(*) from pms_memberships where property_id=$1`, [P])) === 0);
await db.query(`select pms_pos_settle($1,'mobile_money','MP-77812')`, [B4]);
const M = await one(`select * from pms_memberships where member_name='Neema Mushi'`);
ok('paying starts a 30-day membership today', M && M.status === 'active' && M.starts_on.toISOString().slice(0, 10) === '2026-10-13' && M.ends_on.toISOString().slice(0, 10) === '2026-11-11');
const ci = await one(`select pms_activity_check_in($1,$2) r`, [GYM, M.id]);
ok('the member is checked in at the gym door', ci.r.kind === 'member' && ci.r.name === 'Neema Mushi');
ok('but not at the pool with a gym membership', (await err(`select pms_activity_check_in($1,$2)`, [POOL, M.id])).includes('another facility'));
await as(OWNER);
await db.exec(`update pms_properties set business_date='2026-11-12' where id='${P}'`);
await as(DESK);
ok('the day after it ends, the door says so', (await err(`select pms_activity_check_in($1,$2)`, [GYM, M.id])).includes('ended on 11 Nov 2026'));
await as(OWNER); await db.exec(`update pms_properties set business_date='2026-10-13' where id='${P}'`); await as(DESK);

const B5 = await val(`select pms_pos_open_bill($1,null)`, [POOL]);
await db.query(`select pms_pos_add_membership($1,$2,'Juma Ally')`, [B5, TENPASS]);
await db.query(`select pms_pos_post_to_room($1,$2)`, [B5, STAY]);
const M2 = await one(`select * from pms_memberships where member_name='Juma Ally'`);
ok('a pass charged to the room is linked to the stay', M2.stay_id === STAY && M2.visits_included === 10);
for (let i = 0; i < 10; i++) await db.query(`select pms_activity_check_in($1,$2)`, [POOL, M2.id]);
ok('ten swims, then the pass is used up', (await err(`select pms_activity_check_in($1,$2)`, [POOL, M2.id])).includes('All 10 visits'));

const B6 = await val(`select pms_pos_open_bill($1,null)`, [GYM]);
await db.query(`select pms_pos_add_membership($1,$2,'Wrong Person')`, [B6, MONTH]);
await db.query(`select pms_pos_settle($1,'cash')`, [B6]);
await as(OWNER);
await db.query(`select pms_pos_void_bill($1,'Sold by mistake')`, [B6]);
ok('voiding the bill cancels the membership it created', (await val(`select status from pms_memberships where member_name='Wrong Person'`)) === 'cancelled');
await as(DESK);
ok('only managers cancel memberships by hand', (await err(`select pms_cancel_membership($1,'x')`, [M.id])).includes('cannot perform'));

console.log('\nResidents and walk-ins at the door');
await as(HK);
ok('pool attendants (housekeeping) can check guests in', (await one(`select pms_activity_check_in($1,null,$2) r`, [POOL, STAY])).r.name.includes('room 101'));
await as(DESK);
ok('a walk-in needs a name', (await err(`select pms_activity_check_in($1)`, [GYM])).includes('name'));
await db.query(`select pms_activity_check_in($1,null,null,'Day visitor')`, [GYM]);
await as(OWNER);
await db.query(`select pms_check_out($1)`, [STAY]).catch(() => {});
await as(DESK);
const outStay = await val(`select status from pms_stays where id=$1`, [STAY]);
if (outStay === 'checked_out') ok('a checked-out guest is no longer a resident', (await err(`select pms_activity_check_in($1,null,$2)`, [POOL, STAY])).includes('not checked in'));
else ok('a guest with a balance stays in house (check-out refused)', outStay === 'checked_in');

console.log('\nReport');
await as(OWNER);
const rep = (await db.query(`select * from pms_rpt_activities($1,'2026-10-13','2026-10-13')`, [P])).rows;
const games = rep.find((x) => x.outlet === 'Games room'), gym = rep.find((x) => x.outlet === 'Gym'), pool = rep.find((x) => x.outlet === 'Swimming pool');
ok('games room: takings and hours sold', Number(games.revenue) === 20000 && Number(games.hours_sold) === 2, JSON.stringify(games));
ok('gym: member, walk-in visits and new memberships', gym.member_visits === 1 && gym.walk_in_visits === 1 && gym.new_memberships === 1, JSON.stringify(gym));
ok('pool: member and resident visits, room charges', pool.member_visits === 10 && pool.resident_visits === 1 && Number(pool.to_rooms) === 60000, JSON.stringify(pool));
ok('spa and tours appear too', rep.some((x) => x.outlet === 'Spa') && rep.some((x) => x.outlet === 'Excursions'));

console.log('\nTenda ICO sells activities too');
await as(null);
await as(OWNER);
const r2 = await one(`select pms_create_reservation($1,'{"first_name":"Bob"}'::jsonb,'2026-10-13','2026-10-15',$2::jsonb) r`,
  [P, JSON.stringify([{ room_id: await val(`select id from pms_rooms where property_id=$1 and number='102'`, [P]) }])]);
const STAY2 = await val(`select id from pms_stays where reservation_id=$1`, [r2.r.reservation_id]);
await db.query(`select pms_check_in($1)`, [STAY2]);
await as(null);
const x = await one(`select pms_svc_pos_charge($1,'tendaico','TND-POOL-1',$2,'102',8000,'recreation','Pool bar','Sun lounger and towel') r`, [P, STAY2]);
ok('a recreation charge from Tenda ICO lands on the folio', x.r.status === 'posted' && (await val(`select category from pms_folio_lines where id=$1`, [x.r.folio_line_id])) === 'recreation');
ok('unknown departments are still refused', (await err(`select pms_svc_pos_charge($1,'tendaico','TND-X',$2,'102',1,'casino')`, [P, STAY2])).includes('unknown category'));

console.log('\nCopying a resort');
await db.exec(`insert into auth.users(id,email) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','admin@bmg.co.tz')`);
await as(null); await db.query(`select pms_bootstrap_super_admin('admin@bmg.co.tz')`);
await as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
const P2 = await val(`select pms_admin_create_property($1::jsonb)`, [JSON.stringify({ name: 'Pumzika Two', copy_from: P, room_types: [{ name: 'Villa', base_rate: 1, rooms: ['1'] }] })]);
const copied = await one(`select i.item_type, i.duration_minutes, i.resources, o.outlet_type from pms_pos_items i join pms_pos_outlets o on o.id=i.outlet_id where i.property_id=$1 and i.name='Pool table (30 min)'`, [P2.property_id ?? P2.id]);
ok('copying a property brings its timed tables and memberships', copied?.item_type === 'timed' && copied.duration_minutes === 30 && copied.outlet_type === 'games', JSON.stringify(copied));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
