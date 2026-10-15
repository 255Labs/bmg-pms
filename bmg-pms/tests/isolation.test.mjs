// Isolation test: one property's data never reaches another property, one person's access never reaches another's,
// every row records who made and changed it, and the database itself flags any future table that would break this.
// Runs the migrations the way Supabase does (PostgREST roles, default grants). Run: node tests/isolation.test.mjs
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
  create table auth.users (id uuid primary key, email text unique, created_at timestamptz default now(),
    last_sign_in_at timestamptz, email_confirmed_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));

const U = { ownerA: '1a000000-0000-0000-0000-000000000001', deskA: '1a000000-0000-0000-0000-000000000002',
  ownerB: '2b000000-0000-0000-0000-000000000001', deskB: '2b000000-0000-0000-0000-000000000002' };
await db.exec(`insert into auth.users(id,email) values ('${U.ownerA}','gm@a.co.tz'),('${U.deskA}','desk@a.co.tz'),('${U.ownerB}','gm@b.co.tz'),('${U.deskB}','desk@b.co.tz')`);
const asSuper = () => db.exec(`reset role; set session authorization postgres; select set_config('test.uid','',false); select set_config('request.jwt.claims','',false)`);
async function asUser(uid, role = 'authenticated') {
  await asSuper();
  await db.exec(`set session authorization authenticator; set role ${role}`);
  await db.query(`select set_config('test.uid', $1, false), set_config('request.jwt.claims', $2, false)`, [uid ?? '', JSON.stringify({ role, sub: uid, aal: 'aal1' })]);
}
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const val = async (sql, p = []) => Object.values((await q(sql, p))[0] ?? {})[0];
const err = async (sql, p = []) => { try { await db.query(sql, p); return null; } catch (e) { return String(e.message); } };

// ---------------------------------------------------------------- two hotels, each with real activity
async function hotel(owner, desk, name, code, deskMail) {
  await asSuper(); await db.exec(`select set_config('test.uid','${owner}',false)`);
  const P = await val(`select pms_create_property($1,$2,'GM',$3::jsonb)`, [name, code, JSON.stringify([{ name: 'Single', base_rate: 100000, rooms: ['101', '102'] }])]);
  await db.query(`select pms_add_or_invite_member($1,$2,'front_desk')`, [P, deskMail]);
  await db.query(`update pms_properties set business_date = '2026-10-14' where id=$1`, [P]);
  await asUser(owner);
  const room = await val(`select id from pms_rooms where property_id=$1 and number='101'`, [P]);
  const r = await val(`select pms_create_reservation($1,'{"first_name":"Guest","last_name":"${code}","phone":"0713000111"}'::jsonb,'2026-10-14','2026-10-16',$2::jsonb)`, [P, JSON.stringify([{ room_id: room }])]);
  const stay = await val(`select id from pms_stays where reservation_id=$1`, [r.reservation_id]);
  await db.query(`select pms_save_custom_role($1,null,'Night clerk','front_desk','',array['res.add'])`, [P]);
  await asSuper();
  const outlet = await val(`insert into pms_pos_outlets(property_id,name) values ($1,'Bar') returning id`, [P]);
  const item = await val(`insert into pms_pos_items(property_id,outlet_id,name,price) values ($1,$2,'Soda',2000) returning id`, [P, outlet]);
  const bill = await val(`insert into pms_pos_bills(property_id,outlet_id,bill_no,business_date) values ($1,$2,1,'2026-10-14') returning id`, [P, outlet]);
  await db.query(`insert into pms_pos_bill_items(bill_id,item_id,name,qty,price,amount) values ($1,$2,'Soda',1,2000,2000)`, [bill, item]);
  return { P, room, stay, reservation: r.reservation_id, outlet, item, bill };
}
const A = await hotel(U.ownerA, U.deskA, 'Hotel A', 'HA', 'desk@a.co.tz');
const B = await hotel(U.ownerB, U.deskB, 'Hotel B', 'HB', 'desk@b.co.tz');

console.log('Every table belongs to one property');
await asSuper();
const report = await q(`select * from pms__isolation_problems()`);
ok('the database reports no isolation problems (property_id everywhere, row security on, every link guarded)', report.length === 0, JSON.stringify(report));
const tenantTables = (await q(`select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'
  and exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='property_id' and not a.attisdropped) order by 1`)).map((r) => r.relname);
ok(`${tenantTables.length} property tables found`, tenantTables.length > 70);
ok('POS bill lines inherit their bill\'s property', await val(`select property_id from pms_pos_bill_items where bill_id=$1`, [A.bill]) === A.P);
ok('role abilities inherit their role\'s property', Number(await val(`select count(*) from pms_custom_role_privileges where property_id=$1`, [B.P])) === 1);

