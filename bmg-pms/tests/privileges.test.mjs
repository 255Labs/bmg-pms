// Privileges test: custom roles, per-person switches and per-report access, checked through PostgREST's own
// roles; the app's list (src/lib/privileges.js) must match the database's, and the app's can() must agree
// with the database for a customised person.
// Run: node tests/privileges.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { can, setPrivileges } from '../src/lib/format.js';
import { PRIVILEGES, roleDefaults } from '../src/lib/privileges.js';

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
const U = { owner: id(1), manager: id(2), desk: id(3), acct: id(4), hk: id(5), store: id(6), late: id(7) };
await db.exec(`insert into auth.users(id,email) values ${Object.entries(U).map(([k, v]) => `('${v}','${k}@uh.co.tz')`).join(',')}`);
const asSuper = () => db.exec(`reset role; set session authorization postgres; select set_config('test.uid','',false); select set_config('request.jwt.claims','',false)`);
const as = async (uid) => {
  await asSuper();
  await db.exec(`set session authorization authenticator; set role authenticated`);
  await db.query(`select set_config('test.uid', $1, false), set_config('request.jwt.claims', $2, false)`, [uid, JSON.stringify({ role: 'authenticated', sub: uid, aal: 'aal1' })]);
};
const val = async (sql, p = []) => Object.values((await db.query(sql, p)).rows[0] ?? {})[0];
const err = async (sql, p = []) => { try { await db.query(sql, p); return ''; } catch (e) { return e.message; } };
const tryTx = async (sql, p = []) => { await db.exec('begin'); const e = await err(sql, p); await db.exec('rollback'); return e; };
const refused = (m) => /cannot perform|not a member|permission denied|row-level security|Only owners|Owners always|own access/i.test(m);

console.log('The app and the database hold the same list');
await asSuper();
const cat = (await db.query(`select key, grp, label, default_roles from pms_privilege_catalog order by sort_order`)).rows;
ok('same abilities in the same order', JSON.stringify(cat.map((c) => c.key)) === JSON.stringify(PRIVILEGES.map((p) => p.key)));
ok('same names, groups and default roles', cat.every((c, i) => c.label === PRIVILEGES[i].label && c.grp === PRIVILEGES[i].group
  && JSON.stringify(c.default_roles) === JSON.stringify(PRIVILEGES[i].roles)));
const leftover = (await db.query(`select proname from pg_proc where pronamespace = 'public'::regnamespace
  and prosrc ~ 'pms_require\\([^)]*array\\[' order by 1`)).rows.map((r) => r.proname);
const LOOKUPS = ['pms_add_or_invite_member', 'pms_availability', 'pms_change_preview', 'pms_cancel_invite', 'pms_copy_access_to_all', 'pms_delete_custom_role', 'pms_free_rooms',
  'pms_inhouse_guests', 'pms_list_members', 'pms_rate_grid', 'pms_reservation_trail', 'pms_room_recent_stays', 'pms_save_custom_role',
  'pms_set_member', 'pms_set_member_access', 'pms_set_member_title'];
ok('every action asks for an ability (only lookups and owner-only functions keep a role list)', leftover.every((f) => LOOKUPS.includes(f)), leftover.filter((f) => !LOOKUPS.includes(f)).join(', '));

// A property, staff and something to act on
await db.exec(`select set_config('test.uid','${U.owner}',false)`);
const P = await val(`select pms_create_property('Unreal Homes','UH','Owner',$1::jsonb)`, [JSON.stringify([{ name: 'Single', base_rate: 200000, rooms: ['331', '332', '333', '334'] }])]);
const P2 = await val(`select pms_create_property('Whistling Woods','WW','Owner',$1::jsonb)`, [JSON.stringify([{ name: 'Double', base_rate: 250000, rooms: ['101'] }])]);
for (const [k, r] of [['manager', 'manager'], ['desk', 'front_desk'], ['acct', 'accountant'], ['hk', 'housekeeping'], ['store', 'storekeeper']]) {
  await db.query(`select pms_add_or_invite_member($1,$2,$3)`, [P, `${k}@uh.co.tz`, r]);
}
await db.query(`select pms_add_or_invite_member($1,'desk@uh.co.tz','front_desk')`, [P2]);
await db.query(`delete from auth.users where id=$1`, [U.late]);
const room = (n) => val(`select id from pms_rooms where property_id=$1 and number=$2`, [P, n]);
const bd = await val(`select business_date::text from pms_properties where id=$1`, [P]);
const book = async (n, first) => (await db.query(`select pms_create_reservation($1,$2::jsonb,$3::date,$3::date+2,$4::jsonb) r`, [P, JSON.stringify({ first_name: first }), bd, JSON.stringify([{ room_id: await room(n) }])])).rows[0].r;
const r1 = await book('331', 'Ann');
const S1 = await val(`select id from pms_stays where reservation_id=$1`, [r1.reservation_id]);
await db.query(`select pms_check_in($1)`, [S1]);
const F1 = await val(`select id from pms_folios where stay_id=$1`, [S1]);
const L1 = await val(`select pms_post_charge($1,'other','Minibar',5000)`, [F1]);
const r2 = await book('332', 'Ben');
const S2 = await val(`select id from pms_stays where reservation_id=$1`, [r2.reservation_id]);
await db.query(`update pms_rooms set hk_status='dirty' where id=$1`, [await room('332')]);

