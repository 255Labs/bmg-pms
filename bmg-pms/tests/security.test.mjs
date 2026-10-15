// Security test: runs the migrations the way Supabase runs them (default privileges for anon and
// authenticated, PostgREST's authenticator session, JWT claims) and attacks the database as real users would.
// Run: node tests/security.test.mjs
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
  create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid, factor_type text, status text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  -- what Supabase does for every new object in public
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));

const U = { ownerA: '1a000000-0000-0000-0000-000000000001', deskA: '1a000000-0000-0000-0000-000000000002', hkA: '1a000000-0000-0000-0000-000000000003',
  ownerB: '2b000000-0000-0000-0000-000000000001', admin: 'ad000000-0000-0000-0000-000000000001', sneaky: '5e000000-0000-0000-0000-000000000001' };
await db.exec(`insert into auth.users(id,email) values
  ('${U.ownerA}','gm@a.co.tz'),('${U.deskA}','desk@a.co.tz'),('${U.hkA}','hk@a.co.tz'),('${U.ownerB}','gm@b.co.tz'),('${U.admin}','admin@bmg.co.tz')`);

// Superuser (setup) vs. a real API caller: authenticator session, then the request role and claims
const asSuper = () => db.exec(`reset role; set session authorization postgres; select set_config('test.uid','',false); select set_config('request.jwt.claims','',false)`);
async function asUser(uid, { aal = 'aal1', role = 'authenticated' } = {}) {
  await asSuper();
  await db.exec(`set session authorization authenticator; set role ${role}`);
  await db.query(`select set_config('test.uid', $1, false), set_config('request.jwt.claims', $2, false)`,
    [uid ?? '', JSON.stringify({ role, sub: uid, aal })]);
}
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const val = async (sql, p = []) => Object.values((await q(sql, p))[0] ?? {})[0];
const err = async (sql, p = []) => { try { await db.query(sql, p); return null; } catch (e) { return String(e.message); } };
const denied = async (sql, p, match) => { const e = await err(sql, p); return e !== null && (!match || e.includes(match)); };

// Two hotels with their own owners, set up as the owners would
await asSuper(); await db.exec(`select set_config('test.uid','${U.ownerA}',false)`);
const A = await val(`select pms_create_property('Hotel A','HA','GM A',$1::jsonb)`, [JSON.stringify([{ name: 'Single', base_rate: 100000, rooms: ['101', '102'] }])]);
await db.exec(`select pms_add_or_invite_member('${A}','desk@a.co.tz','front_desk'); select pms_add_or_invite_member('${A}','hk@a.co.tz','housekeeping')`);
await db.exec(`select set_config('test.uid','${U.ownerB}',false)`);
const B = await val(`select pms_create_property('Hotel B','HB','GM B',$1::jsonb)`, [JSON.stringify([{ name: 'Suite', base_rate: 300000, rooms: ['201'] }])]);
await asSuper();
const roomA = await val(`select id from pms_rooms where property_id=$1 and number='101'`, [A]);
const typeA = await val(`select id from pms_room_types where property_id=$1`, [A]);
const typeB = await val(`select id from pms_room_types where property_id=$1`, [B]);
const roomB = await val(`select id from pms_rooms where property_id=$1`, [B]);
const coB = await val(`insert into pms_companies(property_id,name) values ($1,'B Corp') returning id`, [B]);
await db.query(`insert into pms_guests(property_id,first_name) values ($1,'Alice'),($2,'Bob')`, [A, B]);
await db.query(`select pms_bootstrap_super_admin('admin@bmg.co.tz')`);

console.log('Anonymous callers (the public key in the browser)');
await asUser(null, { role: 'anon' });
ok('cannot read any table', await denied(`select * from pms_guests`, [], 'permission denied'));
ok('cannot write the audit log', await denied(`select pms_log($1,'fake','x',null,null)`, [A], 'permission denied'));
ok('cannot look up rates', await denied(`select pms_rate($1,null,current_date)`, [typeA], 'permission denied'));
await asSuper();
ok('only the four booking-engine functions are executable by anon', JSON.stringify((await q(`select proname from pg_proc where pronamespace='public'::regnamespace and proname like 'pms%' and has_function_privilege('anon', oid, 'execute') order by 1`)).map((r) => r.proname)) === JSON.stringify(['pms_public_availability', 'pms_public_book', 'pms_public_payment_status', 'pms_public_property']), JSON.stringify((await q(`select proname from pg_proc where pronamespace='public'::regnamespace and proname like 'pms%' and has_function_privilege('anon', oid, 'execute') order by 1`)).map((r) => r.proname)));
ok('no table is readable by anon', Number(await val(`select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in ('r','v') and has_table_privilege('anon', oid, 'select')`)) === 0);

