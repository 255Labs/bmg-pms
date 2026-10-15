// QuickBooks Online test: the real worker code against a fake QuickBooks. Connection and token refresh, account
// mapping, suppliers → vendors (with name clashes), supplier invoices → bills, payments → bill payments, a closed day →
// a balanced journal entry, missing mappings, reconnect, and who may see what. Run: node tests/quickbooks.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQuickBooks, authorizeUrl, exchangeCode } from '../supabase/functions/_shared/quickbooks.js';

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

const OWNER = '30000000-0000-0000-0000-000000000001', ACCT = '30000000-0000-0000-0000-000000000002', DESK = '30000000-0000-0000-0000-000000000003';
await db.exec(`insert into auth.users values ('${OWNER}','gm@h.tz'),('${ACCT}','acct@h.tz'),('${DESK}','desk@h.tz')`);
const as = (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`);
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const val = async (sql, p = []) => Object.values((await db.query(sql, p)).rows[0] ?? {})[0];
const err = async (sql, p = []) => { try { await db.query(sql, p); return ''; } catch (e) { return String(e.message); } };
const rpc = async (fn, args = {}) => {
  await as(null);
  const keys = Object.keys(args);
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
  const r = await db.query(`select * from ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, vals);
  return r.fields.length === 1 && r.fields[0].name === fn ? r.rows[0]?.[fn] : r.rows;
};
const J = (x) => JSON.stringify(x);

// ---------------------------------------------------------------- a hotel with a day of business
await as(OWNER);
const P = await val(`select pms_create_property('Goba Peaks','GP','GM',$1::jsonb)`, [J([{ name: 'Room', base_rate: 100000, rooms: ['1'] }])]);
await db.query(`select pms_add_or_invite_member($1,'acct@h.tz','accountant')`, [P]);
await db.query(`select pms_add_or_invite_member($1,'desk@h.tz','front_desk')`, [P]);
await db.query(`update pms_properties set business_date='2026-10-14' where id=$1`, [P]);
const ROOM = await val(`select id from pms_rooms where property_id=$1`, [P]);
const r = await val(`select pms_create_reservation($1,'{"first_name":"Neema","last_name":"Joseph","phone":"0713000222"}'::jsonb,'2026-10-14','2026-10-15',$2::jsonb)`, [P, J([{ room_id: ROOM }])]);
const STAY = await val(`select id from pms_stays where reservation_id=$1`, [r.reservation_id]);
const FOLIO = await val(`select id from pms_folios where stay_id=$1`, [STAY]);
await db.query(`select pms_check_in($1,true)`, [STAY]);
await db.query(`select pms_open_drawer($1,0)`, [P]);
await db.query(`select pms_post_charge($1,'room','Room 1',100000)`, [FOLIO]);
await db.query(`select pms_post_payment($1,60000,'cash')`, [FOLIO]);
const BAR = await val(`insert into pms_pos_outlets(property_id,name,charge_category,outlet_type) values ($1,'Bar','fnb','bar') returning id`, [P]);
const BEER = await val(`insert into pms_pos_items(property_id,outlet_id,name,price) values ($1,$2,'Beer',5000) returning id`, [P, BAR]);
const B = await val(`select pms_pos_open_bill($1,'Bar',1)`, [BAR]);
await db.query(`select pms_pos_order($1,$2,4)`, [B, BEER]);
await db.query(`select pms_pos_settle($1,'mobile_money','QK1')`, [B]);

console.log('Connecting');
await as(DESK);
ok('front desk cannot see the QuickBooks screen', (await err(`select pms_qbo_status($1)`, [P])).includes('cannot perform'));
await as(ACCT);
const state = await val(`select pms_qbo_begin($1)`, [P]);
const env = { QBO_CLIENT_ID: 'qbo-id', QBO_CLIENT_SECRET: 'qbo-secret', QBO_REDIRECT_URI: 'https://ref.supabase.co/functions/v1/quickbooks-oauth', QBO_ENVIRONMENT: 'sandbox' };
const u = new URL(authorizeUrl(env, state));
ok('the sign-in link asks for accounting access with our state and redirect', u.host === 'appcenter.intuit.com' && u.searchParams.get('scope') === 'com.intuit.quickbooks.accounting'
  && u.searchParams.get('state') === state && u.searchParams.get('redirect_uri') === env.QBO_REDIRECT_URI);