console.log('\nBuilt-in roles keep exactly their defaults');
for (const [k, r] of [['manager', 'manager'], ['desk', 'front_desk'], ['acct', 'accountant'], ['hk', 'housekeeping'], ['store', 'storekeeper'], ['owner', 'owner']]) {
  await as(U[k]);
  const mine = await val(`select pms_my_privileges($1)`, [P]);
  ok(`${r} has its ${roleDefaults(r).length} default abilities`, JSON.stringify(mine) === JSON.stringify(roleDefaults(r)));
}

console.log('\nOnly owners build roles and give access');
await as(U.manager);
ok('a manager cannot make a role', refused(await tryTx(`select pms_save_custom_role($1,null,'Boss','manager')`, [P])));
ok('or write the roles table directly', refused(await tryTx(`insert into pms_custom_roles(property_id,name,base_role) values ($1,'Sneaky','manager')`, [P])));
ok('or give themselves an ability', refused(await tryTx(`select pms_set_member_access($1,$2,null,'{"cash.void":true}'::jsonb)`, [P, U.manager])));
ok('or give someone else one', refused(await tryTx(`select pms_set_member_access($1,$2,null,'{"cash.void":true}'::jsonb)`, [P, U.desk])));
await as(U.owner);
ok('a role cannot rest on owner', /rests on manager/.test(await tryTx(`select pms_save_custom_role($1,null,'Co-owner','owner')`, [P])));
ok('owners cannot change their own access', /own access/.test(await tryTx(`select pms_set_member_access($1,$2,null,'{}'::jsonb)`, [P, U.owner])));
ok('unknown abilities are refused', /Unknown ability/.test(await tryTx(`select pms_set_member_access($1,$2,null,'{"cash.everything":true}'::jsonb)`, [P, U.desk])));
ok('switches must be true or false', /on \(true\) or off/.test(await tryTx(`select pms_set_member_access($1,$2,null,'{"cash.void":"yes"}'::jsonb)`, [P, U.desk])));

console.log('\nA custom role: Front Office Associate (front desk, can void, cannot cancel or run the audit)');
const foa = roleDefaults('front_desk').filter((k) => !['res.cancel', 'fo.night_audit'].includes(k)).concat(['cash.void']);
const FOA = await val(`select pms_save_custom_role($1,null,'Front Office Associate','front_desk','Desk staff',$2::text[])`, [P, foa]);
await db.query(`select pms_set_member_access($1,$2,$3,'{}'::jsonb)`, [P, U.desk, FOA]);
await as(U.desk);
ok('the person now has the role\'s abilities', JSON.stringify((await val(`select pms_my_privileges($1)`, [P])).slice().sort()) === JSON.stringify(foa.slice().sort()));
ok('voiding works', !refused(await tryTx(`select pms_void_line($1,'wrong item')`, [L1])));
ok('cancelling is refused', /cannot perform this: Cancel bookings/.test(await tryTx(`select pms_cancel_stay($1,'test')`, [S2])));
ok('the night audit is refused', refused(await tryTx(`select pms_run_night_audit($1,true)`, [P])));
ok('check-in still works', !refused(await tryTx(`select pms_check_in($1,true)`, [S2])));
setPrivileges(await val(`select pms_my_privileges($1)`, [P]));
ok('the app shows Void and hides Night audit for them', can('front_desk', 'void') && can('front_desk', 'cash.void') && !can('front_desk', 'audit') && !can('front_desk', 'res.cancel'));
setPrivileges(null);

console.log('\nOne person differs from their role');
await as(U.owner);
await db.query(`select pms_set_member_access($1,$2,$3,'{"fo.checkin_dirty":false,"cash.discount":true}'::jsonb)`, [P, U.desk, FOA]);
await as(U.desk);
ok('switched off: check in to a dirty room', /Check in to a dirty room/.test(await tryTx(`select pms_check_in($1,true)`, [S2])));
ok('switched on: discounts work', !refused(await tryTx(`select pms_post_discount($1,1000,'loyal guest')`, [F1])));
setPrivileges(await val(`select pms_my_privileges($1)`, [P]));
ok('and the app agrees', can('front_desk', 'discount') && !can('front_desk', 'fo.checkin_dirty'));
setPrivileges(null);

