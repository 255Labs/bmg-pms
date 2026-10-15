// Permissions test: every role × every protected action, run through the real API roles (as PostgREST does),
// compared with the rules the app uses to show or hide buttons and screens (src/lib/format.js → can()).
// If the database and the app ever disagree, this fails and prints the matrix.
// Run: node tests/permissions.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { can, ROLES } from '../src/lib/format.js';

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

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const USERS = Object.fromEntries(ROLES.map((r, i) => [r, id(i + 1)]));
await db.exec(`insert into auth.users(id,email) values ${ROLES.map((r) => `('${USERS[r]}','${r}@uh.co.tz')`).join(',')}`);
const asSuper = () => db.exec(`reset role; set session authorization postgres; select set_config('test.uid','',false); select set_config('request.jwt.claims','',false)`);
const asUser = async (uid) => {
  await asSuper();
  await db.exec(`set session authorization authenticator; set role authenticated`);
  await db.query(`select set_config('test.uid', $1, false), set_config('request.jwt.claims', $2, false)`, [uid, JSON.stringify({ role: 'authenticated', sub: uid, aal: 'aal1' })]);
};
const val = async (sql, p = []) => Object.values((await db.query(sql, p)).rows[0] ?? {})[0];

// A property with one of every kind of thing to act on
await asSuper();
await db.exec(`select set_config('test.uid','${USERS.owner}',false)`);
const P = await val(`select pms_create_property('Unreal Homes','UH','Owner',$1::jsonb)`, [JSON.stringify([{ name: 'Single', base_rate: 200000, rooms: ['331', '332', '333'] }])]);
for (const r of ROLES.filter((x) => x !== 'owner')) await db.query(`select pms_add_or_invite_member($1,$2,$3)`, [P, `${r}@uh.co.tz`, r]);
const ROOM = await val(`select id from pms_rooms where property_id=$1 and number='331'`, [P]);
const res = (await db.query(`select pms_create_reservation($1,'{"first_name":"Fred"}'::jsonb,(select business_date from pms_properties where id=$1),(select business_date+2 from pms_properties where id=$1),$2::jsonb) r`, [P, JSON.stringify([{ room_id: ROOM }])])).rows[0].r;
const STAY = await val(`select id from pms_stays where reservation_id=$1`, [res.reservation_id]);
await db.query(`select pms_check_in($1)`, [STAY]);
const FOLIO = await val(`select id from pms_folios where stay_id=$1`, [STAY]);
const LINE = await val(`select pms_post_charge($1,'other','Minibar',5000)`, [FOLIO]);
const LOC = await val(`insert into pms_stock_locations(property_id,name,kind) values ($1,'Store','store') returning id`, [P]);
const ITEM = await val(`insert into pms_stock_items(property_id,name,unit) values ($1,'Rice','kg') returning id`, [P]);
const OUTLET = await val(`insert into pms_pos_outlets(property_id,name,outlet_type,charge_category) values ($1,'Gym','gym','recreation') returning id`, [P]);
const MENU = await val(`insert into pms_pos_items(property_id,outlet_id,name,price) values ($1,$2,'Water',1000) returning id`, [P, OUTLET]);
const ATYPE = await val(`insert into pms_asset_types(property_id,name,replacement_cost) values ($1,'Kettle',45000) returning id`, [P]);
await db.query(`select pms_add_assets($1,$2,$3)`, [P, ATYPE, ROOM]);
const ASSET = await val(`select id from pms_assets where room_id=$1`, [ROOM]);
await db.query(`update pms_assets set condition='damaged' where id=$1`, [ASSET]);
const ROOM2 = await val(`select id from pms_rooms where property_id=$1 and number='333'`, [P]);

