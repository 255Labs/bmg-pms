// Payments and messaging test: ClickPesa mobile money, Beem SMS door codes, setup catalogues.
// Real migrations on PGlite, fake provider servers. Run: node tests/payments.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { runPayments, handleWebhook, checksum } from '../supabase/functions/_shared/clickpesa.js';
import { runSms } from '../supabase/functions/_shared/sms.js';
import { runTTLock } from '../supabase/functions/_shared/ttlock.js';
import { md5 } from '../supabase/functions/_shared/md5.js';
import { channexCatalog, ttlockLocks } from '../supabase/functions/_shared/catalog.js';

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
  create table auth.users (id uuid primary key, email text unique);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;`);
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));
// guest mobile money is switched off in the product for now (migration 28); these checks keep the dormant code working
await db.exec(`update pms_catalog set active = true, default_on = true where key = 'clickpesa'`);

const OWNER = '11111111-1111-1111-1111-111111111111', HK = '44444444-4444-4444-4444-444444444444';
await db.exec(`insert into auth.users values ('${OWNER}','owner@bmg.co.tz'), ('${HK}','hk@bmg.co.tz')`);
const as = (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`);
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const fails = async (sql, p, match) => { try { await db.query(sql, p); return false; } catch (e) { return !match || String(e.message).includes(match); } };
await as(OWNER);
const P = (await one(`select pms_create_property('Unreal Homes','UH','Balati',$1::jsonb) id`, [JSON.stringify([{ name: 'Single', base_rate: 200000, rooms: ['331', '332'] }])])).id;
await db.exec(`update pms_properties set business_date = '2026-10-12' where id = '${P}'`);
await db.query(`select pms_set_member($1, 'hk@bmg.co.tz', 'housekeeping')`, [P]);
const R331 = (await one(`select id from pms_rooms where property_id=$1 and number='331'`, [P])).id;
const res = (await one(`select pms_create_reservation($1,'{"first_name":"Ritha","last_name":"Ambonisye","phone":"0754 000 333"}'::jsonb,'2026-10-12','2026-10-14',$2::jsonb) r`,
  [P, JSON.stringify([{ room_id: R331 }])])).r;
const STAY = (await one(`select id from pms_stays where reservation_id=$1`, [res.reservation_id])).id;
const FOLIO = (await one(`select id from pms_folios where stay_id=$1`, [STAY])).id;
const balance = async () => Number((await one(`select balance from pms_folio_balances where folio_id=$1`, [FOLIO])).balance);

