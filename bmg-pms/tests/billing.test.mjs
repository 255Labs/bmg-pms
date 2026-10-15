// BMG PMS subscription test: monthly usage invoices, past due, locking, paying by ClickPesa, unlocking.
// Real migrations on PGlite, fake ClickPesa. Run: node tests/billing.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBilling, handleWebhook } from '../supabase/functions/_shared/clickpesa.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra); } };

const db = new PGlite({ extensions: { btree_gist }, parsers: { 1082: (v) => v } });   // dates stay as YYYY-MM-DD
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

const OWNER = '11111111-1111-1111-1111-111111111111', DESK = '22222222-2222-2222-2222-222222222222', ADMIN = '99999999-9999-9999-9999-999999999999';
await db.exec(`insert into auth.users values ('${OWNER}','owner@bmg.co.tz'), ('${DESK}','desk@bmg.co.tz'), ('${ADMIN}','admin@bmg.co.tz');`);
const as = (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`);
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const fails = async (sql, p, match) => { try { await db.query(sql, p); return false; } catch (e) { return !match || String(e.message).includes(match) || (console.log('     got:', e.message), false); } };
const rpc = async (fn, args = {}) => {
  await as(null);
  const keys = Object.keys(args);
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
  const r = await db.query(`select * from ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, vals);
  return r.fields.length === 1 && r.fields[0].name === fn ? r.rows[0]?.[fn] : r.rows;
};

