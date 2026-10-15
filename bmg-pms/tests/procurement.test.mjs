// Procurement and stores test: suppliers, purchase orders with approval limits and segregation of duties, goods
// received into stock at cost (purchase units → stock units), store requests and issues to the kitchen and the
// gym, three-way match on supplier invoices, payments, creditors ageing, purchases and reorder suggestions.
// Runs as real API callers (PostgREST roles, row security). Run: node tests/procurement.test.mjs
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

const U = { owner: '20000000-0000-0000-0000-000000000001', store: '20000000-0000-0000-0000-000000000002', mgr: '20000000-0000-0000-0000-000000000003',
  acct: '20000000-0000-0000-0000-000000000004', desk: '20000000-0000-0000-0000-000000000005', hk: '20000000-0000-0000-0000-000000000006' };
await db.exec(`insert into auth.users(id,email) values ('${U.owner}','gm@h.tz'),('${U.store}','store@h.tz'),('${U.mgr}','mgr@h.tz'),('${U.acct}','acct@h.tz'),('${U.desk}','desk@h.tz'),('${U.hk}','hk@h.tz')`);
const asSuper = () => db.exec(`reset role; set session authorization postgres; select set_config('test.uid','',false); select set_config('request.jwt.claims','',false)`);
async function as(uid) {
  await asSuper();
  await db.exec(`set session authorization authenticator; set role authenticated`);
  await db.query(`select set_config('test.uid', $1, false), set_config('request.jwt.claims', $2, false)`, [uid, JSON.stringify({ role: 'authenticated', sub: uid, aal: 'aal1' })]);
}
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const val = async (sql, p = []) => Object.values((await q(sql, p))[0] ?? {})[0];
const err = async (sql, p = []) => { try { await db.query(sql, p); return ''; } catch (e) { return String(e.message); } };
const J = (x) => JSON.stringify(x);

await asSuper(); await db.exec(`select set_config('test.uid','${U.owner}',false)`);
const P = await val(`select pms_create_property('Pumzika','PB','GM',$1::jsonb)`, [J([{ name: 'Villa', base_rate: 300000, rooms: ['101'] }])]);
for (const [m, r] of [['store@h.tz', 'storekeeper'], ['mgr@h.tz', 'manager'], ['acct@h.tz', 'accountant'], ['desk@h.tz', 'front_desk'], ['hk@h.tz', 'housekeeping']]) await db.query(`select pms_add_or_invite_member($1,$2,$3)`, [P, m, r]);
await db.query(`update pms_properties set business_date = '2026-10-14', settings = settings || '{"procurement":{"approval_limit":500000}}' where id=$1`, [P]);
const STORE = await val(`insert into pms_stock_locations(property_id,name,kind) values ($1,'Main store','store') returning id`, [P]);
const KITCHEN = await val(`insert into pms_stock_locations(property_id,name,kind) values ($1,'Kitchen','kitchen') returning id`, [P]);
const GYM = await val(`insert into pms_stock_locations(property_id,name,kind) values ($1,'Gym and spa','activity') returning id`, [P]);
const BEER = await val(`insert into pms_stock_items(property_id,name,unit,purchase_unit,units_per_purchase,reorder_level) values ($1,'Kilimanjaro lager','btl','case of 24',24,48) returning id`, [P]);
const RICE = await val(`insert into pms_stock_items(property_id,name,unit,purchase_unit,units_per_purchase) values ($1,'Rice','kg','bag of 25 kg',25) returning id`, [P]);
const TOWEL = await val(`insert into pms_stock_items(property_id,name,unit) values ($1,'Gym towel','pcs') returning id`, [P]);

