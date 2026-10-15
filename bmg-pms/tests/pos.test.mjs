// Full-service POS test: menus, options, happy hours, tables, kitchen tickets and display, voids, service charge,
// split tender with change, part payment then room charge, drawers, reports, end of day and stock.
// Runs as real API callers (PostgREST roles, row security). Run: node tests/pos.test.mjs
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
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create role authenticator noinherit login; grant anon, authenticated, service_role to authenticator;
  create schema auth;
  create table auth.users (id uuid primary key, email text unique, created_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));

const U = { owner: '10000000-0000-0000-0000-000000000001', waiter: '10000000-0000-0000-0000-000000000002', chef: '10000000-0000-0000-0000-000000000003',
  mgr: '10000000-0000-0000-0000-000000000004' };
await db.exec(`insert into auth.users(id,email) values ('${U.owner}','gm@h.tz'),('${U.waiter}','waiter@h.tz'),('${U.chef}','chef@h.tz'),('${U.mgr}','mgr@h.tz')`);
const asSuper = () => db.exec(`reset role; set session authorization postgres; select set_config('test.uid','',false); select set_config('request.jwt.claims','',false)`);
async function as(uid) {
  await asSuper();
  await db.exec(`set session authorization authenticator; set role authenticated`);
  await db.query(`select set_config('test.uid', $1, false), set_config('request.jwt.claims', $2, false)`, [uid, JSON.stringify({ role: 'authenticated', sub: uid, aal: 'aal1' })]);
}
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const val = async (sql, p = []) => Object.values((await q(sql, p))[0] ?? {})[0];
const err = async (sql, p = []) => { try { await db.query(sql, p); return ''; } catch (e) { return String(e.message); } };

// ---------------------------------------------------------------- a hotel with a restaurant and its kitchen store
await asSuper(); await db.exec(`select set_config('test.uid','${U.owner}',false)`);
const P = await val(`select pms_create_property('Pumzika','PB','GM',$1::jsonb)`, [JSON.stringify([{ name: 'Villa', base_rate: 300000, rooms: ['101'] }])]);
for (const [m, r] of [['waiter@h.tz', 'front_desk'], ['chef@h.tz', 'storekeeper'], ['mgr@h.tz', 'manager']]) await db.query(`select pms_add_or_invite_member($1,$2,$3)`, [P, m, r]);
await db.query(`update pms_properties set business_date = '2026-10-14' where id=$1`, [P]);
const KITCHEN = await val(`insert into pms_stock_locations(property_id,name,kind) values ($1,'Main kitchen','kitchen') returning id`, [P]);
const BEEF = await val(`insert into pms_stock_items(property_id,name,unit,avg_cost) values ($1,'Beef','kg',20000) returning id`, [P]);
const CHEESE = await val(`insert into pms_stock_items(property_id,name,unit,avg_cost) values ($1,'Cheese','kg',30000) returning id`, [P]);
const REST = await val(`insert into pms_pos_outlets(property_id,name,charge_category,outlet_type,stock_location_id,service_charge_pct,uses_tables) values ($1,'Beach Restaurant','fnb','restaurant',$2,10,true) returning id`, [P, KITCHEN]);
const ROOM = await val(`select id from pms_rooms where property_id=$1`, [P]);
const res = await val(`select pms_create_reservation($1,'{"first_name":"Asha","last_name":"Mollel","phone":"0713000111"}'::jsonb,'2026-10-14','2026-10-16',$2::jsonb)`, [P, JSON.stringify([{ room_id: ROOM }])]);
const STAY = await val(`select id from pms_stays where reservation_id=$1`, [res.reservation_id]);
await db.query(`select pms_check_in($1, true)`, [STAY]);
const pm = async (name) => val(`select id from pms_payment_methods where property_id=$1 and name=$2`, [P, name]);
const CASH = await pm('Cash'), MPESA = await pm('M-Pesa'), CARD = await pm('Card (Visa / Mastercard)');

