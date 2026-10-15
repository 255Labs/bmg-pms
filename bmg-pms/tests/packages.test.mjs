// Packages test: the price list, each hotel's add-ons and agreed prices, enforcement in the database, and add-on
// lines on the monthly invoice. Only platform administrators change prices or packages. Run: node tests/packages.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra); } };

const db = new PGlite({ extensions: { btree_gist }, parsers: { 1082: (v) => v } });
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

const OWNER = '40000000-0000-0000-0000-000000000001', OWNER2 = '40000000-0000-0000-0000-000000000002', ADMIN = '40000000-0000-0000-0000-000000000009';
await db.exec(`insert into auth.users values ('${OWNER}','gm@a.tz'),('${OWNER2}','gm@b.tz'),('${ADMIN}','admin@bmg.tz')`);
const as = (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`);
const val = async (sql, p = []) => Object.values((await db.query(sql, p)).rows[0] ?? {})[0];
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const err = async (sql, p = []) => { try { await db.query(sql, p); return ''; } catch (e) { return String(e.message); } };
const J = (x) => JSON.stringify(x);

await as(OWNER);
const A = await val(`select pms_create_property('Hotel A','HA','GM',$1::jsonb)`, [J([{ name: 'Room', base_rate: 100000, rooms: ['1', '2', '3', '4', '5'] }])]);
await as(OWNER2);
const B = await val(`select pms_create_property('Hotel B','HB','GM',$1::jsonb)`, [J([{ name: 'Room', base_rate: 100000, rooms: ['1'] }])]);
await as(null);
await db.exec(`insert into pms_platform_admins(user_id) values ('${ADMIN}')`);

console.log('The price list');
ok('every module and integration has an entry', Number(await val(`select count(*) from pms_catalog`)) >= 20);
ok('a new hotel starts with every add-on on', Number(await val(`select count(*) from pms_property_addons where property_id=$1 and enabled`, [A])) === Number(await val(`select count(*) from pms_catalog`)));
await as(OWNER);
ok('an owner cannot change prices', (await err(`select pms_admin_save_catalog('pos','{"monthly_price":1}'::jsonb)`)).includes('administrator'));
ok('…or their own package', (await err(`select pms_admin_set_addon($1,'pos','{"monthly_price_override":"0"}'::jsonb)`, [A])).includes('administrator'));
ok('…nor write the tables directly through the API', !(await val(`select has_table_privilege('authenticated','pms_property_addons','update') or has_table_privilege('authenticated','pms_catalog','update')`)));
await as(ADMIN);
await db.query(`select pms_admin_save_catalog('pos','{"monthly_price":120000}'::jsonb)`);
await db.query(`select pms_admin_save_catalog('channex','{"monthly_price":50000,"per_room_price":2000}'::jsonb)`);
await db.query(`select pms_admin_save_catalog('quickbooks','{"monthly_price":40000}'::jsonb)`);
const cat = await q(`select * from pms_admin_catalog()`);
ok('the administrator sets list prices and sees how many hotels use each', Number(cat.find((c) => c.key === 'pos').monthly_price) === 120000 && cat.find((c) => c.key === 'pos').properties_on === 2);

console.log('Each hotel\'s package');
await db.query(`select pms_admin_set_addon($1,'pos',$2::jsonb)`, [A, J({ monthly_price_override: 90000, note: 'Launch discount' })]);
await db.query(`select pms_admin_set_addon($1,'quickbooks',$2::jsonb)`, [A, J({ free_until: '2099-01-01' })]);
await db.query(`select pms_admin_set_addon($1,'activities','{"enabled":false}'::jsonb)`, [A]);
await db.query(`select pms_admin_set_addon($1,'procurement','{"enabled":false}'::jsonb)`, [A]);
await db.query(`select pms_admin_set_addon($1,'channex','{"enabled":false}'::jsonb)`, [B]);
ok('the base front office cannot be switched off', (await err(`select pms_admin_set_addon($1,'front_office','{"enabled":false}'::jsonb)`, [A])).includes('cannot be switched off'));
const pk = await q(`select * from pms_admin_property_addons($1)`, [A]);
ok('hotel A pays 90,000 for POS (agreed), Channex 50,000 + 5 rooms × 2,000, QuickBooks free for now', Number(pk.find((x) => x.key === 'pos').monthly_now) === 90000
  && Number(pk.find((x) => x.key === 'channex').monthly_now) === 60000 && Number(pk.find((x) => x.key === 'quickbooks').monthly_now) === 0);
ok('hotel B keeps the list price', Number((await q(`select * from pms_admin_property_addons($1)`, [B])).find((x) => x.key === 'pos').monthly_now) === 120000);
ok('the screens follow the package', (await val(`select features from pms_properties where id=$1`, [A])).procurement === false && (await val(`select features from pms_properties where id=$1`, [A])).pos === true);

console.log('The database enforces it');
await as(OWNER);
const GYM = await val(`insert into pms_pos_outlets(property_id,name,charge_category,outlet_type) values ($1,'Gym','recreation','gym') returning id`, [A]);
const BAR = await val(`insert into pms_pos_outlets(property_id,name,charge_category,outlet_type) values ($1,'Bar','fnb','bar') returning id`, [A]);
ok('no activities add-on: the gym cannot open a bill', (await err(`select pms_pos_open_bill($1,null)`, [GYM])).includes('Activities POS is not part'));
ok('…but the bar can', !!(await val(`select pms_pos_open_bill($1,null)`, [BAR])));
const LOC = await val(`insert into pms_stock_locations(property_id,name) values ($1,'Store') returning id`, [A]);
const SUP = await val(`insert into pms_suppliers(property_id,name) values ($1,'Supplier') returning id`, [A]);
ok('no procurement add-on: no purchase orders', (await err(`select pms_po_save($1,$2::jsonb)`, [A, J({ supplier_id: SUP, location_id: LOC, lines: [{ description: 'x', qty: 1, unit_price: 1 }] })])).includes('Procurement is not part'));
await as(OWNER2);
ok('hotel B without Channex cannot switch it on', (await err(`insert into pms_integrations(property_id,provider,enabled,config) values ($1,'channex',true,'{}')`, [B])).includes('Channex channel manager is not part'));
await as(ADMIN);
await db.query(`select pms_admin_set_addon($1,'activities','{"enabled":true}'::jsonb)`, [A]);
await as(OWNER);
ok('switched on again by BMG, the gym opens bills', !!(await val(`select pms_pos_open_bill($1,null)`, [GYM])));
await as(OWNER);
await db.query(`insert into pms_integrations(property_id,provider,enabled,config) values ($1,'sms',true,'{}')`, [A]);
await as(ADMIN);
await db.query(`select pms_admin_set_addon($1,'sms','{"enabled":false}'::jsonb)`, [A]);
ok('switching an integration off in the package switches it off at the hotel', (await val(`select enabled from pms_integrations where property_id=$1 and provider='sms'`, [A])) === false);

console.log('The monthly invoice');
await as(ADMIN);
await db.query(`select pms_admin_set_subscription($1,$2::jsonb)`, [A, J({ trial_ends: '2026-09-01', billing_day: 1 })]);
await as(null);
const INV = await val(`select pms__issue_invoice($1,'2026-10-14')`, [A]);
const inv = (await q(`select * from pms_sub_invoices where id=$1`, [INV]))[0];
const lab = inv.lines.map((l) => l.label);
ok('add-ons on the invoice: POS at the agreed price, Channex monthly and per room', lab.includes('Restaurant and bar POS (agreed price)') && lab.includes('Channex channel manager')
  && lab.includes('Channex channel manager, per active room') && inv.lines.find((l) => l.label === 'Channex channel manager, per active room').qty === 5, J(lab));
ok('free and switched-off add-ons are not charged', !lab.some((l) => l.startsWith('QuickBooks') || l.startsWith('Procurement') || l.startsWith('SMS')));
const plan = (await q(`select * from pms_plans where is_default`))[0];
const expected = Number(plan.base_monthly) + 5 * Number(plan.per_room) + 90000 + 50000 + 5 * 2000;
ok('the total is plan + add-ons, with VAT', Number(inv.subtotal) === expected && Number(inv.total) === Math.round(expected * (1 + Number(plan.vat_pct) / 100) * 100) / 100, `${inv.subtotal} vs ${expected}`);
await as(OWNER);
const mine = await q(`select * from pms_my_package($1)`, [A]);
ok('the owner sees their package and prices, and what else could be added', mine.find((m) => m.key === 'pos').enabled && Number(mine.find((m) => m.key === 'pos').monthly) === 90000
  && mine.find((m) => m.key === 'procurement').enabled === false);
await as(OWNER2);
ok('an owner cannot see another hotel\'s package', (await err(`select * from pms_my_package($1)`, [A])).includes('owners'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
