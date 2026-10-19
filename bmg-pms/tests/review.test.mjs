// Review test: fixes and gaps from the schema review (migration 18): local dates, range checks, door codes on undo,
// Channex max stay, sign-in cleanup, item photos, undo check-in / check-out and merging duplicate guests.
// Run: node tests/review.test.mjs
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
const book = async (n, first, from, to) => (await one(`select pms_create_reservation($1,$2::jsonb,$3::date,$4::date,$5::jsonb) r`, [P, JSON.stringify({ first_name: first, phone: '0754000111' }), from, to, JSON.stringify([{ room_id: await room(n) }])])).r;
const stayOf = (r) => val(`select id from pms_stays where reservation_id=$1`, [r.reservation_id]);

console.log('Local dates');
ok("today follows Dar es Salaam, not the server's UTC date", await val(`select pms__today() = (now() at time zone 'Africa/Dar_es_Salaam')::date`));
ok('a new property starts on its own local date', (await val(`select column_default from information_schema.columns where table_name='pms_properties' and column_name='business_date'`)).includes('pms__today'));

console.log('\nRange checks');
ok('negative base rate refused', /base_rate_nonneg/.test(await err(`update pms_room_types set base_rate=-1 where id=$1`, [SINGLE])));
ok('tax over 100% refused', /tax_range|rate/.test(await err(`insert into pms_taxes(property_id,name,rate) values ($1,'Silly tax',150)`, [P])) || /tax_range/.test(await err(`update pms_properties set tax_rate=150 where id=$1`, [P])));
ok('negative credit limit refused', /credit_nonneg/.test(await err(`insert into pms_companies(property_id,name,credit_limit) values ($1,'Bad Co',-5)`, [P])));
ok('commission over 100% refused', /commission_range/.test(await err(`insert into pms_business_sources(property_id,name,commission_pct) values ($1,'Odd OTA',120)`, [P])));

console.log('\nUndo check-in');
const r1 = await book('331', 'Ann', '2026-10-13', '2026-10-15');
const S1 = await stayOf(r1);
await db.query(`select pms_check_in($1)`, [S1]);
await db.exec(`insert into pms_integrations(property_id, provider, enabled) values ('${P}','ttlock',true) on conflict (property_id, provider) do update set enabled = true`);
await as(DESK);
ok('front desk cannot undo a check-in by default', /Undo a check-in/.test(await err(`select pms_undo_check_in($1,'wrong guest')`, [S1])));
await as(MGR);
ok('a reason is required', /Say why/.test(await err(`select pms_undo_check_in($1,'')`, [S1])));
await db.query(`select pms_undo_check_in($1,'wrong room keyed in')`, [S1]);
ok('the stay is back to confirmed', (await val(`select status from pms_stays where id=$1`, [S1])) === 'confirmed');
ok('the door code is revoked', Number(await val(`select count(*) from pms_jobs where payload->>'stay_id'=$1 and kind='revoke_passcode'`, [S1])) === 1);
ok('it is in the audit trail', Number(await val(`select count(*) from pms_audit_log where action='stay.undo_check_in' and entity_id=$1`, [S1])) === 1);
await db.query(`select pms_check_in($1)`, [S1]);
ok('and the guest can be checked in again', (await val(`select status from pms_stays where id=$1`, [S1])) === 'checked_in');

console.log('\nUndo check-out');
const r2 = await book('332', 'Ben', '2026-10-13', '2026-10-16');
const S2 = await stayOf(r2);
await as(OWNER);
await db.exec(`update pms_rooms set hk_status='clean' where property_id='${P}'`);
await db.query(`select pms_check_in($1)`, [S2]);
await db.query(`select pms_check_out($1)`, [S2]);
ok('early check-out shortens the stay', (await val(`select departure::text from pms_stays where id=$1`, [S2])) === '2026-10-14');
await as(MGR);
await db.query(`select pms_undo_check_out($1,'guest came back for another night')`, [S2]);
const s2 = await one(`select status, departure::text d from pms_stays where id=$1`, [S2]);
ok('undo puts the guest back in house with the booked departure', s2.status === 'checked_in' && s2.d === '2026-10-16', JSON.stringify(s2));
ok('the folio is open again', (await val(`select count(*) from pms_folios where stay_id=$1 and status='open'`, [S2])) > 0);
await db.query(`select pms_check_out($1)`, [S2]);
const r3 = await book('332', 'Cleo', '2026-10-14', '2026-10-15');
ok('undo refuses when the room was sold again', /already booked/.test(await err(`select pms_undo_check_out($1,'oops')`, [S2])));