console.log('Menu set-up (managers, through the API with row security)');
await as(U.waiter);
ok('a waiter cannot change the menu set-up', (await err(`insert into pms_pos_categories(property_id,outlet_id,name) values ($1,$2,'Mains')`, [P, REST])) !== '');
await as(U.mgr);
const MAINS = await val(`insert into pms_pos_categories(property_id,outlet_id,name,station) values ($1,$2,'Mains','kitchen') returning id`, [P, REST]);
const DRINKS = await val(`insert into pms_pos_categories(property_id,outlet_id,name,station) values ($1,$2,'Drinks','bar') returning id`, [P, REST]);
const BURGER = await val(`insert into pms_pos_items(property_id,outlet_id,name,price,category_id) values ($1,$2,'Beef burger',25000,$3) returning id`, [P, REST, MAINS]);
const BEER = await val(`insert into pms_pos_items(property_id,outlet_id,name,price,category_id) values ($1,$2,'Kilimanjaro lager',6000,$3) returning id`, [P, REST, DRINKS]);
const WATER = await val(`insert into pms_pos_items(property_id,outlet_id,name,price,category_id,station) values ($1,$2,'Bottled water',2000,$3,'none') returning id`, [P, REST, DRINKS]);
const COOK = await val(`insert into pms_pos_modifier_groups(property_id,outlet_id,name,min_choices,max_choices) values ($1,$2,'Cooking',1,1) returning id`, [P, REST]);
const EXTRAS = await val(`insert into pms_pos_modifier_groups(property_id,outlet_id,name,min_choices,max_choices) values ($1,$2,'Extras',0,2) returning id`, [P, REST]);
const MED = await val(`insert into pms_pos_modifiers(property_id,group_id,name) values ($1,$2,'Medium') returning id`, [P, COOK]);
const WELL = await val(`insert into pms_pos_modifiers(property_id,group_id,name) values ($1,$2,'Well done') returning id`, [P, COOK]);
const XCHEESE = await val(`insert into pms_pos_modifiers(property_id,group_id,name,price,stock_item_id,stock_qty) values ($1,$2,'Extra cheese',3000,$3,0.03) returning id`, [P, EXTRAS, CHEESE]);
const BACON = await val(`insert into pms_pos_modifiers(property_id,group_id,name,price) values ($1,$2,'Bacon',4000) returning id`, [P, EXTRAS]);
const EGG = await val(`insert into pms_pos_modifiers(property_id,group_id,name,price) values ($1,$2,'Fried egg',2000) returning id`, [P, EXTRAS]);
await db.query(`insert into pms_pos_item_modifier_groups(property_id,item_id,group_id) values ($1,$2,$3),($1,$2,$4)`, [P, BURGER, COOK, EXTRAS]);
const T1 = await val(`insert into pms_pos_tables(property_id,outlet_id,name,zone,seats) values ($1,$2,'T1','Terrace',4) returning id`, [P, REST]);
const T2 = await val(`insert into pms_pos_tables(property_id,outlet_id,name,zone,seats) values ($1,$2,'T2','Terrace',2) returning id`, [P, REST]);
const T3 = await val(`insert into pms_pos_tables(property_id,outlet_id,name,zone,seats) values ($1,$2,'T3','Inside',6) returning id`, [P, REST]);
ok('managers set up categories, options and tables', !!(MAINS && COOK && T3));
await asSuper();
await db.query(`insert into pms_recipe_lines(property_id,pos_item_id,stock_item_id,qty) values ($1,$2,$3,0.2)`, [P, BURGER, BEEF]);
await db.query(`insert into pms_stock_moves(property_id,item_id,location_id,qty,kind,unit_cost,value,business_date) values ($1,$2,$3,10,'opening',20000,200000,'2026-10-14'),($1,$4,$3,2,'opening',30000,60000,'2026-10-14')`, [P, BEEF, KITCHEN, CHEESE]);