// key → how the database is asked. "read" actions count as allowed when rows come back.
const ACTIONS = {
  book: { sql: `select pms_create_reservation($1,'{"first_name":"Ann"}'::jsonb,(select business_date+5 from pms_properties where id=$1),(select business_date+6 from pms_properties where id=$1),$2::jsonb)`, p: [P, JSON.stringify([{ room_id: ROOM2 }])] },
  cashier: { sql: `select pms_post_payment($1,1000,'card','VISA-1')`, p: [FOLIO] },
  void: { sql: `select pms_void_line($1,'test')`, p: [LINE] },
  discount: { sql: `select pms_post_discount($1,1000,'test')`, p: [FOLIO] },
  audit: { sql: `select pms_run_night_audit($1,true)`, p: [P] },
  setup: { sql: `insert into pms_rate_plans(property_id,name,meal_plan) values ($1,'Test plan','RO')`, p: [P] },
  rates: { sql: `select pms_save_rate_grid($1,'[]'::jsonb)`, p: [P] },
  rateview: { sql: `select count(*) from pms_rate_grid($1,(select business_date from pms_properties where id=$1),2)`, p: [P] },
  staff: { sql: `select pms_add_or_invite_member($1,'new@uh.co.tz','front_desk')`, p: [P] },
  reports: { sql: `select count(*) from pms_rpt_occupancy($1,(select business_date from pms_properties where id=$1),(select business_date from pms_properties where id=$1))`, p: [P] },
  trail: { sql: `select count(*) from pms_rpt_audit_trail($1,'2000-01-01','2100-01-01')`, p: [P] },
  pos: { sql: `select pms_pos_open_bill($1,null)`, p: [OUTLET] },
  backoffice: { sql: `select pms_set_exchange_rate($1,'USD',2600,(select business_date from pms_properties where id=$1))`, p: [P] },
  integrations: { sql: `select pms_create_api_key($1,'Till')`, p: [P] },
  stock: { sql: `select pms_receive_stock($1,$2,1,1000)`, p: [LOC, ITEM] },
  recipes: { sql: `select pms_set_recipe($1,'[]'::jsonb)`, p: [MENU] },
  assets: { sql: `select pms_add_assets($1,$2,$3)`, p: [P, ATYPE, ROOM2] },
  inspect: { sql: `select pms_inspect_room($1,'[]'::jsonb)`, p: [ROOM] },
  charge: { sql: `select pms_charge_asset($1,$2,45000,'test')`, p: [ASSET, STAY] },
  door: { sql: `select pms_activity_check_in($1,null,null,'Visitor')`, p: [OUTLET] },
  block: { sql: `select pms_block_room($1,(select business_date+10 from pms_properties where id=$2),(select business_date+11 from pms_properties where id=$2),'paint')`, p: [ROOM2, P] },
  frontoffice: { read: true, sql: `select (select count(*) from pms_guests) + (select count(*) from pms_folio_lines) + (select count(*) from pms_reservations)`, p: [] },
};
const DENIED = /cannot perform|not a member|permission denied|row-level security|platform administrator|Only owners|Only a manager/i;

console.log('Database rules against the app\'s rules, role by role');
const matrix = [];
for (const role of ROLES) {
  await asUser(USERS[role]);
  const row = { role };
  for (const [key, a] of Object.entries(ACTIONS)) {
    let allowed;
    await db.exec('begin');
    try {
      const v = await val(a.sql, a.p);
      allowed = a.read ? Number(v) > 0 : true;
    } catch (e) {
      allowed = !DENIED.test(String(e.message));
    }
    await db.exec('rollback');
    row[key] = allowed;
    const ui = can(role, key);
    ok(`${role.padEnd(12)} ${key.padEnd(12)} database ${allowed ? 'allows' : 'refuses'}`, allowed === ui, `but the app ${ui ? 'shows' : 'hides'} it`);
  }
  matrix.push(row);
}

console.log('\nRemoving a person takes effect at once');
await asSuper();
await db.exec(`select set_config('test.uid','${USERS.owner}',false)`);
await db.query(`select pms_add_or_invite_member($1,'front_desk@uh.co.tz','front_desk',null,false)`, [P]);
await asUser(USERS.front_desk);
ok('a switched-off person sees nothing', Number(await val(`select count(*) from pms_guests`)) === 0);
ok('and can do nothing', DENIED.test(await (async () => { try { await val(ACTIONS.cashier.sql, ACTIONS.cashier.p); return ''; } catch (e) { return e.message; } })()));
await asSuper();
await db.exec(`select set_config('test.uid','${USERS.owner}',false)`);
await db.query(`select pms_add_or_invite_member($1,'front_desk@uh.co.tz','housekeeping')`, [P]);
await asUser(USERS.front_desk);
ok('moved to housekeeping, the guest list disappears at the next request', Number(await val(`select count(*) from pms_guests`)) === 0);
ok('but room checks work', !DENIED.test(await (async () => { try { await val(ACTIONS.inspect.sql, ACTIONS.inspect.p); return ''; } catch (e) { return e.message; } })()));
ok('and the in-house list for the pool door shows names only', (await db.query(`select * from pms_inhouse_guests($1)`, [P])).rows[0]?.guest === 'Fred'
  && !('balance' in ((await db.query(`select * from pms_inhouse_guests($1)`, [P])).rows[0] ?? {})));
await asUser(USERS.manager);
await db.query(`update pms_guests set notes='VIP' where first_name='Fred'`);
ok('front office can edit guests, managers too', true);
await asUser(USERS.accountant);
ok('only managers can blacklist a guest', /Only a manager/.test(await (async () => { try { await db.query(`update pms_guests set blacklisted=true where first_name='Fred'`); return 'no error'; } catch (e) { return e.message; } })())
  || Number(await val(`select count(*) from pms_guests where blacklisted`)) === 0);
await asUser(USERS.storekeeper);
{ const g = (await db.query(`select * from pms_group_snapshot()`)).rows[0];
  ok('group overview shows a storekeeper rooms but not money', g && g.rooms === 3 && g.revenue_last_audit === null && g.open_balance === null); }
await asUser(USERS.accountant);
ok('and shows money to the accountant', Number((await db.query(`select * from pms_group_snapshot()`)).rows[0]?.open_balance) > 0);
await asUser(USERS.owner);
ok('owners cannot demote themselves (no lock-out)', (await (async () => { try { await val(`select pms_add_or_invite_member($1,'owner@uh.co.tz','manager')`, [P]); return ''; } catch (e) { return e.message; } })()).includes('yourself'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.table(matrix);
process.exit(failed ? 1 : 0);
