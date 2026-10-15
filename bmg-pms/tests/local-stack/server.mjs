// Local stand-in for Supabase: PGlite (Postgres 17) + real PostgREST + a tiny auth endpoint.
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import jwt from 'jsonwebtoken';

const APP = new URL('../..', import.meta.url).pathname;
const SECRET = 'super-secret-jwt-token-with-at-least-32-characters';
const db = new PGlite({ extensions: { btree_gist } });

await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create role authenticator login noinherit; grant anon, authenticated to authenticator;
  create schema auth;
  create table auth.users (id uuid primary key, email text unique, password text, created_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(current_setting('request.jwt.claims', true)::json->>'sub',
                           current_setting('test.uid', true)), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`);
for (const f of readdirSync(join(APP, 'supabase/migrations')).sort()) await db.exec(readFileSync(join(APP, 'supabase/migrations', f), 'utf8'));
await db.exec(`grant usage on schema public to anon;`);

// Seed: owner + a property shaped like Unreal Homes with live data
const OWNER = '11111111-1111-1111-1111-111111111111', FD = '33333333-3333-3333-3333-333333333333';
await db.exec(`insert into auth.users values ('${OWNER}','bbalati@bmggroup.co.tz','demo1234'), ('${FD}','frontdesk@bmggroup.co.tz','demo1234')`);
await db.exec(`select set_config('test.uid','${OWNER}',false)`);
const setup = [
  { name: 'Single', code: 'SGL', base_rate: 200000, max_occupancy: 1, rooms: ['331', '332', '333', '334', '336', '337', '338', '339'] },
  { name: 'Double', code: 'DBL', base_rate: 300000, max_occupancy: 2, rooms: ['335', '340'] },
];
const P = (await db.query(`select pms_create_property('Unreal Homes','UH','Balati',$1::jsonb) id`, [JSON.stringify(setup)])).rows[0].id;
await db.query(`select pms_create_property('Whistling Woods Bakehouse','WW','Balati','[{"name":"Standard","base_rate":150000,"rooms":["101","102","103","104"]}]'::jsonb)`);
await db.exec(`update pms_properties set business_date='2026-10-07', address='Dar es Salaam', phone='+255 700 000 000', tin='123-456-789' where id='${P}'`);
await db.query(`select pms_set_member($1,'frontdesk@bmggroup.co.tz','front_desk','Juma')`, [P]);
await db.query(`insert into pms_companies(property_id,name,phone,credit_limit) values ($1,'Hinno Engineering','+255711000000',5000000)`, [P]);
const room = async (n) => (await db.query(`select id from pms_rooms where property_id=$1 and number=$2`, [P, n])).rows[0].id;
const book = async (g, a, d, r, extra = {}) => (await db.query(
  `select pms_create_reservation($1,$2::jsonb,$3,$4,$5::jsonb,(select id from pms_business_sources where property_id=$1 and name=$6)) r`,
  [P, JSON.stringify(g), a, d, JSON.stringify([{ room_id: r ? await room(r) : null, room_type_id: extra.type ?? null, rate: extra.rate ?? null }]), extra.src ?? 'Walk-in'])).rows[0].r;
const stayOf = async (res) => (await db.query(`select id from pms_stays where reservation_id=$1`, [res.reservation_id])).rows[0].id;
const guests = [
  [{ title: 'Mr.', first_name: 'Moga', last_name: 'Kulwa', phone: '+255754000001' }, '331', '2026-10-12', '2026-10-13'],
  [{ title: 'Mr.', first_name: 'Fred', last_name: 'Muoka Mutiso' }, '332', '2026-10-12', '2026-10-28', 'Booking.com'],
  [{ title: 'Mr.', first_name: 'Puka', last_name: 'Joseph' }, '333', '2026-10-12', '2026-10-13'],
  [{ title: 'Mr.', first_name: 'Joseph', last_name: 'Chitinka' }, '336', '2026-10-12', '2026-10-13'],
  [{ title: 'Ms.', first_name: 'Ritha', last_name: 'Ambonisye' }, '337', '2026-10-12', '2026-10-26', 'Direct / Phone'],
  [{ title: 'Mr.', first_name: 'Karim', last_name: 'Abdul' }, '338', '2026-10-12', '2026-10-13'],
  [{ title: 'Mr.', first_name: 'Jonathan', last_name: 'Tilas' }, '339', '2026-10-12', '2026-10-24', 'Expedia'],
];
// A stayover with five nights of history, like the eZee example
{
  const lulu = await book({ title: 'Ms.', first_name: 'Lulu', last_name: 'Kayanda', phone: '0768569836', email: 'lulu.kayanda@example.com', nationality: 'Tanzania' }, '2026-10-07', '2026-10-13', '334', { src: 'Direct / Phone' });
  const ls = await stayOf(lulu);
  await db.query(`select pms_check_in($1)`, [ls]);
  const lf = (await db.query(`select id from pms_folios where stay_id=$1`, [ls])).rows[0].id;
  const pays = { '2026-10-08': ['1a11a6b0c17c5836'], '2026-10-09': ['1a1203c87ac9e802'], '2026-10-10': ['1a124c83b72698e4', '003-1a1274f12ae08bfe'], '2026-10-11': ['003-1a12a93212655bf3'] };
  for (const day of ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']) {
    for (const ref of pays[day] ?? []) await db.query(`select pms_post_payment($1,200000,'bank',$2)`, [lf, 'CRDB ' + ref]);
    await db.query(`select pms_run_night_audit($1)`, [P]);
  }
}
for (const [g, r, a, d, src] of guests) {
  const res = await book(g, a, d, r, { src });
  await db.query(`select pms_check_in($1)`, [await stayOf(res)]);
}
await book({ title: 'Dr.', first_name: 'Amina', last_name: 'Said' }, '2026-10-12', '2026-10-15', null, { type: (await db.query(`select id from pms_room_types where property_id=$1 and name='Double'`, [P])).rows[0].id, src: 'Website' });
await book({ title: 'Mr.', first_name: 'Baraka', last_name: 'Mwita' }, '2026-10-16', '2026-10-19', '335', { src: 'Booking.com' });
await db.query(`select pms_block_room($1,'2026-10-20','2026-10-23','AC servicing')`, [await room('340')]);
await db.query(`select pms_set_room_status($1,'dirty')`, [await room('333')]);
const f1 = (await db.query(`select f.id from pms_folios f join pms_stays s on s.id=f.stay_id join pms_rooms r on r.id=s.room_id where r.number='331' and r.property_id=$1`, [P])).rows[0].id;
await db.query(`select pms_open_drawer($1, 50000)`, [P]);
await db.query(`select pms_post_charge($1,'fnb','Dinner — restaurant bill 0042',35000,'0042')`, [f1]);
await db.query(`select pms_post_payment($1,100000,'mobile_money','QJK7H2L9XA')`, [f1]);

// ---- back office and integrations demo data
await db.query(`select set_config('test.uid','${OWNER}',false)`);
const rest = (await db.query(`insert into pms_pos_outlets(property_id,name,charge_category) values ($1,'Restaurant','fnb') returning id`, [P])).rows[0].id;
const bar = (await db.query(`insert into pms_pos_outlets(property_id,name,charge_category) values ($1,'Pool bar','fnb') returning id`, [P])).rows[0].id;
const lau = (await db.query(`insert into pms_pos_outlets(property_id,name,charge_category) values ($1,'Laundry','laundry') returning id`, [P])).rows[0].id;
for (const [o, g, n, pr] of [[rest,'Mains','Pilau with chicken',18000],[rest,'Mains','Grilled tilapia',25000],[rest,'Mains','Beef mishkaki',20000],[rest,'Breakfast','Full breakfast',15000],[rest,'Drinks','Fresh passion juice',5000],[rest,'Drinks','Bottled water',2000],[bar,'Beer','Kilimanjaro lager',5000],[bar,'Beer','Safari lager',5000],[bar,'Soft','Coca-Cola',2500],[lau,'Wash and iron','Shirt',3000],[lau,'Wash and iron','Trousers',4000],[lau,'Dry clean','Suit',15000]])
  await db.query(`insert into pms_pos_items(property_id,outlet_id,group_name,name,price) values ($1,$2,$3,$4,$5)`, [P, o, g, n, pr]);
await db.query(`insert into pms_travel_agents(property_id,name,commission_pct,phone) values ($1,'Kilimanjaro Safaris',10,'+255 713 000 111'),($1,'Zanzibar Tours',12,'+255 777 000 222')`, [P]);
await db.query(`insert into pms_sales_persons(property_id,name) values ($1,'Neema'),($1,'Baraka')`, [P]);
await db.query(`update pms_reservations set travel_agent_id=(select id from pms_travel_agents where property_id=$1 and name='Kilimanjaro Safaris'), sales_person_id=(select id from pms_sales_persons where property_id=$1 and name='Neema') where property_id=$1 and res_no in (1,3)`, [P]);
await db.query(`insert into pms_packages(property_id,name,price_mode,price,min_nights,inclusions) values ($1,'Weekend escape','per_stay',500000,2,'Breakfast and dinner')`, [P]);
await db.query(`insert into pms_promotions(property_id,code,name,discount_pct) values ($1,'KARIBU10','Karibu 10%',10)`, [P]);
await db.query(`select pms_set_exchange_rate($1,'USD',2650)`, [P]);
await db.query(`select pms_set_exchange_rate($1,'EUR',2880)`, [P]);
await db.query(`insert into pms_lost_found(property_id,description,location,found_by) values ($1,'Black sunglasses','Pool deck','Asha'),($1,'Phone charger',null,'Juma')`, [P]);
await db.query(`insert into pms_integrations(property_id,provider,enabled,config) values ($1,'channex',true,'{"property_id":"716305c4-561a-4561-a187-7f5b8aeb5920"}'),($1,'ttlock',true,'{"staff_usernames":["hk.asha"],"last_sync":"2026-10-12T19:55:00Z"}'),($1,'hikvision',true,'{}'),($1,'fiscal',true,'{"url":"https://vfd.example/api"}')`, [P]);
const rid = async (n) => (await db.query(`select id from pms_rooms where property_id=$1 and number=$2`, [P, n])).rows[0].id;
for (const n of ['331','332','333','334','336','337','338','339','335','340'])
  await db.query(`insert into pms_external_ids(property_id,provider,entity,entity_id,external_id) values ($1,'ttlock','room',$2,$3),($1,'hikvision','room',$2,$4)`, [P, await rid(n), '50' + n, String(Number(n) - 330)]);
await db.query(`select pms_svc_ingest_door_events($1,$2::jsonb)`, [P, JSON.stringify([
  { record_id: 'd1', lock_id: '50340', time_ms: Date.parse('2026-10-11T23:14:00+03:00'), record_type: 4, method: 'passcode', success: true, username: '582913' },
  { record_id: 'd2', lock_id: '50340', time_ms: Date.parse('2026-10-11T23:15:00+03:00'), record_type: 4, method: 'passcode', success: true, username: '582913' },
  { record_id: 'd3', lock_id: '50335', time_ms: Date.parse('2026-10-11T10:00:00+03:00'), record_type: 7, method: 'card', success: true, username: 'hk.asha' },
  { record_id: 'd4', lock_id: '50334', time_ms: Date.parse('2026-10-11T18:22:00+03:00'), record_type: 4, method: 'passcode', success: true, username: 'Lulu' }])]);
await db.query(`select pms_svc_ingest_camera_events($1,$2::jsonb)`, [P, JSON.stringify([{ channel: '10', event_type: 'linedetection', time: '2026-10-11T23:13:40+03:00' }])]);
await db.query(`select pms_svc_channex_ingest($1,$2::jsonb)`, [P, JSON.stringify({ id: 'rev-demo', booking_id: 'bk-demo', status: 'new', ota_name: 'Booking.com', ota_reservation_code: '4412098331', currency: 'USD',
  arrival_date: '2026-10-18', departure_date: '2026-10-21', customer: { name: 'Anna', surname: 'Berg', mail: 'anna@example.com', country: 'SE' },
  rooms: [{ room_type_id: 'unmapped', amount: '240.00', occupancy: { adults: 2 } }] })]);
const lfol = (await db.query(`select f.id from pms_folios f join pms_stays s on s.id=f.stay_id join pms_rooms r on r.id=s.room_id where r.number='339' and r.property_id=$1`, [P])).rows[0].id;
await db.query(`select pms_post_payment($1,200000,'card','VISA-4417')`, [lfol]);
await db.query(`insert into pms_jobs(property_id,provider,kind,status,attempts,last_error) values ($1,'ttlock','issue_passcode','failed',8,'TTLock add passcode: gateway offline')`, [P]);
const mres = (await db.query(`select reservation_id from pms_stays s join pms_rooms r on r.id=s.room_id where r.number='332' and s.property_id=$1`, [P])).rows[0].reservation_id;
await db.query(`insert into pms_guest_messages(property_id,reservation_id,from_name,message) values ($1,$2,'Mr. Otieno (office)','Please call back about Thursday''s meeting')`, [P, mres]);
// platform demo: Tenda ICO key + room charges, restrictions, a successful Channex call
await db.query(`select set_config('test.uid','${OWNER}',false)`);
await db.query(`select pms_create_api_key($1,'Restaurant till')`, [P]);
await db.query(`select pms_create_api_key($1,'Pool bar till')`, [P]);
const st332 = (await db.query(`select s.id from pms_stays s join pms_rooms r on r.id=s.room_id where r.number='332' and s.property_id=$1 and s.status='checked_in'`, [P])).rows[0].id;
await db.query(`select pms_svc_pos_charge($1,'tendaico','TND-20441',$2,'332',38000,'fnb','Restaurant','Restaurant bill TND-20441','[{"name":"Grilled tilapia","qty":1,"amount":25000},{"name":"Passion juice","qty":2,"amount":13000}]'::jsonb)`, [P, st332]);
await db.query(`select pms_svc_pos_charge($1,'tendaico','TND-20457',$2,'332',10000,'fnb','Pool bar')`, [P, st332]);
await db.query(`select pms_svc_pos_charge($1,'tendaico','TND-20460',$2,'332',5000,'fnb','Pool bar')`, [P, st332]);
await db.query(`select pms_svc_pos_void($1,'tendaico','TND-20460','Rang twice')`, [P]);
await db.query(`update pms_api_keys set last_used_at=now() where property_id=$1 and name='Restaurant till'`, [P]);
await db.query(`insert into pms_integration_log(property_id,provider,direction,action,ok,status_code) values ($1,'tendaico','in','room_charge',true,201),($1,'channex','out','availability',true,200)`, [P]);
const sgl = (await db.query(`select id from pms_room_types where property_id=$1 and name='Single'`, [P])).rows[0].id;
const bb = (await db.query(`select id from pms_rate_plans where property_id=$1 order by name limit 1`, [P])).rows[0].id;
await db.query(`select pms_set_restrictions($1,$2,$3,'2026-10-16','2026-10-18',2,false,false,false)`, [P, sgl, bb]);
await db.query(`select pms_set_restrictions($1,$2,$3,'2026-10-24','2026-10-24',1,true,false,false)`, [P, sgl, bb]);
// stock + assets demo
await db.query(`select set_config('test.uid','${OWNER}',false)`);
const loc = async (n, k) => (await db.query(`insert into pms_stock_locations(property_id,name,kind) values ($1,$2,$3) returning id`, [P, n, k])).rows[0].id;
const STO = await loc('Main store', 'store'), KIT = await loc('Kitchen', 'kitchen'), PBAR = await loc('Pool bar', 'bar');
await db.query(`update pms_pos_outlets set stock_location_id=$2 where id=$1`, [rest, KIT]);
await db.query(`update pms_pos_outlets set stock_location_id=$2 where id=$1`, [bar, PBAR]);
const sitem = async (n, u, r) => (await db.query(`insert into pms_stock_items(property_id,name,unit,category,reorder_level) values ($1,$2,$3,$4,$5) returning id`, [P, n, u, r[0], r[1]])).rows[0].id;
const SI = {
  rice: await sitem('Rice', 'kg', ['Dry goods', 10]), chicken: await sitem('Chicken', 'kg', ['Meat', 8]), tilapia: await sitem('Tilapia', 'kg', ['Fish', 5]),
  beef: await sitem('Beef', 'kg', ['Meat', 5]), oil: await sitem('Cooking oil', 'l', ['Dry goods', 5]), passion: await sitem('Passion fruit', 'kg', ['Fruit', 3]),
  kili: await sitem('Kilimanjaro lager', 'btl', ['Beer', 24]), safari: await sitem('Safari lager', 'btl', ['Beer', 24]), coke: await sitem('Coca-Cola 300ml', 'btl', ['Soft drinks', 24]),
};
const recv = (l, i, q, c, s) => db.query(`select pms_receive_stock($1,$2,$3,$4,$5,'DN-'||floor(random()*900+100)::int)`, [l, i, q, c, s]);
await recv(STO, SI.rice, 50, 3200, 'Kariakoo Traders'); await recv(STO, SI.chicken, 25, 12000, 'Kuku Poa'); await recv(STO, SI.tilapia, 12, 14000, 'Feri Market');
await recv(STO, SI.beef, 15, 13000, 'Vingunguti Abattoir'); await recv(STO, SI.oil, 20, 6000, 'Kariakoo Traders'); await recv(STO, SI.passion, 6, 4000, 'Feri Market');
await recv(PBAR, SI.kili, 48, 2500, 'TBL'); await recv(PBAR, SI.safari, 18, 2500, 'TBL'); await recv(PBAR, SI.coke, 30, 900, 'Coca-Cola Kwanza');
for (const [i, q] of [[SI.rice, 12], [SI.chicken, 8], [SI.tilapia, 6], [SI.beef, 5], [SI.oil, 4], [SI.passion, 3]]) await db.query(`select pms_transfer_stock($1,$2,$3,$4,'Issue to kitchen')`, [STO, KIT, i, q]);
const pitem = async (o, n) => (await db.query(`select id from pms_pos_items where outlet_id=$1 and name=$2`, [o, n])).rows[0].id;
const recipe = (it, lines) => db.query(`select pms_set_recipe($1,$2::jsonb)`, [it, JSON.stringify(lines.map(([s, q]) => ({ stock_item_id: s, qty: q })))]);
await recipe(await pitem(rest, 'Pilau with chicken'), [[SI.rice, 0.25], [SI.chicken, 0.3], [SI.oil, 0.02]]);
await recipe(await pitem(rest, 'Grilled tilapia'), [[SI.tilapia, 0.45], [SI.oil, 0.03]]);
await recipe(await pitem(rest, 'Beef mishkaki'), [[SI.beef, 0.3], [SI.oil, 0.01]]);
await recipe(await pitem(rest, 'Fresh passion juice'), [[SI.passion, 0.15]]);
await recipe(await pitem(bar, 'Kilimanjaro lager'), [[SI.kili, 1]]);
await recipe(await pitem(bar, 'Safari lager'), [[SI.safari, 1]]);
await recipe(await pitem(bar, 'Coca-Cola'), [[SI.coke, 1]]);
for (const [o, lines] of [[rest, [['Pilau with chicken', 6], ['Grilled tilapia', 3], ['Fresh passion juice', 5]]], [bar, [['Kilimanjaro lager', 14], ['Safari lager', 9], ['Coca-Cola', 4]]], [rest, [['Beef mishkaki', 4], ['Pilau with chicken', 3]]]]) {
  const b = (await db.query(`select pms_pos_open_bill($1,null,null) id`, [o])).rows[0].id;
  for (const [nm, q] of lines) await db.query(`select pms_pos_add_item($1,$2,$3,null,null)`, [b, await pitem(o, nm), q]);
  await db.query(`select pms_pos_settle($1,'card','DEMO')`, [b]);
}
await db.query(`select pms_record_waste($1,$2,0.4,'Left out of the fridge')`, [KIT, SI.chicken]);
// room assets
const atype = async (n, c, cost) => (await db.query(`insert into pms_asset_types(property_id,name,category,replacement_cost) values ($1,$2,$3,$4) returning id`, [P, n, c, cost])).rows[0].id;
const AT = { tv: await atype('Smart TV 43"', 'electronics', 850000), kettle: await atype('Electric kettle', 'electronics', 45000), hair: await atype('Hair dryer', 'electronics', 60000),
  towel: await atype('Bath towel', 'linen', 25000), robe: await atype('Bathrobe', 'linen', 55000), safe: await atype('In-room safe', 'fixture', 300000), remote: await atype('TV remote', 'electronics', 30000) };
for (const rt of (await db.query(`select id from pms_room_types where property_id=$1`, [P])).rows)
  for (const [t, q] of [[AT.tv, 1], [AT.remote, 1], [AT.kettle, 1], [AT.hair, 1], [AT.towel, 2], [AT.robe, 2], [AT.safe, 1]]) await db.query(`select pms_add_assets($1,$2,null,$3,$4)`, [P, t, rt.id, q]);
const r333 = (await db.query(`select id from pms_rooms where property_id=$1 and number='333'`, [P])).rows[0].id;
const rem = (await db.query(`select a.id from pms_assets a where a.room_id=$1 and a.asset_type_id=$2`, [r333, AT.remote])).rows[0].id;
const rob = (await db.query(`select a.id from pms_assets a where a.room_id=$1 and a.asset_type_id=$2`, [r333, AT.robe])).rows[0].id;
await db.query(`select pms_inspect_room($1,$2::jsonb)`, [r333, JSON.stringify([{ asset_id: rem, condition: 'missing' }, { asset_id: rob, condition: 'damaged', note: 'Stain on sleeve' }])]);

// platform admin demo
await db.query(`select pms_bootstrap_super_admin('bbalati@bmggroup.co.tz')`);
await db.query(`select set_config('test.uid','${OWNER}',false)`);
await db.query(`select pms_admin_create_property($1::jsonb)`, [JSON.stringify({ name: 'Kibo Hill Lodge', room_types: [{ name: 'Cottage', base_rate: 280000, rooms: ['C1','C2','C3','C4'] }], owner_email: 'gm@kibohill.co.tz', owner_name: 'General manager' })]);
await db.query(`select pms_admin_create_property($1::jsonb)`, [JSON.stringify({ name: 'Pumzika Beach Resort', room_types: [{ name: 'Garden Villa', base_rate: 350000, rooms: ['101','102','103','104','105','106'] }], copy_from: P, owner_email: 'rm@pumzika.co.tz' })]);
await db.query(`select pms_admin_update_property((select id from pms_properties where name='Kibo Hill Lodge'), '{"status":"suspended","status_reason":"Renovation until December"}'::jsonb)`);
// mobile money + SMS demo
await db.query(`insert into pms_integrations(property_id,provider,enabled,config) values ($1,'clickpesa',true,'{}'),($1,'sms',true,'{"sender_id":"UNREALHOMES"}')`, [P]);
const lulu = (await db.query(`select f.id from pms_folios f join pms_stays s on s.id=f.stay_id join pms_rooms r on r.id=s.room_id where r.number='334' and s.property_id=$1`, [P])).rows[0].id;
await db.query(`update pms_guests set phone='0754 000 333' where id=(select guest_id from pms_folios where id=$1)`, [lulu]);
const rq1 = (await db.query(`select pms_request_mobile_payment($1,'0754000333',200000) r`, [lulu])).rows[0].r;
await db.query(`select pms_svc_payment_sent($1,true,'PROCESSING','TXN81',null)`, [rq1.id]);
await db.query(`update pms_payment_requests set created_at=now()-interval '2 hours' where id=$1`, [rq1.id]);
await db.query(`select pms_svc_payment_result($1,'SUCCESS',200000,'TXN81')`, [rq1.order_ref]);
await db.query(`update pms_payment_requests set created_at=now()-interval '5 minutes' where id=$1`, [rq1.id]);
const rq2 = (await db.query(`select pms_request_mobile_payment($1,'0754000333',150000) r`, [lulu])).rows[0].r;
await db.query(`select pms_svc_payment_sent($1,true,'PROCESSING','TXN82',null)`, [rq2.id]);
await db.query(`insert into pms_sms_out(property_id,kind,to_phone,body,status,provider_ref,sent_at) values ($1,'door_code','255754000333','Karibu Lulu! Your door code for room 334 at Unreal Homes is 482915. It works until 13 Oct 11:00.','sent','35918915',now()),($1,'manual','255713000111','Your airport transfer is booked for 06:00 tomorrow.','sent','35918916',now())`, [P]);

// ---- activities: games room with pool tables, gym memberships, pool passes, spa
await db.exec(`select set_config('test.uid','${OWNER}',false)`);
const act = async (name, type, cat) => (await db.query(`insert into pms_pos_outlets(property_id,name,outlet_type,charge_category) values ($1,$2,$3,$4) returning id`, [P, name, type, cat])).rows[0].id;
const GAMES = await act('Games room', 'games', 'recreation'), GYM = await act('Gym', 'gym', 'recreation'), POOLX = await act('Swimming pool', 'pool', 'recreation'), SPA = await act('Spa', 'spa', 'spa');
const ai = async (o, name, price, t, x = {}) => (await db.query(`insert into pms_pos_items(property_id,outlet_id,name,group_name,price,item_type,duration_minutes,min_units,grace_minutes,resources,validity_days,visits_included)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`, [P, o, name, x.group ?? null, price, t, x.block ?? null, x.min ?? 1, x.grace ?? 0, x.res ?? null, x.days ?? null, x.visits ?? null])).rows[0].id;
const TBL = await ai(GAMES, 'Pool table', 5000, 'timed', { block: 30, grace: 5, res: ['Table 1', 'Table 2', 'Table 3'], group: 'Tables' });
await ai(GAMES, 'Darts (per hour)', 3000, 'timed', { block: 60, group: 'Tables' });
await ai(GAMES, 'Table tennis bats hire', 2000, 'service', { group: 'Hire' });
const GM = await ai(GYM, 'Monthly membership', 150000, 'membership', { days: 30, group: 'Memberships' });
await ai(GYM, '3-month membership', 400000, 'membership', { days: 90, group: 'Memberships' });
await ai(GYM, 'Day pass', 15000, 'service', { group: 'Passes' });
await ai(GYM, 'Personal trainer (1 h)', 40000, 'service', { group: 'Training' });
const P10 = await ai(POOLX, '10-swim pass', 60000, 'membership', { days: 60, visits: 10, group: 'Passes' });
await ai(POOLX, 'Day pass (non-resident)', 20000, 'service', { group: 'Passes' });
await ai(POOLX, 'Towel hire', 3000, 'service', { group: 'Extras' });
await ai(SPA, 'Swedish massage 60 min', 80000, 'service', { group: 'Massage' });
await ai(SPA, 'Hot stone 90 min', 120000, 'service', { group: 'Massage' });
await ai(SPA, 'Manicure', 35000, 'service', { group: 'Beauty' });
const gb = (await db.query(`select pms_pos_open_bill($1,'Mr Baraka') id`, [GAMES])).rows[0].id;
const gl = (await db.query(`select pms_pos_start_timer($1,$2,'Table 1') id`, [gb, TBL])).rows[0].id;
await db.query(`update pms_pos_bill_items set started_at = now() - interval '38 minutes' where id=$1`, [gl]);
const gb2 = (await db.query(`select pms_pos_open_bill($1,'Room 337') id`, [GAMES])).rows[0].id;
const gl2 = (await db.query(`select pms_pos_start_timer($1,$2,'Table 3') id`, [gb2, TBL])).rows[0].id;
await db.query(`update pms_pos_bill_items set started_at = now() - interval '12 minutes' where id=$1`, [gl2]);
for (const [n, ph] of [['Neema Mushi', '0713 000 444'], ['Hamisi Juma', '0754 210 999'], ['Grace Lyimo', '0688 123 456']]) {
  const b = (await db.query(`select pms_pos_open_bill($1,null) id`, [GYM])).rows[0].id;
  await db.query(`select pms_pos_add_membership($1,$2,$3,$4)`, [b, GM, n, ph]);
  await db.query(`select pms_pos_settle($1,'mobile_money','MP-' || floor(random()*99999)::text)`, [b]);
}
const pb = (await db.query(`select pms_pos_open_bill($1,null) id`, [POOLX])).rows[0].id;
await db.query(`select pms_pos_add_membership($1,$2,'Asha Kombo','0715 555 010')`, [pb, P10]);
await db.query(`select pms_pos_settle($1,'cash')`, [pb]);
for (const m of (await db.query(`select id, outlet_id from pms_memberships where property_id=$1 limit 3`, [P])).rows) await db.query(`select pms_activity_check_in($1,$2)`, [m.outlet_id, m.id]);
await db.query(`select pms_activity_check_in($1,null,null,'Day visitor (Mr Kimaro)')`, [GYM]);

// ---- restaurant service: categories, options, tables, a happy hour, open tables with orders in the kitchen
await db.exec(`select set_config('test.uid','${OWNER}',false)`);
const cat = async (o, n, st, so) => (await db.query(`insert into pms_pos_categories(property_id,outlet_id,name,station,sort_order) values ($1,$2,$3,$4,$5) returning id`, [P, o, n, st, so])).rows[0].id;
const CM = await cat(rest, 'Mains', 'kitchen', 1), CB = await cat(rest, 'Breakfast', 'kitchen', 2), CD = await cat(rest, 'Drinks', 'bar', 3), CBEER = await cat(bar, 'Beer', 'bar', 1), CSOFT = await cat(bar, 'Soft', 'bar', 2);
for (const [o, g, c] of [[rest, 'Mains', CM], [rest, 'Breakfast', CB], [rest, 'Drinks', CD], [bar, 'Beer', CBEER], [bar, 'Soft', CSOFT]])
  await db.query(`update pms_pos_items set category_id=$3 where outlet_id=$1 and group_name=$2`, [o, g, c]);
const mg = async (n, min, max) => (await db.query(`insert into pms_pos_modifier_groups(property_id,outlet_id,name,min_choices,max_choices) values ($1,$2,$3,$4,$5) returning id`, [P, rest, n, min, max])).rows[0].id;
const MG_COOK = await mg('How cooked', 1, 1), MG_SIDE = await mg('Side', 0, 2);
const mod = async (g, n, pr = 0, so = 0) => (await db.query(`insert into pms_pos_modifiers(property_id,group_id,name,price,sort_order) values ($1,$2,$3,$4,$5) returning id`, [P, g, n, pr, so])).rows[0].id;
const M_MED = await mod(MG_COOK, 'Medium', 0, 1); await mod(MG_COOK, 'Well done', 0, 2); await mod(MG_COOK, 'Rare', 0, 0);
const M_CHIPS = await mod(MG_SIDE, 'Chips', 3000, 1); await mod(MG_SIDE, 'Ugali', 2000, 2); await mod(MG_SIDE, 'Kachumbari', 1500, 3);
const MISH = await pitem(rest, 'Beef mishkaki'), TIL = await pitem(rest, 'Grilled tilapia');
await db.query(`insert into pms_pos_item_modifier_groups(property_id,item_id,group_id,sort_order) values ($1,$2,$3,1),($1,$2,$4,2),($1,$5,$4,1)`, [P, MISH, MG_COOK, MG_SIDE, TIL]);
await db.query(`update pms_pos_outlets set uses_tables=true, service_charge_pct=5 where id=$1`, [rest]);
await db.query(`update pms_pos_outlets set uses_tables=true where id=$1`, [bar]);
for (const [o, names, zone] of [[rest, ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'], 'Inside'], [rest, ['Terrace 1', 'Terrace 2'], 'Terrace'], [bar, ['Bar 1', 'Bar 2', 'Pool deck'], 'Pool']])
  for (const [n, i] of names.map((x, k) => [x, k])) await db.query(`insert into pms_pos_tables(property_id,outlet_id,name,zone,seats,sort_order) values ($1,$2,$3,$4,4,$5)`, [P, o, n, zone, i]);
const tbl = async (o, n) => (await db.query(`select id from pms_pos_tables where outlet_id=$1 and name=$2`, [o, n])).rows[0].id;
await db.query(`insert into pms_pos_price_rules(property_id,outlet_id,name,category_id,days,starts,ends,kind,value) values ($1,$2,'Happy hour',$3,'{1,2,3,4,5}','17:00','19:00','percent',20)`, [P, bar, CBEER]);
const t2 = (await db.query(`select pms_pos_open_table($1,3,null) id`, [await tbl(rest, 'T2')])).rows[0].id;
await db.query(`select pms_pos_order($1,$2,2,$3::uuid[],'One without onions',1,null)`, [t2, MISH, [M_MED, M_CHIPS]]);
await db.query(`select pms_pos_order($1,$2,1,'{}'::uuid[],null,1,null)`, [t2, await pitem(rest, 'Pilau with chicken')]);
await db.query(`select pms_pos_order($1,$2,3,'{}'::uuid[],null,1,null)`, [t2, await pitem(rest, 'Fresh passion juice')]);
await db.query(`select pms_pos_send($1,null)`, [t2]);
await db.query(`update pms_pos_bill_items set sent_at = now() - interval '14 minutes' where bill_id=$1`, [t2]);
const t5 = (await db.query(`select pms_pos_open_table($1,2,null) id`, [await tbl(rest, 'T5')])).rows[0].id;
await db.query(`select pms_pos_order($1,$2,1,$3::uuid[],null,1,null)`, [t5, TIL, [M_CHIPS]]);
await db.query(`select pms_pos_send($1,null)`, [t5]);
const ready = (await db.query(`select array_agg(id) a from pms_pos_bill_items where bill_id=$1`, [t5])).rows[0].a;
await db.query(`select pms_pos_kitchen_bump($1::uuid[],'ready')`, [ready]);
const tb = (await db.query(`select pms_pos_open_table($1,4,null) id`, [await tbl(bar, 'Pool deck')])).rows[0].id;
await db.query(`select pms_pos_order($1,$2,4,'{}'::uuid[],null,1,null)`, [tb, await pitem(bar, 'Kilimanjaro lager')]);
await db.query(`select pms_pos_send($1,null)`, [tb]);

// ---- stores and procurement: suppliers, purchase units, an order waiting for approval, one part delivered and invoiced, a store request
const sup = async (n, ph, terms, tin) => (await db.query(`insert into pms_suppliers(property_id,name,contact_name,phone,payment_terms_days,tin) values ($1,$2,$3,$4,$5,$6) returning id`, [P, n, n.split(' ')[0], ph, terms, tin])).rows[0].id;
const S_KAR = await sup('Kariakoo Traders', '0713 400 100', 14, '104-221-998'), S_KUKU = await sup('Kuku Poa', '0754 300 200', 7, null), S_TBL = await sup('TBL (Tanzania Breweries)', '0222 862 000', 30, '100-146-304'),
  S_COKE = await sup('Coca-Cola Kwanza', '0222 450 600', 30, null), S_FERI = await sup('Feri Market', '0688 900 300', 0, null);
for (const [it, u, n, sp, sku] of [[SI.rice, 'bag 25 kg', 25, S_KAR, 'DRY-RICE'], [SI.oil, 'jerrycan 20 l', 20, S_KAR, 'DRY-OIL'], [SI.chicken, 'kg', 1, S_KUKU, 'MEAT-CHK'], [SI.kili, 'crate of 25', 25, S_TBL, 'BEER-KILI'],
  [SI.safari, 'crate of 25', 25, S_TBL, 'BEER-SAF'], [SI.coke, 'crate of 24', 24, S_COKE, 'SOFT-COKE'], [SI.tilapia, 'kg', 1, S_FERI, 'FISH-TIL'], [SI.passion, 'kg', 1, S_FERI, 'FRUIT-PAS'], [SI.beef, 'kg', 1, S_KUKU, 'MEAT-BEEF']])
  await db.query(`update pms_stock_items set purchase_unit=$2, units_per_purchase=$3, default_supplier_id=$4, sku=$5 where id=$1`, [it, u, n, sp, sku]);
await db.query(`update pms_properties set settings = jsonb_set(coalesce(settings,'{}'),'{procurement}','{"approval_limit":500000}') where id=$1`, [P]);
await db.query(`insert into pms_stock_par(property_id,location_id,item_id,par_level,reorder_level) values ($1,$2,$3,72,30),($1,$2,$4,72,30),($1,$5,$6,20,8)`, [P, PBAR, SI.kili, SI.safari, KIT, SI.chicken]);
const po1 = (await db.query(`select pms_po_save($1,$2::jsonb) id`, [P, JSON.stringify({ supplier_id: S_TBL, location_id: PBAR, expected_date: '2026-10-15', notes: 'Deliver before 10:00 please',
  lines: [{ item_id: SI.kili, qty: 6, unit_price: 55000, vat_pct: 18 }, { item_id: SI.safari, qty: 4, unit_price: 55000, vat_pct: 18 }] })])).rows[0].id;
await db.query(`select pms_po_submit($1)`, [po1]);
const po2 = (await db.query(`select pms_po_save($1,$2::jsonb) id`, [P, JSON.stringify({ supplier_id: S_KAR, location_id: STO,
  lines: [{ item_id: SI.rice, qty: 4, unit_price: 78000, vat_pct: 0 }, { item_id: SI.oil, qty: 1, unit_price: 115000, vat_pct: 18 }] })])).rows[0].id;
await db.query(`select pms_po_submit($1)`, [po2]);
const pl = (await db.query(`select id, item_id from pms_po_lines where po_id=$1`, [po2])).rows;
await db.query(`select pms_grn_post($1,$2::jsonb)`, [P, JSON.stringify({ po_id: po2, delivery_note: 'KT-7781', lines: pl.map((l) => ({ po_line_id: l.id, qty: l.item_id === SI.rice ? 3 : 1, unit_cost: l.item_id === SI.rice ? 78000 : 118000 })) })]);
const gl3 = (await db.query(`select g.id, g.item_id, g.qty, g.unit_cost, g.vat_pct from pms_grn_lines g join pms_goods_receipts r on r.id=g.grn_id where r.po_id=$1`, [po2])).rows;
await db.query(`select pms_supplier_invoice_save($1,$2::jsonb)`, [P, JSON.stringify({ supplier_id: S_KAR, invoice_no: 'KT/INV/2291', invoice_date: '2026-10-13',
  lines: gl3.map((g) => ({ grn_line_id: g.id, qty: Number(g.qty), unit_price: Number(g.unit_cost), vat_pct: Number(g.vat_pct) })) })]);
await db.query(`select pms_grn_post($1,$2::jsonb)`, [P, JSON.stringify({ supplier_id: S_FERI, location_id: STO, delivery_note: 'Cash market buy', lines: [{ item_id: SI.tilapia, qty: 8, unit_cost: 14500 }] })]);
await db.query(`select pms_store_request($1,$2::jsonb)`, [P, JSON.stringify({ from_location_id: STO, to_location_id: KIT, needed_by: '2026-10-14', notes: "For tonight's buffet",
  lines: [{ item_id: SI.rice, qty: 10 }, { item_id: SI.chicken, qty: 6 }, { item_id: SI.oil, qty: 3 }] })]);

// ---- packages: BMG's price list for the add-ons (the platform administrator sets these)
await db.query(`update pms_catalog set monthly_price = v.p, per_room_price = v.r from (values ('pos',120000,0),('activities',80000,0),('stock',60000,0),('procurement',90000,0),('quickbooks',50000,0),
  ('channex',60000,1500),('booking_engine',40000,0),('sms',25000,0),('ttlock',30000,1000),('hikvision',30000,0),('fiscal',35000,0),('city_ledger',30000,0)) v(k,p,r) where key = v.k`);
await db.query(`update pms_property_addons set monthly_price_override = 90000, note = 'Launch discount for the first year' where property_id=$1 and key='pos'`, [P]);
await db.query(`update pms_property_addons set free_until = '2026-12-31', note = 'Free while we set it up together' where property_id=$1 and key='quickbooks'`, [P]);

// ---- occupancy audit: what each camera watches, a night of sightings at the entrance and the rooms, then the audit
await db.exec(`select set_config('test.uid','${OWNER}',false)`);
await db.query(`insert into pms_camera_zones(property_id, channel, name, kind, room_id)
  select x.property_id, x.external_id, 'Room ' || r.number || ' door', 'room', x.entity_id from pms_external_ids x join pms_rooms r on r.id = x.entity_id
  where x.property_id = $1 and x.provider = 'hikvision' and x.entity = 'room' on conflict do nothing`, [P]);
await db.query(`insert into pms_camera_zones(property_id, device, channel, name, kind) values ($1,'08:cc:81:16:ff:14','20','Front entrance','entrance'),($1,'08:cc:81:16:ff:14','21','Reception','reception')`, [P]);
await db.exec(`select set_config('test.uid','',false)`);
const sight = (ch, t, target = 'human', device = '') => ({ device, channel: ch, event_type: 'vmd', time: t, target, hits: 3 + Math.floor(Math.random() * 6), ended: new Date(Date.parse(t) + 25000).toISOString() });
await db.query(`select pms_svc_ingest_camera_events($1,$2::jsonb)`, [P, JSON.stringify([
  ...['07:40', '09:15', '11:02', '13:30', '16:45', '18:10', '19:55', '21:20', '22:05', '23:14'].map((h) => sight('20', `2026-10-11T${h}:00+03:00`, 'human', '08:cc:81:16:ff:14')),
  sight('10', '2026-10-11T23:15:00+03:00'), sight('10', '2026-10-12T00:40:00+03:00'),
  sight('5', '2026-10-11T10:02:00+03:00'), sight('4', '2026-10-11T18:25:00+03:00'), sight('3', '2026-10-11T20:10:00+03:00', 'vehicle'),
])]);
await db.exec(`select set_config('test.uid','${OWNER}',false)`);
await db.query(`select pms_audit_settings($1,'{"alert_phones":["0754000111"]}'::jsonb)`, [P]);
// the demo's check-ins happened "now"; give them the times they would have had on their real days
await db.exec(`select set_config('test.uid','',false)`);
await db.query(`update pms_stays set checked_in_at = (arrival + time '14:00') at time zone 'Africa/Dar_es_Salaam',
  checked_out_at = case when status = 'checked_out' then (departure + time '10:00') at time zone 'Africa/Dar_es_Salaam' end
  where property_id = $1 and status in ('checked_in','checked_out')`, [P]);
await db.exec(`select set_config('test.uid','${OWNER}',false)`);
await db.query(`select pms_audit_run($1,'2026-10-05','2026-10-12')`, [P]);

// ---- configuration demo: lists, policies, booking engine, transport, a housekeeper
await db.exec(`select set_config('test.uid','${OWNER}',false)`);
await db.exec(`insert into auth.users(id,email,password) values ('44444444-4444-4444-4444-444444444444','housekeeping@bmggroup.co.tz','demo1234')`);
await db.query(`select pms_set_member($1,'housekeeping@bmggroup.co.tz','housekeeping','Mama Upendo')`, [P]);
// custom roles: front desk without cancellations or the night audit; a revenue manager who only prices and reports
const FOA_ROLE = await (async () => (await db.query(`select pms_save_custom_role($1,null,'Front Office Associate','front_desk','Desk staff on shift',
  (select array_agg(key) from pms_privilege_catalog where 'front_desk' = any(default_roles) and key not in ('res.cancel','fo.night_audit'))) id`, [P])).rows[0].id)();
await db.query(`select pms_save_custom_role($1,null,'Revenue Manager','manager','Prices, restrictions and reports',
  (select array_agg(key) from pms_privilege_catalog where key = 'rates.edit' or grp = 'rpt'))`, [P]);
// a VIP guest for the stay view marks
await db.query(`update pms_guests set attributes='{VIP}' where property_id=$1 and first_name='Fred'`, [P]);
await db.query(`select pms_set_member_access($1,(select id from auth.users where email='frontdesk@bmggroup.co.tz'),$2,'{"cash.void":true}'::jsonb)`, [P, FOA_ROLE]);
await db.query(`update pms_properties set property_type='Apartments', star_rating='4 stars', website='https://unrealhomes.co.tz', reservation_phone='0740 042 042',
  city='Dar es Salaam', region='Dar es Salaam', latitude=-6.7735, longitude=39.2421, reg_numbers='{"Company TIN":"181-170-832"}',
  highlights='{"5 minutes from Mlimani City","Secure parking and 24-hour security","Fully equipped kitchenettes"}',
  amenities='{"Free Wi-Fi","Air conditioning","Parking","Kitchenette","Generator back-up"}',
  policies='{"hotel":"No cots or extra beds are available. Smoking only on balconies.","cancellation":"Free cancellation up to 48 hours before arrival; after that the first night is charged.","checkin":"Check-in from 14:00 with a valid ID or passport."}',
  settings = settings || '{"booking_engine":{"enabled":true,"default_status":"confirmed","require_terms":true,"max_rooms":3,"intro":"Karibu! Book direct for our best rate."},"weekend_days":[5,6]}'
  where id=$1`, [P]);
await db.query(`insert into pms_extra_charges(property_id,name,category,amount,charge_mode) values ($1,'Laundry bag','laundry',15000,'once'),($1,'Extra bed','extra_bed',40000,'per_night'),($1,'Airport parking','transport',10000,'once')`, [P]);
await db.query(`insert into pms_discount_types(property_id,name,kind,value,applies_to) values ($1,'Long stay 10%','percent',10,'room'),($1,'Returning guest','fixed',20000,'all')`, [P]);
await db.query(`update pms_meal_plans set adult_rate=25000, child_rate=12000 where property_id=$1 and code='BB'`, [P]);
await db.query(`update pms_transport_types set rate=60000 where property_id=$1`, [P]);
await db.query(`insert into pms_holidays(property_id,holiday_date,name) values ($1,'2026-10-14','Nyerere Day'),($1,'2026-12-09','Independence Day')`, [P]);
await db.query(`insert into pms_payout_types(property_id,name) values ($1,'Taxi'),($1,'Pharmacy')`, [P]);
await db.query(`update pms_room_types set extra_adult_rate=50000, extra_child_rate=20000, base_adults=1, max_adults=2, bed_type='Queen bed', size_sqm=28, description='Bright one-bedroom apartment with kitchenette.' where property_id=$1 and name='Single'`, [P]);
await db.query(`insert into pms_rate_plans(property_id,name,meal_plan,parent_id,derive_mode,derive_value,cancellation_policy) select $1,'Bed and breakfast','BB',id,'amount',25000,'Free cancellation up to 48 hours before arrival' from pms_rate_plans where property_id=$1 order by name limit 1`, [P]);
await db.query(`select pms_save_rate_grid($1,$2::jsonb)`, [P, JSON.stringify([
  { room_type_id: (await db.query(`select id from pms_room_types where property_id=$1 and name='Single'`, [P])).rows[0].id, rate_plan_id: (await db.query(`select id from pms_rate_plans where property_id=$1 order by name limit 1`, [P])).rows[0].id, date: '2026-10-16', amount: 230000, min_stay: 2 },
  { room_type_id: (await db.query(`select id from pms_room_types where property_id=$1 and name='Double'`, [P])).rows[0].id, rate_plan_id: (await db.query(`select id from pms_rate_plans where property_id=$1 order by name limit 1`, [P])).rows[0].id, date: '2026-10-17', stop_sell: true }])]);
{
  const rr = (await db.query(`select r.id from pms_reservations r join pms_stays s on s.reservation_id=r.id join pms_rooms rm on rm.id=s.room_id where rm.number='337' and r.property_id=$1 limit 1`, [P])).rows[0];
  const tt = (await db.query(`select id from pms_transport_types where property_id=$1 order by name limit 1`, [P])).rows[0].id;
  if (rr) await db.query(`select pms_set_booking_details($1,$2::jsonb)`, [rr.id, JSON.stringify({ dropoff: { type_id: tt, at: '2026-10-12T05:30', flight: 'TC 106' }, market_segment_id: (await db.query(`select id from pms_market_segments where property_id=$1 and name='Corporate'`, [P])).rows[0].id })]);
}
// ---- BMG subscription demo: Unreal Homes paid last month and has this month's invoice due soon;
// Upanga Lodge is locked for an unpaid invoice (sign in as owner@upanga.co.tz to see the lock screen).
{
  await db.query(`update pms_subscriptions set trial_ends = pms__today('Africa/Dar_es_Salaam') - 75, billing_day = 1, status = 'active' where property_id = $1`, [P]);
  const today = (await db.query(`select pms__today('Africa/Dar_es_Salaam') d`)).rows[0].d;
  const last = (await db.query(`select (date_trunc('month', $1::date) - interval '1 month')::date d`, [today])).rows[0].d;
  const old = (await db.query(`select pms__issue_invoice($1, $2::date) id`, [P, last])).rows[0].id;
  await db.query(`insert into pms_sub_payments(invoice_id, property_id, amount, method, status, reference, paid_at) select id, property_id, total, 'bank', 'queued', 'CRDB 77310', now() - interval '25 days' from pms_sub_invoices where id=$1 returning id`, [old])
    .then((r) => db.query(`select pms__apply_sub_payment($1, (select total from pms_sub_invoices where id=$2))`, [r.rows[0].id, old]));
  const cur = (await db.query(`select pms__issue_invoice($1, $2::date) id`, [P, today])).rows[0].id;
  await db.query(`update pms_sub_invoices set due_on = $2::date + 2 where id = $1`, [cur, today]);
  await db.query(`select pms__billing_refresh($1, $2::date)`, [P, today]);
  await db.exec(`select set_config('test.uid','${OWNER}',false)`);
  const L = (await db.query(`select pms_create_property('Upanga Lodge','UL','BMG Group International','[{"name":"Standard","base_rate":90000,"rooms":["101","102","103"]}]'::jsonb) id`)).rows[0].id;
  await db.query(`update pms_subscriptions set trial_ends = $2::date - 60, billing_day = 1 where property_id = $1`, [L, today]);
  const li = (await db.query(`select pms__issue_invoice($1, $2::date) id`, [L, last])).rows[0].id;
  await db.query(`update pms_sub_invoices set due_on = $2::date - 12 where id = $1`, [li, today]);
  await db.query(`select pms__billing_refresh($1, $2::date)`, [L, today]);
  // the locked lodge has its own owner (not a platform administrator, who is never locked out)
  await db.exec(`insert into auth.users(id,email,password) values ('77777777-7777-7777-7777-777777777777','owner@upanga.co.tz','demo1234')`);
  await db.query(`select pms_set_member($1,'owner@upanga.co.tz','owner','Lodge owner')`, [L]);
}
console.log('seeded property', P);

const sock = new PGLiteSocketServer({ db, port: 5433, host: '127.0.0.1', maxConnections: 10 });
await sock.start();

const pgrst = spawn('./postgrest', [], {
  env: { ...process.env, PGRST_DB_URI: 'postgres://authenticator@127.0.0.1:5433/postgres', PGRST_DB_SCHEMAS: 'public',
    PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: SECRET, PGRST_DB_POOL: '1', PGRST_SERVER_PORT: '3001',
    PGRST_DB_CHANNEL_ENABLED: 'false', PGRST_DB_PREPARED_STATEMENTS: 'false' },
  stdio: 'inherit',
});
process.on('exit', () => pgrst.kill());

const users = (await db.query(`select id, email, password from auth.users`)).rows;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  if (req.url.startsWith('/auth/v1/token')) {
    const { email, password } = JSON.parse(body || '{}');
    const u = users.find((x) => x.email === email && x.password === password);
    if (!u) { res.writeHead(400, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials' })); }
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const user = { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    const access_token = jwt.sign({ sub: u.id, role: 'authenticated', email: u.email, aud: 'authenticated', exp }, SECRET);
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    return res.end(JSON.stringify({ access_token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user }));
  }
  if (req.url.startsWith('/auth/v1/')) { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end('{}'); }
  if (req.url.startsWith('/rest/v1/')) {
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length']; if (headers.authorization === 'Bearer demo') delete headers.authorization; // the demo anon key is not a JWT
    const r = await fetch('http://127.0.0.1:3001' + req.url.slice(8), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const out = Buffer.from(await r.arrayBuffer());
    const h = { ...cors }; r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) h[k] = v; });
    res.writeHead(r.status, h); return res.end(out);
  }
  let p = join(APP, 'dist', req.url.split('?')[0]);
  if (!existsSync(p) || req.url === '/') p = join(APP, 'dist/index.html');
  res.writeHead(200, { 'content-type': mime[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(54321, () => console.log('ready on http://localhost:54321'));