console.log('Tables and ordering');
await as(U.waiter);
const B1 = await val(`select pms_pos_open_table($1, 2, 'Mr Kimaro')`, [T1]);
ok('opening a table opens a bill on it', !!B1 && (await val(`select table_id from pms_pos_bills where id=$1`, [B1])) === T1);
ok('opening it again returns the same bill', (await val(`select pms_pos_open_table($1)`, [T1])) === B1);
ok('a burger needs its cooking choice', (await err(`select pms_pos_order($1,$2,1,'{}')`, [B1, BURGER])).includes('Choose one cooking'));
ok('…and at most two extras', (await err(`select pms_pos_order($1,$2,1,$3)`, [B1, BURGER, [MED, XCHEESE, BACON, EGG]])).includes('at most 2'));
ok('an option from another item is refused', (await err(`select pms_pos_order($1,$2,1,$3)`, [B1, BEER, [MED]])).includes('does not belong'));
const L1 = await val(`select pms_pos_order($1,$2,2,$3,'No onions',2,1)`, [B1, BURGER, [MED, XCHEESE]]);
const line = (await q(`select * from pms_pos_bill_items where id=$1`, [L1]))[0];
ok('options are priced into the line (25,000 + 3,000) × 2', Number(line.amount) === 56000 && line.name === 'Beef burger (Medium, Extra cheese)');
ok('note, course and seat are kept, and it goes to the kitchen', line.note === 'No onions' && line.course === 2 && line.seat === 1 && line.station === 'kitchen' && line.kitchen_status === 'new');
const L2 = await val(`select pms_pos_order($1,$2,2)`, [B1, BEER]);
const L3 = await val(`select pms_pos_order($1,$2,1)`, [B1, WATER]);
ok('beer goes to the bar; water needs no station and counts as served', (await val(`select station from pms_pos_bill_items where id=$1`, [L2])) === 'bar'
  && (await val(`select kitchen_status from pms_pos_bill_items where id=$1`, [L3])) === 'served');
let bill = (await q(`select * from pms_pos_bills where id=$1`, [B1]))[0];
ok('10% service charge on top: 70,000 + 7,000 = 77,000', Number(bill.subtotal) === 70000 && Number(bill.service_charge) === 7000 && Number(bill.total) === 77000);

console.log('Kitchen and bar');
const tickets = await val(`select pms_pos_send($1)`, [B1]);
ok('sending prints one ticket per station', tickets.length === 2 && tickets.map((t) => t.station).sort().join() === 'bar,kitchen');
const kt = tickets.find((t) => t.station === 'kitchen');
ok('the kitchen ticket shows table, options, note and seat', kt.table === 'T1' && kt.ticket === 1 && kt.items[0].modifiers.includes('Extra cheese') && kt.items[0].note === 'No onions' && kt.items[0].seat === 1);
ok('nothing new to send twice', (await err(`select pms_pos_send($1)`, [B1])).includes('Nothing new'));
ok('a sent line cannot just be deleted', (await err(`select pms_pos_remove_item($1)`, [L1])).includes('Void it'));
await as(U.waiter);
ok('a waiter cannot open the kitchen display', (await err(`select * from pms_pos_kitchen($1)`, [P])).includes('cannot perform'));
await as(U.chef);
const kds = await q(`select * from pms_pos_kitchen($1,'kitchen')`, [P]);
ok('the chef sees the kitchen order with its age', kds.length === 1 && kds[0].table_name === 'T1' && kds[0].minutes >= 0);
ok('the chef starts and finishes it', (await val(`select pms_pos_kitchen_bump($1,'preparing')`, [[L1]])) === 1 && (await val(`select pms_pos_kitchen_bump($1,'ready')`, [[L1]])) === 1);
await db.query(`select pms_pos_set_available($1,false)`, [BURGER]);
await as(U.waiter);
ok('the floor shows the table with one item ready', (await q(`select * from pms_pos_floor($1)`, [REST])).find((t) => t.name === 'T1').ready === 1);
ok('a sold-out item cannot be ordered', (await err(`select pms_pos_order($1,$2,1,$3)`, [B1, BURGER, [WELL]])).includes('not available'));
await db.query(`select pms_pos_kitchen_bump($1,'served')`, [[L1]]);
ok('the waiter marks it served', (await val(`select kitchen_status from pms_pos_bill_items where id=$1`, [L1])) === 'served');

