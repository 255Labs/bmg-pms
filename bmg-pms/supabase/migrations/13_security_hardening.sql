-- module: platform
-- also: access, back-office, core, front-office, integrations, payments, stock
-- =====================================================================
-- BMG PMS · 13 · Security hardening and performance
-- Findings from the October 2026 audit, each fixed here:
--   1. The public (anon) key could call functions directly, e.g. write fake audit-log entries
--   2. Owners and managers could change any property column straight through the API,
--      including the business date (skipping or re-opening days) and receipt counters
--   3. Integration settings that pick credentials or endpoints (secret suffix, Channex property,
--      VFD URL) could be changed by a property manager, sending the shared keys elsewhere
--   4. Records could point at another property's rows (companies, rooms, rate plans, locks…)
--   5. A few lookup functions answered for any property id (rates, exchange rates, availability,
--      drawer totals)
--   6. Invites could be claimed by an account whose email was never confirmed
--   7. Lines from a closed business day could be voided; drawers closed with no count; negative
--      room rates and floats; unlimited free-text SMS from the desk
--   8. Housekeeping and stores staff could read guest door codes
--   9. Admin notes were readable by property staff
-- Plus: two-step sign-in (MFA) is enforced in the database once a person turns it on, row-level
-- security is evaluated once per query instead of once per row, and foreign keys get indexes.
-- Safe to re-run. Run after 12.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Nothing for anonymous callers; no TRUNCATE / TRIGGER / REFERENCES for anyone in the app
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema public from public;
revoke truncate, trigger, references on all tables in schema public from authenticated;
do $$ begin
  execute 'alter default privileges for role postgres in schema public revoke all on tables from anon';
  execute 'alter default privileges for role postgres in schema public revoke all on sequences from anon';
  execute 'alter default privileges for role postgres in schema public revoke execute on functions from anon';
  execute 'alter default privileges for role postgres in schema public revoke execute on functions from public';
exception when others then null; end $$;

-- ---------------------------------------------------------------------
-- Two-step sign-in: once a person has a verified authenticator, their session must be aal2
-- ---------------------------------------------------------------------
create or replace function pms__aal_ok() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_has boolean := false;
begin
  if auth.uid() is null or to_regclass('auth.mfa_factors') is null then return true; end if;
  execute 'select exists (select 1 from auth.mfa_factors where user_id = $1 and status::text = ''verified'')' into v_has using auth.uid();
  if not v_has then return true; end if;
  return coalesce(nullif(current_setting('request.jwt.claims', true), '')::json->>'aal', '') = 'aal2';
end $$;

create or replace function pms_is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pms_platform_admins where user_id = auth.uid()) and pms__aal_ok()
$$;

create or replace function pms_role(p_property uuid)
returns text language sql stable security definer set search_path = public as $$
  select m.role from pms_members m join pms_properties p on p.id = m.property_id
  where m.property_id = p_property and m.user_id = auth.uid() and m.active
    and (p.status = 'active' or exists (select 1 from pms_platform_admins a where a.user_id = auth.uid()))
    and pms__aal_ok()
$$;

-- The caller's properties (optionally only where they hold one of the roles); used by row-level security
create or replace function pms_my_properties(p_roles text[] default null) returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.property_id from pms_members m join pms_properties p on p.id = m.property_id
  where m.user_id = auth.uid() and m.active and (p_roles is null or m.role = any(p_roles))
    and (p.status = 'active' or exists (select 1 from pms_platform_admins a where a.user_id = auth.uid()))
    and pms__aal_ok()
$$;