console.log('\nInternal functions');
await asUser(U.ownerA);
ok('signed-in users cannot write audit entries directly', await denied(`select pms_log($1,'fake','x',null,null)`, [A], 'permission denied'));
ok('nor queue jobs or SMS', await denied(`select pms__enqueue($1,'sms','send_sms','{}')`, [A], 'permission denied'));
ok('nor call service functions', await denied(`select * from pms_svc_enabled('ttlock')`, [], 'permission denied'));
await asSuper();
ok('nothing internal is granted to signed-in users', Number(await val(`select count(*) from pg_proc where pronamespace='public'::regnamespace and (proname like 'pms\\_\\_%' or proname like 'pms\\_svc\\_%' or proname='pms_log' or prorettype='trigger'::regtype) and has_function_privilege('authenticated', oid, 'execute')`)) === 0);

console.log('\nOne property cannot see or touch another');
await asUser(U.ownerB);
ok('guests: only their own', JSON.stringify((await q(`select first_name from pms_guests`)).map((r) => r.first_name)) === '["Bob"]');
ok('another property is invisible', (await q(`select id from pms_properties where id=$1`, [A])).length === 0);
ok('updates to another property change nothing', (await q(`update pms_rooms set hk_status='dirty' where property_id=$1 returning id`, [A])).length === 0);
ok('cannot price another property\'s rooms', await denied(`select pms_rate($1,null,current_date)`, [typeA], 'not a member'));
ok('cannot count another property\'s availability', await denied(`select pms_type_availability($1,current_date)`, [typeA], 'not a member'));
await asUser(U.ownerA);
ok('a room cannot use another property\'s room type', await denied(`insert into pms_rooms(property_id,room_type_id,number) values ($1,$2,'999')`, [A, typeB], 'another property'));
ok('a booking cannot bill another property\'s company', await denied(
  `select pms_create_reservation($1,'{"first_name":"Eve"}'::jsonb,(select business_date from pms_properties where id=$1),(select business_date+1 from pms_properties where id=$1),$2::jsonb,null,null,$3)`,
  [A, JSON.stringify([{ room_type_id: typeA }]), coB], 'another property'));
const ok1 = await err(`select pms_create_reservation($1,'{"first_name":"Ann"}'::jsonb,(select business_date from pms_properties where id=$1),(select business_date+1 from pms_properties where id=$1),$2::jsonb)`, [A, JSON.stringify([{ room_type_id: typeA }])]);
ok('a normal booking still works', ok1 === null, ok1);
const stayA = await val(`select id from pms_stays where property_id=$1 limit 1`, [A]);
ok('an extra folio cannot bill another property\'s company', await denied(`select pms_add_folio($1,$2)`, [stayA, coB], 'another property'));
ok('negative room rates are refused', await denied(`select pms_create_reservation($1,'{"first_name":"Neg"}'::jsonb,(select business_date from pms_properties where id=$1),(select business_date+1 from pms_properties where id=$1),$2::jsonb)`,
  [A, JSON.stringify([{ room_type_id: typeA, rate: -50000 }])], 'rate_nonneg'));

console.log('\nThe property record');
await asUser(U.ownerA);
ok('owners edit details', (await q(`update pms_properties set phone='0222' where id=$1 returning id`, [A])).length === 1);
ok('but cannot move the business date', await denied(`update pms_properties set business_date = business_date + 1 where id=$1`, [A], 'permission denied'));
ok('nor reset receipt numbers', await denied(`update pms_properties set next_receipt_no = 1 where id=$1`, [A], 'permission denied'));
ok('nor lift a suspension or switch modules', await denied(`update pms_properties set status='active', features='{}' where id=$1`, [A], 'permission denied'));
ok('admin notes are not readable by staff', await denied(`select admin_notes from pms_properties where id=$1`, [A], 'permission denied'));
ok('the app\'s column list still reads', (await q(`select id, name, business_date, features from pms_properties where id=$1`, [A])).length === 1);
await asSuper();
await db.exec(`select set_config('test.uid','${U.ownerA}',false)`);
await db.query(`select pms_open_drawer($1, 10000)`, [A]);
await db.query(`select pms_post_payment((select id from pms_folios where stay_id=$1), 5000, 'cash')`, [stayA]);
await asUser(U.ownerA);
ok('currency is fixed once money is posted', await denied(`update pms_properties set currency='USD' where id=$1`, [A], 'currency cannot change'));