await as(OWNER);
const P = (await one(`select pms_create_property('Unreal Homes','UH','Balati',$1::jsonb) id`, [JSON.stringify([{ name: 'Single', base_rate: 200000, rooms: ['331', '332'] }])])).id;
await db.query(`select pms_set_member($1, 'desk@bmg.co.tz', 'front_desk')`, [P]);
await db.exec(`insert into pms_platform_admins(user_id) values ('${ADMIN}')`);   // once there is an administrator, owners no longer open properties themselves
const TODAY = (await one(`select pms__today(timezone) d from pms_properties where id=$1`, [P])).d;
const day = (n) => new Date(Date.parse(TODAY + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const sub = () => one(`select * from pms_subscriptions where property_id=$1`, [P]);
const locked = async () => (await one(`select billing_locked from pms_properties where id=$1`, [P])).billing_locked;
const refresh = (d = TODAY) => db.query(`select pms__billing_refresh($1, $2::date)`, [P, d]);

// ---------------------------------------------------------------- new property
console.log('A new property');
let s = await sub();
const STD = (await one(`select id from pms_plans where is_default`)).id;
ok('starts on the default plan with a 30-day free trial', s.plan_id === STD && s.status === 'trial' && s.trial_ends === day(30));
await db.query(`select pms__billing_run($1::date)`, [TODAY]);
ok('no invoice during the trial', Number((await one(`select count(*) n from pms_sub_invoices where property_id=$1`, [P])).n) === 0);
ok('the billing tables are closed to the app', !(await one(`select has_table_privilege('authenticated','pms_sub_invoices','select') x`)).x
  && !(await one(`select has_table_privilege('authenticated','pms_plans','select') x`)).x);

// ---------------------------------------------------------------- administrators
console.log('Administrators');
await as(OWNER);
ok('owners cannot change their own subscription', await fails(`select pms_admin_set_subscription($1, '{"trial_ends":"2099-01-01"}'::jsonb)`, [P], 'administrator'));
ok('owners cannot record payments or see other properties', await fails(`select * from pms_admin_billing_overview()`, [], 'administrator'));
await as(ADMIN);
await db.query(`select pms_admin_set_subscription($1, $2::jsonb)`, [P, JSON.stringify({ trial_ends: day(-1), billing_day: 1 })]);
ok('ending the trial makes it active', (await sub()).status === 'active');
const ov = await db.query(`select * from pms_admin_billing_overview()`);
ok('the overview shows usage counts', ov.rows[0].rooms === 2 && ov.rows[0].users === 2 && ov.rows[0].plan === 'Standard');

// ---------------------------------------------------------------- invoice
console.log('Monthly invoice');
await db.query(`select pms__billing_run($1::date)`, [TODAY]);
let inv = await one(`select * from pms_sub_invoices where property_id=$1`, [P]);
ok('issued with the monthly fee, rooms and VAT', inv && Number(inv.subtotal) === 170000 && Number(inv.vat) === 30600 && Number(inv.total) === 200600, JSON.stringify(inv?.lines));
ok('lines show 2 rooms at 10,000', inv.lines.some((l) => l.label === 'Active rooms' && l.qty === 2 && Number(l.amount) === 20000));
ok('numbered BMG-YYYY-NNNNN, due in 7 days', /^BMG-\d{4}-\d{5}$/.test(inv.invoice_no) && inv.due_on === day(7));
const period = inv.period_start;
ok('the period runs one month from the billing day', inv.period_start.endsWith('-01'));
await db.query(`select pms__billing_run($1::date)`, [TODAY]);
ok('running again the same month issues nothing new', Number((await one(`select count(*) n from pms_sub_invoices where property_id=$1`, [P])).n) === 1);

await as(OWNER);
let st = (await one(`select pms_billing_status($1) s`, [P])).s;
ok('the owner sees the invoice and the balance', Number(st.balance) === 200600 && st.invoices.length === 1 && st.subscription.status === 'active');
await as(DESK);
ok('front desk cannot see the subscription', await fails(`select pms_billing_status($1)`, [P], 'owners'));

// ---------------------------------------------------------------- overdue → locked
console.log('Overdue and locked');
await db.query(`update pms_sub_invoices set due_on=$2 where id=$1`, [inv.id, day(-3)]);
await refresh();
ok('3 days late is past due, still open', (await sub()).status === 'past_due' && !(await locked()));
await db.query(`update pms_sub_invoices set due_on=$2 where id=$1`, [inv.id, day(-8)]);
await refresh();
ok('past the 7 days of grace the property locks', (await sub()).status === 'locked' && (await locked()));
await as(DESK);
ok('front desk is shut out of the property', (await one(`select pms_role($1) r`, [P])).r === null);
ok('…and every check that relies on it', await fails(`select pms_need($1,'res.add')`, [P]));
await as(OWNER);
ok('the owner is shut out of the desk too', (await one(`select pms_role($1) r`, [P])).r === null
  && Number((await one(`select count(*) n from pms_my_properties()`)).n) === 0);
const bl = (await db.query(`select * from pms_billing_blocked_properties()`)).rows;
ok('the app learns which property is locked and what is owed', bl.length === 1 && Number(bl[0].balance) === 200600 && bl[0].role === 'owner');
st = (await one(`select pms_billing_status($1) s`, [P])).s;
ok('the owner can still open the bill while locked', st.subscription.status === 'locked' && st.invoices[0].lock_on === day(0));
await as(DESK);
ok('front desk cannot pay', await fails(`select pms_billing_pay($1,'0713000111')`, [inv.id], 'owners'));
await as(ADMIN);
await db.query(`select pms_admin_set_subscription($1, $2::jsonb)`, [P, JSON.stringify({ hold_until: day(2) })]);
ok('"keep open until" lifts the lock while payment is sorted', (await sub()).status === 'past_due' && !(await locked()));
await db.query(`select pms_admin_set_subscription($1, '{"hold_until":""}'::jsonb)`, [P]);
ok('clearing it locks again', await locked());

// ---------------------------------------------------------------- paying by phone
console.log('Paying by mobile money');
const cp = { orders: {}, rejectPhone: '255700000000' };
const calls = [];
const reply = (status, obj) => ({ ok: status < 300, status, text: async () => JSON.stringify(obj) });
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ path: u.pathname, headers: init.headers, body });
  if (u.pathname === '/third-parties/generate-token') {
    return init.headers['client-id'] === 'bmg-platform' && init.headers['api-key'] === 'bmg-key' ? reply(200, { success: true, token: 'Bearer plat' }) : reply(401, { message: 'Invalid credentials' });
  }
  if (init.headers.authorization !== 'Bearer plat') return reply(401, { message: 'Unauthorized' });
  if (u.pathname.endsWith('initiate-ussd-push-request')) {
    if (body.phoneNumber === cp.rejectPhone) return reply(400, { message: 'Invalid phone number' });
    cp.orders[body.orderReference] = { id: 'SUBTXN' + Object.keys(cp.orders).length, status: 'PROCESSING', collectedAmount: null };
    return reply(200, { id: cp.orders[body.orderReference].id, status: 'PROCESSING' });
  }
  const m = u.pathname.match(/^\/third-parties\/payments\/([A-Za-z0-9]+)$/);
  if (m) { const o = cp.orders[m[1]]; return o ? reply(200, [{ id: o.id, status: o.status, collectedAmount: o.collectedAmount }]) : reply(404, {}); }
  return reply(404, {});
};
// the hotel's own ClickPesa account (guest payments) and BMG's platform account are different
const env = { CLICKPESA_CLIENT_ID: 'hotel-client', CLICKPESA_API_KEY: 'hotel-key', CLICKPESA_CLIENT_ID_PLATFORM: 'bmg-platform', CLICKPESA_API_KEY_PLATFORM: 'bmg-key' };