-- Service, member or administrator: who may ask about a property
create or replace function pms__can_see(p_property uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select pms__is_service() or pms_role(p_property) is not null or pms_is_super_admin()
$$;

-- Row-level security: rewrite per-row role checks into a set computed once per query
do $$
declare r record; nq text; nw text;
  function_re1 text := 'pms_is_member\(([\w.]+)\)';
  function_re2 text := '\(?pms_role\(([\w.]+)\) = ANY \((ARRAY\[[^\]]*\])\)\)?';
  function_re3 text := '\(?pms_role\(([\w.]+)\) = (''\w+''::text)\)?';
begin
  for r in select tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' loop
    nq := r.qual; nw := r.with_check;
    if nq is not null then
      nq := regexp_replace(nq, function_re1, '(\1 IN (SELECT pms_my_properties(NULL::text[])))', 'g');
      nq := regexp_replace(nq, function_re2, '(\1 IN (SELECT pms_my_properties(\2)))', 'g');
      nq := regexp_replace(nq, function_re3, '(\1 IN (SELECT pms_my_properties(ARRAY[\2])))', 'g');
    end if;
    if nw is not null then
      nw := regexp_replace(nw, function_re1, '(\1 IN (SELECT pms_my_properties(NULL::text[])))', 'g');
      nw := regexp_replace(nw, function_re2, '(\1 IN (SELECT pms_my_properties(\2)))', 'g');
      nw := regexp_replace(nw, function_re3, '(\1 IN (SELECT pms_my_properties(ARRAY[\2])))', 'g');
    end if;
    if nq is distinct from r.qual then execute format('alter policy %I on %I using (%s)', r.policyname, r.tablename, nq); end if;
    if nw is distinct from r.with_check then execute format('alter policy %I on %I with check (%s)', r.policyname, r.tablename, nw); end if;
  end loop;
end $$;

-- 8. Door codes and the SMS that carry them: front office only
drop policy if exists pms_stay_passcodes_read on pms_stay_passcodes;
create policy pms_stay_passcodes_read on pms_stay_passcodes for select
  using (property_id in (select pms_my_properties(array['owner','manager','front_desk'])));
drop policy if exists pms_sms_out_read on pms_sms_out;
create policy pms_sms_out_read on pms_sms_out for select
  using (property_id in (select pms_my_properties(array['owner','manager','front_desk'])));

-- ---------------------------------------------------------------------
-- 2 + 9. Property record: staff may edit the details, never the counters, dates or status
-- ---------------------------------------------------------------------
revoke select, insert, update, delete on pms_properties from authenticated;
grant select (id, name, code, group_name, address, phone, email, tin, vrn, currency, tax_rate, tax_inclusive,
              check_in_time, check_out_time, business_date, next_res_no, next_folio_no, created_at, next_receipt_no,
              next_bill_no, timezone, status, status_reason, features) on pms_properties to authenticated;
grant update (name, code, address, phone, email, tin, vrn, currency, tax_rate, tax_inclusive,
              check_in_time, check_out_time, timezone) on pms_properties to authenticated;

-- Currency is fixed once money has been posted
create or replace function pms__guard_property() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.currency is distinct from old.currency and not pms__is_service()
     and exists (select 1 from pms_folio_lines where property_id = new.id) then
    raise exception 'The currency cannot change after money has been posted';
  end if;
  if new.tax_rate is not null and (new.tax_rate < 0 or new.tax_rate > 100) then raise exception 'VAT must be between 0 and 100%%'; end if;
  return new;
end $$;
drop trigger if exists trg_guard_property on pms_properties;
create trigger trg_guard_property before update on pms_properties for each row execute function pms__guard_property();

-- ---------------------------------------------------------------------
-- 3. Settings that choose credentials or endpoints belong to platform administrators
-- ---------------------------------------------------------------------
create or replace function pms__protect_integration() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; keys text[] := array['code']; v_new text; v_old text;
begin
  if new.provider = 'channex' then keys := keys || array['property_id']; end if;
  if new.provider = 'fiscal' then keys := keys || array['url','key_header','key_prefix']; end if;
  if not (pms__is_service() or pms_is_super_admin()) then
    foreach k in array keys loop
      v_new := nullif(trim(new.config->>k), '');
      v_old := case when tg_op = 'UPDATE' then nullif(trim(old.config->>k), '') end;
      if v_new is distinct from v_old then
        raise exception 'Only a platform administrator can change "%" for %', k, new.provider;
      end if;
    end loop;
  end if;
  if new.provider = 'fiscal' and nullif(trim(new.config->>'url'), '') is not null and new.config->>'url' !~* '^https://' then
    raise exception 'The VFD endpoint must start with https://';
  end if;
  if new.provider = 'channex' and nullif(trim(new.config->>'property_id'), '') is not null and exists (
       select 1 from pms_integrations i where i.provider = 'channex' and i.property_id <> new.property_id
         and i.config->>'property_id' = new.config->>'property_id') then
    raise exception 'That Channex property is already connected to another property';
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_integration on pms_integrations;
create trigger trg_protect_integration before insert or update on pms_integrations for each row execute function pms__protect_integration();

-- Mapped ids must be this property's records; a lock or Channex id cannot be mapped in two properties
create or replace function pms__check_external_id() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_prop uuid; v_tbl text;
begin
  if new.entity = 'property' then
    v_prop := new.entity_id;
  else
    v_tbl := case new.entity when 'room' then 'pms_rooms' when 'room_type' then 'pms_room_types' when 'rate_plan' then 'pms_rate_plans' end;
    execute format('select property_id from %I where id = $1', v_tbl) into v_prop using new.entity_id;
  end if;
  if v_prop is distinct from new.property_id then raise exception 'That % belongs to another property', replace(new.entity, '_', ' '); end if;
  if new.provider in ('ttlock','channex') and exists (
       select 1 from pms_external_ids x where x.provider = new.provider and x.entity = new.entity
         and x.external_id = new.external_id and x.property_id <> new.property_id) then
    raise exception 'That % id is already used by another property', new.provider;
  end if;
  return new;
end $$;
drop trigger if exists trg_check_external_id on pms_external_ids;
create trigger trg_check_external_id before insert or update on pms_external_ids for each row execute function pms__check_external_id();

-- ---------------------------------------------------------------------
-- 4. Every reference to a property-owned row must stay inside the same property
-- ---------------------------------------------------------------------
create or replace function pms__same_property() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text; v_col text; v_tbl text; v_val text; v_prop uuid; j jsonb := to_jsonb(new); o jsonb;
begin
  if tg_op = 'UPDATE' then o := to_jsonb(old); end if;
  foreach a in array tg_argv loop
    v_col := split_part(a, ':', 1); v_tbl := split_part(a, ':', 2);
    v_val := j->>v_col;
    continue when v_val is null;
    continue when o is not null and o->>v_col is not distinct from v_val and o->>'property_id' is not distinct from j->>'property_id';
    execute format('select property_id from %I where id = $1', v_tbl) into v_prop using v_val::uuid;
    if v_prop is distinct from (j->>'property_id')::uuid then
      raise exception 'The % chosen belongs to another property', replace(regexp_replace(v_col, '_id$', ''), '_', ' ');
    end if;
  end loop;
  return new;
end $$;

-- One trigger per table, built from the foreign keys themselves
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass::text as tbl,
           array_agg(distinct a.attname || ':' || c.confrelid::regclass::text) as args
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
      and c.confrelid <> 'pms_properties'::regclass
      and exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'property_id' and not x.attisdropped)
      and exists (select 1 from pg_attribute x where x.attrelid = c.confrelid and x.attname = 'property_id' and not x.attisdropped)
    group by c.conrelid
  loop
    execute format('drop trigger if exists trg_same_property on %s', r.tbl);
    execute format('create trigger trg_same_property before insert or update on %s for each row execute function pms__same_property(%s)',
      r.tbl, (select string_agg(quote_literal(x), ', ') from unnest(r.args) x));
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. Lookups answer only for the caller's own properties
-- ---------------------------------------------------------------------
create or replace function pms_rate(p_room_type uuid, p_rate_plan uuid, p_date date)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare t pms_room_types;
begin
  select * into t from pms_room_types where id = p_room_type;
  if not found then return 0; end if;
  if not pms__can_see(t.property_id) then raise exception 'You are not a member of this property'; end if;
  return coalesce((select amount from pms_rates where room_type_id = p_room_type and rate_plan_id = p_rate_plan and rate_date = p_date),
                  t.base_rate, 0);