console.log('Suppliers');
await as(U.desk);
ok('front desk cannot add suppliers', (await err(`insert into pms_suppliers(property_id,name) values ($1,'X')`, [P])) !== '');
await as(U.store);
const SBL = await val(`insert into pms_suppliers(property_id,name,phone,tin,payment_terms_days) values ($1,'Serengeti Breweries','0222 000 000','100-200-300',30) returning id`, [P]);
const MOH = await val(`insert into pms_suppliers(property_id,name,payment_terms_days) values ($1,'Mohamed Enterprises',14) returning id`, [P]);
await asSuper();
await db.query(`update pms_stock_items set default_supplier_id=$2 where id=$1`, [BEER, SBL]);
await db.query(`insert into pms_stock_par(property_id,location_id,item_id,par_level,reorder_level) values ($1,$2,$3,120,48)`, [P, STORE, BEER]);

console.log('Reorder and purchase orders');
await as(U.store);
const sug = await q(`select * from pms_reorder_suggestions($1,$2)`, [P, STORE]);
const sb = sug.find((s) => s.item === 'Kilimanjaro lager');
ok('an empty store suggests beer up to par, in cases (120 btl = 5 cases), from its supplier', sb && Number(sb.suggest_purchase_units) === 5 && sb.supplier === 'Serengeti Breweries');
const PO1 = await val(`select pms_po_save($1,$2::jsonb)`, [P, J({ supplier_id: SBL, location_id: STORE, lines: [{ item_id: BEER, qty: 5, unit_price: 48000, vat_pct: 18 }] })]);
let po = (await q(`select * from pms_purchase_orders where id=$1`, [PO1]))[0];
ok('the order is numbered and totalled with VAT (240,000 + 43,200)', po.po_no === 1 && Number(po.total) === 283200 && po.status === 'draft');
ok('within the approval limit it is approved on submit', (await val(`select pms_po_submit($1)`, [PO1])) === 'approved');
const PO2 = await val(`select pms_po_save($1,$2::jsonb)`, [P, J({ supplier_id: MOH, location_id: STORE, lines: [{ item_id: RICE, qty: 20, unit_price: 70000 }, { description: 'Kitchen gas refill', qty: 1, unit_price: 90000 }] })]);
ok('above the limit it waits for approval', (await val(`select pms_po_submit($1)`, [PO2])) === 'pending_approval');
ok('a storekeeper cannot approve', (await err(`select pms_po_approve($1,true)`, [PO2])).includes('cannot perform'));
ok('nothing is received before approval', (await err(`select pms_grn_post($1,$2::jsonb)`, [P, J({ po_id: PO2, lines: [] })])).includes('approved'));
await asSuper();
await db.query(`update pms_purchase_orders set submitted_by=$2 where id=$1`, [PO2, U.mgr]);
await as(U.mgr);
ok('the manager who raised it cannot approve it', (await err(`select pms_po_approve($1,true)`, [PO2])).includes('other than'));
await asSuper();
await db.query(`update pms_purchase_orders set submitted_by=$2 where id=$1`, [PO2, U.store]);
await as(U.mgr);
await db.query(`select pms_po_approve($1,true)`, [PO2]);
ok('another manager approves it', (await val(`select status from pms_purchase_orders where id=$1`, [PO2])) === 'approved');

console.log('Goods received');
await as(U.store);
const L1 = await val(`select id from pms_po_lines where po_id=$1`, [PO1]);
ok('more than ordered is refused', (await err(`select pms_grn_post($1,$2::jsonb)`, [P, J({ po_id: PO1, lines: [{ po_line_id: L1, qty: 6 }] })])).includes('More'));
const G1 = await val(`select pms_grn_post($1,$2::jsonb)`, [P, J({ po_id: PO1, delivery_note: 'DN 5521', lines: [{ po_line_id: L1, qty: 3 }] })]);
ok('3 of 5 cases received: the order is partly received', (await val(`select status from pms_purchase_orders where id=$1`, [PO1])) === 'partly_received');
await as(U.owner);
ok('72 bottles enter the main store at 2,000 a bottle', Number(await val(`select qty from pms_stock_levels where item_id=$1 and location_id=$2`, [BEER, STORE])) === 72
  && Number(await val(`select avg_cost from pms_stock_items where id=$1`, [BEER])) === 2000);