console.log('\nIntegration settings');
await asUser(U.ownerA);
ok('managers can save ordinary settings', (await err(`insert into pms_integrations(property_id,provider,enabled,config) values ($1,'sms',true,'{"sender_id":"HOTELA"}')`, [A])) === null);
ok('but not the secrets suffix (which picks whose credentials are used)', await denied(`update pms_integrations set config = config || '{"code":"HB"}' where property_id=$1 and provider='sms'`, [A], 'platform administrator'));
ok('nor the VFD endpoint (which receives the API key)', await denied(`insert into pms_integrations(property_id,provider,config) values ($1,'fiscal','{"url":"https://evil.example"}')`, [A], 'platform administrator'));
ok('nor the Channex property', await denied(`insert into pms_integrations(property_id,provider,config) values ($1,'channex','{"property_id":"x-1"}')`, [A], 'platform administrator'));
await asSuper(); await db.exec(`insert into pms_members(property_id,user_id,role) values ('${A}','${U.admin}','owner'),('${B}','${U.admin}','owner')`);
await asUser(U.admin);
ok('administrators set them', (await err(`insert into pms_integrations(property_id,provider,config) values ($1,'channex','{"property_id":"chx-A"}')`, [A])) === null);
ok('the VFD endpoint must be https', await denied(`insert into pms_integrations(property_id,provider,config) values ($1,'fiscal','{"url":"http://vfd.example"}')`, [A], 'https'));
ok('one Channex property cannot feed two hotels', await denied(`insert into pms_integrations(property_id,provider,config) values ($1,'channex','{"property_id":"chx-A"}')`, [B], 'already connected'));
await asUser(U.ownerB);
await db.query(`insert into pms_external_ids(property_id,provider,entity,entity_id,external_id) values ($1,'ttlock','room',$2,'LOCK-201')`, [B, roomB]);
await asUser(U.ownerA);
ok('a room cannot be mapped to another hotel\'s lock', await denied(`insert into pms_external_ids(property_id,provider,entity,entity_id,external_id) values ($1,'ttlock','room',$2,'LOCK-201')`, [A, roomA], 'another property'));
ok('nor can a mapping point at another hotel\'s room', await denied(`insert into pms_external_ids(property_id,provider,entity,entity_id,external_id) values ($1,'ttlock','room',$2,'LOCK-X')`, [A, roomB], 'another property'));

console.log('\nDoor codes');
await asSuper();
await db.query(`insert into pms_stay_passcodes(property_id,stay_id,room_id,lock_id,passcode,valid_from,valid_to,status) values ($1,$2,$3,'L1','482913',now(),now()+interval '1 day','issued')`, [A, stayA, roomA]);
await asUser(U.hkA);
ok('housekeeping cannot read guest door codes', (await q(`select passcode from pms_stay_passcodes`)).length === 0);
await asUser(U.deskA);
ok('the front desk can', (await q(`select passcode from pms_stay_passcodes`)).length === 1);

console.log('\nInvites');
await asUser(U.ownerA);
await db.query(`select pms_add_or_invite_member($1,'new@a.co.tz','manager')`, [A]);
await asSuper();
await db.exec(`insert into auth.users(id,email,email_confirmed_at) values ('${U.sneaky}','new@a.co.tz',null)`);
await asUser(U.sneaky);
ok('an unconfirmed account cannot claim an invite', Number(await val(`select pms_claim_invites()`)) === 0);
await asSuper(); await db.exec(`update auth.users set email_confirmed_at = now() where id='${U.sneaky}'`);
await asUser(U.sneaky);
ok('once the email is confirmed, it can', Number(await val(`select pms_claim_invites()`)) === 1);

console.log('\nMoney rules');
await asUser(U.ownerA);
const line = await val(`select pms_post_charge((select id from pms_folios where stay_id=$1),'other','Test',1000)`, [stayA]);
await asSuper(); await db.query(`update pms_properties set business_date = business_date + 1 where id=$1`, [A]);
await asUser(U.ownerA);
ok('lines from a closed day cannot be voided', await denied(`select pms_void_line($1,'oops')`, [line], 'closed'));
const drawer = await val(`select id from pms_drawer_sessions where property_id=$1 and status='open'`, [A]);
ok('a drawer cannot close without a count', await denied(`select pms_close_drawer($1,null)`, [drawer], 'counted'));
ok('drawer totals of another hotel are private', await (async () => { await asUser(U.ownerB); return denied(`select pms_drawer_expected($1)`, [drawer], 'not a member'); })());