end $$;

create or replace function pms_fx_rate(p_property uuid, p_currency text, p_date date) returns numeric
language plpgsql stable security definer set search_path = public as $$
begin
  if not pms__can_see(p_property) then raise exception 'You are not a member of this property'; end if;
  return (select rate from pms_exchange_rates
          where property_id = p_property and currency = upper(p_currency) and effective_date <= p_date
          order by effective_date desc limit 1);
end $$;

create or replace function pms_type_availability(p_room_type uuid, p_date date)
returns integer language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid;
begin
  select property_id into v_prop from pms_room_types where id = p_room_type;
  if v_prop is null then return 0; end if;
  if not pms__can_see(v_prop) then raise exception 'You are not a member of this property'; end if;
  return (select count(*) from pms_rooms r where r.room_type_id = p_room_type and r.active)::int
       - (select count(*) from pms_stays s where s.room_type_id = p_room_type
            and s.status in ('tentative','confirmed','checked_in') and p_date >= s.arrival and p_date < s.departure)::int
       - (select count(*) from pms_maintenance_blocks b join pms_rooms r on r.id = b.room_id
            where r.room_type_id = p_room_type and b.status = 'active' and p_date >= b.from_date and p_date < b.to_date)::int;
end $$;

create or replace function pms_drawer_expected(p_session uuid) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare s pms_drawer_sessions;
begin
  select * into s from pms_drawer_sessions where id = p_session;
  if not found then return null; end if;
  if not pms__can_see(s.property_id) then raise exception 'You are not a member of this property'; end if;
  return s.opening_float
       - coalesce((select sum(l.amount) from pms_folio_lines l
                   where l.drawer_session_id = s.id and not l.voided and l.payment_method = 'cash'), 0)
       + coalesce((select sum(c.amount) * -1 from pms_city_ledger c
                   where c.entry_type = 'payment' and c.payment_method = 'cash' and c.reference = 'drawer:' || s.id::text), 0)
       + coalesce((select sum(b.total) from pms_pos_bills b
                   where b.drawer_session_id = s.id and b.status = 'settled' and b.payment_method = 'cash'), 0)
       - coalesce((select sum(e.amount) from pms_expense_vouchers e where e.drawer_session_id = s.id), 0);