console.log('People only ever see their own property');
for (const [who, own, other] of [['owner A', U.ownerA, B.P], ['desk A', U.deskA, B.P], ['owner B', U.ownerB, A.P], ['desk B', U.deskB, A.P]]) {
  await asUser(own);
  const leaks = [];
  for (const t of tenantTables) {
    const e = await err(`select 1 from ${t} limit 0`);
    if (e) continue;   // not readable at all through the API: nothing can leak
    const n = Number(await val(`select count(*) from ${t} where property_id = $1`, [other]));
    if (n > 0) leaks.push(`${t}:${n}`);
  }
  ok(`${who} reads 0 rows of the other hotel in all ${tenantTables.length} tables`, leaks.length === 0, leaks.join(' '));
}
await asUser(U.ownerA);
ok('owner A sees their own bookings', Number(await val(`select count(*) from pms_reservations`)) === 1);
ok('owner A\'s property list holds only Hotel A', JSON.stringify((await q(`select * from pms_my_properties()`)).map((r) => Object.values(r)[0])) === JSON.stringify([A.P]));
ok('owner A cannot act on Hotel B', (await err(`select pms_check_in($1)`, [B.stay])) !== null);
ok('owner A cannot read Hotel B\'s staff', (await q(`select * from pms_members where property_id=$1`, [B.P])).length === 0);
await asUser(null, 'anon');
ok('the public key reads nothing', (await err(`select * from pms_reservations`)) !== null);

console.log('Rows can never cross between properties (checked as the database owner, who bypasses row security)');
await asSuper();
ok('a booking cannot be put in another hotel\'s room', (await err(`update pms_stays set room_id=$1 where id=$2`, [B.room, A.stay]))?.includes('belongs to another property'));
ok('a bill line cannot use another hotel\'s menu item', (await err(`insert into pms_pos_bill_items(bill_id,item_id,name,qty,price,amount) values ($1,$2,'x',1,1,1)`, [A.bill, B.item]))?.includes('belongs to another property'));
ok('a record cannot be moved to another property', (await err(`update pms_guests set property_id=$1 where property_id=$2`, [B.P, A.P]))?.includes('cannot be moved'));
ok('a POS bill cannot use another hotel\'s outlet', (await err(`insert into pms_pos_bills(property_id,outlet_id,bill_no,business_date) values ($1,$2,9,'2026-10-14')`, [A.P, B.outlet]))?.includes('belongs to another property'));

console.log('Every row records who made and changed it');
await asSuper();
ok('the booking records the owner who made it', await val(`select created_by from pms_reservations where id=$1`, [A.reservation]) === U.ownerA);
await asUser(U.deskA);
await db.query(`select pms_check_in($1, true)`, [A.stay]);
await asSuper();
const st = (await q(`select created_by, updated_by, updated_at from pms_stays where id=$1`, [A.stay]))[0];
ok('the check-in records the desk clerk who did it, keeping the creator', st.updated_by === U.deskA && st.created_by === U.ownerA && st.updated_at);
await asUser(U.deskA);
ok('creation details cannot be rewritten from the app', (await err(`update pms_guests set created_by=$1 where property_id=$2`, [U.deskA, A.P])) !== null
  || (await val(`select count(*) from pms_guests where created_by=$1`, [U.deskA])) == 0);
await asSuper();
ok('every property table has created_by, created_at, updated_by, updated_at', Number(await val(`select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'
  and exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='property_id')
  and (select count(*) from pg_attribute a where a.attrelid=c.oid and a.attname in ('created_by','created_at','updated_by','updated_at') and not a.attisdropped) < 4`)) === 0);

console.log('A future table that forgets the rules is caught');
await asSuper();
await db.exec(`create table pms_test_minibar (id uuid primary key default gen_random_uuid(), property_id uuid not null references pms_properties(id), room_id uuid references pms_rooms(id));
  alter table pms_test_minibar enable row level security;
  create table pms_test_loose (id uuid primary key default gen_random_uuid(), note text);`);
const flagged = await q(`select * from pms__isolation_problems()`);
ok('a new table without property_id is flagged', flagged.some((r) => r.tbl === 'pms_test_loose' && r.problem === 'no property_id'));
ok('…and without row security', flagged.some((r) => r.tbl === 'pms_test_loose' && r.problem === 'no row level security'));
ok('a new link without the same-property guard is flagged', flagged.some((r) => r.tbl === 'pms_test_minibar' && r.problem === 'unguarded reference'));
ok('…and without who-made-it columns', flagged.some((r) => r.tbl === 'pms_test_minibar' && r.problem === 'no audit columns'));
await db.exec(`select pms__apply_platform_rules()`);
ok('applying the platform rules covers it', !(await q(`select * from pms__isolation_problems()`)).some((r) => r.tbl === 'pms_test_minibar'));
ok('and it then refuses a cross-property link', (await err(`insert into pms_test_minibar(property_id,room_id) values ($1,$2)`, [A.P, B.room]))?.includes('belongs to another property'));
await db.exec(`drop table pms_test_minibar; drop table pms_test_loose;`);
await asUser(U.ownerA);
ok('only platform administrators can run the report', (await err(`select * from pms_admin_isolation_report()`))?.includes('administrator'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
