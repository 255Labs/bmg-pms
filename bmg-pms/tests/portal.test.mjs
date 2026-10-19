// Guest portal test: link at check-in, key only to the booking's phone or email, food orders and service requests,
// the staff's live list, accepting a food order (kitchen + room charge), and the portal ending at check-out.
// Runs as real API callers (PostgREST roles, row security). Run: node tests/portal.test.mjs
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

// ---------------------------------------------------------------- a hotel with room service, SMS on, portal on
await asSuper(); await db.exec(`select set_config('test.uid','${U.owner}',false)`);
const P = await val(`select pms_create_property('Pwani Lodge','PL','GM',$1::jsonb)`, [JSON.stringify([{ name: 'Double', base_rate: 250000, rooms: ['201', '202'] }])]);
for (const [m, r] of [['desk@p.tz', 'front_desk'], ['hk@p.tz', 'housekeeping'], ['acct@p.tz', 'accountant']]) await db.query(`select pms_add_or_invite_member($1,$2,$3)`, [P, m, r]);
await db.query(`update pms_properties set business_date = '2026-10-14' where id=$1`, [P]);
await db.query(`insert into pms_property_addons(property_id,key,enabled) values ($1,'guest_portal',true),($1,'pos',true),($1,'sms',true)
  on conflict (property_id,key) do update set enabled = true`, [P]);