end $$;

-- ---------------------------------------------------------------------
-- 6. Invites are only claimed by a confirmed email address
-- ---------------------------------------------------------------------
create or replace function pms_claim_invites() returns int
language plpgsql security definer set search_path = public as $$
declare v_user jsonb; v_email text; i pms_invites; n int := 0;
begin
  if auth.uid() is null then return 0; end if;
  select to_jsonb(u) into v_user from auth.users u where u.id = auth.uid();
  if v_user is null then return 0; end if;
  if v_user ? 'email_confirmed_at' and v_user->>'email_confirmed_at' is null then return 0; end if;
  v_email := lower(v_user->>'email');
  for i in select * from pms_invites where lower(email) = v_email and accepted_at is null loop
    insert into pms_members(property_id, user_id, role, display_name, active) values (i.property_id, auth.uid(), i.role, i.display_name, true)
    on conflict (property_id, user_id) do update set role = excluded.role, active = true;
    update pms_invites set accepted_at = now() where id = i.id;
    perform pms_log(i.property_id, 'member.join', 'member', auth.uid(), jsonb_build_object('email', v_email, 'role', i.role));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 7. Money and messaging rules
-- ---------------------------------------------------------------------
do $$ begin
  alter table pms_stays add constraint pms_stays_rate_nonneg check (rate >= 0) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table pms_stays add constraint pms_stays_guests_nonneg check (adults >= 0 and children >= 0) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table pms_drawer_sessions add constraint pms_drawer_float_nonneg check (opening_float >= 0) not valid;
exception when duplicate_object then null; end $$;