await as(OWNER);
ok('a bad number is refused', await fails(`select pms_billing_pay($1,'123')`, [inv.id], '0713 000 111'));
const r1 = (await one(`select pms_billing_pay($1,'0713 000 111') r`, [inv.id])).r;
ok('the request is for the full amount due with a SUB reference', Number(r1.amount) === 200600 && /^SUB[A-F0-9]{17}$/.test(r1.order_ref) && r1.phone === '255713000111');
ok('a second request at once is refused', await fails(`select pms_billing_pay($1,'0713000111')`, [inv.id], 'already waiting'));
let out = await runBilling({ rpc, fetchFn: fakeFetch, env });
const push = calls.find((c) => c.path.endsWith('initiate-ussd-push-request'));
ok('the push goes to BMG\'s platform account, not the hotel\'s', push && push.headers.authorization === 'Bearer plat' && push.body.amount === '200600' && push.body.orderReference === r1.order_ref);
ok('the request is now waiting for the PIN', (await one(`select status from pms_sub_payments where order_ref=$1`, [r1.order_ref])).status === 'sent');
await as(OWNER);
ok('the pay screen can follow it', (await one(`select pms_billing_payment_state($1) s`, [r1.id])).s === 'sent');
const forged = await handleWebhook({ rpc, fetchFn: fakeFetch, env, body: { data: { orderReference: r1.order_ref, status: 'SUCCESS', collectedAmount: '200600' } } });
ok('a webhook claiming success is checked with ClickPesa first', forged.body.result === 'waiting' && (await locked()));
cp.orders[r1.order_ref].status = 'SUCCESS'; cp.orders[r1.order_ref].collectedAmount = '200600';
const wh = await handleWebhook({ rpc, fetchFn: fakeFetch, env, body: { data: { orderReference: r1.order_ref } } });
ok('once ClickPesa confirms, the invoice is paid', wh.body.result === 'paid' && (await one(`select status from pms_sub_invoices where id=$1`, [inv.id])).status === 'paid');
ok('…and the property unlocks at once', !(await locked()) && (await sub()).status === 'active');
await as(DESK);
ok('front desk is back in', (await one(`select pms_role($1) r`, [P])).r === 'front_desk');
out = await runBilling({ rpc, fetchFn: fakeFetch, env });
ok('the poll never pays twice', Number((await one(`select paid from pms_sub_invoices where id=$1`, [inv.id])).paid) === 200600);

// ---------------------------------------------------------------- partial and bank payments
console.log('Partial and bank payments');
const nextMonth = (await one(`select (($1::date + interval '1 month')::date) d`, [period])).d;
await db.query(`select pms__billing_run($1::date)`, [nextMonth]);
const inv2 = await one(`select * from pms_sub_invoices where property_id=$1 and period_start=$2`, [P, nextMonth]);
ok('next month\'s invoice is issued on its billing day', inv2 && Number(inv2.total) === 200600);
await db.query(`update pms_sub_invoices set due_on=$2 where id=$1`, [inv2.id, day(-9)]);
await refresh();
ok('it locks again when overdue', await locked());
await as(ADMIN);
ok('a payment needs a reference', await fails(`select pms_admin_record_payment($1, 100000, 'bank', '')`, [inv2.id], 'reference'));
await db.query(`select pms_admin_record_payment($1, 100000, 'bank', 'CRDB 55120')`, [inv2.id]);
ok('a part payment does not unlock', (await locked()) && Number((await one(`select paid from pms_sub_invoices where id=$1`, [inv2.id])).paid) === 100000);
ok('an invoice with money on it cannot be voided', await fails(`select pms_admin_void_invoice($1,'mistake')`, [inv2.id], 'cannot be voided'));
await db.query(`select pms_admin_record_payment($1, 100600, 'bank', 'CRDB 55190')`, [inv2.id]);
ok('paying the rest unlocks', !(await locked()) && (await one(`select status from pms_sub_invoices where id=$1`, [inv2.id])).status === 'paid');