const rpc = async (fn, args = {}) => {
  await as(null);
  const keys = Object.keys(args);
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
  const r = await db.query(`select * from ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, vals);
  return r.fields.length === 1 && r.fields[0].name === fn ? r.rows[0]?.[fn] : r.rows;
};

// ---------------------------------------------------------------- fake providers
const calls = [];
const cp = { orders: {}, rejectPhone: '255700000000', down: false };
const sms = { fail: false };
const reply = (status, obj) => ({ ok: status < 300, status, text: async () => JSON.stringify(obj) });
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = !init.body ? null : init.headers?.['content-type'] === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body);
  calls.push({ host: u.host, path: u.pathname, method: init.method ?? 'GET', headers: init.headers, body });
  if (u.host === 'api.clickpesa.com') {
    if (u.pathname === '/third-parties/generate-token') {
      return init.headers['client-id'] === 'cp-client' && init.headers['api-key'] === 'cp-key' ? reply(200, { success: true, token: 'Bearer cp-token' }) : reply(401, { message: 'Invalid credentials' });
    }
    if (init.headers.authorization !== 'Bearer cp-token') return reply(401, { message: 'Unauthorized' });
    if (cp.down) return reply(503, { message: 'Service unavailable' });
    if (u.pathname === '/third-parties/payments/initiate-ussd-push-request') {
      if (body.phoneNumber === cp.rejectPhone) return reply(400, { message: 'Invalid phone number' });
      cp.orders[body.orderReference] = { id: 'TXN' + Object.keys(cp.orders).length, status: 'PROCESSING', collectedAmount: null, amount: body.amount };
      return reply(200, { id: cp.orders[body.orderReference].id, status: 'PROCESSING', channel: 'TIGO-PESA', orderReference: body.orderReference });
    }
    const m = u.pathname.match(/^\/third-parties\/payments\/([A-Za-z0-9]+)$/);
    if (m) { const o = cp.orders[m[1]]; return o ? reply(200, [{ id: o.id, orderReference: m[1], status: o.status, collectedAmount: o.collectedAmount, collectedCurrency: 'TZS' }]) : reply(404, { message: 'Not found' }); }
  }
  if (u.host === 'apisms.beem.africa' && u.pathname === '/v1/send') {
    if (init.headers.authorization !== 'Basic ' + Buffer.from('beem-key:beem-secret').toString('base64')) return reply(401, { message: 'Invalid credentials' });
    if (sms.fail) return reply(500, { message: 'Gateway error' });
    return reply(200, { successful: true, request_id: 35918915, code: 100, message: 'Message Submitted Successfully', valid: 1, invalid: 0, duplicates: 0 });
  }
  if (u.host === 'euapi.ttlock.com') {
    if (u.pathname === '/oauth2/token') return reply(200, { access_token: 'tok', expires_in: 7776000 });
    if (u.pathname === '/v3/keyboardPwd/add') return reply(200, { keyboardPwdId: 4242 });
    if (u.pathname === '/v3/lockRecord/list') return reply(200, { list: [], pages: 1 });
    return reply(200, { errcode: 0 });
  }
  return reply(404, { error: 'unknown ' + url });
};
const env = { CLICKPESA_CLIENT_ID: 'cp-client', CLICKPESA_API_KEY: 'cp-key', BEEM_API_KEY: 'beem-key', BEEM_SECRET_KEY: 'beem-secret',
  TTLOCK_CLIENT_ID: 'cid', TTLOCK_CLIENT_SECRET: 'csec', TTLOCK_USERNAME: 'u', TTLOCK_PASSWORD: 'p' };

// ---------------------------------------------------------------- mobile money
console.log('Mobile money (ClickPesa)');
await as(OWNER);
ok('requests are refused until ClickPesa is switched on', await fails(`select pms_request_mobile_payment($1,'0713000111',100000)`, [FOLIO], 'not switched on'));
await db.query(`insert into pms_integrations(property_id,provider,enabled,config) values ($1,'clickpesa',true,'{}'), ($1,'fiscal',true,'{}')`, [P]);
await as(HK);
ok('housekeeping cannot request payments', await fails(`select pms_request_mobile_payment($1,'0713000111',100000)`, [FOLIO], 'cannot perform'));
await as(OWNER);
ok('a bad number is refused with an example', await fails(`select pms_request_mobile_payment($1,'12345',100000)`, [FOLIO], '0713 000 111'));
ok('cents are refused', await fails(`select pms_request_mobile_payment($1,'0713000111',100000.5)`, [FOLIO], 'whole shillings'));
const req1 = (await one(`select pms_request_mobile_payment($1,'+255 713 000 111',150000) r`, [FOLIO])).r;
ok('the number is stored as 255XXXXXXXXX and the order reference is alphanumeric', req1.phone === '255713000111' && /^BMG[A-F0-9]{17}$/.test(req1.order_ref));
ok('a second request while one is waiting is refused', await fails(`select pms_request_mobile_payment($1,'0713000111',1000)`, [FOLIO], 'already waiting'));
const b0 = await balance();
const run1 = await runPayments({ rpc, fetchFn: fakeFetch, env });
const push = calls.find((c) => c.path.endsWith('initiate-ussd-push-request'));
ok('USSD push sent with token, whole amount as text, TZS and order reference',
  push.headers.authorization === 'Bearer cp-token' && push.body.amount === '150000' && push.body.currency === 'TZS' && push.body.orderReference === req1.order_ref && push.body.phoneNumber === '255713000111');
ok('no checksum when no checksum key is set', !('checksum' in push.body));
ok('the request is now waiting on the phone', (await one(`select status from pms_payment_requests where id=$1`, [req1.id])).status === 'sent' && run1.checked[0]?.result === 'waiting');
ok('nothing is on the folio before the guest approves', (await balance()) === b0);
cp.orders[req1.order_ref].status = 'SUCCESS'; cp.orders[req1.order_ref].collectedAmount = '150000';
const run2 = await runPayments({ rpc, fetchFn: fakeFetch, env });
ok('the poll confirms the payment and posts it', run2.checked[0]?.result === 'paid' && (await balance()) === b0 - 150000);
const line = await one(`select l.payment_method, l.source, l.receipt_no, l.reference from pms_folio_lines l join pms_payment_requests r on r.folio_line_id=l.id where r.id=$1`, [req1.id]);
ok('posted as mobile money with a receipt number and the ClickPesa transaction', line.payment_method === 'mobile_money' && line.source === 'gateway' && line.receipt_no > 0 && line.reference === 'TXN0');
ok('a fiscal receipt is queued for it', Number((await one(`select count(*) n from pms_fiscal_receipts f join pms_payment_requests r on r.folio_line_id=f.folio_line_id where r.id=$1`, [req1.id])).n) === 1);
const wh = await handleWebhook({ rpc, fetchFn: fakeFetch, env, body: { event: 'PAYMENT RECEIVED', data: { orderReference: req1.order_ref, status: 'SUCCESS', collectedAmount: '150000' } } });
ok('a late or repeated webhook never pays twice', wh.body.result === 'already_paid' && (await balance()) === b0 - 150000);

// a forged webhook: claims success, ClickPesa says still processing
await as(OWNER);
const req2 = (await one(`select pms_request_mobile_payment($1,'0754000333',50000) r`, [FOLIO])).r;
await runPayments({ rpc, fetchFn: fakeFetch, env });
const forged = await handleWebhook({ rpc, fetchFn: fakeFetch, env, body: { event: 'PAYMENT RECEIVED', data: { orderReference: req2.order_ref, status: 'SUCCESS', collectedAmount: '50000' } } });
ok('a webhook claiming success is checked with ClickPesa first and ignored', forged.body.result === 'waiting' && (await balance()) === b0 - 150000);
ok('a webhook for an order the PMS never made is ignored', (await handleWebhook({ rpc, fetchFn: fakeFetch, env, body: { data: { orderReference: 'XYZ123456' } } })).body.ignored);
ok('a webhook without a reference is refused', (await handleWebhook({ rpc, fetchFn: fakeFetch, env, body: {} })).status === 400);
cp.orders[req2.order_ref].status = 'FAILED';
await runPayments({ rpc, fetchFn: fakeFetch, env });
ok('a declined payment is marked failed and posts nothing', (await one(`select status from pms_payment_requests where id=$1`, [req2.id])).status === 'failed' && (await balance()) === b0 - 150000);

// partial collection
await as(OWNER);
const req3 = (await one(`select pms_request_mobile_payment($1,'0754000333',40000) r`, [FOLIO])).r;
await runPayments({ rpc, fetchFn: fakeFetch, env });
cp.orders[req3.order_ref].status = 'SETTLED'; cp.orders[req3.order_ref].collectedAmount = '30000';
await runPayments({ rpc, fetchFn: fakeFetch, env });
const r3 = await one(`select status, collected_amount, note from pms_payment_requests where id=$1`, [req3.id]);
ok('only what was collected is posted, with a note', r3.status === 'paid' && Number(r3.collected_amount) === 30000 && r3.note.includes('Collected 30000'));

// ClickPesa rejects the number: no retry
await as(OWNER);
const req4 = (await one(`select pms_request_mobile_payment($1,'0700000000',10000) r`, [FOLIO])).r;
await runPayments({ rpc, fetchFn: fakeFetch, env });
const r4 = await one(`select r.status, r.error, j.status js from pms_payment_requests r, pms_jobs j where r.id=$1 and j.payload->>'request_id'=$1::text`, [req4.id]);
ok('a rejected number fails at once with ClickPesa’s reason, no retries', r4.status === 'failed' && r4.error === 'Invalid phone number' && r4.js === 'done');

// ClickPesa down: the job retries
await as(OWNER);
const req5 = (await one(`select pms_request_mobile_payment($1,'0754000333',10000) r`, [FOLIO])).r;
cp.down = true;
await runPayments({ rpc, fetchFn: fakeFetch, env });
const j5 = await one(`select status, attempts from pms_jobs where payload->>'request_id'=$1::text`, [req5.id]);
ok('when ClickPesa is down the push is queued again', j5.status === 'queued' && j5.attempts === 1);
cp.down = false;
await db.query(`update pms_jobs set run_after=now() where payload->>'request_id'=$1::text`, [req5.id]);
await as(OWNER);
await db.query(`select pms_cancel_payment_request($1)`, [req5.id]);
await runPayments({ rpc, fetchFn: fakeFetch, env });
ok('a cancelled request is never pushed', !calls.some((c) => c.body?.orderReference === req5.order_ref && c.path.endsWith('initiate-ussd-push-request') && !cp.down && cp.orders[req5.order_ref]));

// stale requests expire
await as(OWNER);
const req6 = (await one(`select pms_request_mobile_payment($1,'0754000333',10000) r`, [FOLIO])).r;
await runPayments({ rpc, fetchFn: fakeFetch, env });
await db.query(`update pms_payment_requests set created_at = now() - interval '31 minutes' where id=$1`, [req6.id]);
await runPayments({ rpc, fetchFn: fakeFetch, env });
ok('after 30 minutes with no answer the request expires', (await one(`select status from pms_payment_requests where id=$1`, [req6.id])).status === 'expired');
cp.orders[req6.order_ref].status = 'SUCCESS'; cp.orders[req6.order_ref].collectedAmount = '10000';
const late = await handleWebhook({ rpc, fetchFn: fakeFetch, env, body: { data: { orderReference: req6.order_ref } } });
ok('money that arrives after expiry still lands', late.body.result === 'paid');

const ck = await checksum('secret', { b: '1', a: { d: 2, c: 1 } });
ok('checksum is HMAC-SHA256 of sorted compact JSON', ck === createHmac('sha256', 'secret').update('{"a":{"c":1,"d":2},"b":"1"}').digest('hex'));
await as(OWNER);
const req7 = (await one(`select pms_request_mobile_payment($1,'0754000333',20000) r`, [FOLIO])).r;
await runPayments({ rpc, fetchFn: fakeFetch, env: { ...env, CLICKPESA_CHECKSUM_KEY: 'ck' } });
const p7 = calls.filter((c) => c.body?.orderReference === req7.order_ref).at(-1).body;
const { checksum: sent7, ...rest7 } = p7;
ok('with a checksum key the push carries a valid checksum', sent7 === createHmac('sha256', 'ck').update(JSON.stringify(Object.fromEntries(Object.keys(rest7).sort().map((k) => [k, rest7[k]])))).digest('hex'));

// ---------------------------------------------------------------- SMS door codes
console.log('\nSMS door codes (Beem)');
await as(OWNER);
await db.query(`insert into pms_integrations(property_id,provider,enabled,config) values ($1,'sms',true,'{"sender_id":"UNREALHOMES"}'), ($1,'ttlock',true,'{}')`, [P]);
await db.query(`insert into pms_external_ids(property_id,provider,entity,entity_id,external_id) values ($1,'ttlock','room',$2,'5001')`, [P, R331]);
await db.query(`update pms_rooms set hk_status='clean' where property_id=$1`, [P]);
await db.query(`select pms_check_in($1)`, [STAY]);
await runTTLock({ rpc, fetchFn: fakeFetch, env });
const code = await one(`select passcode, status from pms_stay_passcodes where stay_id=$1`, [STAY]);
const queued = await one(`select to_phone, body, status, kind from pms_sms_out where stay_id=$1`, [STAY]);
ok('issuing a door code queues an SMS to the guest', code.status === 'issued' && queued?.kind === 'door_code' && queued.to_phone === '255754000333');
ok('the SMS names the guest, room and code', queued.body.includes('Ritha') && queued.body.includes('331') && queued.body.includes(code.passcode) && queued.body.includes('Unreal Homes'));
await runSms({ rpc, fetchFn: fakeFetch, env });
const beem = calls.filter((c) => c.host === 'apisms.beem.africa').at(-1);
ok('Beem gets basic auth, the sender ID and one recipient', beem.body.source_addr === 'UNREALHOMES' && beem.body.encoding === 0 && beem.body.recipients[0].dest_addr === '255754000333' && beem.body.message.includes(code.passcode));
ok('the SMS is marked sent with Beem’s request id', (await one(`select status, provider_ref from pms_sms_out where stay_id=$1`, [STAY])).provider_ref === '35918915');
await as(OWNER);
sms.fail = true;
const resend = (await one(`select pms_send_door_code_sms($1) id`, [STAY])).id;
await runSms({ rpc, fetchFn: fakeFetch, env });
ok('a gateway error marks the SMS failed and retries the job', (await one(`select status from pms_sms_out where id=$1`, [resend])).status === 'failed'
  && (await one(`select status from pms_jobs where payload->>'sms_id'=$1::text`, [resend])).status === 'queued');
sms.fail = false;
await db.query(`update pms_jobs set run_after=now() where payload->>'sms_id'=$1::text`, [resend]);
await runSms({ rpc, fetchFn: fakeFetch, env });
ok('the retry sends it', (await one(`select status from pms_sms_out where id=$1`, [resend])).status === 'sent');
await db.query(`update pms_integrations set config = config || '{"door_code_template":"Room {room}: code {code}"}' where property_id=$1 and provider='sms'`, [P]);
await as(OWNER);
const t2 = (await one(`select pms_send_door_code_sms($1, '0713 999 888') id`, [STAY])).id;
ok('a custom template and another number can be used', (await one(`select body, to_phone from pms_sms_out where id=$1`, [t2])).body === `Room 331: code ${code.passcode}`);
await as(HK);
ok('housekeeping cannot send SMS', await fails(`select pms_send_sms($1,'0713000111','hi')`, [P], 'cannot perform'));

// ---------------------------------------------------------------- health + catalogue
console.log('\nHealth and setup catalogues');
await as(OWNER);
const h = Object.fromEntries((await db.query(`select * from pms_integration_health($1)`, [P])).rows.map((r) => [r.provider, r]));
ok('health covers ClickPesa and SMS', h.clickpesa?.enabled && h.sms?.enabled && h.sms.status !== 'off');
ok('the setup screen may ask for catalogues as owner', (await one(`select pms_can_manage_integrations($1) ok`, [P])).ok === true);
await as(HK);
ok('…but not as housekeeping', (await one(`select pms_can_manage_integrations($1) ok`, [P])).ok === false);
const cat = channexCatalog({ data: [{ id: 'rt-1', type: 'room_type', attributes: { title: 'Single Room' } }] },
  { data: [{ id: 'rp-1', type: 'rate_plan', attributes: { title: 'BB' }, relationships: { room_type: { data: { id: 'rt-1', type: 'room_type' } } } }] });
ok('Channex room types and rate plans are read, with each plan’s room type', cat.roomTypes[0].title === 'Single Room' && cat.ratePlans[0].room_type_id === 'rt-1');
ok('TTLock locks are read with their names', ttlockLocks({ list: [{ lockId: 5001, lockAlias: 'Room 331', electricQuantity: 88, hasGateway: 1 }] })[0].title === 'Room 331');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