// ---------------------------------------------------------------- fake QuickBooks
const qb = { vendors: [{ Id: '55', DisplayName: 'Azam Dairy', SyncToken: '0' }], bills: {}, payments: [], journals: {}, refresh: 'R1', calls: [], expired: false, n: 100 };
const reply = (status, obj) => ({ ok: status < 300, status, text: async () => JSON.stringify(obj) });
const fakeFetch = async (url, init = {}) => {
  const uu = new URL(url);
  const body = !init.body ? null : init.headers['content-type'] === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body);
  qb.calls.push({ path: uu.pathname, search: uu.search, method: init.method ?? 'GET', headers: init.headers, body });
  if (uu.host === 'oauth.platform.intuit.com') {
    if (init.headers.authorization !== 'Basic ' + Buffer.from('qbo-id:qbo-secret').toString('base64')) return reply(401, { error: 'invalid_client' });
    if (body.grant_type === 'authorization_code') return body.code === 'CODE1' ? reply(200, { access_token: 'A1', refresh_token: 'R1', expires_in: 3600, x_refresh_token_expires_in: 8640000 }) : reply(400, { error: 'invalid_grant' });
    if (body.grant_type === 'refresh_token') {
      if (body.refresh_token !== qb.refresh) return reply(400, { error: 'invalid_grant', error_description: 'Token invalid' });
      qb.refresh = 'R' + (++qb.n); return reply(200, { access_token: 'A' + qb.n, refresh_token: qb.refresh, expires_in: 3600 });
    }
  }
  if (uu.host !== 'sandbox-quickbooks.api.intuit.com') return reply(404, {});
  if (!uu.searchParams.get('minorversion')) return reply(400, { Fault: { Error: [{ Message: 'minorversion required' }] } });
  if (qb.expired) return reply(401, { Fault: { Error: [{ Message: 'AuthenticationFailed' }] } });
  const ent = uu.pathname.split('/').pop();
  const id = () => String(++qb.n);
  if (ent === 'query') {
    const sql = uu.searchParams.get('query');
    if (sql.includes('from Vendor')) return reply(200, { QueryResponse: { Vendor: qb.vendors.filter((v) => sql.includes(`'${v.DisplayName}'`)) } });
    if (sql.includes('from Account')) return reply(200, { QueryResponse: { Account: [{ Id: '1', Name: 'Cash', AccountType: 'Bank' }] } });
  }
  if (ent === 'vendor') {
    if (!body.Id && qb.vendors.some((v) => v.DisplayName === body.DisplayName)) return reply(400, { Fault: { Error: [{ Message: 'Duplicate Name Exists Error', code: '6240' }] } });
    const v = { ...body, Id: body.Id ?? id(), SyncToken: body.Id ? String(Number(body.SyncToken) + 1) : '0' };
    qb.vendors = qb.vendors.filter((x) => x.Id !== v.Id).concat(v); return reply(200, { Vendor: v });
  }
  if (ent === 'bill' && uu.searchParams.get('operation') === 'delete') { delete qb.bills[body.Id]; return reply(200, { Bill: { Id: body.Id, status: 'Deleted' } }); }
  if (ent === 'bill') { const b = { ...body, Id: body.Id ?? id(), SyncToken: '0' }; qb.bills[b.Id] = b; return reply(200, { Bill: b }); }
  if (ent === 'billpayment') { const b = { ...body, Id: id(), SyncToken: '0' }; qb.payments.push(b); return reply(200, { BillPayment: b }); }
  if (ent === 'journalentry') {
    const dr = body.Line.filter((l) => l.JournalEntryLineDetail.PostingType === 'Debit').reduce((s, l) => s + l.Amount, 0);
    const cr = body.Line.filter((l) => l.JournalEntryLineDetail.PostingType === 'Credit').reduce((s, l) => s + l.Amount, 0);
    if (Math.abs(dr - cr) > 0.001) return reply(400, { Fault: { Error: [{ Message: 'Transaction must balance', code: '6000' }] } });
    const j = { ...body, Id: body.Id ?? id(), SyncToken: body.Id ? String(Number(body.SyncToken) + 1) : '0' }; qb.journals[j.Id] = j; return reply(200, { JournalEntry: j });
  }
  if (ent.startsWith('companyinfo') || uu.pathname.includes('companyinfo')) return reply(200, { CompanyInfo: { CompanyName: 'Goba Peaks Ltd' } });
  return reply(404, {});
};

