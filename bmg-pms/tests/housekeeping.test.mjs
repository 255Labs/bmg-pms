// Housekeeping board test: rooms ticked cleaned, not yet or under maintenance; who may do what; work orders; history.
// Runs as real API callers (PostgREST roles, row security). Run: node tests/housekeeping.test.mjs
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

const U = { owner: '20000000-0000-0000-0000-000000000001', desk: '20000000-0000-0000-0000-000000000002', hk: '20000000-0000-0000-0000-000000000003',
  acct: '20000000-0000-0000-0000-000000000004' };
await db.exec(`insert into auth.users(id,email) values ('${U.owner}','gm@p.tz'),('${U.desk}','desk@p.tz'),('${U.hk}','hk@p.tz'),('${U.acct}','acct@p.tz')`);
let who = null;
const asSuper = () => { who = null; return db.exec(`reset role; set session authorization postgres; select set_config('test.uid','',false); select set_config('request.jwt.claims','',false)`); };
async function as(uid) {
  await asSuper();
  who = uid;
  await db.exec(`set session authorization authenticator; set role authenticated`);
  await db.query(`select set_config('test.uid', $1, false), set_config('request.jwt.claims', $2, false)`, [uid, JSON.stringify({ role: 'authenticated', sub: uid, aal: 'aal1' })]);
}
async function asGuest() {
  await asSuper();
  who = 'guest';
  await db.exec(`set session authorization authenticator; set role anon`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'anon' })]);
}
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const val = async (sql, p = []) => Object.values((await q(sql, p))[0] ?? {})[0];
const err = async (sql, p = []) => { try { await db.query(sql, p); return ''; } catch (e) { return String(e.message); } };

await asSuper(); await db.exec(`select set_config('test.uid','${U.owner}',false)`);
const P = await val(`select pms_create_property('Pwani Lodge','PL','GM',$1::jsonb)`, [JSON.stringify([{ name: 'Double', base_rate: 250000, rooms: ['201', '202', '301'] }])]);
for (const [m, r] of [['desk@p.tz', 'front_desk'], ['hk@p.tz', 'housekeeping'], ['acct@p.tz', 'accountant']]) await db.query(`select pms_add_or_invite_member($1,$2,$3)`, [P, m, r]);
await db.query(`update pms_properties set business_date = '2026-10-14' where id=$1`, [P]);
const room = (n) => val(`select id from pms_rooms where property_id=$1 and number=$2`, [P, n]);
const R201 = await room('201'), R202 = await room('202'), R301 = await room('301');
const r = await val(`select pms_create_reservation($1,'{"first_name":"Asha","last_name":"Mollel"}'::jsonb,'2026-10-14','2026-10-16',$2::jsonb)`, [P, JSON.stringify([{ room_id: R201 }])]);
await db.query(`select pms_check_in(id, true) from pms_stays where reservation_id=$1`, [r.reservation_id]);
await db.query(`update pms_rooms set hk_status='dirty' where id in ($1,$2)`, [R201, R202]);

console.log('The board');
await as(U.hk);
const b = await val(`select pms_hk_board($1)`, [P]);
const b201 = b.rooms.find((x) => x.number === '201');
ok('every room with its cleaning status and what is happening in it', b.rooms.length === 3 && b201.hk_status === 'dirty' && b201.occupancy === 'occupied' && b.rooms.find((x) => x.number === '301').occupancy === 'vacant');
ok('no guest names on the housekeeping board', !JSON.stringify(b).includes('Asha'));
ok('housekeeping may put rooms under maintenance', b.can_maintain === true);
await as(U.acct);
ok('people without the cleaning ability cannot open it', (await err(`select pms_hk_board($1)`, [P])) !== '');

console.log('\nTicking rooms');
await as(U.hk);
await db.query(`select pms_hk_set($1,'clean')`, [R201]);
const after = (await val(`select pms_hk_board($1)`, [P])).rooms.find((x) => x.number === '201');
ok('Cleaned: stamped with who and when', after.hk_status === 'clean' && after.updated_by === 'hk' && !!after.updated_at, JSON.stringify(after));
await db.query(`select pms_hk_set($1,'dirty')`, [R201]);
ok('Not yet', await val(`select hk_status from pms_rooms where id=$1`, [R201]) === 'dirty');
ok('maintenance needs a reason', /fixing/.test(await err(`select pms_hk_set($1,'maintenance','  ')`, [R202])));
await db.query(`select pms_hk_set($1,'maintenance','AC not cooling')`, [R202]);
ok('Under maintenance: out of order with the reason', await val(`select hk_status||'|'||hk_note from pms_rooms where id=$1`, [R202]) === 'out_of_order|AC not cooling');
ok('…and a repair job opens', await val(`select count(*)::int from pms_work_orders where room_id=$1 and status='open' and category='maintenance' and priority='high'`, [R202]) === 1);
await db.query(`select pms_hk_set($1,'maintenance','Still leaking')`, [R202]);
ok('…only one job while it stays in maintenance', await val(`select count(*)::int from pms_work_orders where room_id=$1 and status='open'`, [R202]) === 1);
await as(U.desk);
ok('the desk cannot take a room out of maintenance', (await err(`select pms_hk_set($1,'clean')`, [R202])) !== '');
ok('…nor put one in', (await err(`select pms_hk_set($1,'maintenance','x')`, [R301])) !== '');
await db.query(`select pms_hk_set($1,'clean')`, [R301]);
ok('…but can tick a room cleaned', await val(`select hk_status from pms_rooms where id=$1`, [R301]) === 'clean');
await as(U.hk);
await db.query(`select pms_hk_set($1,'dirty')`, [R202]);
ok('fixed: the room needs cleaning and the job is closed', await val(`select hk_status from pms_rooms where id=$1`, [R202]) === 'dirty'
  && await val(`select count(*)::int from pms_work_orders where room_id=$1 and status='done' and completed_at is not null`, [R202]) === 1);
ok('unknown statuses are refused', /Unknown/.test(await err(`select pms_hk_set($1,'sparkling')`, [R201])));

console.log('\nHistory');
const hist = await q(`select to_status from pms_room_status_log where room_id=$1 order by changed_at, to_status`, [R202]);
ok('every change is kept', hist.length >= 3 && hist.some((h) => h.to_status === 'out_of_order'));
ok('the board lists the last 24 hours', (await val(`select pms_hk_board($1)`, [P])).today.length >= 5);
await as(U.acct);
ok('only people with the cleaning ability read the history', (await q(`select * from pms_room_status_log`)).length === 0);
await as(U.owner);
await db.query(`select pms_set_room_status($1,'inspected',null)`, [R301]);
ok('changes from other screens are kept too', await val(`select count(*)::int from pms_room_status_log where room_id=$1 and to_status='inspected'`, [R301]) === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
