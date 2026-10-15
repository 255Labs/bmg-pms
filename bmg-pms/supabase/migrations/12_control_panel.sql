-- module: platform
-- also: access, core, front-office, integrations, reports
-- =====================================================================
-- BMG PMS 12 — super admin control panel.
--   Platform admins see and manage every property: create (optionally copying
--   another property's setup), suspend, switch modules on or off, set the
--   go-live business date, and manage people across properties. Staff can be
--   invited by email before they have an account; the invite is claimed when
--   they first sign in.
-- First admin (run once in the SQL Editor, after that person has signed up):
--   select pms_bootstrap_super_admin('you@bmggroup.co.tz');
-- Safe to re-run. Run after 11.
-- =====================================================================

create table if not exists pms_platform_admins (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  added_by  uuid,
  added_at  timestamptz not null default now()
);

create or replace function pms_is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pms_platform_admins where user_id = auth.uid())
$$;

create or replace function pms__require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not pms_is_super_admin() then raise exception 'Only a platform administrator can do this'; end if;
end $$;

-- Only from the SQL Editor (database owner) or the service role: makes the first administrator
create or replace function pms_bootstrap_super_admin(p_email text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not pms__is_service() then raise exception 'Run this from the Supabase SQL Editor'; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then raise exception 'No account for %. Sign up in the app first.', p_email; end if;
  insert into pms_platform_admins(user_id) values (v_user) on conflict do nothing;
  return v_user;
end $$;

-- Self-service property creation closes once an administrator exists
create or replace function pms_create_property(
  p_name text, p_code text default null, p_display_name text default null,
  p_room_setup jsonb default '[]'::jsonb, p_tax_inclusive boolean default true
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_rt jsonb; v_type uuid; v_room text; v_i int := 0;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  -- once a platform administrator exists, only administrators open new properties (from the control panel)
  if exists (select 1 from pms_platform_admins) and not pms_is_super_admin() then
    raise exception 'New properties are opened by your platform administrator';
  end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Property name is required'; end if;

  insert into pms_properties(name, code, tax_inclusive)
  values (trim(p_name), nullif(upper(trim(p_code)),''), p_tax_inclusive) returning id into v_id;

  insert into pms_members(property_id, user_id, role, display_name)
  values (v_id, auth.uid(), 'owner', p_display_name);

  insert into pms_rate_plans(property_id, name, meal_plan) values
    (v_id, 'Room Only', 'RO'), (v_id, 'Bed & Breakfast', 'BB');

  insert into pms_business_sources(property_id, name, kind) values
    (v_id,'Walk-in','walk_in'), (v_id,'Direct / Phone','direct'), (v_id,'Website','direct'),
    (v_id,'Booking.com','ota'), (v_id,'Expedia','ota'), (v_id,'Airbnb','ota'),
    (v_id,'Travel Agent','travel_agent'), (v_id,'Corporate','company');

  for v_rt in select * from jsonb_array_elements(coalesce(p_room_setup,'[]'::jsonb)) loop
    v_i := v_i + 1;
    insert into pms_room_types(property_id, name, code, base_rate, max_occupancy, sort_order)
    values (v_id, v_rt->>'name', v_rt->>'code', coalesce((v_rt->>'base_rate')::numeric,0),
            coalesce((v_rt->>'max_occupancy')::int,2), v_i)
    returning id into v_type;
    for v_room in select jsonb_array_elements_text(coalesce(v_rt->'rooms','[]'::jsonb)) loop
      insert into pms_rooms(property_id, room_type_id, number) values (v_id, v_type, trim(v_room));
    end loop;
  end loop;

  perform pms_log(v_id, 'property.create', 'property', v_id, jsonb_build_object('name', p_name));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Property status and modules
-- ---------------------------------------------------------------------
alter table pms_properties add column if not exists status text not null default 'active';
alter table pms_properties drop constraint if exists pms_properties_status_check;
alter table pms_properties add constraint pms_properties_status_check check (status in ('active','suspended'));
alter table pms_properties add column if not exists status_reason text;
alter table pms_properties add column if not exists features jsonb not null default '{}';
alter table pms_properties add column if not exists admin_notes text;

-- A suspended property is closed to its staff (platform admins still get in)
create or replace function pms_role(p_property uuid)
returns text language sql stable security definer set search_path = public as $$
  select m.role from pms_members m join pms_properties p on p.id = m.property_id
  where m.property_id = p_property and m.user_id = auth.uid() and m.active
    and (p.status = 'active' or exists (select 1 from pms_platform_admins a where a.user_id = auth.uid()))
$$;

-- ...and its integrations stop
create or replace function pms_svc_enabled(p_provider text)
returns table(property_id uuid, property_name text, timezone text, currency text, config jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_service();
  return query select p.id, p.name, p.timezone, p.currency, i.config
    from pms_integrations i join pms_properties p on p.id = i.property_id
    where i.provider = p_provider and i.enabled and p.status = 'active';
end $$;

-- The property switcher lists only properties the person can open
create or replace function pms_group_snapshot()
returns table(property_id uuid, property text, role text, business_date date, rooms int, in_house int,
              arrivals int, departures int, occupancy_pct numeric, revenue_last_audit numeric,
              open_balance numeric, dirty_rooms int)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, m.role, p.business_date,
    (select count(*) from pms_rooms r where r.property_id = p.id and r.active)::int,
    (select count(*) from pms_stays s where s.property_id = p.id and s.status = 'checked_in')::int,
    (select count(*) from pms_stays s where s.property_id = p.id and s.arrival = p.business_date
       and s.status in ('confirmed','tentative'))::int,
    (select count(*) from pms_stays s where s.property_id = p.id and s.departure = p.business_date
       and s.status = 'checked_in')::int,
    coalesce((select na.occupancy_pct from pms_night_audits na where na.property_id = p.id
       order by na.business_date desc limit 1), 0),
    coalesce((select na.room_revenue + na.tax_revenue + na.other_revenue from pms_night_audits na
       where na.property_id = p.id order by na.business_date desc limit 1), 0),
    coalesce((select sum(b.balance) from pms_folio_balances b join pms_folios f on f.id = b.folio_id
       where f.property_id = p.id and f.status = 'open'), 0),
    (select count(*) from pms_rooms r where r.property_id = p.id and r.hk_status = 'dirty')::int
  from pms_properties p join pms_members m on m.property_id = p.id
  where m.user_id = auth.uid() and m.active and (p.status = 'active' or pms_is_super_admin())
  order by p.name
$$;

-- ---------------------------------------------------------------------
-- Invites: add people by email before they have an account
-- ---------------------------------------------------------------------
create table if not exists pms_invites (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  email         text not null,
  role          text not null check (role in ('owner','manager','front_desk','accountant','housekeeping','storekeeper')),
  display_name  text,
  invited_by    uuid,
  created_at    timestamptz not null default now(),
  accepted_at   timestamptz
);
create unique index if not exists uq_pms_invites_open on pms_invites(property_id, lower(email)) where accepted_at is null;

-- Owners (for their property) and platform admins (anywhere): add someone, or invite them if they have no account yet
create or replace function pms_add_or_invite_member(p_property uuid, p_email text, p_role text, p_display_name text default null, p_active boolean default true)
returns text
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not pms_is_super_admin() then perform pms_require(p_property, array['owner']); end if;
  if not exists (select 1 from pms_properties where id = p_property) then raise exception 'Property not found'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if p_role not in ('owner','manager','front_desk','accountant','housekeeping','storekeeper') then raise exception 'Unknown role %', p_role; end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is null then
    insert into pms_invites(property_id, email, role, display_name, invited_by) values (p_property, v_email, p_role, p_display_name, auth.uid())
    on conflict (property_id, lower(email)) where accepted_at is null do update set role = excluded.role, display_name = coalesce(excluded.display_name, pms_invites.display_name);
    perform pms_log(p_property, 'member.invite', 'property', p_property, jsonb_build_object('email', v_email, 'role', p_role));
    return 'invited';
  end if;
  if v_user = auth.uid() and (p_role <> 'owner' or not p_active) and not pms_is_super_admin() then
    raise exception 'You cannot demote or deactivate yourself';
  end if;
  insert into pms_members(property_id, user_id, role, display_name, active) values (p_property, v_user, p_role, p_display_name, p_active)
  on conflict (property_id, user_id) do update set role = excluded.role, display_name = coalesce(excluded.display_name, pms_members.display_name), active = excluded.active;
  perform pms_log(p_property, 'member.set', 'member', v_user, jsonb_build_object('email', v_email, 'role', p_role, 'active', p_active));
  return case when p_active then 'added' else 'deactivated' end;
end $$;

create or replace function pms_cancel_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i pms_invites;
begin
  select * into i from pms_invites where id = p_invite;
  if not found then raise exception 'Invite not found'; end if;
  if not pms_is_super_admin() then perform pms_require(i.property_id, array['owner']); end if;
  delete from pms_invites where id = p_invite and accepted_at is null;
end $$;

-- Called by the app after sign-in: turns open invites for this email into memberships
create or replace function pms_claim_invites() returns int
language plpgsql security definer set search_path = public as $$
declare v_email text; i pms_invites; n int := 0;
begin
  if auth.uid() is null then return 0; end if;
  select lower(email) into v_email from auth.users where id = auth.uid();
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
-- Control panel: overview, create, update, people, activity
-- ---------------------------------------------------------------------
create or replace function pms_admin_overview()
returns table(property_id uuid, name text, code text, group_name text, status text, status_reason text, features jsonb,
              business_date date, created_at timestamptz, rooms int, members int, owners text, pending_invites int,
              in_house int, occupancy_pct numeric, open_balance numeric, last_audit date, last_activity timestamptz,
              failed_jobs int, integrations_on int, admin_notes text, currency text, timezone text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_admin();
  return query
    select p.id, p.name, p.code, p.group_name, p.status, p.status_reason, p.features, p.business_date, p.created_at,
      (select count(*) from pms_rooms r where r.property_id = p.id and r.active)::int,
      (select count(*) from pms_members m where m.property_id = p.id and m.active)::int,
      (select string_agg(u.email::text, ', ' order by u.email) from pms_members m join auth.users u on u.id = m.user_id
        where m.property_id = p.id and m.role = 'owner' and m.active),
      (select count(*) from pms_invites i where i.property_id = p.id and i.accepted_at is null)::int,
      (select count(*) from pms_stays s where s.property_id = p.id and s.status = 'checked_in')::int,
      case when (select count(*) from pms_rooms r where r.property_id = p.id and r.active) > 0 then
        round((select count(*) from pms_stays s where s.property_id = p.id and s.status = 'checked_in') * 100.0
              / (select count(*) from pms_rooms r where r.property_id = p.id and r.active), 1) else 0 end,
      coalesce((select sum(greatest(b.balance, 0)) from pms_folio_balances b join pms_folios f on f.id = b.folio_id where f.property_id = p.id and f.status = 'open'), 0),
      (select max(na.business_date) from pms_night_audits na where na.property_id = p.id),
      (select max(a.created_at) from pms_audit_log a where a.property_id = p.id),
      (select count(*) from pms_jobs j where j.property_id = p.id and j.status = 'failed')::int,
      (select count(*) from pms_integrations i where i.property_id = p.id and i.enabled)::int,
      p.admin_notes, p.currency, p.timezone
    from pms_properties p order by p.status, p.name;
end $$;

-- p: { name, code, group_name, currency, timezone, tax_rate, tax_inclusive, check_in_time, check_out_time,
--      address, phone, email, tin, vrn, business_date, features, admin_notes,
--      room_types: [{ name, code, base_rate, max_occupancy, rooms: ['301','302'] }],
--      copy_from: <property id>, owner_email, owner_name, add_me: true|false }
create or replace function pms_admin_create_property(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_src uuid := nullif(p->>'copy_from', '')::uuid; rt jsonb; v_type uuid; v_room text; v_i int := 0;
        v_owner text; v_rooms int := 0; m record; v_map jsonb := '{}'; v_old uuid; v_new uuid;
begin
  perform pms__require_admin();
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Property name is required'; end if;
  if nullif(trim(p->>'code'), '') is not null and exists (select 1 from pms_properties where code = upper(trim(p->>'code'))) then
    raise exception 'Code % is already used by another property', upper(trim(p->>'code'));
  end if;
  if v_src is not null and not exists (select 1 from pms_properties where id = v_src) then raise exception 'The property to copy from was not found'; end if;

  insert into pms_properties(name, code, group_name, currency, timezone, tax_rate, tax_inclusive, check_in_time, check_out_time,
                             address, phone, email, tin, vrn, business_date, features, admin_notes)
  values (trim(p->>'name'), nullif(upper(trim(coalesce(p->>'code', ''))), ''),
          coalesce(nullif(trim(p->>'group_name'), ''), 'BMG Group International Limited'),
          coalesce(nullif(upper(trim(p->>'currency')), ''), 'TZS'), coalesce(nullif(p->>'timezone', ''), 'Africa/Dar_es_Salaam'),
          coalesce(nullif(p->>'tax_rate', '')::numeric, 18), coalesce((p->>'tax_inclusive')::boolean, true),
          coalesce(nullif(p->>'check_in_time', '')::time, '14:00'), coalesce(nullif(p->>'check_out_time', '')::time, '10:00'),
          nullif(p->>'address', ''), nullif(p->>'phone', ''), nullif(p->>'email', ''), nullif(p->>'tin', ''), nullif(p->>'vrn', ''),
          coalesce(nullif(p->>'business_date', '')::date, current_date), coalesce(p->'features', '{}'), nullif(p->>'admin_notes', ''))
  returning id into v_id;

  -- rooms
  for rt in select * from jsonb_array_elements(coalesce(p->'room_types', '[]')) loop
    continue when coalesce(trim(rt->>'name'), '') = '';
    v_i := v_i + 1;
    insert into pms_room_types(property_id, name, code, base_rate, max_occupancy, sort_order)
    values (v_id, trim(rt->>'name'), nullif(trim(coalesce(rt->>'code', '')), ''), coalesce(nullif(rt->>'base_rate', '')::numeric, 0),
            coalesce(nullif(rt->>'max_occupancy', '')::int, 2), v_i)
    returning id into v_type;
    for v_room in select distinct trim(x) from jsonb_array_elements_text(coalesce(rt->'rooms', '[]')) x where trim(x) <> '' loop
      if exists (select 1 from pms_rooms where property_id = v_id and number = v_room) then raise exception 'Room % is listed twice', v_room; end if;
      insert into pms_rooms(property_id, room_type_id, number) values (v_id, v_type, v_room);
      v_rooms := v_rooms + 1;
    end loop;
  end loop;

  if v_src is null then
    insert into pms_rate_plans(property_id, name, meal_plan) values (v_id, 'Room Only', 'RO'), (v_id, 'Bed & Breakfast', 'BB');
    insert into pms_business_sources(property_id, name, kind) values
      (v_id,'Walk-in','walk_in'), (v_id,'Direct / Phone','direct'), (v_id,'Website','direct'),
      (v_id,'Booking.com','ota'), (v_id,'Expedia','ota'), (v_id,'Airbnb','ota'),
      (v_id,'Travel Agent','travel_agent'), (v_id,'Corporate','company');
  else
    -- copy the setup that is the same from hotel to hotel; nothing guest- or money-related
    insert into pms_rate_plans(property_id, name, meal_plan, active) select v_id, name, meal_plan, active from pms_rate_plans where property_id = v_src;
    insert into pms_business_sources(property_id, name, kind, commission_pct, active) select v_id, name, kind, commission_pct, active from pms_business_sources where property_id = v_src;
    insert into pms_asset_types(property_id, name, category, replacement_cost, active) select v_id, name, category, replacement_cost, active from pms_asset_types where property_id = v_src;
    insert into pms_stock_locations(property_id, name, kind, active) select v_id, name, kind, active from pms_stock_locations where property_id = v_src;
    insert into pms_stock_items(property_id, name, unit, category, reorder_level, active) select v_id, name, unit, category, reorder_level, active from pms_stock_items where property_id = v_src;
    for m in select * from pms_pos_outlets where property_id = v_src loop
      insert into pms_pos_outlets(property_id, name, charge_category, outlet_type, active, stock_location_id)
      values (v_id, m.name, m.charge_category, m.outlet_type, m.active,
              (select l2.id from pms_stock_locations l1 join pms_stock_locations l2 on l2.property_id = v_id and l2.name = l1.name where l1.id = m.stock_location_id))
      returning id into v_new;
      for v_old in select id from pms_pos_items where outlet_id = m.id loop
        -- activity settings (14_activities) come along: timers, memberships, tables and courts
        insert into pms_pos_items(property_id, outlet_id, name, group_name, price, active, sort_order,
                                  item_type, duration_minutes, min_units, grace_minutes, resources, validity_days, visits_included)
        select v_id, v_new, name, group_name, price, active, sort_order,
               item_type, duration_minutes, min_units, grace_minutes, resources, validity_days, visits_included
        from pms_pos_items where id = v_old returning id into v_type;
        insert into pms_recipe_lines(property_id, pos_item_id, stock_item_id, qty)
        select v_id, v_type, s2.id, rl.qty from pms_recipe_lines rl join pms_stock_items s1 on s1.id = rl.stock_item_id
          join pms_stock_items s2 on s2.property_id = v_id and s2.name = s1.name where rl.pos_item_id = v_old;
      end loop;
    end loop;
    update pms_properties set features = coalesce(nullif(p->'features', '{}'::jsonb), (select features from pms_properties where id = v_src)) where id = v_id;
  end if;

  if coalesce((p->>'add_me')::boolean, false) then
    insert into pms_members(property_id, user_id, role) values (v_id, auth.uid(), 'owner') on conflict do nothing;
  end if;
  if nullif(trim(p->>'owner_email'), '') is not null then
    v_owner := pms_add_or_invite_member(v_id, p->>'owner_email', 'owner', nullif(p->>'owner_name', ''));
  end if;

  perform pms_log(v_id, 'property.create', 'property', v_id, jsonb_build_object('name', p->>'name', 'by', 'control panel', 'copied_from', v_src, 'rooms', v_rooms));
  return jsonb_build_object('property_id', v_id, 'rooms', v_rooms, 'owner', v_owner);
end $$;

-- Patch: name, code, group_name, status, status_reason, features, admin_notes
create or replace function pms_admin_update_property(p_property uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare old pms_properties;
begin
  perform pms__require_admin();
  select * into old from pms_properties where id = p_property for update;
  if not found then raise exception 'Property not found'; end if;
  if p ? 'status' and p->>'status' = 'suspended' and coalesce(trim(p->>'status_reason'), '') = '' then
    raise exception 'Give a reason for suspending the property';
  end if;
  if p ? 'code' and nullif(trim(p->>'code'), '') is not null and exists (select 1 from pms_properties where code = upper(trim(p->>'code')) and id <> p_property) then
    raise exception 'Code % is already used by another property', upper(trim(p->>'code'));
  end if;
  update pms_properties set
    name = case when p ? 'name' then coalesce(nullif(trim(p->>'name'), ''), name) else name end,
    code = case when p ? 'code' then nullif(upper(trim(coalesce(p->>'code', ''))), '') else code end,
    group_name = case when p ? 'group_name' then coalesce(nullif(trim(p->>'group_name'), ''), group_name) else group_name end,
    status = coalesce(p->>'status', status),
    status_reason = case when p ? 'status' then (case when p->>'status' = 'active' then null else p->>'status_reason' end) else status_reason end,
    features = case when p ? 'features' then p->'features' else features end,
    admin_notes = case when p ? 'admin_notes' then nullif(p->>'admin_notes', '') else admin_notes end
  where id = p_property;
  perform pms_log(p_property, 'property.admin_update', 'property', p_property, p);
end $$;

-- Go-live date: only before anything has been posted
create or replace function pms_admin_set_business_date(p_property uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_admin();
  if exists (select 1 from pms_night_audits where property_id = p_property) or exists (select 1 from pms_folio_lines where property_id = p_property) then
    raise exception 'The business date can only be set before the first posting. After that, only the night audit moves it.';
  end if;
  update pms_properties set business_date = p_date where id = p_property;
  perform pms_log(p_property, 'property.business_date', 'property', p_property, jsonb_build_object('date', p_date));
end $$;

-- Give yourself owner access to a property (logged), to work inside it
create or replace function pms_admin_join_property(p_property uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_admin();
  insert into pms_members(property_id, user_id, role, active) values (p_property, auth.uid(), 'owner', true)
  on conflict (property_id, user_id) do update set role = 'owner', active = true;
  perform pms_log(p_property, 'member.admin_join', 'member', auth.uid(), null);
end $$;

create or replace function pms_admin_people()
returns table(kind text, id uuid, property_id uuid, property text, email text, display_name text, role text, active boolean,
              last_sign_in timestamptz, since timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_admin();
  return query
    select 'member'::text, m.user_id, p.id, p.name, u.email::text, m.display_name, m.role, m.active, u.last_sign_in_at, u.created_at
      from pms_members m join pms_properties p on p.id = m.property_id join auth.users u on u.id = m.user_id
    union all
    select 'invite', i.id, p.id, p.name, i.email, i.display_name, i.role, true, null::timestamptz, i.created_at
      from pms_invites i join pms_properties p on p.id = i.property_id where i.accepted_at is null
    order by 4, 5;
end $$;

create or replace function pms_admin_activity(p_limit int default 200, p_property uuid default null)
returns table(created_at timestamptz, property text, email text, action text, entity text, details jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_admin();
  return query
    select a.created_at, p.name, u.email::text, a.action, a.entity, a.details
      from pms_audit_log a left join pms_properties p on p.id = a.property_id left join auth.users u on u.id = a.user_id
     where p_property is null or a.property_id = p_property
     order by a.created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end $$;

create or replace function pms_admin_list_admins() returns table(user_id uuid, email text, added_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_admin();
  return query select a.user_id, u.email::text, a.added_at from pms_platform_admins a join auth.users u on u.id = a.user_id order by u.email;
end $$;

create or replace function pms_admin_set_admin(p_email text, p_admin boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  perform pms__require_admin();
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then raise exception 'No account for %. They must sign up first.', p_email; end if;
  if p_admin then
    insert into pms_platform_admins(user_id, added_by) values (v_user, auth.uid()) on conflict do nothing;
  else
    if v_user = auth.uid() then raise exception 'You cannot remove yourself; ask another administrator'; end if;
    delete from pms_platform_admins where user_id = v_user;
  end if;
  insert into pms_audit_log(property_id, user_id, action, entity, entity_id, details)
  values (null, auth.uid(), case when p_admin then 'admin.add' else 'admin.remove' end, 'user', v_user, jsonb_build_object('email', p_email));
end $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
alter table pms_platform_admins enable row level security;
revoke all on pms_platform_admins from authenticated, anon;
alter table pms_invites enable row level security;
drop policy if exists pms_invites_read on pms_invites;
create policy pms_invites_read on pms_invites for select using (pms_role(property_id) = 'owner' or pms_is_super_admin());
revoke all on pms_invites from authenticated, anon;
grant select on pms_invites to authenticated;

revoke execute on function pms_bootstrap_super_admin(text) from public, authenticated, anon;
revoke execute on function pms__require_admin() from public, authenticated, anon;
grant execute on function pms_is_super_admin() to authenticated;
grant execute on function pms_add_or_invite_member(uuid, text, text, text, boolean) to authenticated;
grant execute on function pms_cancel_invite(uuid) to authenticated;
grant execute on function pms_claim_invites() to authenticated;
grant execute on function pms_admin_overview() to authenticated;
grant execute on function pms_admin_create_property(jsonb) to authenticated;
grant execute on function pms_admin_update_property(uuid, jsonb) to authenticated;
grant execute on function pms_admin_set_business_date(uuid, date) to authenticated;
grant execute on function pms_admin_join_property(uuid) to authenticated;
grant execute on function pms_admin_people() to authenticated;
grant execute on function pms_admin_activity(int, uuid) to authenticated;
grant execute on function pms_admin_list_admins() to authenticated;
grant execute on function pms_admin_set_admin(text, boolean) to authenticated;
grant execute on function pms_group_snapshot() to authenticated;
grant execute on function pms_role(uuid) to authenticated;
grant execute on function pms_is_member(uuid) to authenticated;
revoke execute on function pms_svc_enabled(text) from public, authenticated, anon;
do $$ begin execute 'grant execute on function pms_svc_enabled(text) to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';