console.log('\nMerge duplicate guests');
const g1 = await val(`select guest_id from pms_reservations where id=$1`, [r1.reservation_id]);
const dup = await val(`insert into pms_guests(property_id,first_name,email,attributes,notes) values ($1,'Ann','ann@example.com','{VIP}','Prefers a high floor') returning id`, [P]);
const r4 = (await one(`select pms_create_reservation($1,$2::jsonb,'2026-10-20','2026-10-21',$3::jsonb) r`, [P, JSON.stringify({ id: dup }), JSON.stringify([{ room_type_id: DOUBLE }])])).r;
await as(DESK);
ok('front desk cannot merge by default', /Merge duplicate/.test(await err(`select pms_merge_guests($1,$2)`, [g1, dup])));
await as(MGR);
const m = await val(`select pms_merge_guests($1,$2)`, [g1, dup]);
ok('bookings move to the kept profile', Number(m.reservations) >= 1 && (await val(`select guest_id from pms_reservations where id=$1`, [r4.reservation_id])) === g1);
const kept = await one(`select email, attributes, notes from pms_guests where id=$1`, [g1]);
ok('missing details are filled in and tags joined', kept.email === 'ann@example.com' && kept.attributes.includes('VIP') && /high floor/.test(kept.notes ?? ''));
ok('the duplicate is gone', Number(await val(`select count(*) from pms_guests where id=$1`, [dup])) === 0);

console.log('\nChannex, sign-ins and photos');
await as(null);
await db.query(`insert into pms_channex_rate_map(property_id, room_type_id, rate_plan_id, channex_rate_plan_id) values ($1,$2,$3,'cx-rp-1')`, [P, SINGLE, RO]);
await db.query(`insert into pms_rate_restrictions(property_id, room_type_id, rate_plan_id, rate_date, min_stay, max_stay) values ($1,$2,$3,'2026-10-14',2,5)`, [P, SINGLE, RO]);
const snap = await val(`select pms_svc_ari_snapshot($1,'2026-10-13','2026-10-16')`, [P]);
const d14 = snap.rates.find((r) => r.date === '2026-10-14');
ok('the ARI snapshot carries max stay', d14?.max_stay === 5 && d14?.min_stay === 2, JSON.stringify(d14));
const { buildAriValues } = await import('../supabase/functions/_shared/channex.js');
const vals = buildAriValues(snap, 'cx-prop');
ok('…and the Channex request sends it (0 = no limit)', vals.restrictions.some((v) => v.max_stay === 5) && vals.restrictions.some((v) => v.max_stay === 0), JSON.stringify(vals.restrictions));
ok('sign-in records are deleted with the account', (await val(`select count(*) from pg_constraint where conname='pms_sign_ins_user_fk'`)) == 1);
await as(OWNER);
const OUT = await val(`insert into pms_pos_outlets(property_id,name,outlet_type,charge_category) values ($1,'Bar','bar','fnb') returning id`, [P]);
ok('item photos must be https', /image_https/.test(await err(`insert into pms_pos_items(property_id,outlet_id,name,price,image_url) values ($1,$2,'Lager',5000,'http://x.y/a.jpg')`, [P, OUT])));
ok('https photos are fine', !(await err(`insert into pms_pos_items(property_id,outlet_id,name,price,image_url) values ($1,$2,'Lager',5000,'https://abc.supabase.co/storage/v1/object/public/property-media/x.jpg')`, [P, OUT])));

console.log('\nAre you sure: room moves and amendments');
await as(DESK);
const r5 = await book('333', 'Dora', '2026-10-13', '2026-10-16');
const S5 = await stayOf(r5);
const pv = await val(`select pms_change_preview($1,$2)`, [S5, await room('340')]);
ok('a move preview shows the new type and its normal rate', pv.type_changed && Number(pv.current_rate) === 200000 && Number(pv.suggested_rate) === 300000, JSON.stringify(pv));
ok('…and what the remaining nights cost now and after', Number(pv.to_post_before) === 3 && Number(pv.charges_before) === 600000 && Number(pv.charges_suggested) === 900000);
ok('previewing changes nothing', (await val(`select room_id from pms_stays where id=$1`, [S5])) === await room('333'));
await db.query(`select pms_move_room($1,$2,300000,'Guest asked for a double')`, [S5, await room('340')]);
const m5 = await one(`select room_id, rate from pms_stays where id=$1`, [S5]);
ok('move with the new rate in one step', m5.room_id === await room('340') && Number(m5.rate) === 300000);
ok('the reason is in the audit trail', Number(await val(`select count(*) from pms_audit_log where action='stay.move' and entity_id=$1 and details->>'reason' like 'Guest asked%'`, [S5])) === 1);
await db.query(`select pms_move_room($1,$2,null,null)`, [S5, await room('333')]);
ok('moving back while keeping the rate leaves it unchanged', Number(await val(`select rate from pms_stays where id=$1`, [S5])) === 300000);
const pa = await val(`select pms_change_preview($1,null,null,'2026-10-18',3,0)`, [S5]);
ok('an amendment preview counts the extra nights', Number(pa.to_post_after) === 5 && Number(pa.charges_keep) === 1500000);
ok('…and prices the extra adult on the normal rate', Number(pa.suggested_rate) >= 200000, JSON.stringify(pa));
await db.query(`select pms_change_stay($1,'2026-10-13','2026-10-15',1,0,250000,'Leaving a day early')`, [S5]);
const c5 = await one(`select departure::text d, rate from pms_stays where id=$1`, [S5]);
ok('amend with the chosen rate and a reason', c5.d === '2026-10-15' && Number(c5.rate) === 250000);
ok('the reason is logged', Number(await val(`select count(*) from pms_audit_log where action='stay.amend_reason' and entity_id=$1`, [S5])) === 1);