console.log('Voids and table moves');
ok('a waiter cannot void a sent item', (await err(`select pms_pos_void_item($1,'Spilled')`, [L2])).includes('cannot perform'));
await as(U.mgr);
await db.query(`select pms_pos_void_item($1,'Spilled')`, [L2]);
bill = (await q(`select * from pms_pos_bills where id=$1`, [B1]))[0];
ok('a voided beer drops off the bill (58,000 + 5,800)', Number(bill.subtotal) === 58000 && Number(bill.total) === 63800);
await as(U.waiter);
const B2 = await val(`select pms_pos_open_table($1)`, [T2]);
await db.query(`select pms_pos_order($1,$2,1)`, [B2, BEER]);
ok('a bill cannot move onto a busy table', (await err(`select pms_pos_move_table($1,$2)`, [B1, T2])).includes('Merge'));
await db.query(`select pms_pos_move_table($1,$2)`, [B1, T3]);
ok('…but moves to a free one', (await val(`select table_no from pms_pos_bills where id=$1`, [B1])) === 'T3');
await db.query(`select pms_pos_merge_bills($1,$2)`, [B1, B2]);
bill = (await q(`select * from pms_pos_bills where id=$1`, [B1]))[0];
ok('merging brings the other table\'s items across (64,000 + 6,400)', Number(bill.subtotal) === 64000 && Number(bill.total) === 70400);
ok('the emptied bill closes as merged and the table is free', (await val(`select void_reason from pms_pos_bills where id=$1`, [B2])).startsWith('Merged into') && (await q(`select * from pms_pos_floor($1)`, [REST])).find((t) => t.name === 'T2').bill_id === null);

console.log('Split payment, change and drawers');
ok('cash needs an open drawer', (await err(`select pms_pos_pay($1,$2,20000,null,20000)`, [B1, CASH])).includes('drawer'));
const DRAWER = await val(`select pms_open_drawer($1, 50000)`, [P]);
const p1 = await val(`select pms_pos_pay($1,$2,20000,null,50000)`, [B1, CASH]);
ok('cash 50,000 given for 20,000: 30,000 change, 50,400 still due', Number(p1.change) === 30000 && Number(p1.due) === 50400 && p1.settled === false);
ok('mobile money needs a reference', (await err(`select pms_pos_pay($1,$2,30000,null)`, [B1, MPESA])).includes('reference'));
ok('a card cannot pay more than is due', (await err(`select pms_pos_pay($1,$2,60000,'X1')`, [B1, CARD])).includes('left to pay'));
const p2 = await val(`select pms_pos_pay($1,$2,30000,'QK72HD')`, [B1, MPESA]);
ok('M-Pesa 30,000 leaves 20,400', Number(p2.due) === 20400);
ok('a discount cannot take the bill below what is paid', (await as(U.mgr), await err(`select pms_pos_discount($1,30000,'Regular')`, [B1])).includes('already been paid'));
await as(U.waiter);
const p3 = await val(`select pms_pos_pay($1,$2,null,'4411')`, [B1, CARD]);
bill = (await q(`select * from pms_pos_bills where id=$1`, [B1]))[0];
ok('the card pays the rest and the bill settles', p3.settled === true && bill.status === 'settled' && Number(bill.paid) === 70400);
ok('the bill names all three tenders', bill.payment_method_name === 'Card (Visa / Mastercard) + Cash + M-Pesa' || bill.payment_method_name.split(' + ').length === 3);
ok('the drawer expects float + cash only (50,000 + 20,000)', Number(await val(`select pms_drawer_expected($1)`, [DRAWER])) === 70000);

console.log('Part paid, rest to the room');
const B3 = await val(`select pms_pos_open_bill($1,'Pool',1)`, [REST]);
await db.query(`select pms_pos_order($1,$2,3)`, [B3, BEER]);
await db.query(`select pms_pos_pay($1,$2,5000,null,5000)`, [B3, CASH]);
const fl = await val(`select pms_pos_post_to_room($1,$2)`, [B3, STAY]);
await as(U.owner);
ok('only the unpaid 14,800 goes to the folio', Number(await val(`select amount from pms_folio_lines where id=$1`, [fl])) === 14800);