-- A day closed by the night audit stays closed: correct it with a discount or refund instead
create or replace function pms_void_line(p_line uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare l pms_folio_lines; f pms_folios; v_bd date;
begin
  select * into l from pms_folio_lines where id = p_line for update;
  if not found then raise exception 'Line not found'; end if;
  f := pms__open_folio(l.folio_id);
  perform pms_require(l.property_id, array['owner','manager']);
  if l.voided then raise exception 'Already voided'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  if l.payment_method = 'city_ledger' then raise exception 'City ledger transfers cannot be voided here'; end if;
  select business_date into v_bd from pms_properties where id = l.property_id;
  if l.business_date < v_bd then
    raise exception 'This line belongs to %, which is closed. Post a discount or refund instead.', to_char(l.business_date, 'DD Mon YYYY');
  end if;
  if l.drawer_session_id is not null and exists (
    select 1 from pms_drawer_sessions where id = l.drawer_session_id and status = 'closed') then
    raise exception 'This cash was counted in a closed drawer. Post a refund instead.';
  end if;
  update pms_folio_lines set voided = true, void_reason = p_reason, voided_by = auth.uid(), voided_at = now()
  where id = p_line;
  perform pms_log(l.property_id, 'folio.void', 'folio_line', p_line,
    jsonb_build_object('folio_no', f.folio_no, 'amount', l.amount, 'description', l.description, 'reason', p_reason));
end $$;

create or replace function pms_close_drawer(p_session uuid, p_counted numeric, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s pms_drawer_sessions; v_exp numeric;
begin
  select * into s from pms_drawer_sessions where id = p_session for update;
  if not found or s.status <> 'open' then raise exception 'Drawer is not open'; end if;
  perform pms_require(s.property_id);
  if s.user_id <> auth.uid() and pms_role(s.property_id) not in ('owner','manager') then
    raise exception 'Only the cashier or a manager can close this drawer';
  end if;
  if p_counted is null or p_counted < 0 then raise exception 'Enter the cash you counted'; end if;
  v_exp := pms_drawer_expected(p_session);
  update pms_drawer_sessions set status = 'closed', closed_at = now(), expected_cash = v_exp,
    counted_cash = p_counted, variance = p_counted - v_exp, notes = p_notes
  where id = p_session;
  perform pms_log(s.property_id, 'drawer.close', 'drawer', p_session,
    jsonb_build_object('expected', v_exp, 'counted', p_counted, 'variance', p_counted - v_exp));
  return jsonb_build_object('expected', v_exp, 'counted', p_counted, 'variance', p_counted - v_exp);
end $$;

-- Free-text SMS cost money: short, and a sensible hourly limit per property and per number
create or replace function pms_send_sms(p_property uuid, p_phone text, p_body text, p_stay uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_to text := pms__msisdn(p_phone);
begin
  perform pms_require(p_property, array['owner','manager','front_desk']);
  if not pms__integration_on(p_property, 'sms') then raise exception 'SMS is not switched on for this property'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Write a message'; end if;
  if length(trim(p_body)) > 480 then raise exception 'Keep messages under 480 characters (three SMS)'; end if;
  if v_to is null then raise exception 'Enter a mobile number such as 0713 000 111'; end if;
  if (select count(*) from pms_sms_out where property_id = p_property and kind = 'manual' and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'This property has sent 60 messages in the last hour. Try again later.';
  end if;
  if (select count(*) from pms_sms_out where property_id = p_property and to_phone = v_to and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'This number has had 5 messages in the last hour. Try again later.';
  end if;
  if p_stay is not null and not exists (select 1 from pms_stays where id = p_stay and property_id = p_property) then
    raise exception 'Stay not found';
  end if;
  v_id := pms__queue_sms(p_property, p_stay, 'manual', p_phone, trim(p_body));
  perform pms_log(p_property, 'sms.send', 'sms', v_id, jsonb_build_object('to', v_to));
  return v_id;
end $$;

-- Camera relays get their own keys (one per property), like POS tills
alter table pms_api_keys drop constraint if exists pms_api_keys_provider_check;
alter table pms_api_keys add constraint pms_api_keys_provider_check check (provider in ('tendaico','hikvision'));

create or replace function pms_create_api_key(p_property uuid, p_name text, p_provider text default 'tendaico')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_key text; v_id uuid;
begin
  perform pms_require(p_property, array['owner','manager']);
  if p_provider not in ('tendaico','hikvision') then raise exception 'Unknown key type %', p_provider; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the key a name, such as the outlet or till'; end if;
  if (select count(*) from pms_api_keys where property_id = p_property and revoked_at is null) >= 50 then
    raise exception 'This property already has 50 active keys. Revoke unused ones first.';
  end if;
  v_key := 'bmgpms_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into pms_api_keys(property_id, provider, name, prefix, key_hash, created_by)
  values (p_property, p_provider, left(trim(p_name), 80), left(v_key, 14), encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), auth.uid())
  returning id into v_id;
  perform pms_log(p_property, 'api_key.create', 'api_key', v_id, jsonb_build_object('name', p_name, 'provider', p_provider));
  return jsonb_build_object('id', v_id, 'key', v_key, 'prefix', left(v_key, 14));
end $$;

-- Lost phone: an administrator removes a person's authenticators so they can sign in and set it up again
create or replace function pms_admin_reset_mfa(p_email text) returns int
language plpgsql security definer set search_path = public as $$
declare v_user uuid; n int := 0;
begin
  perform pms__require_admin();
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then raise exception 'No account for %', p_email; end if;
  if to_regclass('auth.mfa_factors') is not null then
    begin
      execute 'delete from auth.mfa_factors where user_id = $1' using v_user;
      get diagnostics n = row_count;
    exception when insufficient_privilege then
      raise exception 'This database does not let the app remove authenticators. In Supabase open Authentication → Users → %, and remove the MFA factor there.', p_email;
    end;
  end if;
  insert into pms_audit_log(property_id, user_id, action, entity, entity_id, details)
  select m.property_id, auth.uid(), 'member.mfa_reset', 'member', v_user, jsonb_build_object('email', lower(trim(p_email)), 'factors', n)
  from pms_members m where m.user_id = v_user;
  return n;
end $$;

-- Whether the caller has turned on two-step sign-in (for the reminder on the control panel)
create or replace function pms_my_mfa_on() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v boolean := false;
begin
  if auth.uid() is null or to_regclass('auth.mfa_factors') is null then return false; end if;
  execute 'select exists (select 1 from auth.mfa_factors where user_id = $1 and status::text = ''verified'')' into v using auth.uid();
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Performance: an index behind every single-column foreign key
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass::text as tbl, a.attname as col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
      and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
  loop
    execute format('create index if not exists %I on %s (%I)', left('ix_' || r.tbl || '_' || r.col, 63), r.tbl, r.col);
  end loop;
end $$;
create index if not exists ix_pms_members_user_active on pms_members (user_id) where active;
create index if not exists ix_pms_audit_log_property_time on pms_audit_log (property_id, created_at desc);
create index if not exists ix_pms_sms_out_property_time on pms_sms_out (property_id, created_at desc);

-- ---------------------------------------------------------------------
-- Final sweep: internal helpers, service functions and triggers are never callable from the app
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like 'pms\_\_%' or p.proname like 'pms\_svc\_%' or p.proname in ('pms_log','pms_bootstrap_super_admin')
           or p.prorettype = 'trigger'::regtype)
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.fn);
  end loop;
end $$;
-- …and every app-facing pms_ function is granted to signed-in users explicitly (each checks roles itself)
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'pms\_%'
      and p.proname not like 'pms\_\_%' and p.proname not like 'pms\_svc\_%'
      and p.proname not in ('pms_log','pms_bootstrap_super_admin') and p.prorettype <> 'trigger'::regtype
  loop
    execute format('grant execute on function %s to authenticated', r.fn);
  end loop;
end $$;
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
revoke execute on all functions in schema public from public, anon;

notify pgrst, 'reload schema';
