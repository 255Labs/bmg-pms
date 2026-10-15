-- module: core
-- also: back-office, integrations, operations, payments, platform, stock
-- 18 · Schema review: fixes and gaps found going through migrations 01–17 again
--
--  1. Dates: "today" defaults used the server's UTC date, which is yesterday in Dar es Salaam between
--     00:00 and 03:00. They now use the property's own time zone.
--  2. Money and rates: sign and range checks where a wrong value would corrupt reports
--     (base rates, credit limits, tax rate, commission, costs, exchange amounts).
--  3. Door codes: undoing a check-in left the guest's door code working. Any move out of "in house"
--     now revokes it.
--  4. Channex: maximum nights is now sent with the other restrictions.
--  5. Sign-in records are removed with the person's account.
--  6. New: undo check-in, undo check-out (same business day), merge duplicate guests, photos on
--     outlet items, and the abilities that control them.
-- Safe to re-run.

-- ---------------------------------------------------------------------
-- 1. Local dates
-- ---------------------------------------------------------------------
create or replace function pms__today(p_tz text default 'Africa/Dar_es_Salaam') returns date
language sql stable set search_path = public as $$
  select (now() at time zone coalesce(nullif(p_tz, ''), 'Africa/Dar_es_Salaam'))::date
$$;
alter table pms_properties alter column business_date set default pms__today();
alter table pms_lost_found alter column found_on set default pms__today();

-- Opening a property without a first business day: that property's own today, not UTC's
do $$
declare d text; n text;
begin
  for d in select pg_get_functiondef(p.oid) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'pms_admin_create_property' loop
    n := replace(d, $x$coalesce(nullif(p->>'business_date', '')::date, current_date)$x$,
                    $x$coalesce(nullif(p->>'business_date', '')::date, pms__today(p->>'timezone'))$x$);
    if n <> d then execute n; end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. Range checks (added NOT VALID so old rows never block the upgrade, then validated where clean)
-- ---------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select * from (values
    ('pms_room_types',        'pms_room_types_base_rate_nonneg',     'base_rate >= 0'),
    ('pms_companies',         'pms_companies_credit_nonneg',         'credit_limit is null or credit_limit >= 0'),
    ('pms_properties',        'pms_properties_tax_range',            'tax_rate >= 0 and tax_rate <= 100'),
    ('pms_business_sources',  'pms_sources_commission_range',        'commission_pct is null or (commission_pct >= 0 and commission_pct <= 100)'),
    ('pms_assets',            'pms_assets_cost_nonneg',              'cost is null or cost >= 0'),
    ('pms_stock_items',       'pms_stock_items_avg_cost_nonneg',     'avg_cost >= 0'),
    ('pms_stock_moves',       'pms_stock_moves_unit_cost_nonneg',    'unit_cost is null or unit_cost >= 0'),
    ('pms_folio_lines',       'pms_folio_lines_fx_rate_pos',         'fx_rate is null or fx_rate > 0'),
    ('pms_payment_requests',  'pms_payreq_collected_nonneg',         'collected_amount is null or collected_amount >= 0'),
    ('pms_drawer_sessions',   'pms_drawer_counted_nonneg',           'counted_cash is null or counted_cash >= 0'),
    ('pms_night_audits',      'pms_audit_occ_range',                 'occupancy_pct is null or (occupancy_pct >= 0 and occupancy_pct <= 100)')
  ) as t(tbl, name, expr) loop
    begin
      execute format('alter table %I add constraint %I check (%s) not valid', c.tbl, c.name, c.expr);
    exception when duplicate_object then null; when undefined_column then raise notice 'skip %: %', c.tbl, sqlerrm;
    end;
    begin
      execute format('alter table %I validate constraint %I', c.tbl, c.name);
    exception when others then raise notice 'Constraint % kept for new rows only: existing rows need fixing (%)', c.name, sqlerrm;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Door codes follow every move out of "in house" (undo check-in included)
-- ---------------------------------------------------------------------
create or replace function pms_trg_ttlock_stays() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not pms__integration_on(new.property_id, 'ttlock') then return null; end if;
  if new.status = 'checked_in' and (old.status <> 'checked_in' or new.room_id is distinct from old.room_id) then
    if old.status = 'checked_in' and new.room_id is distinct from old.room_id then
      perform pms__enqueue(new.property_id, 'ttlock', 'revoke_passcode', jsonb_build_object('stay_id', new.id, 'room_id', old.room_id));
    end if;
    perform pms__enqueue(new.property_id, 'ttlock', 'issue_passcode', jsonb_build_object('stay_id', new.id));
  elsif old.status = 'checked_in' and new.status <> 'checked_in' then
    perform pms__enqueue(new.property_id, 'ttlock', 'revoke_passcode', jsonb_build_object('stay_id', new.id));
  elsif new.status = 'checked_in' and new.departure <> old.departure then
    perform pms__enqueue(new.property_id, 'ttlock', 'extend_passcode', jsonb_build_object('stay_id', new.id), 'ttlock:extend:' || new.id);
  end if;
  return null;