console.log('Happy hour');
await as(U.mgr);
await db.query(`insert into pms_pos_price_rules(property_id,outlet_id,name,category_id,days,starts,ends,kind,value) values ($1,$2,'Sundowner',$3,'{0,1,2,3,4,5,6}','00:00','23:59','percent',50)`, [P, REST, DRINKS]);
await as(U.waiter);
const B4 = await val(`select pms_pos_open_bill($1,'Bar',1)`, [REST]);
const L4 = await val(`select pms_pos_order($1,$2,1)`, [B4, BEER]);
const hh = (await q(`select price, price_rule from pms_pos_bill_items where id=$1`, [L4]))[0];
ok('drinks are half price during the happy hour, and the line says why', Number(hh.price) === 3000 && hh.price_rule === 'Sundowner');
await as(U.mgr);
await db.query(`update pms_pos_price_rules set active = false where property_id=$1`, [P]);
await db.query(`select pms_pos_void_bill($1,'Test')`, [B4]);

console.log('Stock, reports and end of day');
await asSuper();
const beefUsed = Number(await val(`select -sum(qty) from pms_stock_moves where item_id=$1 and kind='sale'`, [BEEF]));
const cheeseUsed = Number(await val(`select -sum(qty) from pms_stock_moves where item_id=$1 and kind='sale'`, [CHEESE]));
ok('2 burgers take 0.4 kg of beef; the extra cheese takes 0.06 kg', beefUsed === 0.4 && cheeseUsed === 0.06, `${beefUsed} ${cheeseUsed}`);
await as(U.owner);
const sales = (await q(`select * from pms_rpt_pos_sales($1,'2026-10-14','2026-10-14')`, [P]))[0];
ok('outlet sales split walk-in tenders from room charges', Number(sales.walk_in) === 75400 && Number(sales.to_rooms) === 14800 && Number(sales.cash) === 25000);
ok('the merged bill is not counted as a void (only the happy-hour test bill is)', sales.voided === 1);
const pmr = await q(`select * from pms_rpt_payment_methods($1,'2026-10-14','2026-10-14')`, [P]);
ok('payments by method show each POS tender', pmr.some((r) => r.method === 'M-Pesa (POS)' && Number(r.amount) === 30000) && pmr.some((r) => r.method === 'Cash (POS)' && Number(r.amount) === 25000));
const z = await val(`select pms_rpt_pos_z($1,'2026-10-14')`, [REST]);
ok('end of day: net, service charge, rooms, tenders, voided items and best sellers', Number(z.net) === 90200 && Number(z.service_charge) === 8200 && Number(z.to_rooms) === 14800
  && z.tenders.length === 3 && z.voided_items.length >= 1 && z.top_items[0].item === 'Beef burger', JSON.stringify(z).slice(0, 400));
const dr = (await q(`select * from pms_rpt_daily_revenue($1,'2026-10-14','2026-10-14')`, [P]))[0];
ok('daily revenue counts outlet tenders and the room part once', Number(dr.fnb) === 75400 + 14800);

console.log('Activities use the same POS');
await asSuper();
const GYM = await val(`insert into pms_pos_outlets(property_id,name,charge_category,outlet_type) values ($1,'Gym','recreation','gym') returning id`, [P]);
const DAY = await val(`insert into pms_pos_items(property_id,outlet_id,name,price,item_type) values ($1,$2,'Day pass',15000,'service') returning id`, [P, GYM]);
await as(U.waiter);
const B5 = await val(`select pms_pos_open_bill($1,null)`, [GYM]);
const L5 = await val(`select pms_pos_order($1,$2,1)`, [B5, DAY]);
ok('a gym day pass needs no kitchen and is paid the same way', (await val(`select kitchen_status from pms_pos_bill_items where id=$1`, [L5])) === 'served'
  && (await val(`select pms_pos_pay($1,$2,null,'QK9')`, [B5, MPESA])).settled === true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