await db.query(`insert into pms_integrations(property_id,provider,enabled) values ($1,'sms',true) on conflict (property_id,provider) do update set enabled = true`, [P]);
const RS = await val(`insert into pms_pos_outlets(property_id,name,charge_category,outlet_type) values ($1,'Room service','fnb','room_service') returning id`, [P]);
const MAINS = await val(`insert into pms_pos_categories(property_id,outlet_id,name,station) values ($1,$2,'Mains','kitchen') returning id`, [P, RS]);
const PILAU = await val(`insert into pms_pos_items(property_id,outlet_id,name,price,category_id) values ($1,$2,'Chicken pilau',18000,$3) returning id`, [P, RS, MAINS]);
const JUICE = await val(`insert into pms_pos_items(property_id,outlet_id,name,price,category_id) values ($1,$2,'Passion juice',5000,$3) returning id`, [P, RS, MAINS]);
const STEAK = await val(`insert into pms_pos_items(property_id,outlet_id,name,price,category_id) values ($1,$2,'Steak',40000,$3) returning id`, [P, RS, MAINS]);
const COOK = await val(`insert into pms_pos_modifier_groups(property_id,outlet_id,name,min_choices,max_choices) values ($1,$2,'Cooking',1,1) returning id`, [P, RS]);
await db.query(`insert into pms_pos_item_modifier_groups(property_id,item_id,group_id) values ($1,$2,$3)`, [P, STEAK, COOK]);
const room = (n) => val(`select id from pms_rooms where property_id=$1 and number=$2`, [P, n]);
const book = async (n, guest) => {
  const r = await val(`select pms_create_reservation($1,$2::jsonb,'2026-10-14','2026-10-16',$3::jsonb)`, [P, JSON.stringify(guest), JSON.stringify([{ room_id: await room(n) }])]);
  return val(`select id from pms_stays where reservation_id=$1`, [r.reservation_id]);
};
const S1 = await book('201', { first_name: 'Neema', last_name: 'Kweka', phone: '0754 111 222', email: 'Neema@Example.com' });
const S2 = await book('202', { first_name: 'Juma', last_name: 'Ali', phone: '0713 999 888' });
// the text log as the SMS worker sees it (staff never see queued keys and links)
const lastSms = async (stay, kind) => {
  const back = who; await asSuper();
  const v = await val(`select body from pms_sms_out where stay_id=$1 and kind=$2 order by created_at desc, id limit 1`, [stay, kind]);
  if (back === 'guest') await asGuest(); else if (back) await as(back);
  return v;
};
const tokenOf = (body) => (body ?? '').match(/#\/stay\/([0-9a-f]{64})/)?.[1];
const keyOf = (body) => (body ?? '').match(/key is (\d{6})/)?.[1];

console.log('Settings and the link at check-in');
await as(U.desk);
ok('the desk cannot switch the portal on (owners and managers do, in Setup)', (await err(`update pms_properties set settings = jsonb_set(coalesce(settings,'{}'),'{guest_portal}','{"enabled":true}') where id=$1`, [P])) !== ''
  || (await val(`select settings->'guest_portal' from pms_properties where id=$1`, [P])) == null);
await as(U.owner);
await db.query(`update pms_properties set settings = jsonb_set(coalesce(settings,'{}'),'{guest_portal}',$2::jsonb) where id=$1`,
  [P, JSON.stringify({ enabled: true, auto_send: true, send_sms: true, send_email: true, app_url: 'https://bmg-pms.netlify.app/' })]);
await as(U.desk);
ok('before check-in there is no portal', /checked in/.test(await err(`select pms_portal_send($1)`, [S1])));
await db.query(`select pms_check_in($1, true)`, [S1]);
const linkSms = await lastSms(S1, 'portal_link');
ok('checking in texts the guest a link', !!linkSms && linkSms.includes('https://bmg-pms.netlify.app/#/stay/'), linkSms);
ok('the desk cannot read the queued email with the link', await val(`select count(*)::int from pms_email_out where stay_id=$1`, [S1]) === 0);
await asSuper();
ok('…and emails it to the address on the booking', await val(`select count(*)::int from pms_email_out where stay_id=$1 and kind='portal_link' and to_email='neema@example.com'`, [S1]) === 1);
await as(U.desk);
await asSuper();
ok('both are queued for sending', await val(`select count(*)::int from pms_jobs where provider in ('sms','email') and status='queued'`) >= 2);
await as(U.desk);
await asSuper();
ok('…the stored value is not the link itself', await val(`select count(*)::int from pms_guest_portals where token_hash = $1`, [tokenOf(linkSms)]) === 0);
await as(U.desk);
const st = await val(`select pms_portal_status($1)`, [S1]);
ok('the desk sees it was sent by SMS and email', st.active && st.sent_via.includes('sms') && st.sent_via.includes('email'), JSON.stringify(st));
ok('the desk sees the contacts masked', st.phone === '0754 *** 222' && st.email === 'n***@example.com', JSON.stringify(st));
const readOnly = async (sql, args) => { await db.exec('begin read only'); try { await db.query(sql, args); return ''; } catch (e) { return e.message; } finally { await db.exec('rollback'); } };
ok('read-only calls work as the API makes them (status, live list, link)', (await readOnly(`select pms_portal_status($1)`, [S1])) === '' && (await readOnly(`select pms_guest_requests_live($1)`, [P])) === '');
ok('staff cannot read portal secrets directly', (await err(`select token_hash from pms_guest_portals`)) !== '');

console.log('\nSigning in: the key goes only to the booking\'s phone or email');
const T1 = tokenOf(linkSms);
await asGuest();
const open = await val(`select pms_portal_open($1)`, [T1]);
ok('the link opens the hotel name and masked contacts, nothing else', open.property === 'Pwani Lodge' && open.phone_hint === '0754 *** 222' && open.by_sms && open.by_email && !('room' in open), JSON.stringify(open));
ok('a made-up link is refused', /expired|not valid/.test(await err(`select pms_portal_open($1)`, ['a'.repeat(64)])));
const wrong = await val(`select pms_portal_send_key($1,'0700 000 000')`, [T1]);
ok('a different phone number gets no key', wrong.ok === false && /not the number/.test(wrong.error));
const wrongMail = await val(`select pms_portal_send_key($1,'someone@else.com')`, [T1]);
ok('a different email gets no key', wrongMail.ok === false);
await asSuper();
ok('no key was sent for those', await val(`select count(*)::int from pms_sms_out where kind='portal_key'`) === 0 && await val(`select count(*)::int from pms_email_out where kind='portal_key'`) === 0);
await asGuest();
const sent = await val(`select pms_portal_send_key($1,'+255 754 111 222')`, [T1]);
ok('the booking\'s number (written another way) gets a key', sent.ok && sent.by === 'sms' && sent.sent_to === '0754 *** 222', JSON.stringify(sent));
ok('the guest cannot read the text queue', (await err(`select body from pms_sms_out`)) !== '');
await asSuper();
const key1 = keyOf(await lastSms(S1, 'portal_key'));
ok('the key is texted to that number', /^\d{6}$/.test(key1 ?? '') && await val(`select to_phone from pms_sms_out where kind='portal_key' order by created_at desc limit 1`) === '255754111222');
await asGuest();
const bad = await val(`select pms_portal_login($1,'000000')`, [T1]);
ok('a wrong key is refused', bad.ok === false && /not right/.test(bad.error));
const nolink = await err(`select pms_portal_login($1,$2)`, ['b'.repeat(64), key1]);
ok('the right key with another link is refused', /expired|not valid/.test(nolink));
const login = await val(`select pms_portal_login($1,$2)`, [T1, key1]);
ok('the right key signs in', login.ok && login.session?.length === 64);
const SESSION = login.session;
ok('a key works only once', (await val(`select pms_portal_login($1,$2)`, [T1, key1])).ok === false);
// email route
const viaMail = await val(`select pms_portal_send_key($1,' NEEMA@example.com ')`, [T1]);
ok('the booking\'s email also gets a key', viaMail.ok && viaMail.by === 'email' && viaMail.sent_to === 'n***@example.com');
await asSuper();
const key2 = keyOf(await val(`select body from pms_email_out where kind='portal_key' order by created_at desc limit 1`));
await asGuest();
const login2 = await val(`select pms_portal_login($1,$2)`, [T1, key2]);
ok('…and that key signs in a second phone', login2.ok);
// five wrong tries burn the key
await val(`select pms_portal_send_key($1,'0754111222')`, [T1]);
for (let i = 0; i < 5; i++) await val(`select pms_portal_login($1,'111111')`, [T1]);
await asSuper();
const key3 = keyOf(await lastSms(S1, 'portal_key'));
await asGuest();
ok('after five wrong tries even the right key is refused', (await val(`select pms_portal_login($1,$2)`, [T1, key3])).ok === false);
// at most 5 keys an hour
await asSuper(); await db.query(`update pms_guest_portals set keys_sent = 5 where stay_id=$1`, [S1]); await asGuest();
ok('at most five keys an hour', /Five keys/.test(await err(`select pms_portal_send_key($1,'0754111222')`, [T1])));
await asSuper(); await db.query(`update pms_guest_portals set keys_sent = 0 where stay_id=$1`, [S1]); await asGuest();

console.log('\nWhat the guest sees and asks for');
const home = await val(`select pms_portal_home($1)`, [SESSION]);
ok('room, dates and name', home.stay.room === '201' && home.guest.first_name === 'Neema' && home.stay.departure === '2026-10-16', JSON.stringify(home.stay));
ok('the room-service menu (dishes needing a choice are left out)', home.food && home.menu.some((m) => m.name === 'Chicken pilau') && !home.menu.some((m) => m.name === 'Steak'));
ok('the services offered', home.services.some((s) => s.kind === 'towels') && home.services.length === 9);
ok('the bill', 'balance' in home.bill);
ok('a made-up session sees nothing', /SIGNED_OUT/.test(await err(`select pms_portal_home($1)`, ['c'.repeat(64)])));
const REQ_TOWELS = await val(`select pms_portal_request($1,'{"kind":"towels","details":"Two bath towels please"}'::jsonb)`, [SESSION]);
ok('the guest asks for towels', !!REQ_TOWELS);
ok('"something else" needs a description', /Tell us/.test(await err(`select pms_portal_request($1,'{"kind":"other"}'::jsonb)`, [SESSION])));
ok('an unknown service is refused', /Choose one/.test(await err(`select pms_portal_request($1,'{"kind":"spa"}'::jsonb)`, [SESSION])));
const REQ_FOOD = await val(`select pms_portal_request($1,$2::jsonb)`, [SESSION, JSON.stringify({ kind: 'food', details: 'Room 201, no chilli', items: [{ item_id: PILAU, qty: 2 }, { item_id: JUICE, qty: 1, note: 'No ice' }] })]);
ok('the guest orders food', !!REQ_FOOD);
ok('a dish from another outlet or a made-up one is refused', /no longer on the menu/.test(await err(`select pms_portal_request($1,$2::jsonb)`, [SESSION, JSON.stringify({ kind: 'food', items: [{ item_id: '00000000-0000-0000-0000-000000000000', qty: 1 }] })])));
ok('silly quantities are refused', /between 1 and 20/.test(await err(`select pms_portal_request($1,$2::jsonb)`, [SESSION, JSON.stringify({ kind: 'food', items: [{ item_id: PILAU, qty: 500 }] })])));
const REQ_WAKE = await val(`select pms_portal_request($1,'{"kind":"wakeup"}'::jsonb)`, [SESSION]);
await val(`select pms_portal_cancel($1,$2)`, [SESSION, REQ_WAKE]);
const home2 = await val(`select pms_portal_home($1)`, [SESSION]);
const food = home2.requests.find((r) => r.id === REQ_FOOD);
ok('prices come from the menu, not the guest', Number(food.total) === 41000 && food.items.length === 2, JSON.stringify(food));
ok('the guest can cancel a request nobody has picked up', home2.requests.find((r) => r.id === REQ_WAKE).status === 'cancelled');
ok('the guest cannot read requests directly', (await err(`select * from pms_guest_requests`)) !== '');

console.log('\nThe welcome page, guide, documents and offers');
await as(U.owner);
await db.query(`update pms_properties set settings = jsonb_set(settings, '{guest_portal}', settings->'guest_portal' || $2::jsonb) where id=$1`,
  [P, JSON.stringify({ welcome_text: 'We are delighted to have you with us.', welcome_signed: 'The Pwani Lodge team', wifi_name: 'Pwani-Guest', wifi_password: 'karibu2026' })]);
await db.query(`insert into pms_portal_content(property_id,kind,title,body,sort_order) values ($1,'guide','Breakfast','06:30 to 10:00 at the beach restaurant',1),($1,'guide','Pool','Open 07:00 to 19:00',2)`, [P]);
await db.query(`insert into pms_portal_content(property_id,kind,title,file_url) values ($1,'document','Hotel guide (PDF)','https://example.supabase.co/storage/v1/object/public/property-media/guide.pdf')`, [P]);
const SPA = await val(`insert into pms_portal_content(property_id,kind,title,body,price,image_url) values ($1,'offer','Couples massage','60 minutes at the spa',120000,'https://example.supabase.co/x.jpg') returning id`, [P]);
await db.query(`insert into pms_portal_content(property_id,kind,title,ends_on) values ($1,'offer','Last month''s deal','2026-09-30')`, [P]);
ok('links and files must be https', /check/.test(await err(`insert into pms_portal_content(property_id,kind,title,link_url) values ($1,'guide','Bad','javascript:alert(1)')`, [P])));
await as(U.desk);
ok('the desk cannot change the guide', (await err(`insert into pms_portal_content(property_id,kind,title) values ($1,'guide','Desk note')`, [P])) !== '');
await asGuest();
const w = await val(`select pms_portal_welcome($1)`, [SESSION]);
ok('welcome by name with the hotel\'s letter', w.welcome.title === 'Karibu, Neema!' && w.welcome.text.includes('delighted') && w.welcome.wifi_name === 'Pwani-Guest', JSON.stringify(w.welcome));
ok('the booking: number, room and type, dates, nights, guests', w.booking.room === '201' && w.booking.room_type === 'Double' && w.booking.nights === 2 && w.booking.adults >= 1 && w.booking.res_no > 0, JSON.stringify(w.booking));
ok('the guide in order, the documents', w.guide.map((x) => x.title).join() === 'Breakfast,Pool' && w.documents.length === 1);
ok('only offers running today', w.offers.length === 1 && w.offers[0].title === 'Couples massage' && Number(w.offers[0].price) === 120000);
const OFFER_REQ = await val(`select pms_portal_offer($1,$2,'Tomorrow at 4pm for two')`, [SESSION, SPA]);
ok('"I\'m interested" reaches staff as a request', !!OFFER_REQ);
ok('…once', /already/.test(await err(`select pms_portal_offer($1,$2,null)`, [SESSION, SPA])));
ok('an ended or made-up offer is refused', /ended/.test(await err(`select pms_portal_offer($1,$2,null)`, [SESSION, '00000000-0000-0000-0000-000000000000'])));
ok('the welcome page marks it as asked', (await val(`select pms_portal_welcome($1)`, [SESSION])).offers[0].asked === true);
ok('a made-up session sees no welcome page', /SIGNED_OUT/.test(await err(`select pms_portal_welcome($1)`, ['d'.repeat(64)])));
await as(U.desk);
ok('staff see the offer request with the guest\'s note', (await val(`select pms_guest_requests_live($1)`, [P])).some((r) => r.id === OFFER_REQ && r.title === 'Offer: Couples massage' && r.details === 'Tomorrow at 4pm for two'));
await val(`select pms_guest_request_update($1,'done','Booked for 16:00')`, [OFFER_REQ]);

console.log('\nThe portal\'s look (platform administrators)');
await asSuper();
await db.query(`insert into auth.users(id,email) values ('20000000-0000-0000-0000-0000000000aa','admin@bmg.tz')`);
await db.query(`insert into pms_platform_admins(user_id) values ('20000000-0000-0000-0000-0000000000aa') on conflict do nothing`).catch(async () => db.query(`select pms_bootstrap_super_admin('admin@bmg.tz')`));
await as(U.owner);
ok('a hotel owner cannot change the portal look', /administrator|admin|permission/i.test(await err(`select pms_admin_save_portal_theme($1,'{"preset":"ocean"}'::jsonb)`, [P])));
await as('20000000-0000-0000-0000-0000000000aa');
await db.query(`select pms_admin_save_portal_theme($1,$2::jsonb)`, [P, JSON.stringify({ preset: 'custom', primary: '#0B4F6C', accent: '#FFB703', background: '#F5FAFC', heading_font: 'classic', tagline: 'Where the ocean meets Africa',
  hero_images: [{ url: 'https://example.supabase.co/hero1.jpg', caption: 'Beach at sunset' }] })]);
ok('BMG sets colours, heading style, tagline and photos', (await val(`select pms_admin_portal_theme($1)`, [P])).accent === '#FFB703');
ok('colours must be real colours', /check|violates/.test(await err(`select pms_admin_save_portal_theme($1,'{"preset":"custom","primary":"red;}"}'::jsonb)`, [P])));
ok('photos must be https', /https/.test(await err(`select pms_admin_save_portal_theme($1,'{"hero_images":[{"url":"http://x.tz/a.jpg"}]}'::jsonb)`, [P])));
ok('at most 8 photos', /8/.test(await err(`select pms_admin_save_portal_theme($1,$2::jsonb)`, [P, JSON.stringify({ hero_images: Array.from({ length: 9 }, (_, i) => ({ url: `https://x.tz/${i}.jpg` })) })])));
await asGuest();
const th = (await val(`select pms_portal_welcome($1)`, [SESSION])).theme;
ok('the guest\'s page wears the hotel\'s look', th.primary === '#0B4F6C' && th.heading_font === 'classic' && th.photos[0].caption === 'Beach at sunset' && th.tagline.includes('ocean'));
ok('…the sign-in page too', (await val(`select pms_portal_open($1)`, [T1])).theme.accent === '#FFB703');
await as('20000000-0000-0000-0000-0000000000aa');
await db.query(`select pms_admin_save_portal_theme($1,'{"preset":"safari"}'::jsonb)`, [P]);
ok('a ready-made theme fills in its colours', (await val(`select pms_admin_portal_theme($1)`, [P])).primary === '#5A3E1B');

console.log('\nStaff see each request live and handle it');
await as(U.desk);
const live = await val(`select pms_guest_requests_live($1)`, [P]);
const t = live.find((r) => r.id === REQ_TOWELS);
ok('the desk sees the request with room and guest', t && t.room === '201' && t.guest === 'Neema Kweka' && t.status === 'new' && t.stay_id === S1, JSON.stringify(t));
await as(U.hk);
ok('housekeeping sees requests too', (await val(`select pms_guest_requests_live($1)`, [P])).length >= 2);
await val(`select pms_guest_request_update($1,'accepted')`, [REQ_TOWELS]);
await val(`select pms_guest_request_update($1,'done','Left at the door')`, [REQ_TOWELS]);
ok('housekeeping accepts and finishes the towels', await val(`select status from pms_guest_requests where id=$1`, [REQ_TOWELS]) === 'done');
ok('housekeeping cannot send portal links', /permission|not allowed|cannot|privilege|access/i.test(await err(`select pms_portal_send($1)`, [S1])));
ok('housekeeping cannot accept a food order (it charges the room)', (await err(`select pms_guest_request_update($1,'accepted')`, [REQ_FOOD])) !== '');
await as(U.acct);
ok('people without the ability do not see requests', (await err(`select pms_guest_requests_live($1)`, [P])) !== '');
await as(U.desk);
ok('declining needs a note for the guest', /why/.test(await err(`select pms_guest_request_update($1,'declined')`, [REQ_FOOD])));
const acc = await val(`select pms_guest_request_update($1,'accepted')`, [REQ_FOOD]);
ok('accepting the food order opens an outlet bill', !!acc.pos_bill_id);
const bill = (await q(`select * from pms_pos_bills where id=$1`, [acc.pos_bill_id]))[0];
ok('…for the room, charged to the room', bill.status === 'room' && bill.table_no === 'Room 201' && bill.stay_id === S1 && Number(bill.total) === 41000, JSON.stringify(bill));
ok('…sent to the kitchen display', await val(`select count(*)::int from pms_pos_bill_items where bill_id=$1 and kitchen_status='sent'`, [acc.pos_bill_id]) === 2);
ok('…with the guest\'s note', await val(`select note from pms_pos_bill_items where bill_id=$1 and name='Passion juice'`, [acc.pos_bill_id]) === 'Guest portal · No ice');
ok('…and on the folio', await val(`select count(*)::int from pms_folio_lines where stay_id=$1 and amount=41000`, [S1]) === 1);
ok('a charged order cannot just be declined', /already charged/.test(await err(`select pms_guest_request_update($1,'declined','Sorry')`, [REQ_FOOD])));
ok('accepting twice is refused', /Already/.test(await err(`select pms_guest_request_update($1,'accepted')`, [REQ_FOOD])));
await val(`select pms_guest_request_update($1,'done')`, [REQ_FOOD]);
ok('finishing does not charge again', await val(`select count(*)::int from pms_folio_lines where stay_id=$1 and amount=41000`, [S1]) === 1);
await asGuest();
const home3 = await val(`select pms_portal_home($1)`, [SESSION]);
ok('the guest sees the status and the staff note', home3.requests.find((r) => r.id === REQ_TOWELS).staff_note === 'Left at the door' && home3.requests.find((r) => r.id === REQ_FOOD).status === 'done');
ok('the guest sees the order on the bill', home3.bill.lines.some((l) => Number(l.amount) === 41000));

console.log('\nThe desk: send again, WhatsApp, key at the desk, stop');
await as(U.desk);
const again = await val(`select pms_portal_send($1,false,false,null)`, [S1]);
ok('sending again gives a fresh link for WhatsApp', again.link.startsWith('https://bmg-pms.netlify.app/#/stay/') && again.phone === '255754111222' && again.sent_via.length === 0);
await asGuest();
ok('a new link signs out the old one', /SIGNED_OUT/.test(await err(`select pms_portal_home($1)`, [SESSION])));
ok('…and the old link stops working', /expired/.test(await err(`select pms_portal_open($1)`, [T1])));
const T2 = tokenOf(again.link);
await as(U.desk);
const deskKey = await val(`select pms_portal_desk_key($1)`, [S1]);
await asGuest();
const login3 = await val(`select pms_portal_login($1,$2)`, [T2, deskKey]);
ok('a key read out at the desk signs in', login3.ok);
await as(U.desk);
await db.query(`select pms_check_in($1, true)`, [S2]);
ok('a guest with no email gets the text only', await val(`select count(*)::int from pms_email_out where stay_id=$1`, [S2]) === 0 && !!(await lastSms(S2, 'portal_link')));
await db.query(`select pms_portal_revoke($1)`, [S2]);
await asGuest();
ok('a stopped link no longer opens', /expired/.test(await err(`select pms_portal_open($1)`, [tokenOf(await (async () => { await asSuper(); const b = await lastSms(S2, 'portal_link'); await asGuest(); return b; })())])));

console.log('\nCheck-out ends it');
await as(U.desk);
const bal = await val(`select balance from pms_folio_balances b join pms_folios f on f.id=b.folio_id where f.stay_id=$1 and f.status='open'`, [S1]);
const cash = await val(`select id from pms_payment_methods where property_id=$1 and name='Cash'`, [P]);
await db.query(`select pms_open_drawer($1, 0)`, [P]).catch(() => {});
await db.query(`select pms_post_payment(f.id, $2, 'cash') from pms_folios f where f.stay_id=$1 and f.status='open'`, [S1, bal]).catch(async () => {
  await asSuper(); await db.query(`insert into pms_folio_lines(property_id,folio_id,stay_id,line_type,category,description,amount,payment_method,business_date,source) select property_id,id,stay_id,'payment','payment','Cash',$2,'cash','2026-10-14','manual' from pms_folios where stay_id=$1 and status='open'`, [S1, -bal]); await as(U.desk);
});
await db.query(`select pms_check_out($1)`, [S1]);
await asGuest();
ok('after check-out the session is gone', /SIGNED_OUT/.test(await err(`select pms_portal_home($1)`, [login3.session])));
ok('…the link is dead', /expired/.test(await err(`select pms_portal_open($1)`, [T2])));
ok('…and no new key can be asked for', /expired/.test(await err(`select pms_portal_send_key($1,'0754111222')`, [T2])));

console.log('\nPackage');
await asSuper();
await db.query(`update pms_property_addons set enabled=false where property_id=$1 and key='guest_portal'`, [P]);
ok('without the add-on the screens hide it', await val(`select features->>'guest_portal' from pms_properties where id=$1`, [P]) === 'false');
await as(U.desk);
ok('…and no link can be sent', /not part of this property/.test(await err(`select pms_portal_send($1)`, [S2])));
ok('anon cannot call staff functions', await (async () => { await asGuest(); return (await err(`select pms_guest_requests_live($1)`, [P])) !== ''; })());

console.log('\nSecrets stay secret');
{
  await as(U.desk);
  ok('staff never see a queued key or link in the text log', (await q(`select body from pms_sms_out where kind in ('portal_key','portal_link') and status <> 'sent'`)).length === 0);
  await asSuper();
  const sid = await val(`select id from pms_sms_out where kind='portal_key' and status='queued' order by created_at desc limit 1`);
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  await db.query(`select pms_svc_sms_result($1, true, 'beem-1', null)`, [sid]);
  const body = await val(`select body from pms_sms_out where id=$1`, [sid]);
  ok('once sent, the key is blanked in the record', /\*{6}/.test(body) && !/\d{6}/.test(body), body);
  const lid = await val(`select id from pms_sms_out where kind='portal_link' and status='queued' order by created_at limit 1`);
  await db.query(`select pms_svc_sms_result($1, true, 'beem-2', null)`, [lid]);
  ok('…and the private link too', !/[0-9a-f]{64}/.test(await val(`select body from pms_sms_out where id=$1`, [lid])));
  await db.exec(`select set_config('request.jwt.claims', '', false)`);
  await db.query(`update pms_property_addons set enabled=true where property_id=$1 and key='guest_portal'`, [P]);
  await db.query(`update pms_properties set settings = jsonb_set(settings, '{guest_portal,app_url}', '"javascript:alert(1)//"') where id=$1`, [P]);
  await as(U.desk);
  ok('a link address that is not https is refused', /plain https/.test(await err(`select pms_portal_send($1)`, [S2])));
  ok('…even when the desk passes one', /plain https/.test(await err(`select pms_portal_send($1,true,true,'http://evil.example/')`, [S2])));
  await asSuper();
  await db.query(`update pms_properties set settings = jsonb_set(settings, '{guest_portal,app_url}', '"https://bmg-pms.netlify.app"') where id=$1`, [P]);
  const { parseOrigins, corsFor } = await import('../supabase/functions/_shared/util.js');
  ok('APP_ORIGINS slips are forgiven', JSON.stringify(parseOrigins('http://https://bmg-pms.netlify.app/, https://PMS.bmggroup.co.tz ')) === JSON.stringify(['https://bmg-pms.netlify.app', 'https://pms.bmggroup.co.tz']));
  ok('…and plain http or junk is dropped', parseOrigins('http://evil.example, *, javascript:x').length === 0 && parseOrigins('http://localhost:5173').length === 1);
  ok('CORS never answers "*" and never echoes a stranger', corsFor([], 'https://evil.example')['access-control-allow-origin'] === 'null'
    && corsFor(['https://bmg-pms.netlify.app'], 'https://evil.example')['access-control-allow-origin'] === 'https://bmg-pms.netlify.app');
}

console.log('\nThe email worker (Resend)');
{
  const { runEmail, fromLine } = await import('../supabase/functions/_shared/email.js');
  await asSuper();
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  const rpc = async (fn, args) => {
    const names = Object.keys(args);
    const r = await db.query(`select ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as v`, names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n])));
    return r.rows[0]?.v;
  };
  const rpcSet = async (fn, args) => (await db.query(`select * from ${fn}(${Object.keys(args).map((n, i) => `${n} => $${i + 1}`).join(', ')})`, Object.values(args))).rows;
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'em_' + calls.length }), { status: 200 }); };
  const out = await runEmail({ rpc: (fn, a) => (fn === 'pms_svc_claim_jobs' ? rpcSet(fn, a) : rpc(fn, a)), fetchFn, env: { RESEND_API_KEY: 're_test', EMAIL_FROM: 'BMG Hotels <stay@bmggroup.co.tz>' } });
  ok('queued emails are sent', out.length >= 2 && out.every((x) => x.ok), JSON.stringify(out));
  const body = JSON.parse(calls[0].init.body);
  ok('…from the hotel\'s name at BMG\'s address, with the bearer key', body.from === 'Pwani Lodge <stay@bmggroup.co.tz>' && calls[0].init.headers.authorization === 'Bearer re_test' && body.to[0] === 'neema@example.com');
  ok('…and marked sent', await val(`select count(*)::int from pms_email_out where status='sent'`) === out.length);
  ok('a sender name cannot inject headers', fromLine('x@y.tz', 'Bad\r\nBcc: a@b') === 'BadBcc: a@b <x@y.tz>');
  const none = await runEmail({ rpc: (fn, a) => (fn === 'pms_svc_claim_jobs' ? rpcSet(fn, a) : rpc(fn, a)), fetchFn, env: {} });
  ok('nothing left to send', none.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