console.log('\nSMS');
await asUser(U.deskA);
ok('long messages are refused', await denied(`select pms_send_sms($1,'0713000111',$2)`, [A, 'x'.repeat(481)], '480'));
for (let i = 0; i < 5; i++) await db.query(`select pms_send_sms($1,'0713000111','Hello')`, [A]);
ok('a number gets at most five messages an hour', await denied(`select pms_send_sms($1,'0713000111','Hello')`, [A], '5 messages'));

console.log('\nKeys');
await asUser(U.ownerA);
ok('camera relays get their own keys', !!(await val(`select pms_create_api_key($1,'Relay PC','hikvision')`, [A])));
ok('unknown key types are refused', await denied(`select pms_create_api_key($1,'X','other')`, [A], 'Unknown key type'));

console.log('\nTwo-step sign-in');
await asSuper(); await db.exec(`insert into auth.mfa_factors(user_id,factor_type,status) values ('${U.ownerA}','totp','verified')`);
await asUser(U.ownerA, { aal: 'aal1' });
ok('with an authenticator on, a password-only session sees nothing', (await q(`select id from pms_guests`)).length === 0);
ok('and can do nothing', await denied(`select pms_post_charge((select id from pms_folios limit 1),'other','x',1)`, [], ''));
await asUser(U.ownerA, { aal: 'aal2' });
ok('after the code, everything is back', (await q(`select id from pms_guests`)).length >= 1);
await asUser(U.admin, { aal: 'aal1' });
ok('a lost phone is reset by an administrator', Number(await val(`select pms_admin_reset_mfa('gm@a.co.tz')`)) === 1);
await asUser(U.ownerA, { aal: 'aal1' });
ok('then the password works again, until a new authenticator is set up', (await q(`select id from pms_guests`)).length >= 1);
await asUser(U.deskA, { aal: 'aal1' });
ok('only administrators can reset it', await denied(`select pms_admin_reset_mfa('gm@a.co.tz')`, [], 'platform administrator'));
ok('people without an authenticator are unaffected', (await q(`select id from pms_guests`)).length >= 1);

console.log('\nProperty-wide two-step sign-in and the public booking engine');
await asSuper(); await db.query(`update pms_properties set settings = settings || '{"require_mfa":true}' where id=$1`, [A]);
await asUser(U.deskA, { aal: 'aal1' });
ok('when the property requires two-step sign-in, a password-only session sees nothing', (await q(`select id from pms_guests`)).length === 0);
ok('and the app is told why', (await q(`select * from pms_mfa_blocked_properties()`)).length === 1);
await asUser(U.deskA, { aal: 'aal2' });
ok('with the code, work carries on', (await q(`select id from pms_guests`)).length >= 1);
await asSuper(); await db.query(`update pms_properties set settings = (settings - 'require_mfa') || '{"booking_engine":{"enabled":true}}' where id=$1`, [A]);
await asUser(null, { role: 'anon' });
ok('anonymous visitors can see the public booking page', (await q(`select pms_public_property('HA') r`))[0].r.name === 'Hotel A');
ok('but not a property that has not opened online booking', await denied(`select pms_public_property('HB')`, [], 'not open'));
ok('and still cannot read any table', await denied(`select * from pms_reservations`, [], 'permission denied'));

console.log('\nStructure');
await asSuper();
ok('row-level security no longer calls a function per row', Number(await val(`select count(*) from pg_policies where schemaname='public' and (coalesce(qual,'') ~ 'pms_is_member\\(|pms_role\\(' or coalesce(with_check,'') ~ 'pms_is_member\\(|pms_role\\(')`)) === 0);
ok('every table has row-level security', Number(await val(`select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r' and not relrowsecurity`)) === 0);
ok('every foreign key has an index', Number(await val(`select count(*) from pg_constraint c where c.contype='f' and c.connamespace='public'::regnamespace and not exists (select 1 from pg_index i where i.indrelid=c.conrelid and i.indkey[0]=c.conkey[1])`)) === 0);
ok('every security-definer function pins its search path', Number(await val(`select count(*) from pg_proc where pronamespace='public'::regnamespace and prosecdef and not exists (select 1 from unnest(coalesce(proconfig,'{}')) c where c like 'search_path=%')`)) === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