console.log('\nReinstating a no-show or cancelled booking');
await as(OWNER);
await db.exec(`update pms_properties set business_date='2026-11-01' where id='${P}'`);
const rn = await book('332', 'Nadia', '2026-11-01', '2026-11-04');
const SN = await stayOf(rn);
const rc = await book('335', 'Omar', '2026-11-03', '2026-11-05');
const SC = await stayOf(rc);
const old = await book('340', 'Quinn', '2026-11-03', '2026-11-04');
const SO = await stayOf(old);
await db.exec(`update pms_properties set business_date='2026-11-02' where id='${P}'`);
await db.query(`update pms_stays set status='no_show' where id=$1`, [SN]);   // as the night audit of 1 Nov would
await db.query(`select pms__refresh_reservation($1)`, [rn.reservation_id]);
const nf = await val(`select id from pms_folios where stay_id=$1`, [SN]);
await db.query(`select pms_post_room_charge($1,'no_show',200000,'No-show 1 Nov')`, [nf]);
await as(DESK);
ok('the front desk cannot reinstate', (await err(`select pms_reinstate_stay($1,'Guest arrived')`, [SN])).length > 0);
await as(MGR);
ok('a reason is required', (await err(`select pms_reinstate_stay($1,'')`, [SN])).includes('Say why'));
const back = await val(`select pms_reinstate_stay($1,'Flight delayed, guest arrived today',true)`, [SN]);
const sn = await one(`select status, arrival::text a, departure::text d, room_id from pms_stays where id=$1`, [SN]);
ok('the no-show is confirmed again, starting today (the missed night is not stayed)', sn.status === 'confirmed' && sn.a === '2026-11-02' && sn.d === '2026-11-04' && back.arrival_moved === true);
ok('it keeps its room', sn.room_id === await room('332') && back.room_released === false);
ok('the no-show fee was waived (voided with the reason)', Number(await val(`select count(*) from pms_folio_lines where stay_id=$1 and sub_type='no_show' and voided and void_reason like 'Fee waived%'`, [SN])) === 1 && back.fees_voided === 1);
ok('the reservation shows as confirmed again', (await val(`select status from pms_reservations where id=$1`, [rn.reservation_id])) === 'confirmed');
ok('it is in the audit trail with the reason', Number(await val(`select count(*) from pms_audit_log where action='stay.reinstate' and entity_id=$1`, [SN])) === 1);
await as(OWNER);
await db.query(`select pms_cancel_stay($1,'Changed plans')`, [SC]);
await book('335', 'Paul', '2026-11-03', '2026-11-05');   // the room is sold again
const back2 = await val(`select pms_reinstate_stay($1,'Cancelled by mistake')`, [SC]);
ok('a cancelled booking whose room was resold comes back without a room, for the desk to assign', back2.room_released === true
  && (await val(`select room_id from pms_stays where id=$1`, [SC])) === null && (await val(`select status from pms_stays where id=$1`, [SC])) === 'confirmed');
await db.query(`select pms_cancel_stay($1,'x')`, [SO]);
await db.exec(`update pms_properties set business_date='2026-11-05' where id='${P}'`);
ok('a booking whose dates are over cannot be reinstated', (await err(`select pms_reinstate_stay($1,'Too late')`, [SO])).includes('dates are over'));
ok('a live booking cannot be reinstated', (await err(`select pms_reinstate_stay($1,'x')`, [SC])).includes('Only a no-show'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