console.log('\nReports one by one');
await as(U.owner);
await db.query(`select pms_set_member_access($1,$2,null,'{"rpt.audit_trail":false,"rpt.food_cost":false}'::jsonb)`, [P, U.acct]);
await as(U.acct);
ok('audit trail switched off for the accountant', /Audit trail/.test(await tryTx(`select * from pms_rpt_audit_trail($1,'2000-01-01','2100-01-01')`, [P])));
ok('other reports still run', !refused(await tryTx(`select * from pms_rpt_voids($1,'2000-01-01','2100-01-01')`, [P])));
await as(U.owner);
await db.query(`select pms_set_member_access($1,$2,null,'{"rpt.occupancy":true}'::jsonb)`, [P, U.store]);
await as(U.store);
ok('occupancy switched on for a storekeeper', !refused(await tryTx(`select * from pms_rpt_occupancy($1,$2::date,$2::date)`, [P, bd])));
ok('but guests stay hidden (records follow the built-in role)', Number(await val(`select count(*) from pms_guests`)) === 0);

console.log('\nChanges take effect at once');
await as(U.owner);
await db.query(`select pms_save_custom_role($1,$2,'Front Office Associate','front_desk','Desk staff',$3::text[],false)`, [P, FOA, foa]);
await as(U.desk);
ok('switching the role off leaves its people with nothing', (await val(`select pms_my_privileges($1)`, [P])).filter((k) => !['fo.checkin_dirty', 'cash.discount'].includes(k)).length === 0);
await as(U.owner);
await db.query(`select pms_save_custom_role($1,$2,'Front Office Associate','front_desk','Desk staff',$3::text[],true)`, [P, FOA, foa]);
ok('a role in use cannot be deleted', /still have this role/.test(await tryTx(`select pms_delete_custom_role($1)`, [FOA])));
await db.query(`select pms_add_or_invite_member($1,'desk@uh.co.tz','housekeeping')`, [P]);
ok('moving someone to another built-in role drops a custom role that rests elsewhere', await val(`select custom_role_id is null from pms_members where property_id=$1 and user_id=$2`, [P, U.desk]));
await db.query(`select pms_add_or_invite_member($1,'desk@uh.co.tz','front_desk')`, [P]);
await db.query(`select pms_set_member_access($1,$2,$3,'{}'::jsonb)`, [P, U.desk, FOA]);
await db.query(`select pms_add_or_invite_member($1,'desk@uh.co.tz','owner')`, [P]);
ok('making someone owner clears their switches', await val(`select custom_role_id is null and overrides = '{}' from pms_members where property_id=$1 and user_id=$2`, [P, U.desk]));
await db.query(`select pms_add_or_invite_member($1,'desk@uh.co.tz','front_desk')`, [P]);
await db.query(`select pms_add_or_invite_member($1,'manager@uh.co.tz','owner')`, [P]);
ok('owners cannot be restricted', /full access/.test(await tryTx(`select pms_set_member_access($1,$2,null,'{}'::jsonb)`, [P, U.manager])));
await db.query(`select pms_add_or_invite_member($1,'manager@uh.co.tz','manager')`, [P]);

console.log('\nInvites and copying to other properties');
await db.query(`select pms_add_or_invite_member($1,'late@uh.co.tz','front_desk')`, [P]);
const INV = await val(`select id from pms_invites where property_id=$1 and email='late@uh.co.tz'`, [P]);
await db.query(`select pms_set_member_access($1,$2,$3,'{}'::jsonb)`, [P, INV, FOA]);
await asSuper();
await db.query(`insert into auth.users(id,email) values ($1,'late@uh.co.tz')`, [U.late]);
await as(U.late);
await db.query(`select pms_claim_invites()`);
ok('an invite carries its custom role to the new member', await val(`select custom_role_id = $3 from pms_members where property_id=$1 and user_id=$2`, [P, U.late, FOA]));
await as(U.owner);
await db.query(`select pms_set_member_access($1,$2,$3,'{"cash.discount":true}'::jsonb)`, [P, U.desk, FOA]);
ok('copied to the one other property they work at', Number(await val(`select pms_copy_access_to_all($1,$2)`, [P, U.desk])) === 1);
ok('with the role created there and the same switches', await val(`select r.name = 'Front Office Associate' and m.overrides = '{"cash.discount":true}'
  from pms_members m join pms_custom_roles r on r.id = m.custom_role_id where m.property_id=$1 and m.user_id=$2`, [P2, U.desk]));
await as(U.desk);
ok('and it works there', JSON.stringify((await val(`select pms_my_privileges($1)`, [P2])).slice().sort()) === JSON.stringify([...foa, 'cash.discount'].sort()));
await as(U.manager);
ok('a manager cannot copy access', refused(await tryTx(`select pms_copy_access_to_all($1,$2)`, [P, U.desk])));
await asSuper();
ok('every change is in the audit trail', Number(await val(`select count(*) from pms_audit_log where property_id=$1 and action in ('member.access','role.create','role.update')`, [P])) >= 5);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
