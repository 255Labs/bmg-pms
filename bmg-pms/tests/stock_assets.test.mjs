// Stock and assets test: recipes take ingredients out when a POS bill is paid or charged to a room,
// receiving, transfers, waste, counts, food cost; room assets, checks, work orders and damage charges.
// Run: node tests/stock_assets.test.mjs
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
  create table auth.users (id uuid primary key, email text unique);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;`);
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));

const OWNER = '11111111-1111-1111-1111-111111111111', STORE = '55555555-5555-5555-5555-555555555555',
  HK = '44444444-4444-4444-4444-444444444444', DESK = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users values ('${OWNER}','owner@bmg.co.tz'),('${STORE}','store@bmg.co.tz'),('${HK}','hk@bmg.co.tz'),('${DESK}','desk@bmg.co.tz')`);
const as = (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`);
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const val = async (sql, p = []) => Object.values(await one(sql, p))[0];
const fails = async (sql, p, match) => { try { await db.query(sql, p); return false; } catch (e) { return !match || String(e.message).includes(match); } };

await as(OWNER);
const P = await val(`select pms_create_property('Unreal Homes','UH','Balati',$1::jsonb)`, [JSON.stringify([{ name: 'Single', base_rate: 200000, rooms: ['331', '332'] }, { name: 'Double', base_rate: 300000, rooms: ['335'] }])]);
await db.exec(`update pms_properties set business_date = '2026-10-12' where id = '${P}'`);
for (const [e, r] of [['store@bmg.co.tz', 'storekeeper'], ['hk@bmg.co.tz', 'housekeeping'], ['desk@bmg.co.tz', 'front_desk']]) await db.query(`select pms_set_member($1,$2,$3)`, [P, e, r]);
const room = (n) => val(`select id from pms_rooms where property_id=$1 and number=$2`, [P, n]);

// ---------------------------------------------------------------- setup
console.log('Stock setup');
const STOREROOM = await val(`insert into pms_stock_locations(property_id,name,kind) values ($1,'Main store','store') returning id`, [P]);
const KITCHEN = await val(`insert into pms_stock_locations(property_id,name,kind) values ($1,'Kitchen','kitchen') returning id`, [P]);
const BAR = await val(`insert into pms_stock_locations(property_id,name,kind) values ($1,'Pool bar','bar') returning id`, [P]);
const item = (name, unit, reorder = 0) => val(`insert into pms_stock_items(property_id,name,unit,reorder_level) values ($1,$2,$3,$4) returning id`, [P, name, unit, reorder]);
const RICE = await item('Rice', 'kg', 5), CHICKEN = await item('Chicken', 'kg', 3), OIL = await item('Cooking oil', 'l'), BEER = await item('Kilimanjaro lager', 'btl', 24);
const REST = await val(`insert into pms_pos_outlets(property_id,name,stock_location_id) values ($1,'Restaurant',$2) returning id`, [P, KITCHEN]);
const POOL = await val(`insert into pms_pos_outlets(property_id,name,stock_location_id) values ($1,'Pool bar',$2) returning id`, [P, BAR]);
const PILAU = await val(`insert into pms_pos_items(property_id,outlet_id,name,price) values ($1,$2,'Pilau with chicken',18000) returning id`, [P, REST]);
const JUICE = await val(`insert into pms_pos_items(property_id,outlet_id,name,price) values ($1,$2,'Passion juice',5000) returning id`, [P, REST]);
const KILI = await val(`insert into pms_pos_items(property_id,outlet_id,name,price) values ($1,$2,'Kilimanjaro lager',5000) returning id`, [P, POOL]);

await as(STORE);
await db.query(`select pms_receive_stock($1,$2,50,3000,'Kariakoo Traders','INV-881')`, [STOREROOM, RICE]);
await db.query(`select pms_receive_stock($1,$2,20,12000,'Kuku Poa','INV-882')`, [STOREROOM, CHICKEN]);
await db.query(`select pms_receive_stock($1,$2,20,6000,null,null,true)`, [STOREROOM, OIL]);
await db.query(`select pms_receive_stock($1,$2,48,2500,'TBL')`, [BAR, BEER]);
await db.query(`select pms_receive_stock($1,$2,50,3400,'Kariakoo Traders','INV-901')`, [STOREROOM, RICE]);
ok('the storekeeper can receive stock', true);
ok('weighted average cost updates on each delivery', Number(await val(`select avg_cost from pms_stock_items where id=$1`, [RICE])) === 3200);
await as(HK);
ok('housekeeping cannot receive stock', await fails(`select pms_receive_stock($1,$2,1,1)`, [STOREROOM, RICE], 'cannot perform'));
await as(STORE);
ok('staff cannot edit the average cost directly (column permission)', (await val(`select has_column_privilege('authenticated','pms_stock_items','avg_cost','UPDATE')`)) === false
  && (await val(`select has_column_privilege('authenticated','pms_stock_items','reorder_level','UPDATE')`)) === true);
await db.query(`select pms_transfer_stock($1,$2,$3,10,'Issue to kitchen')`, [STOREROOM, KITCHEN, RICE]);
await db.query(`select pms_transfer_stock($1,$2,$3,6,'Issue to kitchen')`, [STOREROOM, KITCHEN, CHICKEN]);
await db.query(`select pms_transfer_stock($1,$2,$3,2,null)`, [STOREROOM, KITCHEN, OIL]);
const lvl = async (it, loc) => Number(await val(`select coalesce((select qty from pms_stock_levels where item_id=$1 and location_id=$2),0)`, [it, loc]));
ok('issuing moves stock from the store to the kitchen', (await lvl(RICE, STOREROOM)) === 90 && (await lvl(RICE, KITCHEN)) === 10);
ok('the store cannot issue more than it holds', await fails(`select pms_transfer_stock($1,$2,$3,500)`, [STOREROOM, KITCHEN, RICE], 'Only 90'));
ok('the ledger cannot be edited', await fails(`update pms_stock_moves set qty=1`, [], 'cannot be changed'));

// ---------------------------------------------------------------- recipes and sales
console.log('\nRecipes and POS sales');
await db.query(`select pms_set_recipe($1,$2::jsonb)`, [PILAU, JSON.stringify([{ stock_item_id: RICE, qty: 0.25 }, { stock_item_id: CHICKEN, qty: 0.3 }, { stock_item_id: OIL, qty: 0.02 }])]);
await db.query(`select pms_set_recipe($1,$2::jsonb)`, [KILI, JSON.stringify([{ stock_item_id: BEER, qty: 1 }])]);
await as(DESK);
ok('front desk cannot change recipes', await fails(`select pms_set_recipe($1,'[]'::jsonb)`, [PILAU], 'cannot perform'));
// a cashier sells: open bill, 4 × pilau + 1 juice (no recipe), pay by card
const bill = await val(`select pms_pos_open_bill($1,'T4',null)`, [REST]);
await db.query(`select pms_pos_add_item($1,$2,4,null,null)`, [bill, PILAU]);
await db.query(`select pms_pos_add_item($1,$2,1,null,null)`, [bill, JUICE]);
ok('nothing leaves the kitchen while the bill is open', (await lvl(RICE, KITCHEN)) === 10);
await db.query(`select pms_pos_settle($1,'card','VISA-1')`, [bill]);
ok('paying the bill takes 4 portions of rice, chicken and oil out of the kitchen',
  (await lvl(RICE, KITCHEN)) === 9 && Math.abs((await lvl(CHICKEN, KITCHEN)) - 4.8) < 1e-9 && Math.abs((await lvl(OIL, KITCHEN)) - 1.92) < 1e-9);
ok('the store is untouched by kitchen sales', (await lvl(RICE, STOREROOM)) === 90);
const saleValue = Number(await val(`select -sum(value) from pms_stock_moves where pos_bill_id=$1`, [bill]));
ok('the sale is costed at average cost', Math.abs(saleValue - (1 * 3200 + 1.2 * 12000 + 0.08 * 6000)) < 0.02, saleValue);
// room charge at the bar
await as(OWNER);
const res = await val(`select pms_create_reservation($1,'{"first_name":"Fred"}'::jsonb,'2026-10-12','2026-10-14',$2::jsonb)`, [P, JSON.stringify([{ room_id: await room('332') }])]);
const STAY = await val(`select id from pms_stays where reservation_id=$1`, [res.reservation_id]);
await db.query(`update pms_rooms set hk_status='clean' where property_id=$1`, [P]);
await db.query(`select pms_check_in($1)`, [STAY]);
await as(DESK);
const bar = await val(`select pms_pos_open_bill($1,null,null)`, [POOL]);
await db.query(`select pms_pos_add_item($1,$2,3,null,null)`, [bar, KILI]);
await db.query(`select pms_pos_post_to_room($1,$2)`, [bar, STAY]);
ok('a bar bill charged to a room takes 3 bottles from the bar', (await lvl(BEER, BAR)) === 45);
await as(OWNER);
await db.query(`select pms_pos_void_bill($1,'Wrong guest')`, [bar]);
ok('voiding the bill puts the bottles back', (await lvl(BEER, BAR)) === 48);
const outletless = await val(`insert into pms_pos_outlets(property_id,name) values ($1,'Laundry') returning id`, [P]);
const shirt = await val(`insert into pms_pos_items(property_id,outlet_id,name,price) values ($1,$2,'Shirt',3000) returning id`, [P, outletless]);
await as(DESK);
const lb = await val(`select pms_pos_open_bill($1,null,null)`, [outletless]);
await db.query(`select pms_pos_add_item($1,$2,2,null,null)`, [lb, shirt]);
await db.query(`select pms_pos_settle($1,'card','V2')`, [lb]);
ok('outlets without a stock location sell normally', (await val(`select status from pms_pos_bills where id=$1`, [lb])) === 'settled');
// a kitchen can run below zero rather than block a sale
await as(DESK);
const big = await val(`select pms_pos_open_bill($1,null,null)`, [REST]);
await db.query(`select pms_pos_add_item($1,$2,40,null,null)`, [big, PILAU]);
await db.query(`select pms_pos_settle($1,'card','V3')`, [big]);
ok('a sale is never blocked; the kitchen shows below zero for the count to catch', (await lvl(RICE, KITCHEN)) === -1);

// ---------------------------------------------------------------- waste, count, reports
console.log('\nWaste, counts and reports');
await as(STORE);
ok('waste needs a reason', await fails(`select pms_record_waste($1,$2,1,'')`, [KITCHEN, CHICKEN], 'Say why'));
await db.query(`select pms_record_waste($1,$2,0.5,'Left out overnight')`, [KITCHEN, CHICKEN]);
await db.query(`select pms_transfer_stock($1,$2,$3,15,null)`, [STOREROOM, KITCHEN, RICE]);
const count = (await db.query(`select * from pms_stock_count($1,$2::jsonb,'Month end')`, [KITCHEN, JSON.stringify([{ item_id: RICE, counted: 13 }, { item_id: CHICKEN, counted: '' }])])).rows;
ok('a count shows expected, counted and the variance in shillings', count.length === 1 && Number(count[0].expected) === 14 && Number(count[0].variance) === -1 && Number(count[0].variance_value) === -3200);
ok('after the count the system matches the shelf', (await lvl(RICE, KITCHEN)) === 13);
await db.query(`update pms_stock_items set reorder_level=10 where id=$1`, [CHICKEN]);   // 6.3 kg left across stores
const levels = (await db.query(`select * from pms_rpt_stock_levels($1)`, [P])).rows;
ok('stock levels list every item at every location with value', levels.some((l) => l.item === 'Rice' && l.location === 'Main store' && Number(l.qty) === 75 && Number(l.value) === 240000));
ok('chicken is flagged low against its reorder level', levels.find((l) => l.item === 'Chicken').low === true && levels.find((l) => l.item === 'Rice').low === false);
const fc = (await db.query(`select * from pms_rpt_food_cost($1,'2026-10-12','2026-10-12')`, [P])).rows;
const pil = fc.find((r) => r.menu_item === 'Pilau with chicken');
ok('food cost: pilau sold 44, cost as a share of sales', Number(pil.qty_sold) === 44 && Number(pil.revenue) === 792000 && Number(pil.cost_pct) > 25 && Number(pil.cost_pct) < 30, JSON.stringify(pil));
ok('menu items with no recipe are shown so they get one', fc.find((r) => r.menu_item === 'Passion juice').has_recipe === false);
ok('the voided beer is not counted as sold', !fc.some((r) => r.menu_item === 'Kilimanjaro lager'));
const use = (await db.query(`select * from pms_rpt_stock_usage($1,'2026-10-12','2026-10-12')`, [P])).rows;
const ch = use.find((u) => u.item === 'Chicken');
ok('usage report: chicken received, sold, wasted', Number(ch.received) === 20 && Math.abs(Number(ch.sold) - 13.2) < 1e-9 && Number(ch.wasted) === 0.5, JSON.stringify(ch));

// ---------------------------------------------------------------- assets
console.log('\nRoom assets');
await as(OWNER);
const TV = await val(`insert into pms_asset_types(property_id,name,category,replacement_cost) values ($1,'Smart TV 43"','electronics',850000) returning id`, [P]);
const KETTLE = await val(`insert into pms_asset_types(property_id,name,category,replacement_cost) values ($1,'Kettle','electronics',45000) returning id`, [P]);
const TOWEL = await val(`insert into pms_asset_types(property_id,name,category,replacement_cost) values ($1,'Bath towel','linen',25000) returning id`, [P]);
const SGL = await val(`select id from pms_room_types where property_id=$1 and name='Single'`, [P]);
ok('adding a kettle to every Single room creates one per room', (await val(`select pms_add_assets($1,$2,null,$3,1)`, [P, KETTLE, SGL])) === 2);
await db.query(`select pms_add_assets($1,$2,null,$3,2)`, [P, TOWEL, SGL]);
await db.query(`select pms_add_assets($1,$2,$3,null,1,'TV-0332',800000)`, [P, TV, await room('332')]);
ok('a tag belongs to one item only', await fails(`select pms_add_assets($1,$2,$3,null,1,'TV-0332')`, [P, TV, await room('331')]));
ok('room 332 holds a TV, a kettle and 2 towels', Number(await val(`select count(*) from pms_assets where room_id=$1`, [await room('332')])) === 3);
await as(DESK);
ok('front desk cannot add assets', await fails(`select pms_add_assets($1,$2,$3)`, [P, KETTLE, await room('335')], 'cannot perform'));
// guest leaves 332: housekeeping checks the room
const a332 = (await db.query(`select a.id, t.name from pms_assets a join pms_asset_types t on t.id=a.asset_type_id where a.room_id=$1`, [await room('332')])).rows;
const idOf = (n) => a332.find((a) => a.name.startsWith(n)).id;
await as(HK);
const insp = await val(`select pms_inspect_room($1,$2::jsonb,$3,'After check-out')`, [await room('332'), JSON.stringify([
  { asset_id: idOf('Smart TV'), condition: 'damaged', note: 'Cracked screen' }, { asset_id: idOf('Kettle'), condition: 'missing' }, { asset_id: idOf('Bath towel'), condition: 'good' }]), STAY]);
ok('the check lists two issues with replacement costs', insp.checked === 3 && insp.issues.length === 2 && insp.issues.find((i) => i.item === 'Kettle').replacement_cost === 45000);
const wo = (await db.query(`select title, priority from pms_work_orders where property_id=$1 order by created_at`, [P])).rows;
ok('each issue opens a work order; missing is high priority', wo.length === 2 && wo.some((w) => w.title === 'Missing: Kettle in room 332' && w.priority === 'high') && wo.some((w) => w.title.startsWith('Damaged: Smart TV')));
await db.query(`select pms_inspect_room($1,$2::jsonb)`, [await room('332'), JSON.stringify([{ asset_id: idOf('Kettle'), condition: 'missing' }])]);
ok('checking again does not open a second work order', Number(await val(`select count(*) from pms_work_orders where property_id=$1`, [P])) === 2);
ok('an item from another room cannot be checked here', await fails(`select pms_inspect_room($1,$2::jsonb)`, [await room('331'), JSON.stringify([{ asset_id: idOf('Kettle'), condition: 'good' }])], 'not in room'));
await as(HK);
ok('housekeeping cannot charge a guest', await fails(`select pms_charge_asset($1,$2,45000)`, [idOf('Kettle'), STAY], 'cannot perform'));
await as(DESK);
const folio = await val(`select id from pms_folios where stay_id=$1`, [STAY]);
const before = Number(await val(`select balance from pms_folio_balances where folio_id=$1`, [folio]));
await db.query(`select pms_charge_asset($1,$2,45000,'Guest agreed')`, [idOf('Kettle'), STAY]);
ok('charging the guest posts a damage line on their folio', Number(await val(`select balance from pms_folio_balances where folio_id=$1`, [folio])) === before + 45000
  && (await val(`select description from pms_folio_lines where folio_id=$1 and category='damage'`, [folio])) === 'Missing kettle (room 332)');
ok('the same item cannot be charged twice for one stay', await fails(`select pms_charge_asset($1,$2,45000)`, [idOf('Kettle'), STAY], 'already charged'));
await as(HK);
await db.query(`select pms_inspect_room($1,$2::jsonb)`, [await room('332'), JSON.stringify([{ asset_id: idOf('Kettle'), condition: 'good', note: 'Found in 335' }])]);
ok('an item found again is recorded as found', (await val(`select kind from pms_asset_events where asset_id=$1 order by id desc limit 1`, [idOf('Kettle')])) === 'found');
await db.query(`select pms_move_asset($1,$2,'Swapped')`, [idOf('Bath towel'), await room('331')]);
ok('moving an item keeps its history', (await val(`select count(*) from pms_asset_events where asset_id=$1 and kind='moved'`, [idOf('Bath towel')])) == 1);
await as(OWNER);
await db.query(`select pms_retire_asset($1,'Beyond repair')`, [idOf('Smart TV')]);
ok('a retired item leaves the room check list but stays on record', (await val(`select condition from pms_assets where id=$1`, [idOf('Smart TV')])) === 'retired');
ok('every check is recorded', Number(await val(`select count(*) from pms_room_inspections where property_id=$1`, [P])) === 3);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
