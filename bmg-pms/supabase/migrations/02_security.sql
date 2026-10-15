-- module: access
-- also: core
-- =====================================================================
-- BMG PMS — 02 SECURITY: role helpers, row level security, grants
-- Reads are open to members of a property. Money, stays and audit
-- records can only be written through the functions in 03/04.
-- =====================================================================

create or replace function pms_role(p_property uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from pms_members
  where property_id = p_property and user_id = auth.uid() and active
$$;

create or replace function pms_is_member(p_property uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select pms_role(p_property) is not null
$$;

create or replace function pms_require(p_property uuid, p_roles text[] default null)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_role text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  v_role := pms_role(p_property);
  if v_role is null then raise exception 'You are not a member of this property'; end if;
  if p_roles is not null and not (v_role = any(p_roles)) then
    raise exception 'Your role (%) cannot perform this action', v_role;
  end if;
  return v_role;
end $$;

create or replace function pms_log(p_property uuid, p_action text, p_entity text, p_entity_id uuid, p_details jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into pms_audit_log(property_id, user_id, action, entity, entity_id, details)
  values (p_property, auth.uid(), p_action, p_entity, p_entity_id, p_details)
$$;

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'pms_room_types','pms_rooms','pms_rate_plans','pms_rates','pms_business_sources',
    'pms_companies','pms_guests','pms_reservations','pms_stays','pms_maintenance_blocks',
    'pms_drawer_sessions','pms_folios','pms_folio_lines','pms_city_ledger',
    'pms_expense_vouchers','pms_work_orders','pms_night_audits','pms_audit_log',
    'pms_integrations','pms_external_ids','pms_members'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (pms_is_member(property_id))', t || '_read', t);
  end loop;
end $$;

alter table pms_properties enable row level security;
drop policy if exists pms_properties_read on pms_properties;
create policy pms_properties_read on pms_properties for select using (pms_is_member(id));
drop policy if exists pms_properties_update on pms_properties;
create policy pms_properties_update on pms_properties for update
  using (pms_role(id) in ('owner','manager')) with check (pms_role(id) in ('owner','manager'));

-- Setup tables: owner and manager maintain them directly
do $$
declare t text;
begin
  foreach t in array array[
    'pms_room_types','pms_rooms','pms_rate_plans','pms_rates','pms_business_sources',
    'pms_companies','pms_integrations','pms_external_ids'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format($p$create policy %I on %I for all
      using (pms_role(property_id) in ('owner','manager'))
      with check (pms_role(property_id) in ('owner','manager'))$p$, t || '_write', t);
  end loop;
end $$;

-- Front desk may add and edit guests and companies' contact data via guests table
drop policy if exists pms_guests_insert on pms_guests;
create policy pms_guests_insert on pms_guests for insert
  with check (pms_role(property_id) in ('owner','manager','front_desk'));
drop policy if exists pms_guests_update on pms_guests;
create policy pms_guests_update on pms_guests for update
  using (pms_role(property_id) in ('owner','manager','front_desk'))
  with check (pms_role(property_id) in ('owner','manager','front_desk'));

-- Work orders: every member can raise and update them
drop policy if exists pms_work_orders_insert on pms_work_orders;
create policy pms_work_orders_insert on pms_work_orders for insert with check (pms_is_member(property_id));
drop policy if exists pms_work_orders_update on pms_work_orders;
create policy pms_work_orders_update on pms_work_orders for update
  using (pms_is_member(property_id)) with check (pms_is_member(property_id));

-- ---------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------
-- Stays cannot land on a room that is blocked for maintenance
create or replace function pms_trg_stay_vs_block() returns trigger
language plpgsql as $$
begin
  if new.room_id is not null and new.status in ('tentative','confirmed','checked_in') then
    if exists (
      select 1 from pms_maintenance_blocks b
      where b.room_id = new.room_id and b.status = 'active'
        and daterange(b.from_date, b.to_date) && daterange(new.arrival, new.departure)
    ) then
      raise exception 'Room is blocked for maintenance on those dates';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_stay_vs_block on pms_stays;
create trigger trg_stay_vs_block before insert or update on pms_stays
  for each row execute function pms_trg_stay_vs_block();

-- Blocks cannot be placed over live stays
create or replace function pms_trg_block_vs_stay() returns trigger
language plpgsql as $$
begin
  if new.status = 'active' and exists (
    select 1 from pms_stays s
    where s.room_id = new.room_id and s.status in ('tentative','confirmed','checked_in')
      and daterange(s.arrival, s.departure) && daterange(new.from_date, new.to_date)
  ) then
    raise exception 'Room has a reservation on those dates. Move the guest first.';
  end if;
  return new;
end $$;
drop trigger if exists trg_block_vs_stay on pms_maintenance_blocks;
create trigger trg_block_vs_stay before insert or update on pms_maintenance_blocks
  for each row execute function pms_trg_block_vs_stay();

-- Folio lines are append-only except for voiding
create or replace function pms_trg_lines_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Folio lines cannot be deleted. Void them instead.'; end if;
  if new.amount <> old.amount or new.folio_id <> old.folio_id or new.business_date <> old.business_date
     or old.voided then
    raise exception 'Folio lines cannot be edited. Void and re-post.';
  end if;
  return new;
end $$;
drop trigger if exists trg_lines_immutable on pms_folio_lines;
create trigger trg_lines_immutable before update or delete on pms_folio_lines
  for each row execute function pms_trg_lines_immutable();

-- ---------------------------------------------------------------------
-- Grants (RLS still applies)
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
