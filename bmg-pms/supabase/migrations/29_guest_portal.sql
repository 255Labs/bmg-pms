-- module: guest-portal
-- also: billing, core, integrations, payments
-- 29 · Guest portal: a private page for each checked-in guest, and live requests for staff
--
--  - At check-in (or when the desk presses "Send portal link") the guest gets a private link by SMS and/or email;
--    the desk can also pass it on through WhatsApp. The link alone opens nothing: the guest asks for a 6-digit key,
--    which goes ONLY to the phone number or email on the booking (or the desk reads one out in person).
--  - The portal works while the stay is checked in. Check-out, an undone check-in, or "Stop the link" ends it at
--    once, and every signed-in phone is signed out.
--  - Guests order food from the room-service menu and ask for services (cleaning, towels, repairs, taxi, wake-up…).
--    Each request reaches staff live: a pop-up, a bell on the guest's bar in Stay view and on the reservation.
--    Staff accept, finish or decline; accepting a food order opens the outlet bill, sends it to the kitchen and
--    charges it to the room.
--  - Emails go out through a new email queue (Edge Function email-sync, Resend); texts through the SMS queue.
-- Safe to re-run.

-- ---------------------------------------------------------------------
-- 1. The add-on, its screens and its abilities
-- ---------------------------------------------------------------------
insert into pms_catalog(key, kind, name, description, included, sort_order)
values ('guest_portal', 'module', 'Guest portal', 'Guests order food and ask for services from their phone; staff see each request live', false, 15)
on conflict (key) do update set kind = excluded.kind, sort_order = excluded.sort_order;
select pms__seed_addons(id, false) from pms_properties;

create or replace function pms__addons_to_features() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update pms_properties p set features = coalesce(p.features, '{}'::jsonb) || jsonb_build_object(
      'pos', pms__addon_on(p.id, 'pos') or pms__addon_on(p.id, 'activities'),
      'stock', pms__addon_on(p.id, 'stock'), 'procurement', pms__addon_on(p.id, 'procurement'),
      'city_ledger', pms__addon_on(p.id, 'city_ledger'), 'expenses', pms__addon_on(p.id, 'expenses'),
      'back_office', pms__addon_on(p.id, 'back_office'), 'guest_services', pms__addon_on(p.id, 'guest_services'),
      'assets', pms__addon_on(p.id, 'assets'), 'import', pms__addon_on(p.id, 'import'),
      'accounting', pms__addon_on(p.id, 'quickbooks'), 'guest_portal', pms__addon_on(p.id, 'guest_portal'),
      'integrations', exists (select 1 from pms_catalog c where c.kind = 'integration' and pms__addon_on(p.id, c.key)) or pms__addon_on(p.id, 'revenue_assurance'))
  where p.id = new.property_id;
  if new.key = 'booking_engine' and not new.enabled then
    update pms_properties set settings = jsonb_set(coalesce(settings, '{}'), '{booking_engine,enabled}', 'false')
    where id = new.property_id and coalesce((settings->'booking_engine'->>'enabled')::boolean, false);
  end if;
  if new.key = 'guest_portal' and not new.enabled then
    update pms_guest_portals set revoked_at = now() where property_id = new.property_id and revoked_at is null;
  end if;
  if not new.enabled then
    update pms_integrations set enabled = false where property_id = new.property_id and provider = new.key and enabled;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
-- One portal per stay. Only hashes of the link and the keys are kept.
create table if not exists pms_guest_portals (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references pms_properties(id) on delete cascade,
  stay_id          uuid not null unique references pms_stays(id) on delete cascade,
  token_hash       text not null unique,
  phone            text,                -- the only number a key may be sent to (from the booking)
  email            text,                -- the only email a key may be sent to (from the booking)
  revoked_at       timestamptz,
  sent_via         text[] not null default '{}',
  sent_at          timestamptz,
  key_hash         text,
  key_expires_at   timestamptz,
  key_tries        integer not null default 0,
  keys_sent        integer not null default 0,
  keys_window      timestamptz,
  wrong_contacts   integer not null default 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz not null default now()
);