// ---------------------------------------------------------------- void, agreed price, failures
console.log('Voids, agreed prices, failures');
await db.query(`select pms_admin_set_subscription($1, '{"price_override":"250000"}'::jsonb)`, [P]);
ok('issuing again for a month already invoiced is refused', await fails(`select pms_admin_issue_invoice($1)`, [P], 'already has invoice'));
const month3 = (await one(`select (($1::date + interval '2 month')::date) d`, [period])).d;
const inv3 = await one(`select pms__issue_invoice($1, $2::date) id`, [P, month3]);
const i3 = await one(`select * from pms_sub_invoices where id=$1`, [inv3.id]);
ok('an agreed price replaces the plan (VAT still added)', i3.lines.length === 1 && Number(i3.subtotal) === 250000 && Number(i3.total) === 295000);
await db.query(`update pms_sub_invoices set due_on=$2 where id=$1`, [inv3.id, day(-20)]);
await refresh();
ok('locks when overdue', await locked());
await db.query(`select pms_admin_void_invoice($1,'Issued by mistake')`, [inv3.id]);
ok('voiding the only overdue invoice unlocks', !(await locked()) && (await sub()).status === 'active');
const re3 = await one(`select pms__issue_invoice($1, $2::date) id`, [P, month3]);
ok('a voided month can be invoiced again', re3.id && re3.id !== inv3.id);
await db.query(`update pms_sub_invoices set status='void', void_reason='test' where id=$1`, [re3.id]);

await db.query(`update pms_sub_invoices set status='open', void_reason=null, due_on=$2 where id=$1`, [inv3.id, day(5)]);
await as(OWNER);
const r2 = (await one(`select pms_billing_pay($1,'0700 000 000') r`, [inv3.id])).r;
await runBilling({ rpc, fetchFn: fakeFetch, env });
const p2 = await one(`select status, error from pms_sub_payments where order_ref=$1`, [r2.order_ref]);
ok('a number ClickPesa turns down is marked failed with its reason', p2.status === 'failed' && p2.error.includes('Invalid phone'));
await db.exec(`update pms_sub_payments set created_at = now() - interval '10 minutes' where order_ref = '${r2.order_ref}'`);
await as(OWNER);
const r3 = (await one(`select pms_billing_pay($1,'0713000111') r`, [inv3.id])).r;
const noKeys = await runBilling({ rpc, fetchFn: fakeFetch, env: {} });
ok('without BMG ClickPesa keys the request fails with a clear message', !!noKeys.error
  && (await one(`select error from pms_sub_payments where order_ref=$1`, [r3.order_ref])).error.includes('not set up'));
ok('guest payment webhooks are not mistaken for subscriptions', (await handleWebhook({ rpc, fetchFn: fakeFetch, env, body: { data: { orderReference: 'BMG0000000000000000X' } } })).body.ignored);

await as(ADMIN);
await db.query(`select pms_admin_set_subscription($1, '{"cancelled":true}'::jsonb)`, [P]);
await db.query(`update pms_sub_invoices set due_on=$2 where id=$1`, [inv3.id, day(-30)]);
await db.query(`select pms__billing_run($1::date)`, [TODAY]);
ok('a cancelled subscription is never locked or invoiced', !(await locked()) && (await sub()).status === 'cancelled');
await db.query(`select pms_admin_save_plan($1::jsonb)`, [JSON.stringify({ name: 'Lodge', base_monthly: 80000, per_room: 0, vat_pct: 18, trial_days: 14, is_default: true })]);
ok('a new default plan replaces the old default', (await one(`select count(*) n from pms_plans where is_default`)).n == 1 && (await one(`select name from pms_plans where is_default`)).name === 'Lodge');
await db.query(`select pms_admin_set_subscription($1, '{"cancelled":false}'::jsonb)`, [P]);
await db.query(`update pms_properties set status='suspended' where id=$1`, [P]);
const before = Number((await one(`select count(*) n from pms_sub_invoices where property_id=$1`, [P])).n);
await db.query(`select pms__billing_run($1::date)`, [(await one(`select (($1::date + interval '5 month')::date) d`, [period])).d]);
ok('a property suspended by BMG is not invoiced', Number((await one(`select count(*) n from pms_sub_invoices where property_id=$1`, [P])).n) === before);
await db.query(`update pms_properties set status='active' where id=$1`, [P]);
await db.exec(`delete from pms_platform_admins`);
await as(OWNER);
const P2 = (await one(`select pms_create_property('Second Lodge','SL','Balati','[]'::jsonb) id`)).id;
const s2 = await one(`select s.*, pl.name from pms_subscriptions s join pms_plans pl on pl.id=s.plan_id where property_id=$1`, [P2]);
ok('new properties get the default plan and its trial', s2.name === 'Lodge' && s2.trial_ends === day(14) && s2.status === 'trial');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