end $$;

-- Early check-in is charged once per stay, even if the check-in is undone and done again
do $$
declare d text; n text;
begin
  for d in select pg_get_functiondef(p.oid) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'pms__early_checkin' loop
    n := replace(d, $x$  if new.arrival <> p.business_date then return null; end if;$x$,
                    $x$  if new.arrival <> p.business_date then return null; end if;
  if exists (select 1 from pms_folio_lines l where l.stay_id = new.id and l.sub_type = 'early_checkin' and not l.voided) then return null; end if;$x$);
    if n <> d and position('sub_type = ''early_checkin'' and not l.voided' in d) = 0 then execute n; end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Channex: maximum nights travels with the other restrictions
-- ---------------------------------------------------------------------
create or replace function pms_svc_ari_snapshot(p_property uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_avail jsonb; v_rates jsonb;
begin
  perform pms__require_service();
  select coalesce(jsonb_agg(jsonb_build_object('room_type_id', x.external_id, 'date', d::date,
      'availability', greatest(0, pms_type_availability(x.entity_id, d::date))) order by x.external_id, d), '[]'::jsonb)
    into v_avail
  from pms_external_ids x cross join generate_series(p_from, p_to - 1, interval '1 day') d
  where x.property_id = p_property and x.provider = 'channex' and x.entity = 'room_type';

  select coalesce(jsonb_agg(jsonb_build_object('rate_plan_id', m.channex_rate_plan_id, 'date', d::date,
      'rate', pms_rate(m.room_type_id, m.rate_plan_id, d::date),
      'min_stay', coalesce(r.min_stay, 1), 'max_stay', r.max_stay, 'stop_sell', coalesce(r.stop_sell, false),
      'cta', coalesce(r.cta, false), 'ctd', coalesce(r.ctd, false)) order by m.channex_rate_plan_id, d), '[]'::jsonb)
    into v_rates
  from pms_channex_rate_map m cross join generate_series(p_from, p_to - 1, interval '1 day') d
  left join pms_rate_restrictions r on r.room_type_id = m.room_type_id and r.rate_plan_id = m.rate_plan_id and r.rate_date = d::date
  where m.property_id = p_property;

  return jsonb_build_object('availability', v_avail, 'rates', v_rates);
end $$;

-- ---------------------------------------------------------------------
-- 5. Sign-in records go with the account
-- ---------------------------------------------------------------------
do $$ begin
  if to_regclass('auth.users') is not null then
    delete from pms_sign_ins s where not exists (select 1 from auth.users u where u.id = s.user_id);
    alter table pms_sign_ins add constraint pms_sign_ins_user_fk foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
exception when duplicate_object then null; end $$;
create index if not exists ix_sign_ins_user on pms_sign_ins (user_id, at desc);

-- ---------------------------------------------------------------------
-- 6a. Photos on outlet items and outlets (public property-media bucket, https only)
-- ---------------------------------------------------------------------
alter table pms_pos_items add column if not exists image_url text;
alter table pms_pos_outlets add column if not exists image_url text;
do $$ begin
  alter table pms_pos_items add constraint pms_pos_items_image_https check (image_url is null or (image_url ~* '^https://' and length(image_url) <= 600));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table pms_pos_outlets add constraint pms_pos_outlets_image_https check (image_url is null or (image_url ~* '^https://' and length(image_url) <= 600));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 6b. Undo check-in / undo check-out (same business day, ability-controlled)
-- ---------------------------------------------------------------------
alter table pms_stays add column if not exists planned_departure date;
-- remember the booked departure when check-out shortens a stay, so an undo can put it back
create or replace function pms__remember_departure() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status = 'checked_out' and old.status = 'checked_in' then new.planned_departure := old.departure; end if;
  return new;
end $$;
drop trigger if exists trg_remember_departure on pms_stays;
create trigger trg_remember_departure before update of status on pms_stays for each row execute function pms__remember_departure();

-- the three new abilities (res.merge_guests, fo.undo_checkin, fo.undo_checkout) are in the list in 17

create or replace function pms_undo_check_in(p_stay uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v pms_stays; v_bd date;
begin
  v := pms__stay(p_stay);
  perform pms_need(v.property_id, 'fo.undo_checkin');
  if v.status <> 'checked_in' then raise exception 'The guest is not checked in'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Say why the check-in is being undone'; end if;
  select business_date into v_bd from pms_properties where id = v.property_id;
  if v.arrival <> v_bd then raise exception 'Only a check-in from today (business day %) can be undone; a night has been audited since.', v_bd; end if;
  -- the automatic early check-in charge goes with it
  update pms_folio_lines set voided = true, void_reason = 'Check-in undone: ' || p_reason, voided_by = auth.uid(), voided_at = now()
  where stay_id = p_stay and sub_type = 'early_checkin' and not voided;
  update pms_stays set status = 'confirmed', checked_in_at = null where id = p_stay;
  perform pms__refresh_reservation(v.reservation_id);
  perform pms_log(v.property_id, 'stay.undo_check_in', 'stay', p_stay, jsonb_build_object('reason', p_reason, 'room_id', v.room_id));
end $$;

create or replace function pms_undo_check_out(p_stay uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v pms_stays; v_bd date;
begin
  v := pms__stay(p_stay);
  perform pms_need(v.property_id, 'fo.undo_checkout');
  if v.status <> 'checked_out' then raise exception 'The guest is not checked out'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Say why the check-out is being undone'; end if;
  select business_date into v_bd from pms_properties where id = v.property_id;
  if v.checked_out_at is null or exists (select 1 from pms_night_audits a where a.property_id = v.property_id and a.business_date >= v.departure and a.business_date < v_bd)
     or v.departure < v_bd then
    raise exception 'Only a check-out from today can be undone';
  end if;
  if exists (select 1 from pms_folio_lines l join pms_folios f on f.id = l.folio_id
             where f.stay_id = p_stay and l.payment_method = 'city_ledger' and not l.voided and l.business_date = v_bd) then
    raise exception 'The balance was moved to the city ledger at check-out. Reverse that first.';
  end if;
  -- the room must still be free for the rest of the booked stay (the no-double-booking rule checks it too)
  update pms_stays set status = 'checked_in', checked_out_at = null,
    departure = greatest(coalesce(planned_departure, departure), v_bd + 1), planned_departure = null
  where id = p_stay;
  update pms_folios set status = 'open', closed_at = null
  where stay_id = p_stay and status = 'closed' and closed_at >= v.checked_out_at - interval '5 minutes';
  perform pms__refresh_reservation(v.reservation_id);
  perform pms_log(v.property_id, 'stay.undo_check_out', 'stay', p_stay, jsonb_build_object('reason', p_reason, 'room_id', v.room_id));
exception when exclusion_violation then
  raise exception 'Room is already booked by someone else for those nights. Move this guest first.';
end $$;

-- ---------------------------------------------------------------------
-- 6c. Merge duplicate guest profiles (eZee "consolidate")
-- ---------------------------------------------------------------------
create or replace function pms_merge_guests(p_keep uuid, p_drop uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k pms_guests; d pms_guests; n_res int; n_fol int;
begin
  if p_keep = p_drop then raise exception 'Choose two different guests'; end if;
  select * into k from pms_guests where id = p_keep for update;
  select * into d from pms_guests where id = p_drop for update;
  if k.id is null or d.id is null then raise exception 'Guest not found'; end if;
  if k.property_id <> d.property_id then raise exception 'Both guests must belong to the same property'; end if;
  perform pms_need(k.property_id, 'res.merge_guests');
  update pms_reservations set guest_id = p_keep where guest_id = p_drop;
  get diagnostics n_res = row_count;
  update pms_folios set guest_id = p_keep where guest_id = p_drop;
  get diagnostics n_fol = row_count;
  update pms_attachments set guest_id = p_keep where guest_id = p_drop;
  -- fill gaps on the kept profile from the other one; tags join up; notes are kept side by side
  update pms_guests set
    phone = coalesce(nullif(phone, ''), d.phone), email = coalesce(nullif(email, ''), d.email),
    id_type = coalesce(nullif(id_type, ''), d.id_type), id_number = coalesce(nullif(id_number, ''), d.id_number),
    nationality = coalesce(nullif(nationality, ''), d.nationality), date_of_birth = coalesce(date_of_birth, d.date_of_birth),
    gender = coalesce(nullif(gender, ''), d.gender), title = coalesce(nullif(title, ''), d.title),
    attributes = (select coalesce(array_agg(distinct a), '{}') from unnest(coalesce(attributes, '{}') || coalesce(d.attributes, '{}')) a),
    blacklisted = blacklisted or d.blacklisted, blacklist_reason = coalesce(blacklist_reason, d.blacklist_reason),
    notes = nullif(concat_ws(E'\n', nullif(notes, ''), nullif(d.notes, '')), '')
  where id = p_keep;
  delete from pms_guests where id = p_drop;
  perform pms_log(k.property_id, 'guest.merge', 'guest', p_keep,
    jsonb_build_object('merged', pms__guest_name(d), 'reservations', n_res, 'folios', n_fol));
  return jsonb_build_object('reservations', n_res, 'folios', n_fol);
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as fn from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname not like 'pms\_public\_%' loop
    execute format('revoke execute on function %s from public, anon', r.fn);
  end loop;
end $$;
revoke execute on function pms__today(text), pms__remember_departure() from authenticated;
grant execute on function pms_undo_check_in(uuid, text), pms_undo_check_out(uuid, text), pms_merge_guests(uuid, uuid) to authenticated;
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';