create table if not exists pms_guest_portal_sessions (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  portal_id     uuid not null references pms_guest_portals(id) on delete cascade,
  session_hash  text not null unique,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create table if not exists pms_guest_requests (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  stay_id       uuid not null references pms_stays(id) on delete cascade,
  portal_id     uuid references pms_guest_portals(id) on delete set null,
  kind          text not null check (kind in ('food','housekeeping','towels','amenities','maintenance','laundry','taxi','wakeup','late_checkout','other')),
  title         text not null check (length(title) between 1 and 120),
  details       text check (details is null or length(details) <= 500),
  items         jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  total         numeric(14,2) not null default 0 check (total >= 0),
  outlet_id     uuid references pms_pos_outlets(id) on delete set null,
  wanted_at     timestamptz,
  status        text not null default 'new' check (status in ('new','accepted','done','declined','cancelled')),
  staff_note    text check (staff_note is null or length(staff_note) <= 300),
  handled_by    uuid,
  accepted_at   timestamptz,
  done_at       timestamptz,
  pos_bill_id   uuid references pms_pos_bills(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists ix_guest_requests_open on pms_guest_requests (property_id, created_at) where status in ('new','accepted');
create index if not exists ix_guest_requests_stay on pms_guest_requests (stay_id);

-- Emails (portal links and keys for now), sent by the email-sync Edge Function
create table if not exists pms_email_out (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  stay_id       uuid references pms_stays(id) on delete set null,
  kind          text not null default 'manual' check (kind in ('portal_link','portal_key','manual')),
  to_email      text not null check (to_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  subject       text not null check (length(subject) between 1 and 200),
  body          text not null check (length(body) between 1 and 4000),
  status        text not null default 'queued' check (status in ('queued','sent','failed')),
  provider_ref  text,
  error         text,
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists ix_email_out_stay on pms_email_out (stay_id);

alter table pms_sms_out drop constraint if exists pms_sms_out_kind_check;
alter table pms_sms_out add constraint pms_sms_out_kind_check check (kind in ('door_code','manual','audit_alert','portal_link','portal_key'));
alter table pms_jobs drop constraint if exists pms_jobs_provider_check;
alter table pms_jobs add constraint pms_jobs_provider_check
  check (provider in ('channex','ttlock','hikvision','fiscal','clickpesa','sms','quickbooks','email'));

-- Staff read requests through functions; nobody reads portal secrets or the email queue directly
alter table pms_guest_portals enable row level security;
alter table pms_guest_portal_sessions enable row level security;
alter table pms_guest_requests enable row level security;
alter table pms_email_out enable row level security;
revoke all on pms_guest_portals, pms_guest_portal_sessions, pms_guest_requests, pms_email_out from anon, authenticated;
grant select on pms_guest_requests, pms_email_out to authenticated;
drop policy if exists pms_guest_requests_read on pms_guest_requests;
create policy pms_guest_requests_read on pms_guest_requests for select using (pms_has_priv(property_id, 'fo.requests'));

-- ---------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------
create or replace function pms__hash(p text) returns text
language sql immutable as $$ select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex') $$;

create or replace function pms__random_token() returns text
language sql volatile as $$ select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') $$;

create or replace function pms__random_key() returns text
language sql volatile as $$
  select lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0')
$$;

create or replace function pms__mask_phone(p text) returns text
language sql immutable as $$
  select case when p is null then null when p like '255%' and length(p) = 12 then '0' || substr(p, 4, 3) || ' *** ' || right(p, 3)
              else left(p, 3) || ' *** ' || right(p, 3) end
$$;

create or replace function pms__mask_email(p text) returns text
language sql immutable as $$
  select case when p is null then null else left(split_part(p, '@', 1), 1) || '***@' || split_part(p, '@', 2) end
$$;

create or replace function pms__queue_email(p_property uuid, p_stay uuid, p_kind text, p_to text, p_subject text, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_to text := lower(trim(coalesce(p_to, '')));
begin
  if v_to !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return null; end if;
  insert into pms_email_out(property_id, stay_id, kind, to_email, subject, body)
  values (p_property, p_stay, p_kind, v_to, left(p_subject, 200), left(p_body, 4000)) returning id into v_id;
  perform pms__enqueue(p_property, 'email', 'send_email', jsonb_build_object('email_id', v_id));
  return v_id;
end $$;

-- The portal's settings for a property, with defaults
create or replace function pms__portal_settings(p_property uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('enabled', false, 'auto_send', true, 'send_sms', true, 'send_email', true, 'food', true, 'outlet_id', null,
           'services', '["housekeeping","towels","amenities","maintenance","laundry","taxi","wakeup","late_checkout","other"]'::jsonb,
           'welcome', null, 'app_url', null)
         || coalesce((select settings->'guest_portal' from pms_properties where id = p_property), '{}'::jsonb)
$$;

create or replace function pms__portal_service_title(p_kind text) returns text
language sql immutable as $$
  select case p_kind when 'food' then 'Food order' when 'housekeeping' then 'Clean my room' when 'towels' then 'Fresh towels'
    when 'amenities' then 'Toiletries, pillows or blankets' when 'maintenance' then 'Something needs fixing'
    when 'laundry' then 'Laundry pick-up' when 'taxi' then 'Book a taxi' when 'wakeup' then 'Wake-up call'
    when 'late_checkout' then 'Late check-out' else 'Something else' end
$$;

-- ---------------------------------------------------------------------
-- 4. Issuing the link (desk, or automatically at check-in)
-- ---------------------------------------------------------------------
create or replace function pms__portal_issue(p_stay uuid, p_sms boolean, p_email boolean, p_app_url text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s pms_stays; g pms_guests; pr pms_properties; cfg jsonb; v_token text; v_portal uuid; v_url text; v_link text;
  v_msg text; v_room text; v_sms uuid; v_mail uuid; v_phone text; v_email text; v_via text[] := '{}';
begin
  select * into s from pms_stays where id = p_stay;
  if not found then raise exception 'Stay not found'; end if;
  if s.status <> 'checked_in' then raise exception 'The portal opens once the guest is checked in'; end if;
  perform pms__require_addon(s.property_id, 'guest_portal');
  select * into pr from pms_properties where id = s.property_id;
  select gg.* into g from pms_reservations r join pms_guests gg on gg.id = r.guest_id where r.id = s.reservation_id;
  cfg := pms__portal_settings(s.property_id);
  v_url := nullif(trim(coalesce(p_app_url, cfg->>'app_url', '')), '');
  if v_url is null then raise exception 'Save the guest portal settings once (Setup → Guest portal) so the link knows the app''s address'; end if;
  -- links go only to a real https address (http only for a computer's own test copy)
  if v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' and v_url !~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' then
    raise exception 'The app address must be a plain https:// address, such as https://pms.bmggroup.co.tz';
  end if;
  v_url := regexp_replace(regexp_replace(v_url, '#.*$', ''), '/+$', '');
  v_phone := pms__msisdn(g.phone);
  v_email := nullif(lower(trim(coalesce(g.email, ''))), '');
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_email := null; end if;
  if v_phone is null and v_email is null then raise exception 'Add the guest''s mobile number or email first: the login key can only go to one of them'; end if;
  v_token := pms__random_token();
  insert into pms_guest_portals(property_id, stay_id, token_hash, phone, email)
  values (s.property_id, p_stay, pms__hash(v_token), v_phone, v_email)
  on conflict (stay_id) do update set token_hash = excluded.token_hash, phone = excluded.phone, email = excluded.email,
    revoked_at = null, key_hash = null, key_expires_at = null, key_tries = 0, wrong_contacts = 0, locked_until = null
  returning id into v_portal;
  delete from pms_guest_portal_sessions where portal_id = v_portal;   -- a new link signs out the old one
  v_link := v_url || '/#/stay/' || v_token;
  select number into v_room from pms_rooms where id = s.room_id;
  v_msg := coalesce(nullif(trim(cfg->>'welcome'), ''), 'Karibu {guest}! Order food and ask for anything during your stay at {property} here:')
    || ' ' || v_link || ' . A login key is sent to this number or email. The link stops working at check-out.';
  v_msg := replace(replace(replace(v_msg, '{guest}', coalesce(g.first_name, 'guest')), '{property}', pr.name), '{room}', coalesce(v_room, ''));
  if p_sms and v_phone is not null and pms__integration_on(s.property_id, 'sms') then
    v_sms := pms__queue_sms(s.property_id, p_stay, 'portal_link', v_phone, v_msg);
    if v_sms is not null then v_via := array_append(v_via, 'sms'); end if;
  end if;
  if p_email and v_email is not null then
    v_mail := pms__queue_email(s.property_id, p_stay, 'portal_link', v_email, 'Your stay at ' || pr.name, v_msg);
    if v_mail is not null then v_via := array_append(v_via, 'email'); end if;
  end if;
  update pms_guest_portals set sent_via = v_via, sent_at = now() where id = v_portal;
  perform pms_log(s.property_id, 'portal.issue', 'stay', p_stay, jsonb_build_object('sent_via', v_via));
  return jsonb_build_object('link', v_link, 'message', v_msg, 'phone', v_phone, 'email', v_email, 'sent_via', v_via,
                            'sms_on', pms__integration_on(s.property_id, 'sms'));
end $$;

-- Desk: send (or send again) the link. Returns the link and message, so the desk can also share it on WhatsApp.
create or replace function pms_portal_send(p_stay uuid, p_sms boolean default true, p_email boolean default true, p_app_url text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s pms_stays;
begin
  s := pms__stay(p_stay);
  perform pms_need(s.property_id, 'fo.portal');
  if nullif(trim(coalesce(p_app_url, '')), '') is not null and pms__portal_settings(s.property_id)->>'app_url' is null then
    update pms_properties set settings = jsonb_set(coalesce(settings, '{}'), '{guest_portal}', coalesce(settings->'guest_portal', '{}') || jsonb_build_object('app_url', trim(p_app_url)))
    where id = s.property_id;
  end if;
  return pms__portal_issue(p_stay, p_sms, p_email, p_app_url);
end $$;

-- Desk: stop the link now (lost phone, wrong person)
create or replace function pms_portal_revoke(p_stay uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s pms_stays;
begin
  s := pms__stay(p_stay);
  perform pms_need(s.property_id, 'fo.portal');
  update pms_guest_portals set revoked_at = now() where stay_id = p_stay and revoked_at is null;
  delete from pms_guest_portal_sessions where portal_id in (select id from pms_guest_portals where stay_id = p_stay);
  perform pms_log(s.property_id, 'portal.revoke', 'stay', p_stay, null);
end $$;

-- Desk: a key to read out to the guest in person (no phone or email signal, SMS not set up…)
create or replace function pms_portal_desk_key(p_stay uuid) returns text
language plpgsql security definer set search_path = public as $$
declare s pms_stays; p pms_guest_portals; v_key text := pms__random_key();
begin
  s := pms__stay(p_stay);
  perform pms_need(s.property_id, 'fo.portal');
  select * into p from pms_guest_portals where stay_id = p_stay and revoked_at is null;
  if not found or s.status <> 'checked_in' then raise exception 'Send the portal link first'; end if;
  update pms_guest_portals set key_hash = pms__hash(p.id || ':' || v_key), key_expires_at = now() + interval '15 minutes', key_tries = 0, locked_until = null
  where id = p.id;
  perform pms_log(s.property_id, 'portal.desk_key', 'stay', p_stay, null);
  return v_key;
end $$;

-- Desk: is there a portal, was it sent, has the guest signed in?
create or replace function pms_portal_status(p_stay uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s pms_stays; p pms_guest_portals;
begin
  select * into s from pms_stays where id = p_stay;   -- read-only: no row lock (pms__stay locks)
  if not found then raise exception 'Stay not found'; end if;
  perform pms_need(s.property_id, 'fo.requests');
  select * into p from pms_guest_portals where stay_id = p_stay;
  return jsonb_build_object(
    'available', pms__addon_on(s.property_id, 'guest_portal'),
    'issued', p.id is not null, 'active', p.id is not null and p.revoked_at is null and s.status = 'checked_in',
    'sent_via', coalesce(to_jsonb(p.sent_via), '[]'), 'sent_at', p.sent_at, 'revoked_at', p.revoked_at, 'last_login_at', p.last_login_at,
    'phone', pms__mask_phone(p.phone), 'email', pms__mask_email(p.email),
    'signed_in', (select count(*) from pms_guest_portal_sessions x where x.portal_id = p.id),
    'can_send', pms_has_priv(s.property_id, 'fo.portal'));
end $$;

-- Check-in sends the link by itself (if switched on); anything that ends the stay ends the portal
create or replace function pms_trg_stay_portal() returns trigger
language plpgsql security definer set search_path = public as $$
declare cfg jsonb;
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status = 'checked_in' and old.status in ('tentative','confirmed') then
    cfg := pms__portal_settings(new.property_id);
    if coalesce((cfg->>'enabled')::boolean, false) and coalesce((cfg->>'auto_send')::boolean, true)
       and cfg->>'app_url' is not null and pms__addon_on(new.property_id, 'guest_portal') then
      begin
        perform pms__portal_issue(new.id, coalesce((cfg->>'send_sms')::boolean, true), coalesce((cfg->>'send_email')::boolean, true), null);
      exception when others then
        perform pms_log(new.property_id, 'portal.not_sent', 'stay', new.id, jsonb_build_object('reason', sqlerrm));
      end;
    end if;
  elsif new.status <> 'checked_in' then
    update pms_guest_portals set revoked_at = coalesce(revoked_at, now()) where stay_id = new.id;
    delete from pms_guest_portal_sessions where portal_id in (select id from pms_guest_portals where stay_id = new.id);
  end if;
  return new;
end $$;
drop trigger if exists trg_stay_portal on pms_stays;
create trigger trg_stay_portal after update of status on pms_stays for each row execute function pms_trg_stay_portal();

-- ---------------------------------------------------------------------
-- 5. The guest's side (no sign-in to the PMS: the link, then a key)
-- ---------------------------------------------------------------------
-- A link that still works: not stopped, stay checked in, hotel has the portal
create or replace function pms__portal_by_token(p_token text) returns pms_guest_portals
language plpgsql stable security definer set search_path = public as $$
declare p pms_guest_portals;
begin
  if p_token is null or length(p_token) <> 64 then raise exception 'This link is not valid'; end if;
  select gp.* into p from pms_guest_portals gp join pms_stays s on s.id = gp.stay_id
  where gp.token_hash = pms__hash(p_token) and gp.revoked_at is null and s.status = 'checked_in'
    and pms__addon_on(gp.property_id, 'guest_portal');
  if not found then raise exception 'This link has expired. It stops working at check-out; ask reception if you are still staying with us.'; end if;
  return p;
end $$;

create or replace function pms__portal_by_session(p_session text) returns pms_guest_portals
language plpgsql security definer set search_path = public as $$
declare p pms_guest_portals;
begin
  if p_session is null or length(p_session) <> 64 then raise exception 'SIGNED_OUT: Please sign in again'; end if;
  select gp.* into p from pms_guest_portal_sessions x join pms_guest_portals gp on gp.id = x.portal_id
    join pms_stays s on s.id = gp.stay_id
  where x.session_hash = pms__hash(p_session) and gp.revoked_at is null and s.status = 'checked_in'
    and pms__addon_on(gp.property_id, 'guest_portal');
  if p.id is null then raise exception 'SIGNED_OUT: Your access has ended. It stops at check-out; ask reception if you are still staying with us.'; end if;
  update pms_guest_portal_sessions set last_seen_at = now() where session_hash = pms__hash(p_session) and last_seen_at < now() - interval '1 minute';
  return p;
end $$;

-- Opening the link: hotel name and where a key can be sent (masked)
create or replace function pms_portal_open(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p pms_guest_portals; pr pms_properties; g text;
begin
  p := pms__portal_by_token(p_token);
  select * into pr from pms_properties where id = p.property_id;
  select gg.first_name into g from pms_stays s join pms_reservations r on r.id = s.reservation_id join pms_guests gg on gg.id = r.guest_id where s.id = p.stay_id;
  return jsonb_build_object('property', pr.name, 'logo_url', pr.logo_url, 'phone', coalesce(pr.reservation_phone, pr.phone), 'guest', g,
    'by_sms', p.phone is not null and pms__integration_on(p.property_id, 'sms'), 'by_email', p.email is not null,
    'phone_hint', pms__mask_phone(p.phone), 'email_hint', pms__mask_email(p.email));
end $$;

-- Ask for a key: the guest types the phone number or email used on the booking; only that one receives it
create or replace function pms_portal_send_key(p_token text, p_contact text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p pms_guest_portals; pr pms_properties; v_c text := lower(trim(coalesce(p_contact, ''))); v_key text; v_to text; v_kind text; v_msg text;
begin
  p := pms__portal_by_token(p_token);
  if p.locked_until > now() then raise exception 'Too many tries. Wait a few minutes or ask reception for a key.'; end if;
  if v_c ~ '@' then
    if p.email is null or v_c <> p.email then v_kind := null; else v_kind := 'email'; v_to := p.email; end if;
  elsif pms__msisdn(v_c) is not null and pms__msisdn(v_c) = p.phone then
    v_kind := 'sms'; v_to := p.phone;
  end if;
  if v_kind is null then
    update pms_guest_portals set
      locked_until = case when wrong_contacts + 1 >= 8 then now() + interval '30 minutes' else locked_until end,
      wrong_contacts = case when wrong_contacts + 1 >= 8 then 0 else wrong_contacts + 1 end
    where id = p.id;
    return jsonb_build_object('ok', false, 'error', 'That is not the number or email on this booking. Use the one you gave when you booked, or ask reception.');
  end if;
  if v_kind = 'sms' and not pms__integration_on(p.property_id, 'sms') then
    raise exception 'Texts are not set up at this hotel. Use your email, or ask reception for a key.';
  end if;
  -- at most 5 keys an hour
  if p.keys_window is null or p.keys_window < now() - interval '1 hour' then
    update pms_guest_portals set keys_window = now(), keys_sent = 0 where id = p.id;
    p.keys_sent := 0;
  end if;
  if p.keys_sent >= 5 then raise exception 'Five keys have been sent in the last hour. Use the latest one, or ask reception.'; end if;
  v_key := pms__random_key();
  update pms_guest_portals set key_hash = pms__hash(p.id || ':' || v_key), key_expires_at = now() + interval '15 minutes', key_tries = 0,
    keys_sent = keys_sent + 1, wrong_contacts = 0 where id = p.id;
  select * into pr from pms_properties where id = p.property_id;
  v_msg := 'Your ' || pr.name || ' guest portal key is ' || v_key || '. It works for 15 minutes. Do not share it.';
  if v_kind = 'sms' then perform pms__queue_sms(p.property_id, p.stay_id, 'portal_key', v_to, v_msg);
  else perform pms__queue_email(p.property_id, p.stay_id, 'portal_key', v_to, 'Your key for ' || pr.name, v_msg); end if;
  return jsonb_build_object('ok', true, 'sent_to', case when v_kind = 'sms' then pms__mask_phone(v_to) else pms__mask_email(v_to) end, 'by', v_kind);
end $$;

-- Sign in with the key; returns a session for this phone or browser
create or replace function pms_portal_login(p_token text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p pms_guest_portals; v_session text;
begin
  p := pms__portal_by_token(p_token);
  if p.locked_until > now() then raise exception 'Too many tries. Wait a few minutes or ask reception for a key.'; end if;
  if p.key_hash is null or p.key_expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'That key has expired. Ask for a new one.');
  end if;
  if pms__hash(p.id || ':' || regexp_replace(coalesce(p_key, ''), '\D', '', 'g')) <> p.key_hash then
    update pms_guest_portals set key_tries = key_tries + 1,
      key_hash = case when key_tries + 1 >= 5 then null else key_hash end where id = p.id;
    return jsonb_build_object('ok', false, 'error', case when p.key_tries + 1 >= 5 then 'Wrong key five times. Ask for a new one.' else 'That key is not right. Check the message and try again.' end);
  end if;
  v_session := pms__random_token();
  update pms_guest_portals set key_hash = null, key_tries = 0, last_login_at = now() where id = p.id;
  -- at most 5 phones signed in at once; the oldest is signed out
  delete from pms_guest_portal_sessions where id in (select id from pms_guest_portal_sessions where portal_id = p.id order by last_seen_at desc offset 4);
  insert into pms_guest_portal_sessions(property_id, portal_id, session_hash, created_by) values (p.property_id, p.id, pms__hash(v_session), null);
  perform pms_log(p.property_id, 'portal.login', 'stay', p.stay_id, null);
  return jsonb_build_object('ok', true, 'session', v_session);
end $$;

create or replace function pms_portal_logout(p_session text) returns void
language sql security definer set search_path = public as $$
  delete from pms_guest_portal_sessions where session_hash = pms__hash(p_session)
$$;

-- Everything the portal shows: the stay, the bill, the menu, the services and the guest's requests
create or replace function pms_portal_home(p_session text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p pms_guest_portals; s pms_stays; pr pms_properties; cfg jsonb; v_outlet uuid; v_menu jsonb := '[]'; v_guest jsonb; v_bill jsonb;
begin
  p := pms__portal_by_session(p_session);
  select * into s from pms_stays where id = p.stay_id;
  select * into pr from pms_properties where id = p.property_id;
  cfg := pms__portal_settings(p.property_id);
  select jsonb_build_object('first_name', g.first_name, 'last_name', g.last_name, 'res_no', r.res_no) into v_guest
    from pms_reservations r join pms_guests g on g.id = r.guest_id where r.id = s.reservation_id;
  v_outlet := pms__portal_outlet(p.property_id);
  if v_outlet is not null then
    select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'price', (select x.price from pms__pos_price(i) x),
             'category', coalesce(c.name, i.group_name, 'Menu'), 'image_url', case when i.image_url ~ '^https://' then i.image_url end)
             order by coalesce(c.sort_order, 999), coalesce(c.name, i.group_name), i.sort_order, i.name), '[]')
      into v_menu
    from pms_pos_items i left join pms_pos_categories c on c.id = i.category_id
    where i.outlet_id = v_outlet and i.active and i.available and coalesce(i.item_type, 'product') = 'product'
      and (c.id is null or c.active)
      and not exists (select 1 from pms_pos_item_modifier_groups ig join pms_pos_modifier_groups mg on mg.id = ig.group_id
                      where ig.item_id = i.id and mg.active and mg.min_choices > 0);
  end if;
  select jsonb_build_object(
      'balance', coalesce(sum(l.amount) filter (where not l.voided), 0),
      'lines', coalesce(jsonb_agg(jsonb_build_object('date', l.business_date, 'description', l.description, 'amount', l.amount)
                order by l.business_date, l.created_at) filter (where not l.voided), '[]'))
    into v_bill
  from pms_folios f join pms_folio_lines l on l.folio_id = f.id
  where f.stay_id = s.id and f.status = 'open' and f.company_id is null;
  return jsonb_build_object(
    'property', jsonb_build_object('name', pr.name, 'logo_url', pr.logo_url, 'phone', coalesce(pr.reservation_phone, pr.phone),
                                   'currency', pr.currency, 'check_out_time', pr.check_out_time, 'timezone', pr.timezone),
    'guest', v_guest,
    'stay', jsonb_build_object('room', (select number from pms_rooms where id = s.room_id), 'arrival', s.arrival, 'departure', s.departure),
    'bill', coalesce(v_bill, jsonb_build_object('balance', 0, 'lines', '[]'::jsonb)),
    'food', v_outlet is not null and jsonb_array_length(v_menu) > 0,
    'menu', v_menu,
    'services', (select coalesce(jsonb_agg(jsonb_build_object('kind', k, 'title', pms__portal_service_title(k))), '[]')
                 from jsonb_array_elements_text(cfg->'services') k where k in ('housekeeping','towels','amenities','maintenance','laundry','taxi','wakeup','late_checkout','other')),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'title', q.title, 'details', q.details, 'items', q.items,
                   'total', q.total, 'status', q.status, 'staff_note', q.staff_note, 'wanted_at', q.wanted_at, 'created_at', q.created_at)
                   order by q.created_at desc), '[]')
                 from pms_guest_requests q where q.stay_id = s.id));
end $$;

-- Which outlet's menu the portal shows: the one chosen in settings, else the room-service outlet, else the restaurant
create or replace function pms__portal_outlet(p_property uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare cfg jsonb := pms__portal_settings(p_property); v uuid;
begin
  if not coalesce((cfg->>'food')::boolean, true) or not pms__addon_on(p_property, 'pos') then return null; end if;
  select id into v from pms_pos_outlets where property_id = p_property and active and id = nullif(cfg->>'outlet_id', '')::uuid;
  if v is null then   -- a food outlet: room service first, then one called restaurant or kitchen, then any restaurant or cafe
    select id into v from pms_pos_outlets where property_id = p_property and active and charge_category = 'fnb'
      and outlet_type in ('room_service','restaurant','cafe')
    order by case when outlet_type = 'room_service' then 0 when name ~* 'room service|restaurant|kitchen|dining' then 1 when outlet_type = 'restaurant' then 2 else 3 end, name limit 1;
  end if;
  return v;
end $$;

-- A guest's request: a service, or a food order from the menu
create or replace function pms_portal_request(p_session text, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare gp pms_guest_portals; cfg jsonb; v_kind text := p->>'kind'; v_details text := nullif(left(trim(coalesce(p->>'details', '')), 500), '');
  v_items jsonb := '[]'; v_total numeric := 0; v_outlet uuid; v_id uuid; x jsonb; i pms_pos_items; v_qty numeric; v_price numeric; v_wanted timestamptz;
  v_room text; v_guest text;
begin
  gp := pms__portal_by_session(p_session);
  cfg := pms__portal_settings(gp.property_id);
  if (select count(*) from pms_guest_requests where stay_id = gp.stay_id and status in ('new','accepted')) >= 10 then
    raise exception 'You have 10 requests waiting. Please wait for the team, or call reception.';
  end if;
  if (select count(*) from pms_guest_requests where stay_id = gp.stay_id and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many requests in the last hour. Please call reception.';
  end if;
  begin v_wanted := nullif(p->>'wanted_at', '')::timestamptz; exception when others then v_wanted := null; end;
  if v_wanted is not null and (v_wanted < now() - interval '5 minutes' or v_wanted > now() + interval '14 days') then
    raise exception 'Choose a time during your stay';
  end if;
  if v_kind = 'food' then
    v_outlet := pms__portal_outlet(gp.property_id);
    if v_outlet is null then raise exception 'Food orders are not taken through the portal here. Please call reception.'; end if;
    if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'Choose something from the menu'; end if;
    if jsonb_array_length(p->'items') > 30 then raise exception 'At most 30 different dishes in one order'; end if;
    for x in select * from jsonb_array_elements(p->'items') loop
      select * into i from pms_pos_items where id = nullif(x->>'item_id', '')::uuid and outlet_id = v_outlet and active and available;
      if not found then raise exception 'Something you chose is no longer on the menu. Refresh and try again.'; end if;
      v_qty := floor(coalesce(nullif(x->>'qty', '')::numeric, 1));
      if v_qty < 1 or v_qty > 20 then raise exception 'Choose between 1 and 20 of %', i.name; end if;
      select z.price into v_price from pms__pos_price(i) z;
      v_items := v_items || jsonb_build_object('item_id', i.id, 'name', i.name, 'qty', v_qty, 'price', v_price,
                   'note', nullif(left(trim(coalesce(x->>'note', '')), 120), ''));
      v_total := v_total + v_qty * v_price;
    end loop;
  elsif v_kind is null or not (cfg->'services') ? v_kind then
    raise exception 'Choose one of the services offered';
  elsif v_kind = 'other' and v_details is null then
    raise exception 'Tell us what you need';
  end if;
  insert into pms_guest_requests(property_id, stay_id, portal_id, kind, title, details, items, total, outlet_id, wanted_at, created_by)
  values (gp.property_id, gp.stay_id, gp.id, v_kind,
          case when v_kind = 'food' then 'Food order (' || (select sum((y->>'qty')::numeric)::int from jsonb_array_elements(v_items) y) || ' items)'
               else pms__portal_service_title(v_kind) end,
          v_details, v_items, round(v_total, 2), v_outlet, v_wanted, null)
  returning id into v_id;
  select r.number, g.first_name into v_room, v_guest from pms_stays s left join pms_rooms r on r.id = s.room_id
    join pms_reservations rs on rs.id = s.reservation_id join pms_guests g on g.id = rs.guest_id where s.id = gp.stay_id;
  perform pms_log(gp.property_id, 'portal.request', 'stay', gp.stay_id, jsonb_build_object('request', v_id, 'kind', v_kind, 'room', v_room, 'total', v_total));
  return v_id;
end $$;

-- The guest can take back a request nobody has picked up yet
create or replace function pms_portal_cancel(p_session text, p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
declare gp pms_guest_portals;
begin
  gp := pms__portal_by_session(p_session);
  update pms_guest_requests set status = 'cancelled', done_at = now() where id = p_request and stay_id = gp.stay_id and status = 'new';
  if not found then raise exception 'The team has already picked this up. Please call reception to change it.'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. Staff side
-- ---------------------------------------------------------------------
-- Open requests (new and accepted) plus what was finished in the last 12 hours; polled by every open screen
create or replace function pms_guest_requests_live(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'fo.requests');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'stay_id', q.stay_id, 'reservation_id', s.reservation_id, 'res_no', r.res_no,
      'room', rm.number, 'guest', trim(coalesce(g.first_name, '') || ' ' || coalesce(g.last_name, '')), 'kind', q.kind, 'title', q.title,
      'details', q.details, 'items', q.items, 'total', q.total, 'wanted_at', q.wanted_at, 'status', q.status, 'staff_note', q.staff_note,
      'created_at', q.created_at, 'accepted_at', q.accepted_at, 'done_at', q.done_at, 'pos_bill_id', q.pos_bill_id,
      'handled_by', (select coalesce(m.display_name, split_part(u.email, '@', 1)) from auth.users u left join pms_members m on m.user_id = u.id and m.property_id = q.property_id where u.id = q.handled_by))
      order by q.created_at desc), '[]')
    from pms_guest_requests q join pms_stays s on s.id = q.stay_id join pms_reservations r on r.id = s.reservation_id
    join pms_guests g on g.id = r.guest_id left join pms_rooms rm on rm.id = s.room_id
    where q.property_id = p_property and (q.status in ('new','accepted') or coalesce(q.done_at, q.created_at) > now() - interval '12 hours'));
end $$;

-- Accept, finish or decline. Accepting a food order opens the outlet bill, sends it to the kitchen and charges the room.
create or replace function pms_guest_request_update(p_request uuid, p_status text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q pms_guest_requests; s pms_stays; v_bill uuid; x jsonb; v_n bigint; v_room text; v_line uuid;
begin
  select * into q from pms_guest_requests where id = p_request for update;
  if not found then raise exception 'Request not found'; end if;
  perform pms_need(q.property_id, 'fo.requests');
  if p_status not in ('accepted','done','declined') then raise exception 'Unknown status %', p_status; end if;
  if q.status in ('done','declined','cancelled') then raise exception 'This request is already %', q.status; end if;
  if p_status = 'accepted' and q.status <> 'new' then raise exception 'Already accepted'; end if;
  if p_status = 'declined' and coalesce(trim(p_note), '') = '' then raise exception 'Tell the guest why (they see this note)'; end if;
  if p_status = 'declined' and q.pos_bill_id is not null then raise exception 'This order is already charged to the room. Void the outlet bill first, then decline.'; end if;
  select * into s from pms_stays where id = q.stay_id;
  if q.kind = 'food' and p_status in ('accepted','done') and q.pos_bill_id is null then
    perform pms_need(q.property_id, 'pos.sell');
    if s.status <> 'checked_in' then raise exception 'The guest has checked out; the order cannot be charged to the room'; end if;
    if q.outlet_id is null then raise exception 'The outlet for this order no longer exists'; end if;
    select number into v_room from pms_rooms where id = s.room_id;
    v_bill := pms_pos_open_bill(q.outlet_id, 'Room ' || coalesce(v_room, '?'), null);
    update pms_pos_bills set guest_name = (select trim(coalesce(g.first_name, '') || ' ' || coalesce(g.last_name, '')) from pms_reservations r join pms_guests g on g.id = r.guest_id where r.id = s.reservation_id)
    where id = v_bill;
    for x, v_n in select e, o from jsonb_array_elements(q.items) with ordinality t(e, o) loop
      -- the kitchen sees the dish's own note, and the order's note on the first dish
      perform pms_pos_order(v_bill, (x->>'item_id')::uuid, (x->>'qty')::numeric, '{}'::uuid[],
        concat_ws(' · ', 'Guest portal', x->>'note', case when v_n = 1 then q.details end));
    end loop;
    if exists (select 1 from pms_pos_bill_items where bill_id = v_bill and kitchen_status = 'new') then perform pms_pos_send(v_bill); end if;
    v_line := pms_pos_post_to_room(v_bill, q.stay_id);
    update pms_guest_requests set pos_bill_id = v_bill where id = q.id;
  end if;
  update pms_guest_requests set status = p_status, staff_note = coalesce(nullif(left(trim(coalesce(p_note, '')), 300), ''), staff_note),
    handled_by = auth.uid(),
    accepted_at = case when p_status in ('accepted','done') then coalesce(accepted_at, now()) else accepted_at end,
    done_at = case when p_status in ('done','declined') then now() else done_at end
  where id = q.id;
  perform pms_log(q.property_id, 'portal.request_' || p_status, 'stay', q.stay_id, jsonb_build_object('request', q.id, 'title', q.title, 'bill', v_bill));
  return jsonb_build_object('status', p_status, 'pos_bill_id', coalesce(v_bill, q.pos_bill_id));
end $$;

-- ---------------------------------------------------------------------
-- 7. Email queue for the Edge Function
-- ---------------------------------------------------------------------
create or replace function pms_svc_email(p_email uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when pms__is_service() then to_jsonb(m) || jsonb_build_object('property_name', p.name, 'property_code', p.code, 'reply_to', p.email) end
  from pms_email_out m join pms_properties p on p.id = m.property_id where m.id = p_email
$$;

create or replace function pms_svc_email_result(p_email uuid, p_ok boolean, p_ref text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  update pms_email_out set status = case when p_ok then 'sent' else 'failed' end, provider_ref = coalesce(p_ref, provider_ref),
         error = case when p_ok then null else left(p_error, 500) end, sent_at = case when p_ok then now() else sent_at end where id = p_email;
end $$;

-- ---------------------------------------------------------------------
-- 7b. Keys and links are secrets: hidden from staff screens until sent, then blanked in the record
-- ---------------------------------------------------------------------
create or replace function pms_trg_redact_portal_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'sent' and new.kind in ('portal_key','portal_link') then
    new.body := regexp_replace(regexp_replace(new.body, '#/stay/[0-9a-f]{64}', '#/stay/(private link)', 'g'), '[0-9]{6}', '******', 'g');
  end if;
  return new;
end $$;
drop trigger if exists trg_redact_portal_sms on pms_sms_out;
create trigger trg_redact_portal_sms before update of status on pms_sms_out for each row execute function pms_trg_redact_portal_message();
drop trigger if exists trg_redact_portal_email on pms_email_out;
create trigger trg_redact_portal_email before update of status on pms_email_out for each row execute function pms_trg_redact_portal_message();
drop policy if exists pms_sms_out_read on pms_sms_out;
create policy pms_sms_out_read on pms_sms_out for select
  using (property_id in (select pms_my_properties(array['owner','manager','front_desk']))
         and (kind not in ('portal_key','portal_link') or status = 'sent'));
drop policy if exists pms_email_out_read on pms_email_out;
create policy pms_email_out_read on pms_email_out for select
  using (pms_has_priv(property_id, 'fo.portal') and (kind not in ('portal_key','portal_link') or status = 'sent'));

-- ---------------------------------------------------------------------
-- 8. Abilities and grants
-- ---------------------------------------------------------------------
-- fo.portal and fo.requests are in the ability list (17_privileges.sql and src/lib/privileges.js)

revoke execute on function pms__hash(text), pms__random_token(), pms__random_key(), pms__mask_phone(text), pms__mask_email(text),
  pms__queue_email(uuid, uuid, text, text, text, text), pms__portal_settings(uuid), pms__portal_issue(uuid, boolean, boolean, text),
  pms_trg_stay_portal(), pms__portal_by_token(text), pms__portal_by_session(text), pms__portal_outlet(uuid), pms__portal_service_title(text),
  pms_svc_email(uuid), pms_svc_email_result(uuid, boolean, text, text), pms_trg_redact_portal_message()
  from public, anon, authenticated;
revoke execute on function pms_portal_send(uuid, boolean, boolean, text), pms_portal_revoke(uuid), pms_portal_desk_key(uuid), pms_portal_status(uuid),
  pms_guest_requests_live(uuid), pms_guest_request_update(uuid, text, text)
  from public, anon;
grant execute on function pms_portal_send(uuid, boolean, boolean, text), pms_portal_revoke(uuid), pms_portal_desk_key(uuid), pms_portal_status(uuid),
  pms_guest_requests_live(uuid), pms_guest_request_update(uuid, text, text) to authenticated;
revoke execute on function pms_portal_open(text), pms_portal_send_key(text, text), pms_portal_login(text, text), pms_portal_logout(text),
  pms_portal_home(text), pms_portal_request(text, jsonb), pms_portal_cancel(text, uuid) from public;
grant execute on function pms_portal_open(text), pms_portal_send_key(text, text), pms_portal_login(text, text), pms_portal_logout(text),
  pms_portal_home(text), pms_portal_request(text, jsonb), pms_portal_cancel(text, uuid) to anon, authenticated;
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;

-- the screens learn whether each hotel has the portal
update pms_properties p set features = coalesce(p.features, '{}'::jsonb) || jsonb_build_object('guest_portal', pms__addon_on(p.id, 'guest_portal'))
where (p.features->>'guest_portal')::boolean is distinct from pms__addon_on(p.id, 'guest_portal');

select pms__apply_platform_rules();
notify pgrst, 'reload schema';
