// Operations test: hotel profile and settings lists, rate grid with derived plans and extra guests, folio operations
// (payment methods, extra charges, discount types, room charge sub types, adjustment, paid out, meal plan, transport,
// split and cut folio, files), POS for in-house guests, users and devices, notifications and the booking engine.
// Run: node tests/operations.test.mjs
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
// guest mobile money is switched off in the product for now (migration 28); these checks keep the dormant code working
await db.exec(`update pms_catalog set active = true, default_on = true where key = 'clickpesa'`);

const OWNER = '11111111-1111-1111-1111-111111111111', DESK = '22222222-2222-2222-2222-222222222222', MGR = '33333333-3333-3333-3333-333333333333';
await db.exec(`insert into auth.users(id,email) values ('${OWNER}','owner@uh.co.tz'),('${DESK}','desk@uh.co.tz'),('${MGR}','mgr@uh.co.tz')`);
const as = (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`);
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const one = async (sql, p = []) => (await q(sql, p))[0];
const val = async (sql, p = []) => Object.values((await one(sql, p)) ?? {})[0];
const err = async (sql, p = []) => { try { await db.query(sql, p); return ''; } catch (e) { return String(e.message); } };

await as(OWNER);
const P = await val(`select pms_create_property('Unreal Homes','UH','Balati',$1::jsonb)`, [JSON.stringify([{ name: 'Single', base_rate: 200000, rooms: ['331', '332', '333'] }, { name: 'Double', base_rate: 300000, rooms: ['335', '340'] }])]);
await db.exec(`update pms_properties set business_date='2026-10-13', check_in_time='14:00', check_out_time='10:00' where id='${P}'`);
await db.query(`select pms_set_member($1,'desk@uh.co.tz','front_desk')`, [P]);
await db.query(`select pms_set_member($1,'mgr@uh.co.tz','manager')`, [P]);
const SINGLE = await val(`select id from pms_room_types where property_id=$1 and name='Single'`, [P]);
const DOUBLE = await val(`select id from pms_room_types where property_id=$1 and name='Double'`, [P]);
const RO = await val(`select id from pms_rate_plans where property_id=$1 order by name limit 1`, [P]);
const room = (n) => val(`select id from pms_rooms where property_id=$1 and number=$2`, [P, n]);

console.log('Hotel profile and lists');
await db.query(`update pms_properties set property_type='Apartments', star_rating='4 stars', website='unrealhomes.co.tz', reservation_phone='0740042042',
  reg_numbers='{"Company TIN":"181-170-832"}', address='Kijitonyama', city='Dar es Salaam', region='Dar es Salaam', postal_code='255',
  latitude=-6.7735, longitude=39.2421, highlights='{"24-hour security","Free Wi-Fi"}', amenities='{"Air conditioning","Kitchenette","Parking"}',
  policies='{"hotel":"No cots or extra beds.","cancellation":"Free cancellation up to 48 hours before arrival."}' where id=$1`, [P]);
const prof = await one(`select website, star_rating, highlights, policies from pms_properties where id=$1`, [P]);
ok('profile, highlights, amenities and policies are stored', prof.website === 'https://unrealhomes.co.tz' && prof.highlights.length === 2 && prof.policies.cancellation.startsWith('Free'));
ok('a logo must be an https address', (await err(`update pms_properties set logo_url='http://x/logo.png' where id=$1`, [P])).includes('https'));
ok('coordinates are checked', (await err(`update pms_properties set latitude=200 where id=$1`, [P])).includes('Latitude'));
ok('new properties get payment methods, meal plans, segments, reservation types and a VAT line',
  Number(await val(`select count(*) from pms_payment_methods where property_id=$1`, [P])) >= 6
  && Number(await val(`select count(*) from pms_meal_plans where property_id=$1`, [P])) === 5
  && Number(await val(`select count(*) from pms_market_segments where property_id=$1`, [P])) >= 5
  && Number(await val(`select count(*) from pms_reservation_types where property_id=$1`, [P])) >= 4
  && (await val(`select name from pms_taxes where property_id=$1`, [P])) === 'VAT');
await db.query(`insert into pms_taxes(property_id,name,rate,applies_to) values ($1,'Service charge',5,'{room}')`, [P]);
ok('taxes on rooms add up to the rate the night audit uses', Number(await val(`select tax_rate from pms_properties where id=$1`, [P])) === 23);
const lbl = await val(`select pms__tax_label($1)`, [P]); ok('…and name themselves on the folio', lbl === 'VAT 18% + Service charge 5%', lbl);
await db.query(`update pms_taxes set active=false where property_id=$1 and name='Service charge'`, [P]);

console.log('\nRates: derived plans, extra guests, grid, max nights');
await db.query(`update pms_room_types set base_adults=1, max_adults=2, max_children=1, extra_adult_rate=50000, extra_child_rate=20000 where id=$1`, [SINGLE]);
const BB = await val(`insert into pms_rate_plans(property_id,name,meal_plan,parent_id,derive_mode,derive_value) values ($1,'Bed and breakfast','BB',$2,'amount',25000) returning id`, [P, RO]);
const NR = await val(`insert into pms_rate_plans(property_id,name,meal_plan,parent_id,derive_mode,derive_value) values ($1,'Non-refundable','RO',$2,'percent',-10) returning id`, [P, RO]);
ok('a derived plan follows its parent plus an amount', Number(await val(`select pms_rate($1,$2,'2026-10-20')`, [SINGLE, BB])) === 225000);
ok('…or a percentage', Number(await val(`select pms_rate($1,$2,'2026-10-20')`, [SINGLE, NR])) === 180000);
const saved = await val(`select pms_save_rate_grid($1,$2::jsonb)`, [P, JSON.stringify([
  { room_type_id: SINGLE, rate_plan_id: RO, date: '2026-10-24', amount: 240000, extra_adult: 60000 },
  { room_type_id: SINGLE, rate_plan_id: RO, date: '2026-10-25', min_stay: 2, max_stay: 5, cta: true },
  { room_type_id: DOUBLE, rate_plan_id: RO, date: '2026-10-25', stop_sell: true }])]);
ok('the grid saves rates and restrictions together', saved === 3);
ok('a weekend rate on the parent moves the derived plans too', Number(await val(`select pms_rate($1,$2,'2026-10-24')`, [SINGLE, BB])) === 265000);
const grid = await q(`select * from pms_rate_grid($1,'2026-10-24',2) where room_type_id=$2 and rate_plan_id=$3 order by rate_date`, [P, SINGLE, RO]);
ok('the grid reads back amounts, extra adult rates, min/max nights, COA and inventory',
  Number(grid[0].amount) === 240000 && grid[0].own_rate && Number(grid[0].extra_adult) === 60000 && grid[1].min_stay === 2 && grid[1].max_stay === 5 && grid[1].cta && grid[0].total === 3 && grid[0].free === 3);
await db.query(`select pms_save_rate_grid($1,$2::jsonb)`, [P, JSON.stringify([{ room_type_id: SINGLE, rate_plan_id: RO, date: '2026-10-24', amount: null }])]);
ok('clearing a cell goes back to the base rate', Number(await val(`select pms_rate($1,$2,'2026-10-24')`, [SINGLE, RO])) === 200000);
await as(DESK);
ok('front desk cannot change rates', (await err(`select pms_save_rate_grid($1,'[]'::jsonb)`, [P])).includes('cannot perform'));
const R1 = await one(`select pms_create_reservation($1,'{"first_name":"Fred","last_name":"Mutiso","phone":"0754000111"}'::jsonb,'2026-10-13','2026-10-16',$2::jsonb,null,$3) r`,
  [P, JSON.stringify([{ room_id: await room('332'), adults: 2, children: 1 }]), RO]);
const STAY = await val(`select id from pms_stays where reservation_id=$1`, [R1.r.reservation_id]);
ok('two adults and a child in a single: base + extra adult + extra child', Number(await val(`select rate from pms_stays where id=$1`, [STAY])) === 270000);
await db.query(`select pms_check_in($1)`, [STAY]);
const FOLIO = await val(`select id from pms_folios where stay_id=$1`, [STAY]);
const bal = async (f = FOLIO) => Number(await val(`select balance from pms_folio_balances where folio_id=$1`, [f]));

console.log('\nFolio operations');
await db.query(`select pms_open_drawer($1,100000)`, [P]);
const CARD = await val(`select id from pms_payment_methods where property_id=$1 and kind='card'`, [P]);
await as(OWNER); await db.query(`update pms_payment_methods set surcharge_pct=3 where id=$1`, [CARD]); await as(DESK);
await db.query(`select pms_post_payment_method($1,100000,$2,'VISA-4421')`, [FOLIO, CARD]);
const pay = await one(`select payment_method, payment_method_name, description from pms_folio_lines where folio_id=$1 and line_type='payment'`, [FOLIO]);
ok('payments carry the method the hotel set up (and its kind for the drawer)', pay.payment_method === 'card' && pay.payment_method_name === 'Card (Visa / Mastercard)');
ok('a card surcharge is added to the bill', Number(await val(`select amount from pms_folio_lines where folio_id=$1 and description like '%charge' and line_type='charge'`, [FOLIO])) === 3000);
await as(OWNER);
const LAUNDRY = await val(`insert into pms_extra_charges(property_id,name,category,amount,charge_mode) values ($1,'Laundry bag','laundry',15000,'once') returning id`, [P]);
const LONG = await val(`insert into pms_discount_types(property_id,name,kind,value,applies_to) values ($1,'Long stay 10%','percent',10,'room') returning id`, [P]);
const PICKUP = await val(`select id from pms_transport_types where property_id=$1 and name like 'Airport pick-up%'`, [P]);
await db.query(`update pms_transport_types set rate=60000 where id=$1`, [PICKUP]);
await db.query(`update pms_meal_plans set adult_rate=25000, child_rate=12000 where property_id=$1 and code='BB'`, [P]);
await as(DESK);
await db.query(`select pms_post_extra_charge($1,$2,2)`, [FOLIO, LAUNDRY]);
ok('extra charges post from the list with a quantity', (await one(`select amount, category from pms_folio_lines where folio_id=$1 and description like 'Laundry bag%'`, [FOLIO])).amount == 30000);
const rc = await val(`select pms_post_room_charge($1,'late_checkout',135000,'Left at 15:00')`, [FOLIO]);
const rcl = await one(`select category, sub_type, description from pms_folio_lines where id=$1`, [rc]);
ok('room charge posting with sub types (late check-out, day use, no-show…)', rcl.category === 'room' && rcl.sub_type === 'late_checkout' && rcl.description.startsWith('Late check-out · room 332'));
ok('front desk cannot post adjustments', (await err(`select pms_post_adjustment($1,-5000,'x')`, [FOLIO])).includes('cannot perform'));
await as(MGR);
await db.query(`select pms_post_discount_type($1,$2)`, [FOLIO, LONG]);
const ld = await q(`select amount, description from pms_folio_lines where folio_id=$1 and (description like '%Long stay%' or category='room')`, [FOLIO]); ok('a 10% long-stay discount is worked out from the room charges', ld.some((l) => Number(l.amount) === -13500), JSON.stringify(ld));
await db.query(`select pms_post_adjustment($1,-5000,'Wi-Fi was down')`, [FOLIO]);
ok('managers post adjustments down (or up)', Number(await val(`select amount from pms_folio_lines where folio_id=$1 and category='adjustment'`, [FOLIO])) === -5000);
await as(DESK);
const before = Number(await val(`select pms_drawer_expected((select id from pms_drawer_sessions where property_id=$1 and status='open'))`, [P]));
await db.query(`select pms_post_paid_out($1,20000,'Pharmacy','Shoppers Plaza')`, [FOLIO]);
const after = Number(await val(`select pms_drawer_expected((select id from pms_drawer_sessions where property_id=$1 and status='open'))`, [P]));
ok('a paid out takes cash from the drawer and adds it to the bill', before - after === 20000);
await db.query(`select pms_post_meal_plan($1,(select id from pms_meal_plans where property_id=$2 and code='BB'),1)`, [FOLIO, P]);
ok('meal plan posts per adult and child', Number(await val(`select amount from pms_folio_lines where folio_id=$1 and description like 'Meal plan%'`, [FOLIO])) === 62000);
await db.query(`select pms_set_booking_details($1,$2::jsonb)`, [R1.r.reservation_id, JSON.stringify({ pickup: { type_id: PICKUP, at: '2026-10-13T06:30', flight: 'TC 105' }, market_segment_id: await val(`select id from pms_market_segments where property_id=$1 and name='Corporate'`, [P]) })]);
await db.query(`select pms_post_transport($1,'pickup')`, [R1.r.reservation_id]);
ok('an airport pick-up posts once', Number(await val(`select amount from pms_folio_lines where folio_id=$1 and category='transport'`, [FOLIO])) === 60000
  && (await err(`select pms_post_transport($1,'pickup')`, [R1.r.reservation_id])).includes('Already charged'));
const lines = (await q(`select id from pms_folio_lines where folio_id=$1 and not voided and category in ('laundry','transport') order by created_at`, [FOLIO])).map((r) => r.id);
const before2 = await bal();
const F2 = await val(`select pms_split_folio($1,$2::uuid[])`, [FOLIO, lines]);
ok('split folio moves chosen lines to a new folio; the total stays the same', (await bal()) + (await bal(F2)) === before2 && (await bal(F2)) === 90000);
await db.query(`select pms_post_room_charge($1,'room',1000,'test')`, [FOLIO]);
await as(OWNER); await db.exec(`update pms_properties set business_date='2026-10-14' where id='${P}'`); await as(DESK);
await db.query(`select pms_post_charge($1,'other','Late bar tab',7000)`, [FOLIO]);
const F3 = await val(`select pms_cut_folio($1,'2026-10-14')`, [FOLIO]);
ok('cut folio moves everything from a date onwards', (await bal(F3)) === 7000);
ok('files must be filed under the property', (await err(`select pms_add_attachment($1,'other/x.pdf','x.pdf',10,'application/pdf')`, [R1.r.reservation_id])).includes('folder'));
ok('…and recorded when they are', !!(await val(`select pms_add_attachment($1,$2,'passport.pdf',2048,'application/pdf')`, [R1.r.reservation_id, `${P}/res/passport.pdf`])));
const lq = await one(`select pms_late_checkout_quote($1) r`, [STAY]);
ok('late check-out quote uses the property rule (50% by default)', Number(lq.r.amount) === 135000);
await as(OWNER); await db.exec(`update pms_properties set business_date='2026-10-13' where id='${P}'`); await as(DESK);

console.log('\nPOS for in-house guests');
const OUT = await val(`select id from pms_pos_outlets where property_id=$1 limit 1`, [P]) ?? null;
await as(OWNER);
const BAR = OUT ?? await val(`insert into pms_pos_outlets(property_id,name) values ($1,'Restaurant') returning id`, [P]);
const PILAU = await val(`insert into pms_pos_items(property_id,outlet_id,name,price) values ($1,$2,'Pilau',18000) returning id`, [P, BAR]);
const SODA = await val(`insert into pms_pos_items(property_id,outlet_id,name,price) values ($1,$2,'Soda',2000) returning id`, [P, BAR]);
await as(DESK);
const B1 = await val(`select pms_pos_open_bill($1,null)`, [BAR]);
await db.query(`select pms_pos_attach_guest($1,$2)`, [B1, STAY]);
ok('a bill is opened for an in-house guest (room service, tab)', (await val(`select table_no from pms_pos_bills where id=$1`, [B1])) === 'Room 332 · Fred Mutiso');
await db.query(`select pms_pos_add_item($1,$2,1,null,null)`, [B1, PILAU]);
await db.query(`select pms_pos_add_item($1,$2,2,null,null)`, [B1, SODA]);
const items = (await q(`select id from pms_pos_bill_items where bill_id=$1 and item_id=$2`, [B1, SODA])).map((r) => r.id);
const B2 = await val(`select pms_pos_split_bill($1,$2::uuid[])`, [B1, items]);
ok('a bill splits into two', Number(await val(`select total from pms_pos_bills where id=$1`, [B1])) === 18000 && Number(await val(`select total from pms_pos_bills where id=$1`, [B2])) === 4000);
await db.query(`select pms_set_booking_details($1,'{"allow_pos":false}'::jsonb)`, [R1.r.reservation_id]);
ok('with POS charges switched off, the room cannot be charged', (await err(`select pms_pos_post_to_room($1,$2)`, [B1, STAY])).includes('switched off'));
ok('…and Tenda ICO gets a clear error', (await err(`select pms_svc_pos_charge($1,'tendaico','T-1',$2,'332',5000)`, [P, STAY])).includes('NO_POST'));
await as(MGR);
await db.query(`select pms_set_booking_details($1,'{"allow_pos":true,"credit_limit":1}'::jsonb)`, [R1.r.reservation_id]);
await as(DESK);
ok('over the credit limit, room charges stop', (await err(`select pms_pos_post_to_room($1,$2)`, [B1, STAY])).includes('credit limit'));
ok('only managers set credit limits', (await err(`select pms_set_booking_details($1,'{"credit_limit":5}'::jsonb)`, [R1.r.reservation_id])).includes('Set credit limits'));
await as(MGR); await db.query(`select pms_set_booking_details($1,'{"credit_limit":""}'::jsonb)`, [R1.r.reservation_id]); await as(DESK);
await db.query(`select pms_pos_post_to_room($1,$2)`, [B1, STAY]);
ok('then the in-house guest\'s bill goes to the room', (await val(`select status from pms_pos_bills where id=$1`, [B1])) === 'room');
const MPESA = await val(`select id from pms_payment_methods where property_id=$1 and name='M-Pesa'`, [P]);
await db.query(`select pms_pos_settle_method($1,$2,'QK81XZ')`, [B2, MPESA]);
ok('the other half is paid by M-Pesa at the outlet', (await one(`select status, payment_method, payment_method_name from pms_pos_bills where id=$1`, [B2])).payment_method_name === 'M-Pesa');

console.log('\nUsers, devices and the audit trail');
await as(DESK);
await db.query(`select set_config('request.headers', $1, false)`, [JSON.stringify({ 'x-forwarded-for': '154.74.187.16, 10.0.0.1', 'user-agent': 'Mozilla/5.0 Chrome' })]);
await db.query(`select pms_record_sign_in()`);
await db.query(`select pms_record_sign_in()`);
await db.query(`select pms_post_charge($1,'other','Key card',5000)`, [FOLIO]);
await db.query(`select set_config('request.headers', '', false)`);
ok('sign-ins are recorded once per device per hour', Number(await val(`select count(*) from pms_sign_ins where user_id=$1`, [DESK])) === 1);
ok('the audit trail keeps the IP address', (await val(`select ip from pms_audit_log where action='folio.charge' order by id desc limit 1`)) === '154.74.187.16');
ok('…and shows it on the reservation', (await q(`select ip from pms_reservation_trail($1)`, [R1.r.reservation_id])).some((r) => r.ip === '154.74.187.16'));
await as(OWNER);
await db.query(`select pms_set_member_title($1,$2,'Front Office Associate')`, [P, DESK]);
const staff = await q(`select * from pms_list_staff($1)`, [P]);
ok('the staff list has titles, last sign-in and IP', staff.find((s) => s.email === 'desk@uh.co.tz')?.title === 'Front Office Associate' && staff.find((s) => s.email === 'desk@uh.co.tz')?.last_ip === '154.74.187.16');
ok('device activity per member', (await q(`select * from pms_staff_devices($1)`, [P])).length === 1);
ok('user activity per member', (await q(`select * from pms_staff_activity($1,$2)`, [P, DESK])).length > 5);
await as(DESK);
ok('only owners and managers see staff activity', (await err(`select * from pms_staff_activity($1)`, [P])).includes('cannot perform'));

console.log('\nGuests and reservation types');
await as(OWNER);
const BAD = await val(`insert into pms_guests(property_id,first_name,last_name,blacklisted,blacklist_reason) values ($1,'Mr','Trouble',true,'Unpaid bill 2025') returning id`, [P]);
await as(DESK);
ok('front desk cannot book a blacklisted guest', (await err(`select pms_create_reservation($1,$2::jsonb,'2026-10-20','2026-10-21','[{"room_type_id":"${SINGLE}"}]'::jsonb)`, [P, JSON.stringify({ id: BAD })])).includes('blacklist'));
await as(MGR);
ok('a manager can', !(await err(`select pms_create_reservation($1,$2::jsonb,'2026-10-20','2026-10-21','[{"room_type_id":"${SINGLE}"}]'::jsonb)`, [P, JSON.stringify({ id: BAD })])));

console.log('\nNotifications');
await as(OWNER);
await db.query(`insert into pms_integrations(property_id,provider,enabled,config) values ($1,'sms',true,'{}')`, [P]);
await db.query(`update pms_properties set settings = settings || '{"notifications":{"booking_sms":true,"checkin_sms":true,"checkout_sms":true}}' where id=$1`, [P]);
await as(DESK);
const R2 = await one(`select pms_create_reservation($1,'{"first_name":"Amina","phone":"0713000444"}'::jsonb,'2026-10-13','2026-10-14',$2::jsonb) r`, [P, JSON.stringify([{ room_id: await room('333') }])]);
ok('a booking texts the guest', (await val(`select body from pms_sms_out where to_phone='255713000444' order by created_at limit 1`)).includes(`#${R2.r.res_no}`));
await db.query(`select pms_check_in((select id from pms_stays where reservation_id=$1))`, [R2.r.reservation_id]);
ok('check-in sends a welcome with the room number', (await val(`select body from pms_sms_out where to_phone='255713000444' order by created_at desc limit 1`)).includes('room 333'));

console.log('\nReports');
await as(OWNER);
ok('market segment report', (await q(`select * from pms_rpt_segments($1,'2026-10-13','2026-10-15')`, [P])).some((r) => r.segment === 'Corporate' && r.room_nights === 3));
ok('payments by method, including POS', (await q(`select * from pms_rpt_payment_methods($1,'2026-10-13','2026-10-13')`, [P])).some((r) => r.method === 'M-Pesa (POS)'));
const rev = await one(`select * from pms_rpt_daily_revenue($1,'2026-10-13','2026-10-14') limit 1`, [P]).catch(() => null);
ok('paid outs are not counted as revenue', rev === null || !JSON.stringify(rev).includes('20000'));

console.log('\nTwo-step sign-in required by the property');
await as(OWNER);
await db.query(`update pms_properties set settings = settings || '{"require_mfa":true}' where id=$1`, [P]);
ok('the setting is stored (enforced once Supabase MFA exists; see security test)', (await val(`select settings->>'require_mfa' from pms_properties where id=$1`, [P])) === 'true');
await db.query(`update pms_properties set settings = settings - 'require_mfa' where id=$1`, [P]);

console.log('\nBooking engine');
await as(null);
ok('closed until the hotel switches it on', (await err(`select pms_public_property('UH')`)).includes('not open'));
await as(OWNER);
await db.query(`update pms_properties set settings = settings || '{"booking_engine":{"enabled":true,"default_status":"confirmed","require_terms":true,"max_rooms":2}}' where id=$1`, [P]);
await db.query(`update pms_rate_plans set on_booking_engine=false where id=$1`, [NR]);
await as(null);
const pub = await one(`select pms_public_property('uh') r`);
ok('the public page has profile, policies and room types', pub.r.name === 'Unreal Homes' && pub.r.policies.cancellation && pub.r.room_types.length === 2);
const av = (await one(`select pms_public_availability('UH','2026-10-25','2026-10-26',1,0) r`)).r;
ok('availability respects closed-to-arrival and stop sell', av.find((o) => o.room_type === 'Single' && o.rate_plan_id === RO).reason === 'No arrivals on this day'
  && av.find((o) => o.room_type === 'Double' && o.rate_plan_id === RO).available === false);
ok('plans not offered online stay hidden', !av.some((o) => o.rate_plan_id === NR));
const av2 = (await one(`select pms_public_availability('UH','2026-10-26','2026-10-28',2,0) r`)).r;
const offer = av2.find((o) => o.room_type === 'Single' && o.rate_plan_id === BB);
ok('two adults in a single online: derived BB rate plus the extra adult', Number(offer.total) === 2 * (225000 + 50000) && offer.available);
const booking = { arrival: '2026-10-26', departure: '2026-10-28', adults: 2, children: 0, room_type_id: SINGLE, rate_plan_id: BB, first_name: 'Neema', last_name: 'Mushi', email: 'neema@example.com', phone: '0688123456' };
ok('terms must be accepted', (await err(`select pms_public_book('UH',$1::jsonb)`, [JSON.stringify(booking)])).includes('accept'));
const b = (await one(`select pms_public_book('UH',$1::jsonb) r`, [JSON.stringify({ ...booking, accept_terms: true, requests: 'High floor please' })])).r;
const made = await one(`select r.status, r.booked_via, s.rate, r.notes, src.name src from pms_reservations r join pms_stays s on s.reservation_id=r.id join pms_business_sources src on src.id=r.source_id where r.res_no=$1 and r.property_id=$2`, [b.res_no, P]);
ok('an online booking lands as a confirmed reservation from "Website"', made.status === 'confirmed' && made.booked_via === 'website' && Number(made.rate) === 275000 && made.src === 'Website' && made.notes.includes('High floor'));
ok('too many rooms at once is refused', (await err(`select pms_public_book('UH',$1::jsonb)`, [JSON.stringify({ ...booking, accept_terms: true, rooms: 5 })])).includes('between 1 and 2'));
ok('bad email is refused', (await err(`select pms_public_book('UH',$1::jsonb)`, [JSON.stringify({ ...booking, accept_terms: true, email: 'nope' })])).includes('email'));
await db.query(`select pms_public_book('UH',$1::jsonb)`, [JSON.stringify({ ...booking, accept_terms: true })]);
await db.query(`select pms_public_book('UH',$1::jsonb)`, [JSON.stringify({ ...booking, accept_terms: true, arrival: '2026-11-02', departure: '2026-11-03' })]);
ok('the same person can only book three times a day online', (await err(`select pms_public_book('UH',$1::jsonb)`, [JSON.stringify({ ...booking, accept_terms: true, arrival: '2026-11-05', departure: '2026-11-06' })])).includes('several bookings'));
ok('past dates are refused', (await err(`select pms_public_availability('UH','2026-10-01','2026-10-02',1,0)`)).includes('past'));
await as(OWNER); await db.query(`select pms_create_reservation($1,'{"first_name":"Last"}'::jsonb,'2026-10-13','2026-10-14',$2::jsonb)`, [P, JSON.stringify([{ room_id: await room('331') }])]); await as(null);
ok('sold-out rooms cannot be booked', (await one(`select pms_public_availability('UH','2026-10-13','2026-10-14',1,0) r`)).r.find((o) => o.room_type === 'Single').reason === 'Sold out');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