const t = await exchangeCode(fakeFetch, env, 'CODE1');
ok('the code is exchanged for tokens with the app\'s credentials', t.access === 'A1' && t.refresh === 'R1');
await rpc('pms_svc_qbo_consume_state', { p_state: state });
ok('a state can only be used once', (await rpc('pms_svc_qbo_consume_state', { p_state: state })) === null);
await rpc('pms_svc_qbo_save', { p_property: P, p_realm: '9341', p_env: 'sandbox', p_access: 'A1', p_access_expires: new Date(Date.now() - 1000).toISOString(),
  p_refresh: 'R1', p_refresh_expires: t.refreshExpires, p_company: 'Goba Peaks Ltd', p_user: ACCT });
await as(ACCT);
let st = await val(`select pms_qbo_status($1)`, [P]);
ok('the accountant sees the company and the accounts to map', st.connected && st.company === 'Goba Peaks Ltd' && st.accounts.some((a) => a.key === 'revenue:room') && st.accounts.some((a) => a.key === 'guest_ledger'));
ok('nobody can read the tokens through the API', !(await one(`select has_table_privilege('authenticated','pms_qbo_connections','select') x`)).x);

console.log('Suppliers, bills and payments');
await as(ACCT);
const SUP = await val(`insert into pms_suppliers(property_id,name,phone,tin) values ($1,'Mohamed Enterprises','0713 111 222','123-456-789') returning id`, [P]);
const SUP2 = await val(`insert into pms_suppliers(property_id,name) values ($1,'Azam Dairy') returning id`, [P]);
ok('a new supplier queues a vendor for QuickBooks', Number(await val(`select count(*) from pms_jobs where provider='quickbooks' and kind='vendor'`)) === 2);
let out = await runQuickBooks({ rpc, fetchFn: fakeFetch, env });
ok('the expired access token is refreshed first and the new refresh token kept', qb.calls.some((c) => c.body?.grant_type === 'refresh_token')
  && (await one(`select refresh_token from pms_qbo_connections where property_id=$1`, [P])).refresh_token === qb.refresh);
const vcall = qb.calls.find((c) => c.path.endsWith('/vendor') && c.body.DisplayName === 'Mohamed Enterprises');
ok('the vendor goes with name, phone and TIN, on minor version 75', vcall && vcall.body.PrimaryPhone.FreeFormNumber === '0713 111 222' && vcall.body.AcctNum === '123-456-789' && vcall.search.includes('minorversion=75'));
ok('a supplier already in QuickBooks under the same name is linked, not duplicated', (await val(`select qbo_id from pms_qbo_links where entity='vendor' and local_id=$1`, [SUP2])) === '55');
const STORE = await val(`insert into pms_stock_locations(property_id,name) values ($1,'Store') returning id`, [P]);
const MILK = await val(`insert into pms_stock_items(property_id,name,unit) values ($1,'Milk','l') returning id`, [P]);
await as(OWNER);
const G = await val(`select pms_grn_post($1,$2::jsonb)`, [P, J({ supplier_id: SUP, location_id: STORE, lines: [{ item_id: MILK, qty: 20, unit_cost: 2500, vat_pct: 18 }] })]);
const GL = await val(`select id from pms_grn_lines where grn_id=$1`, [G]);
const INV = await val(`select pms_supplier_invoice_save($1,$2::jsonb)`, [P, J({ supplier_id: SUP, invoice_no: 'ME-1001', invoice_date: '2026-10-14',
  lines: [{ grn_line_id: GL, qty: 20, unit_price: 2500, vat_pct: 18 }, { description: 'Generator service', qty: 1, unit_price: 80000, expense_code: 'Repairs' }] })]);
out = await runQuickBooks({ rpc, fetchFn: fakeFetch, env });
ok('without mapped accounts the bill waits and says which to map', (await val(`select last_error from pms_jobs where kind='bill'`)).includes('inventory') && (await val(`select last_error from pms_jobs where kind='bill'`)).includes('expense:Repairs'));
await as(ACCT);
for (const [k, id] of [['inventory', '10'], ['expense:Repairs', '11'], ['vat_input', '12'], ['payment:bank', '13'], ['payment:cash', '14'], ['payment:mobile_money', '15'],
  ['revenue:room', '20'], ['revenue:fnb', '21'], ['revenue:tax', '22'], ['guest_ledger', '30'], ['cogs', '40'], ['discounts', '41']]) await db.query(`select pms_qbo_set_mapping($1,$2,$3,$4)`, [P, k, id, k]);