ok('the stock movement points to its delivery line', !!(await val(`select grn_line_id from pms_stock_moves where item_id=$1 and kind='receive'`, [BEER])));
await as(U.store);
const RL = (await q(`select * from pms_po_lines where po_id=$1 order by description`, [PO2]));
const RICEL = RL.find((l) => l.item_id === RICE).id, GASL = RL.find((l) => !l.item_id).id;
ok('a service line (gas refill) is not received into stock', (await err(`select pms_grn_post($1,$2::jsonb)`, [P, J({ po_id: PO2, lines: [{ po_line_id: GASL, qty: 1 }] })])).includes('not a stock item'));
const G2 = await val(`select pms_grn_post($1,$2::jsonb)`, [P, J({ po_id: PO2, lines: [{ po_line_id: RICEL, qty: 20, unit_cost: 72000, batch: 'B-77', expiry_date: '2027-06-30' }] })]);
ok('rice arrives at a higher price than ordered: 500 kg at 2,880/kg', Number(await val(`select avg_cost from pms_stock_items where id=$1`, [RICE])) === 2880);
const G3 = await val(`select pms_grn_post($1,$2::jsonb)`, [P, J({ supplier_id: MOH, location_id: STORE, lines: [{ item_id: TOWEL, qty: 40, unit_cost: 8000 }] })]);
ok('a delivery without an order is received too', !!G3 && Number(await val(`select qty from pms_stock_levels where item_id=$1 and location_id=$2`, [TOWEL, STORE])) === 40);

console.log('Store requests: the kitchen and the gym');
await as(U.hk);
const R1 = await val(`select pms_store_request($1,$2::jsonb)`, [P, J({ from_location_id: STORE, to_location_id: GYM, lines: [{ item_id: TOWEL, qty: 15 }] })]);
ok('housekeeping can ask the store for gym towels', !!R1);
ok('…but cannot issue them', (await err(`select pms_store_issue($1)`, [R1])).includes('cannot perform'));
await as(U.desk);
const R2 = await val(`select pms_store_request($1,$2::jsonb)`, [P, J({ from_location_id: STORE, to_location_id: KITCHEN, lines: [{ item_id: RICE, qty: 100 }, { item_id: BEER, qty: 100 }] })]);
await as(U.store);
await db.query(`select pms_store_issue($1)`, [R1]);
ok('the gym request is issued in full', (await val(`select status from pms_store_requests where id=$1`, [R1])) === 'issued');
ok('the store cannot issue more beer than it holds', (await err(`select pms_store_issue($1)`, [R2])).includes('Only 72'));
const rl = await q(`select id, item_id from pms_store_request_lines where request_id=$1`, [R2]);
const iss = await val(`select pms_store_issue($1,$2::jsonb)`, [R2, J(rl.map((l) => ({ line_id: l.id, qty: l.item_id === RICE ? 100 : 48 })))]);
ok('part of the kitchen request is issued at cost (100 kg × 2,880 + 48 × 2,000)', Number(iss.value) === 384000 && (await val(`select status from pms_store_requests where id=$1`, [R2])) === 'partly_issued');
await as(U.owner);
ok('stock moved from the store to the kitchen', Number(await val(`select qty from pms_stock_levels where item_id=$1 and location_id=$2`, [RICE, KITCHEN])) === 100
  && Number(await val(`select qty from pms_stock_levels where item_id=$1 and location_id=$2`, [RICE, STORE])) === 400);

