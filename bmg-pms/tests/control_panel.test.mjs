// Control panel test: super admins create, copy, suspend and adjust properties, invite people, see everything.
// Run: node tests/control_panel.test.mjs
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

const ADMIN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', OWNER = '11111111-1111-1111-1111-111111111111', DESK = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users(id,email) values ('${ADMIN}','balati@bmggroup.co.tz'),('${OWNER}','gm@unrealhomes.co.tz'),('${DESK}','desk@unrealhomes.co.tz')`);
const as = (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`);
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const val = async (sql, p = []) => Object.values(await one(sql, p))[0];
const fails = async (sql, p, match) => { try { await db.query(sql, p); return false; } catch (e) { return !match || String(e.message).includes(match); } };

console.log('Super admin');
// an existing property run by its own owner
await as(OWNER);
const UH = await val(`select pms_create_property('Unreal Homes','UH','GM',$1::jsonb)`, [JSON.stringify([{ name: 'Single', base_rate: 200000, rooms: ['331', '332'] }])]);
await db.query(`insert into pms_stock_locations(property_id,name,kind) values ($1,'Kitchen','kitchen')`, [UH]);
const KIT = await val(`select id from pms_stock_locations where property_id=$1`, [UH]);
const RICE = await val(`insert into pms_stock_items(property_id,name,unit) values ($1,'Rice','kg') returning id`, [UH]);
const OUT = await val(`insert into pms_pos_outlets(property_id,name,stock_location_id) values ($1,'Restaurant',$2) returning id`, [UH, KIT]);
const PILAU = await val(`insert into pms_pos_items(property_id,outlet_id,name,price) values ($1,$2,'Pilau',18000) returning id`, [UH, OUT]);
await db.query(`select pms_set_recipe($1,$2::jsonb)`, [PILAU, JSON.stringify([{ stock_item_id: RICE, qty: 0.25 }])]);
await db.query(`insert into pms_asset_types(property_id,name,replacement_cost) values ($1,'Kettle',45000)`, [UH]);
await db.query(`update pms_business_sources set commission_pct=15 where property_id=$1 and name='Booking.com'`, [UH]);


await as(ADMIN);
ok('nobody is an administrator until bootstrapped', (await val(`select pms_is_super_admin()`)) === false);
ok('the control panel is closed to non-admins', await fails(`select * from pms_admin_overview()`, [], 'platform administrator'));
await as(null);
await db.query(`select pms_bootstrap_super_admin('Balati@BMGgroup.co.tz')`);
await as(ADMIN);
ok('the first admin is made from the SQL Editor, by email', (await val(`select pms_is_super_admin()`)) === true);
await as(OWNER);
ok('after that, only administrators open new properties', await fails(`select pms_create_property('Side hotel')`, [], 'platform administrator'));

console.log('\nCreating properties');
await as(ADMIN);
const created = await val(`select pms_admin_create_property($1::jsonb)`, [JSON.stringify({
  name: 'Pumzika Beach Resort', code: 'pbr', group_name: 'BMG Group International Limited', currency: 'TZS', tax_rate: 18,
  room_types: [{ name: 'Garden Villa', base_rate: 350000, rooms: ['101', '102', '103'] }, { name: 'Ocean Suite', base_rate: 600000, max_occupancy: 3, rooms: ['201', '202'] }],
  copy_from: UH, owner_email: 'resident.manager@pumzika.co.tz', owner_name: 'Resident manager', features: { stock: true, assets: true, pos: true },
})]);
const PBR = created.property_id;
ok('a property is created with its rooms', created.rooms === 5 && Number(await val(`select count(*) from pms_room_types where property_id=$1`, [PBR])) === 2);
ok('the code is stored upper case', (await val(`select code from pms_properties where id=$1`, [PBR])) === 'PBR');
ok('an owner without an account is invited', created.owner === 'invited' && Number(await val(`select count(*) from pms_invites where property_id=$1 and accepted_at is null`, [PBR])) === 1);
ok('rate plans and sources (with commission) are copied', Number(await val(`select commission_pct from pms_business_sources where property_id=$1 and name='Booking.com'`, [PBR])) === 15);
const rec = await one(`select rl.qty, si.property_id sp, o.stock_location_id is not null linked from pms_recipe_lines rl join pms_pos_items pi on pi.id=rl.pos_item_id
  join pms_pos_outlets o on o.id=pi.outlet_id join pms_stock_items si on si.id=rl.stock_item_id where rl.property_id=$1`, [PBR]);
ok('outlets, menus and recipes are copied and point at the new property’s own stock', rec && Number(rec.qty) === 0.25 && rec.sp === PBR && rec.linked);
ok('no stock, guests or money are copied', Number(await val(`select count(*) from pms_stock_moves where property_id=$1`, [PBR])) === 0
  && Number(await val(`select count(*) from pms_guests where property_id=$1`, [PBR])) === 0);
ok('a duplicate code is refused', await fails(`select pms_admin_create_property('{"name":"X","code":"UH"}'::jsonb)`, [], 'already used'));
ok('a room listed twice is refused', await fails(`select pms_admin_create_property($1::jsonb)`, [JSON.stringify({ name: 'Y', room_types: [{ name: 'A', rooms: ['1', '1 '] }, { name: 'B', rooms: ['1'] }] })], 'listed twice'));
const blank = await val(`select pms_admin_create_property('{"name":"Whistling Woods","room_types":[{"name":"Standard","rooms":["1","2"]}],"add_me":true}'::jsonb)`);
ok('without copying, default rate plans and sources are made', Number(await val(`select count(*) from pms_rate_plans where property_id=$1`, [blank.property_id])) === 2);
ok('"add me" makes the admin an owner there', (await val(`select role from pms_members where property_id=$1 and user_id=$2`, [blank.property_id, ADMIN])) === 'owner');
await as(OWNER);
ok('an owner cannot use the control panel', await fails(`select pms_admin_create_property('{"name":"Z"}'::jsonb)`, [], 'platform administrator'));

console.log('\nInvites');
await db.exec(`insert into auth.users(id,email) values ('33333333-3333-3333-3333-333333333333','resident.manager@pumzika.co.tz')`);
await as('33333333-3333-3333-3333-333333333333');
ok('the invite is claimed at first sign-in', (await val(`select pms_claim_invites()`)) === 1);
ok('they are now owner of the new property', (await val(`select role from pms_group_snapshot() where property_id=$1`, [PBR])) === 'owner');
ok('claiming again changes nothing', (await val(`select pms_claim_invites()`)) === 0);
await as(OWNER);
ok('an owner can invite to their own property', (await val(`select pms_add_or_invite_member($1,'chef@unrealhomes.co.tz','storekeeper','Chef')`, [UH])) === 'invited');
ok('…and add someone who has an account', (await val(`select pms_add_or_invite_member($1,'desk@unrealhomes.co.tz','front_desk')`, [UH])) === 'added');
ok('…but not to someone else’s property', await fails(`select pms_add_or_invite_member($1,'x@y.co.tz','manager')`, [PBR], 'not a member'));
ok('a bad email is refused', await fails(`select pms_add_or_invite_member($1,'not-an-email','manager')`, [UH], 'valid email'));

console.log('\nAdjusting properties');
await as(ADMIN);
ok('suspending needs a reason', await fails(`select pms_admin_update_property($1,'{"status":"suspended"}'::jsonb)`, [UH], 'reason'));
await db.query(`select pms_admin_update_property($1,'{"status":"suspended","status_reason":"Contract on hold"}'::jsonb)`, [UH]);
await as(DESK);
ok('staff of a suspended property cannot open it', (await val(`select count(*) from pms_group_snapshot() where property_id=$1`, [UH])) == 0
  && await fails(`select pms_create_reservation($1,'{"first_name":"A"}'::jsonb,current_date,current_date+1,'[{"room_type_id":null}]'::jsonb)`, [UH], 'not a member'));
await db.query(`insert into pms_integrations(property_id,provider,enabled) values ($1,'channex',true)`, [UH]);
await as(null);
ok('its integrations stop', (await db.query(`select * from pms_svc_enabled('channex')`)).rows.length === 0);
await as(ADMIN);
await db.query(`select pms_admin_update_property($1,'{"status":"active"}'::jsonb)`, [UH]);
await as(null);
ok('reactivating restores them', (await db.query(`select * from pms_svc_enabled('channex')`)).rows.length === 1);
await as(ADMIN);
await db.query(`select pms_admin_update_property($1,'{"features":{"stock":false,"assets":true},"admin_notes":"Pilot site"}'::jsonb)`, [UH]);
ok('modules can be switched off per property', (await one(`select features->>'stock' s from pms_properties where id=$1`, [UH])).s === 'false');
await db.query(`select pms_admin_set_business_date($1,'2026-11-01')`, [PBR]);
ok('the go-live business date can be set before anything is posted', (await val(`select business_date::text from pms_properties where id=$1`, [PBR])) === '2026-11-01');
await as(OWNER);
const res = await val(`select pms_create_reservation($1,'{"first_name":"Lulu"}'::jsonb,(select business_date from pms_properties where id=$1),(select business_date+2 from pms_properties where id=$1),$2::jsonb)`,
  [UH, JSON.stringify([{ room_id: await val(`select id from pms_rooms where property_id=$1 and number='331'`, [UH]) }])]);
await db.query(`select pms_post_charge((select id from pms_folios where reservation_id=$1),'other','Test',1000)`, [res.reservation_id]);
await as(ADMIN);
ok('…but not once money has been posted', await fails(`select pms_admin_set_business_date($1,'2026-11-01')`, [UH], 'before the first posting'));

console.log('\nOverview, people, activity');
const ov = (await db.query(`select * from pms_admin_overview()`)).rows;
const uh = ov.find((r) => r.property_id === UH);
ok('the overview lists every property with rooms, owners and activity', ov.length === 3 && uh.rooms === 2 && uh.owners.includes('gm@unrealhomes.co.tz') && uh.pending_invites === 1 && uh.last_activity);
const people = (await db.query(`select * from pms_admin_people()`)).rows;
ok('people lists members and open invites across properties', people.some((p) => p.kind === 'invite' && p.email === 'chef@unrealhomes.co.tz') && people.some((p) => p.kind === 'member' && p.email === 'desk@unrealhomes.co.tz'));
ok('the admin can change anyone’s role anywhere', (await val(`select pms_add_or_invite_member($1,'desk@unrealhomes.co.tz','manager')`, [UH])) === 'added');
const act = (await db.query(`select * from pms_admin_activity(50)`)).rows;
ok('activity shows actions across properties with who did them', act.some((a) => a.action === 'property.admin_update' && a.email === 'balati@bmggroup.co.tz'));
await db.query(`select pms_admin_join_property($1)`, [UH]);
ok('an admin can join a property as owner to work inside it', (await val(`select role from pms_members where property_id=$1 and user_id=$2`, [UH, ADMIN])) === 'owner');
await db.query(`select pms_admin_set_admin('gm@unrealhomes.co.tz', true)`);
ok('admins can add other admins', (await db.query(`select * from pms_admin_list_admins()`)).rows.length === 2);
ok('an admin cannot remove themselves', await fails(`select pms_admin_set_admin('balati@bmggroup.co.tz', false)`, [], 'cannot remove yourself'));
await db.query(`select pms_admin_set_admin('gm@unrealhomes.co.tz', false)`);
ok('…but can remove another', (await db.query(`select * from pms_admin_list_admins()`)).rows.length === 1);
await as(OWNER);
ok('signed-in users cannot run the bootstrap', (await val(`select has_function_privilege('authenticated','pms_bootstrap_super_admin(text)','execute')`)) === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