ok('mapping an unknown key is refused', (await err(`select pms_qbo_set_mapping($1,'revenue:moon','1','x')`, [P])).includes('Unknown'));
await as(null); await db.query(`update pms_jobs set run_after = now() where provider='quickbooks'`);
out = await runQuickBooks({ rpc, fetchFn: fakeFetch, env });
const bill = Object.values(qb.bills)[0];
ok('the bill goes to the vendor with stock to inventory, the service to repairs and VAT apart', bill && bill.VendorRef.value === (await val(`select qbo_id from pms_qbo_links where entity='vendor' and local_id=$1`, [SUP]))
  && bill.Line.find((l) => l.AccountBasedExpenseLineDetail.AccountRef.value === '10').Amount === 50000
  && bill.Line.find((l) => l.AccountBasedExpenseLineDetail.AccountRef.value === '11').Amount === 80000
  && bill.Line.find((l) => l.Description === 'VAT').Amount === 9000 && bill.DocNumber === 'ME-1001', J(bill?.Line));
await as(OWNER);
await db.query(`select pms_supplier_pay($1,50000,'bank','TT 991')`, [INV]);
await runQuickBooks({ rpc, fetchFn: fakeFetch, env });
const pay = qb.payments[0];
ok('the payment is linked to the bill and drawn on the mapped bank account', pay && pay.Line[0].LinkedTxn[0].TxnId === bill.Id && pay.CheckPayment.BankAccountRef.value === '13' && pay.TotalAmt === 50000);

console.log('The closed day');
await as(ACCT);
const prev = await val(`select pms_qbo_preview_day($1,'2026-10-14')`, [P]);
const dr = prev.lines.filter((l) => l.side === 'Debit').reduce((s, l) => s + Number(l.amount), 0);
const cr = prev.lines.filter((l) => l.side === 'Credit').reduce((s, l) => s + Number(l.amount), 0);
ok('the day balances: room 100,000 and bar 20,000 against cash 60,000, M-Pesa 20,000 and the guest ledger 40,000',
  Math.abs(dr - cr) < 0.01 && prev.lines.find((l) => l.key === 'revenue:room').amount == 100000 && prev.lines.find((l) => l.key === 'guest_ledger').amount == 40000
  && prev.lines.find((l) => l.key === 'payment:mobile_money').amount == 20000, J(prev.lines));
ok('a day not yet closed cannot be sent', (await err(`select pms_qbo_send_day($1,'2026-10-14')`, [P])).includes('closed'));
await as(null); await db.query(`update pms_properties set business_date='2026-10-15' where id=$1`, [P]);
await as(ACCT);
await db.query(`select pms_qbo_send_day($1,'2026-10-14')`, [P]);
await runQuickBooks({ rpc, fetchFn: fakeFetch, env });
const je = Object.values(qb.journals)[0];
ok('one journal entry per day, numbered PMS-20261014, and QuickBooks accepted it as balanced', je && je.DocNumber === 'PMS-20261014' && je.TxnDate === '2026-10-14');
await as(ACCT); await db.query(`select pms_qbo_send_day($1,'2026-10-14')`, [P]);
await runQuickBooks({ rpc, fetchFn: fakeFetch, env });
ok('sending the day again updates the same entry instead of adding another', Object.keys(qb.journals).length === 1 && Object.values(qb.journals)[0].SyncToken === '1');

console.log('Losing the connection');
qb.refresh = 'SOMETHING-ELSE'; qb.expired = true;
await as(null); await db.query(`update pms_qbo_connections set access_expires_at = now() - interval '1 hour' where property_id=$1`, [P]);
await as(ACCT); await db.query(`insert into pms_suppliers(property_id,name) values ($1,'New Supplier')`, [P]);
await runQuickBooks({ rpc, fetchFn: fakeFetch, env });
await as(ACCT);
st = await val(`select pms_qbo_status($1)`, [P]);
ok('a refused refresh marks the connection "reconnect" and the job keeps its error', st.status === 'needs_reconnect' && st.recent.some((j) => (j.error ?? '').includes('sign-in failed')));
await db.query(`select pms_qbo_disconnect($1)`, [P]);
ok('disconnecting clears the tokens', (await rpc('pms_svc_qbo_connections', {})).length === 0 && (await one(`select refresh_token from pms_qbo_connections where property_id=$1`, [P])).refresh_token === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