console.log('Supplier invoices, three-way match and payments');
await as(U.store);
ok('a storekeeper cannot enter supplier invoices', (await err(`select pms_supplier_invoice_save($1,'{}'::jsonb)`, [P])).includes('cannot perform'));
await as(U.acct);
const g1l = await val(`select id from pms_grn_lines where grn_id=$1`, [G1]);
const I1 = await val(`select pms_supplier_invoice_save($1,$2::jsonb)`, [P, J({ supplier_id: SBL, invoice_no: 'SBL-9001', invoice_date: '2026-10-14', po_id: PO1, lines: [{ grn_line_id: g1l, qty: 3, unit_price: 48000, vat_pct: 18 }] })]);
let inv = (await q(`select * from pms_supplier_invoices where id=$1`, [I1]))[0];
ok('an invoice that agrees with order and delivery is matched; due in 30 days', inv.match_status === 'matched' && Number(inv.total) === 169920 && inv.due_date === '2026-11-13');
ok('the same supplier invoice number cannot be entered twice', (await err(`select pms_supplier_invoice_save($1,$2::jsonb)`, [P, J({ supplier_id: SBL, invoice_no: 'SBL-9001', lines: [{ description: 'x', qty: 1, unit_price: 1 }] })])).includes('already entered'));
const g2l = await val(`select id from pms_grn_lines where grn_id=$1`, [G2]);
const I2 = await val(`select pms_supplier_invoice_save($1,$2::jsonb)`, [P, J({ supplier_id: MOH, invoice_no: 'ME-311', invoice_date: '2026-08-01', lines: [{ grn_line_id: g2l, qty: 20, unit_price: 72000 }, { description: 'Kitchen gas refill', qty: 1, unit_price: 90000, expense_code: 'Utilities' }] })]);
inv = (await q(`select * from pms_supplier_invoices where id=$1`, [I2]))[0];
ok('a price above the order is flagged as a variance with the reason', inv.match_status === 'variance' && inv.match_notes.includes('ordered at 70000'));
ok('…and cannot be paid until a manager accepts it', (await err(`select pms_supplier_pay($1,100000,'bank','TT1')`, [I2])).includes('must accept'));
await as(U.mgr);
await db.query(`select pms_supplier_invoice_approve($1,'Price rise agreed by phone')`, [I2]);
await as(U.acct);
ok('payments need a reference', (await err(`select pms_supplier_pay($1,100000,'bank',null)`, [I2])).includes('reference'));
ok('cannot pay more than owed', (await err(`select pms_supplier_pay($1,9000000,'bank','TT1')`, [I2])).includes('Only'));
await db.query(`select pms_supplier_pay($1,500000,'bank','CRDB TT 7781')`, [I2]);
await db.query(`select pms_supplier_pay($1,$2,'mobile_money','QK44')`, [I1, 169920]);
ok('paying in full closes the invoice', (await val(`select status from pms_supplier_invoices where id=$1`, [I1])) === 'paid');
const cred = await q(`select * from pms_rpt_creditors($1,'2026-10-14')`, [P]);
const me = cred.find((c) => c.supplier === 'Mohamed Enterprises');
ok('creditors: Mohamed is owed 1,030,000, overdue 60 days, so in 31–60 (due 15 Aug)', me && Number(me.balance) === 1030000 && Number(me.d31_60) === 1030000, J(me));
ok('Serengeti owes nothing and is not listed', !cred.some((c) => c.supplier === 'Serengeti Breweries'));
const pur = await q(`select * from pms_rpt_purchases($1,'2026-10-01','2026-10-31')`, [P]);
ok('purchases report: 72 btl of beer for 144,000', pur.some((r) => r.item === 'Kilimanjaro lager' && Number(r.qty) === 72 && Number(r.value) === 144000));

console.log('Who sees what');
await as(U.store);
ok('a storekeeper sees orders and deliveries but not supplier money', (await q(`select * from pms_purchase_orders`)).length === 2 && (await q(`select * from pms_supplier_invoices`)).length === 0);
await as(U.hk);
ok('housekeeping sees its store requests, not orders', (await q(`select * from pms_store_requests`)).length === 2 && (await q(`select * from pms_purchase_orders`)).length === 0);
await as(U.store);
ok('only the order\'s own lines can be received against it', (await err(`select pms_grn_post($1,$2::jsonb)`, [P, J({ po_id: PO1, lines: [{ item_id: BEER, qty: 1, unit_cost: 1 }] })])).includes('must be one of its lines'));
await as(U.store);
await db.query(`select pms_po_cancel($1,'Supplier out of stock')`, [PO1]);
ok('cancelling a part-received order closes it', (await val(`select status from pms_purchase_orders where id=$1`, [PO1])) === 'closed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
