-- module: operations
-- also: access, back-office, cashiering, core, front-office, integrations, night-audit, platform, reports
-- =====================================================================
-- BMG PMS · 15 · Hotel profile, configuration lists, rate grid, folio operations,
--                POS for in-house guests, users and devices, notifications, booking engine
-- The eZee Absolute screens this matches: Hotel Profile (profile, highlights, amenities, photos,
-- policies), Room Type / Rate Type / Rate Plan / Tax, Settings (payment, extra charge, discount,
-- currency, transport, payouts, meal plan, remark, market segment, booking source, holidays,
-- reservation type, guest attributes), General Settings, Notifications, Documents, Booking Engine,
-- Users (roles, blocked, device activity, user activity, MFA), Rates grid (inventory, rates, extra
-- adult/child, min/max nights, stop sell, COA, COD), Folio (adjustment, room charge sub types,
-- transfer, split, cut, upload files, meal plan), Audit trail with IP.
-- Safe to re-run. Run after 14.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Hotel profile and settings
-- ---------------------------------------------------------------------
alter table pms_properties add column if not exists property_type text;
alter table pms_properties add column if not exists star_rating text;
alter table pms_properties add column if not exists website text;
alter table pms_properties add column if not exists fax text;
alter table pms_properties add column if not exists reservation_phone text;
alter table pms_properties add column if not exists reg_numbers jsonb not null default '{}'::jsonb;
alter table pms_properties add column if not exists address_line2 text;
alter table pms_properties add column if not exists city text;
alter table pms_properties add column if not exists region text;
alter table pms_properties add column if not exists postal_code text;
alter table pms_properties add column if not exists country text not null default 'Tanzania';
alter table pms_properties add column if not exists latitude numeric(9,6);
alter table pms_properties add column if not exists longitude numeric(9,6);
alter table pms_properties add column if not exists logo_url text;
alter table pms_properties add column if not exists highlights text[] not null default '{}';
alter table pms_properties add column if not exists amenities text[] not null default '{}';
alter table pms_properties add column if not exists policies jsonb not null default '{}'::jsonb;
alter table pms_properties add column if not exists settings jsonb not null default '{}'::jsonb;

grant select (property_type, star_rating, website, fax, reservation_phone, reg_numbers, address_line2, city, region, postal_code,
              country, latitude, longitude, logo_url, highlights, amenities, policies, settings) on pms_properties to authenticated;
grant update (property_type, star_rating, website, fax, reservation_phone, reg_numbers, address_line2, city, region, postal_code,
              country, latitude, longitude, logo_url, highlights, amenities, policies, settings) on pms_properties to authenticated;

-- A setting with its default: pms__setting(property, 'early_checkin', 'auto_post') etc.
create or replace function pms__setting(p_property uuid, variadic p_path text[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select settings #> p_path from pms_properties where id = p_property
$$;

-- Website / logo / photo / settings sanity (owners edit these directly)
create or replace function pms__guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.website is not null and new.website <> '' and new.website !~* '^https?://' then new.website := 'https://' || new.website; end if;
  if new.logo_url is not null and new.logo_url !~* '^https://' then raise exception 'The logo must be an https address'; end if;
  if new.latitude is not null and (new.latitude < -90 or new.latitude > 90) then raise exception 'Latitude must be between -90 and 90'; end if;
  if new.longitude is not null and (new.longitude < -180 or new.longitude > 180) then raise exception 'Longitude must be between -180 and 180'; end if;
  if jsonb_typeof(new.settings) <> 'object' or jsonb_typeof(new.policies) <> 'object' then raise exception 'Settings must be an object'; end if;
  if length(new.policies::text) > 60000 or length(new.settings::text) > 60000 then raise exception 'Policies or settings are too long'; end if;
  return new;
end $$;
drop trigger if exists trg_guard_profile on pms_properties;
create trigger trg_guard_profile before insert or update on pms_properties for each row execute function pms__guard_profile();

-- Photo gallery (files live in the public "property-media" storage bucket under <property id>/)
create table if not exists pms_property_photos (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  url          text not null check (url ~* '^https://'),
  path         text,
  caption      text,
  room_type_id uuid references pms_room_types(id) on delete set null,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);

-- Files attached to a reservation or guest (passport scans, contracts…) in the private "pms-files" bucket
create table if not exists pms_attachments (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  reservation_id  uuid references pms_reservations(id) on delete cascade,
  guest_id        uuid references pms_guests(id) on delete cascade,
  path            text not null,
  file_name       text not null,
  size_bytes      bigint,
  content_type    text,
  uploaded_by     uuid,
  created_at      timestamptz not null default now()
);

-- Storage buckets and their rules (only where Supabase Storage exists)
do $$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets(id, name, public) values ('property-media', 'property-media', true) on conflict (id) do nothing;
  insert into storage.buckets(id, name, public) values ('pms-files', 'pms-files', false) on conflict (id) do nothing;
  execute 'drop policy if exists pms_media_write on storage.objects';
  execute $p$create policy pms_media_write on storage.objects for insert to authenticated
    with check (bucket_id = 'property-media' and (storage.foldername(name))[1] in (select x::text from pms_my_properties(array['owner','manager']) x))$p$;
  execute 'drop policy if exists pms_media_delete on storage.objects';
  execute $p$create policy pms_media_delete on storage.objects for delete to authenticated
    using (bucket_id = 'property-media' and (storage.foldername(name))[1] in (select x::text from pms_my_properties(array['owner','manager']) x))$p$;
  execute 'drop policy if exists pms_files_read on storage.objects';
  execute $p$create policy pms_files_read on storage.objects for select to authenticated
    using (bucket_id = 'pms-files' and (storage.foldername(name))[1] in (select x::text from pms_my_properties(array['owner','manager','front_desk','accountant']) x))$p$;
  execute 'drop policy if exists pms_files_write on storage.objects';
  execute $p$create policy pms_files_write on storage.objects for insert to authenticated
    with check (bucket_id = 'pms-files' and (storage.foldername(name))[1] in (select x::text from pms_my_properties(array['owner','manager','front_desk','accountant']) x))$p$;
  execute 'drop policy if exists pms_files_delete on storage.objects';
  execute $p$create policy pms_files_delete on storage.objects for delete to authenticated
    using (bucket_id = 'pms-files' and (storage.foldername(name))[1] in (select x::text from pms_my_properties(array['owner','manager']) x))$p$;
exception when others then
  raise notice 'Storage policies not created (%). Create the buckets in the dashboard; see README.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 2. Configuration lists (eZee Settings menu)
-- ---------------------------------------------------------------------
create table if not exists pms_payment_methods (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references pms_properties(id) on delete cascade,
  name             text not null,
  kind             text not null check (kind in ('cash','mobile_money','card','bank','other')),
  surcharge_pct    numeric(6,2) not null default 0 check (surcharge_pct between 0 and 20),
  surcharge_fixed  numeric(14,2) not null default 0 check (surcharge_fixed >= 0),
  active           boolean not null default true,
  sort_order       integer not null default 0,
  unique (property_id, name)
);
create table if not exists pms_extra_charges (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  category     text not null default 'other' check (category in ('fnb','laundry','minibar','transport','spa','recreation','tours','events','extra_bed','damage','other')),
  amount       numeric(14,2) not null check (amount >= 0),
  charge_mode  text not null default 'once' check (charge_mode in ('once','per_night','per_person','per_person_night')),
  active       boolean not null default true,
  unique (property_id, name)
);
create table if not exists pms_discount_types (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  kind         text not null default 'percent' check (kind in ('percent','fixed')),
  value        numeric(14,2) not null check (value > 0),
  applies_to   text not null default 'room' check (applies_to in ('room','all')),
  active       boolean not null default true,
  unique (property_id, name),
  check (kind <> 'percent' or value <= 100)
);
create table if not exists pms_transport_types (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  vehicle      text,
  rate         numeric(14,2) not null default 0 check (rate >= 0),
  active       boolean not null default true,
  unique (property_id, name)
);
create table if not exists pms_payout_types (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  active       boolean not null default true,
  unique (property_id, name)
);
create table if not exists pms_meal_plans (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  code         text not null,
  name         text not null,
  adult_rate   numeric(14,2) not null default 0 check (adult_rate >= 0),
  child_rate   numeric(14,2) not null default 0 check (child_rate >= 0),
  active       boolean not null default true,
  unique (property_id, code)
);
create table if not exists pms_remarks (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  kind         text not null default 'general' check (kind in ('general','void','discount','cancel','housekeeping','adjustment')),
  text         text not null,
  active       boolean not null default true
);
create table if not exists pms_market_segments (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  active       boolean not null default true,
  unique (property_id, name)
);
create table if not exists pms_holidays (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  holiday_date  date not null,
  name          text not null,
  unique (property_id, holiday_date)
);
create table if not exists pms_reservation_types (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references pms_properties(id) on delete cascade,
  name           text not null,
  is_confirmed   boolean not null default true,
  complimentary  boolean not null default false,
  release_hours  integer check (release_hours is null or release_hours > 0),
  active         boolean not null default true,
  unique (property_id, name)
);
create table if not exists pms_guest_attributes (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  color        text not null default 'navy' check (color in ('navy','orange','claret','green','grey')),
  active       boolean not null default true,
  unique (property_id, name)
);
create table if not exists pms_taxes (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  rate         numeric(6,3) not null check (rate >= 0 and rate <= 100),
  applies_to   text[] not null default '{room}',
  active       boolean not null default true,
  sort_order   integer not null default 0,
  unique (property_id, name)
);
create table if not exists pms_custom_roles (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  base_role    text not null check (base_role in ('owner','manager','front_desk','accountant','housekeeping','storekeeper')),
  description  text,
  active       boolean not null default true,
  unique (property_id, name)
);

-- Standard rules: everyone at the property reads; owners and managers keep them
do $$
declare t text;
begin
  foreach t in array array['pms_payment_methods','pms_extra_charges','pms_discount_types','pms_transport_types','pms_payout_types',
    'pms_meal_plans','pms_remarks','pms_market_segments','pms_holidays','pms_reservation_types','pms_guest_attributes','pms_taxes',
    'pms_custom_roles','pms_property_photos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (property_id in (select pms_my_properties(null::text[])))', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format('create policy %I on %I for all using (property_id in (select pms_my_properties(array[''owner'',''manager'']))) with check (property_id in (select pms_my_properties(array[''owner'',''manager''])))', t || '_write', t);
    execute format('revoke all on %I from anon', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
    execute format('create index if not exists %I on %I (property_id)', 'ix_' || t || '_property', t);
  end loop;
end $$;
alter table pms_attachments enable row level security;
drop policy if exists pms_attachments_read on pms_attachments;
create policy pms_attachments_read on pms_attachments for select using (property_id in (select pms_my_properties(array['owner','manager','front_desk','accountant'])));
revoke all on pms_attachments from anon, authenticated;
grant select on pms_attachments to authenticated;
create index if not exists ix_attachments_reservation on pms_attachments (reservation_id);
create index if not exists ix_attachments_guest on pms_attachments (guest_id);
create index if not exists ix_attachments_property on pms_attachments (property_id);
create index if not exists ix_photos_room_type on pms_property_photos (room_type_id);

-- Default lists for every property (new ones by trigger, existing ones once)
create or replace function pms__seed_lists(p_property uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_vat numeric;
begin
  insert into pms_payment_methods(property_id, name, kind, sort_order) values
    (p_property, 'Cash', 'cash', 1), (p_property, 'M-Pesa', 'mobile_money', 2), (p_property, 'Tigo Pesa', 'mobile_money', 3),
    (p_property, 'Airtel Money', 'mobile_money', 4), (p_property, 'Card (Visa / Mastercard)', 'card', 5),
    (p_property, 'Bank transfer', 'bank', 6), (p_property, 'Other', 'other', 9)
  on conflict do nothing;
  insert into pms_meal_plans(property_id, code, name) values
    (p_property, 'RO', 'Room only'), (p_property, 'BB', 'Bed and breakfast'), (p_property, 'HB', 'Half board'),
    (p_property, 'FB', 'Full board'), (p_property, 'AI', 'All inclusive')
  on conflict do nothing;
  insert into pms_market_segments(property_id, name) values
    (p_property, 'Leisure'), (p_property, 'Corporate'), (p_property, 'Government'), (p_property, 'NGO'),
    (p_property, 'Group'), (p_property, 'Long stay'), (p_property, 'Complimentary')
  on conflict do nothing;
  insert into pms_reservation_types(property_id, name, is_confirmed, complimentary, release_hours) values
    (p_property, 'Confirmed booking', true, false, null), (p_property, 'Guaranteed (deposit or card)', true, false, null),
    (p_property, 'Tentative / on hold', false, false, 24), (p_property, 'Complimentary', true, true, null), (p_property, 'House use', true, true, null)
  on conflict do nothing;
  insert into pms_guest_attributes(property_id, name, color) values
    (p_property, 'VIP', 'orange'), (p_property, 'Repeat guest', 'navy'), (p_property, 'Corporate', 'green'), (p_property, 'Special needs', 'claret')
  on conflict do nothing;
  insert into pms_transport_types(property_id, name, vehicle) values
    (p_property, 'Airport pick-up (JNIA)', 'Saloon car'), (p_property, 'Airport drop-off (JNIA)', 'Saloon car')
  on conflict do nothing;
  insert into pms_remarks(property_id, kind, text)
  select p_property, k, t from (values ('void','Posted to the wrong room'), ('void','Wrong amount'), ('discount','Long stay'),
    ('discount','Returning guest'), ('cancel','Guest changed plans'), ('cancel','Duplicate booking'), ('adjustment','Correction of a closed day')) v(k, t)
  where not exists (select 1 from pms_remarks r where r.property_id = p_property);
  select tax_rate into v_vat from pms_properties where id = p_property;
  if not exists (select 1 from pms_taxes where property_id = p_property) then
    insert into pms_taxes(property_id, name, rate, applies_to) values (p_property, 'VAT', coalesce(v_vat, 18), '{room,fnb,laundry,minibar,transport,spa,recreation,tours,events,other}');
  end if;
end $$;

create or replace function pms__seed_on_property() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform pms__seed_lists(new.id);
  return null;
end $$;
drop trigger if exists trg_seed_lists on pms_properties;
create trigger trg_seed_lists after insert on pms_properties for each row execute function pms__seed_on_property();
do $$ declare r record; begin for r in select id from pms_properties loop perform pms__seed_lists(r.id); end loop; end $$;

-- Taxes decide the VAT figure the night audit uses (sum of active taxes on rooms) and its wording
create or replace function pms__sync_tax() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_prop uuid := coalesce(new.property_id, old.property_id);
begin
  update pms_properties set tax_rate = coalesce((select sum(rate) from pms_taxes where property_id = v_prop and active and 'room' = any(applies_to)), 0)
   where id = v_prop;
  return null;
end $$;
drop trigger if exists trg_sync_tax on pms_taxes;
create trigger trg_sync_tax after insert or update or delete on pms_taxes for each row execute function pms__sync_tax();

create or replace function pms__tax_label(p_property uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(string_agg(name || ' ' || trim(to_char(rate, 'FM990.###')) || '%', ' + ' order by sort_order, rate desc, name), 'VAT')
  from pms_taxes where property_id = p_property and active and 'room' = any(applies_to)
$$;

-- ---------------------------------------------------------------------
-- 3. Room types, rates, derived plans, extra adult/child, max nights
-- ---------------------------------------------------------------------
alter table pms_room_types add column if not exists base_adults integer not null default 2 check (base_adults >= 1);
alter table pms_room_types add column if not exists max_adults integer;
alter table pms_room_types add column if not exists max_children integer not null default 0;
alter table pms_room_types add column if not exists extra_adult_rate numeric(14,2) not null default 0 check (extra_adult_rate >= 0);
alter table pms_room_types add column if not exists extra_child_rate numeric(14,2) not null default 0 check (extra_child_rate >= 0);
alter table pms_room_types add column if not exists description text;
alter table pms_room_types add column if not exists size_sqm numeric(7,1);
alter table pms_room_types add column if not exists bed_type text;

alter table pms_rates add column if not exists extra_adult numeric(14,2) check (extra_adult >= 0);
alter table pms_rates add column if not exists extra_child numeric(14,2) check (extra_child >= 0);

alter table pms_rate_plans add column if not exists parent_id uuid references pms_rate_plans(id) on delete set null;
alter table pms_rate_plans add column if not exists derive_mode text check (derive_mode in ('percent','amount'));
alter table pms_rate_plans add column if not exists derive_value numeric(14,2);
alter table pms_rate_plans add column if not exists on_booking_engine boolean not null default true;
alter table pms_rate_plans add column if not exists description text;
alter table pms_rate_plans add column if not exists cancellation_policy text;
do $$ begin
  alter table pms_rate_plans add constraint pms_rate_plans_not_self check (parent_id is null or parent_id <> id);
exception when duplicate_object then null; end $$;

alter table pms_rate_restrictions add column if not exists max_stay integer check (max_stay is null or max_stay >= 1);

-- Rate for one night: the day's own rate, else the parent plan's rate adjusted, else the base rate
create or replace function pms__rate(p_room_type uuid, p_rate_plan uuid, p_date date, p_depth int default 0) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v numeric; rp pms_rate_plans;
begin
  select amount into v from pms_rates where room_type_id = p_room_type and rate_plan_id = p_rate_plan and rate_date = p_date;
  if v is not null then return v; end if;
  select * into rp from pms_rate_plans where id = p_rate_plan;
  if rp.parent_id is not null and p_depth < 4 then
    v := pms__rate(p_room_type, rp.parent_id, p_date, p_depth + 1);
    return greatest(0, round(case when rp.derive_mode = 'percent' then v * (1 + coalesce(rp.derive_value, 0) / 100)
                                  else v + coalesce(rp.derive_value, 0) end, 2));
  end if;
  return coalesce((select base_rate from pms_room_types where id = p_room_type), 0);
end $$;

create or replace function pms_rate(p_room_type uuid, p_rate_plan uuid, p_date date)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid;
begin
  select property_id into v_prop from pms_room_types where id = p_room_type;
  if v_prop is null then return 0; end if;
  if not pms__can_see(v_prop) then raise exception 'You are not a member of this property'; end if;
  return pms__rate(p_room_type, p_rate_plan, p_date);
end $$;

-- Rate including adults and children above what the room includes
create or replace function pms__rate_for(p_room_type uuid, p_rate_plan uuid, p_date date, p_adults int, p_children int) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare t pms_room_types; r pms_rates;
begin
  select * into t from pms_room_types where id = p_room_type;
  select * into r from pms_rates where room_type_id = p_room_type and rate_plan_id = p_rate_plan and rate_date = p_date;
  return pms__rate(p_room_type, p_rate_plan, p_date)
       + greatest(coalesce(p_adults, 1) - t.base_adults, 0) * coalesce(r.extra_adult, t.extra_adult_rate)
       + greatest(coalesce(p_children, 0), 0) * coalesce(r.extra_child, t.extra_child_rate);
end $$;

create or replace function pms_rate_for(p_room_type uuid, p_rate_plan uuid, p_date date, p_adults int, p_children int) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid;
begin
  select property_id into v_prop from pms_room_types where id = p_room_type;
  if v_prop is null or not pms__can_see(v_prop) then raise exception 'You are not a member of this property'; end if;
  return pms__rate_for(p_room_type, p_rate_plan, p_date, p_adults, p_children);
end $$;

-- Rooms of a type still free on a date (no permission check: callers check)
create or replace function pms__free_of_type(p_room_type uuid, p_date date) returns int
language sql stable security definer set search_path = public as $$
  select (select count(*) from pms_rooms r where r.room_type_id = p_room_type and r.active)::int
       - (select count(*) from pms_stays s where s.room_type_id = p_room_type
            and s.status in ('tentative','confirmed','checked_in') and p_date >= s.arrival and p_date < s.departure)::int
       - (select count(*) from pms_maintenance_blocks b join pms_rooms r on r.id = b.room_id
            where r.room_type_id = p_room_type and b.status = 'active' and p_date >= b.from_date and p_date < b.to_date)::int
$$;

-- Rate and inventory grid in one call (eZee Rates screen)
create or replace function pms_rate_grid(p_property uuid, p_from date, p_days int default 14)
returns table(room_type_id uuid, rate_plan_id uuid, rate_date date, amount numeric, own_rate boolean, extra_adult numeric, extra_child numeric,
              min_stay int, max_stay int, stop_sell boolean, cta boolean, ctd boolean, free int, sold int, total int, holiday text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property);
  if p_days < 1 or p_days > 62 then raise exception 'Show between 1 and 62 days'; end if;
  return query
    select t.id, rp.id, d::date,
      pms__rate(t.id, rp.id, d::date), r.amount is not null,
      coalesce(r.extra_adult, t.extra_adult_rate), coalesce(r.extra_child, t.extra_child_rate),
      coalesce(x.min_stay, 1), x.max_stay, coalesce(x.stop_sell, false), coalesce(x.cta, false), coalesce(x.ctd, false),
      pms__free_of_type(t.id, d::date),
      (select count(*)::int from pms_stays s where s.room_type_id = t.id and s.status in ('tentative','confirmed','checked_in','checked_out')
         and d::date >= s.arrival and d::date < s.departure),
      (select count(*)::int from pms_rooms rm where rm.room_type_id = t.id and rm.active),
      (select h.name from pms_holidays h where h.property_id = p_property and h.holiday_date = d::date)
    from pms_room_types t
    cross join pms_rate_plans rp
    cross join generate_series(p_from, p_from + p_days - 1, interval '1 day') d
    left join pms_rates r on r.room_type_id = t.id and r.rate_plan_id = rp.id and r.rate_date = d::date
    left join pms_rate_restrictions x on x.room_type_id = t.id and x.rate_plan_id = rp.id and x.rate_date = d::date
    where t.property_id = p_property and rp.property_id = p_property and t.active and rp.active
    order by t.sort_order, t.name, rp.name, d;
end $$;

-- Save many grid cells at once. Each cell: {room_type_id, rate_plan_id, date, amount?, extra_adult?, extra_child?,
-- min_stay?, max_stay?, stop_sell?, cta?, ctd?}. A key that is present is set; null clears an own rate.
create or replace function pms_save_rate_grid(p_property uuid, p_cells jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare c jsonb; n int := 0; v_t uuid; v_p uuid; v_d date; x pms_rate_restrictions;
begin
  perform pms_require(p_property, array['owner','manager']);
  if jsonb_typeof(p_cells) <> 'array' then raise exception 'Cells must be a list'; end if;
  if jsonb_array_length(p_cells) > 5000 then raise exception 'Save at most 5,000 cells at a time'; end if;
  for c in select * from jsonb_array_elements(p_cells) loop
    v_t := (c->>'room_type_id')::uuid; v_p := (c->>'rate_plan_id')::uuid; v_d := (c->>'date')::date;
    if not exists (select 1 from pms_room_types where id = v_t and property_id = p_property)
       or not exists (select 1 from pms_rate_plans where id = v_p and property_id = p_property) then
      raise exception 'Room type or rate plan not found';
    end if;
    if c ? 'amount' or c ? 'extra_adult' or c ? 'extra_child' then
      if c ? 'amount' and c->'amount' = 'null'::jsonb then
        delete from pms_rates where room_type_id = v_t and rate_plan_id = v_p and rate_date = v_d;
      else
        if coalesce((c->>'amount')::numeric, 0) < 0 or coalesce((c->>'extra_adult')::numeric, 0) < 0 or coalesce((c->>'extra_child')::numeric, 0) < 0 then
          raise exception 'Rates cannot be negative';
        end if;
        insert into pms_rates(property_id, room_type_id, rate_plan_id, rate_date, amount, extra_adult, extra_child)
        values (p_property, v_t, v_p, v_d, coalesce((c->>'amount')::numeric, pms__rate(v_t, v_p, v_d)),
                (c->>'extra_adult')::numeric, (c->>'extra_child')::numeric)
        on conflict (room_type_id, rate_plan_id, rate_date) do update set
          amount = case when c ? 'amount' then excluded.amount else pms_rates.amount end,
          extra_adult = case when c ? 'extra_adult' then excluded.extra_adult else pms_rates.extra_adult end,
          extra_child = case when c ? 'extra_child' then excluded.extra_child else pms_rates.extra_child end;
      end if;
    end if;
    if c ? 'min_stay' or c ? 'max_stay' or c ? 'stop_sell' or c ? 'cta' or c ? 'ctd' then
      select * into x from pms_rate_restrictions where room_type_id = v_t and rate_plan_id = v_p and rate_date = v_d;
      insert into pms_rate_restrictions(property_id, room_type_id, rate_plan_id, rate_date, min_stay, max_stay, stop_sell, cta, ctd)
      values (p_property, v_t, v_p, v_d,
        greatest(1, coalesce(case when c ? 'min_stay' then (c->>'min_stay')::int end, x.min_stay, 1)),
        case when c ? 'max_stay' then nullif((c->>'max_stay')::int, 0) else x.max_stay end,
        case when c ? 'stop_sell' then (c->>'stop_sell')::boolean else coalesce(x.stop_sell, false) end,
        case when c ? 'cta' then (c->>'cta')::boolean else coalesce(x.cta, false) end,
        case when c ? 'ctd' then (c->>'ctd')::boolean else coalesce(x.ctd, false) end)
      on conflict (room_type_id, rate_plan_id, rate_date) do update set
        min_stay = excluded.min_stay, max_stay = excluded.max_stay, stop_sell = excluded.stop_sell, cta = excluded.cta, ctd = excluded.ctd;
      delete from pms_rate_restrictions where room_type_id = v_t and rate_plan_id = v_p and rate_date = v_d
        and min_stay = 1 and max_stay is null and not stop_sell and not cta and not ctd;
    end if;
    n := n + 1;
  end loop;
  perform pms_log(p_property, 'rates.grid', 'property', p_property, jsonb_build_object('cells', n));
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 4. Reservations, guests and stays: segments, types, transport, POS permission
-- ---------------------------------------------------------------------
alter table pms_reservations add column if not exists market_segment_id uuid references pms_market_segments(id);
alter table pms_reservations add column if not exists reservation_type_id uuid references pms_reservation_types(id);
alter table pms_reservations add column if not exists pickup jsonb;
alter table pms_reservations add column if not exists dropoff jsonb;
alter table pms_reservations add column if not exists booked_via text;
alter table pms_guests add column if not exists attributes text[] not null default '{}';
alter table pms_guests add column if not exists blacklisted boolean not null default false;
alter table pms_guests add column if not exists blacklist_reason text;
alter table pms_guests add column if not exists date_of_birth date;
alter table pms_guests add column if not exists gender text check (gender is null or gender in ('female','male','other'));
alter table pms_stays add column if not exists allow_pos boolean not null default true;
alter table pms_stays add column if not exists credit_limit numeric(14,2) check (credit_limit is null or credit_limit >= 0);
alter table pms_folio_lines add column if not exists payment_method_name text;
alter table pms_folio_lines add column if not exists sub_type text;
alter table pms_members add column if not exists title text;
alter table pms_pos_bills add column if not exists payment_method_name text;
create index if not exists ix_res_segment on pms_reservations (market_segment_id);
create index if not exists ix_res_type on pms_reservations (reservation_type_id);

-- Blacklisted guests: only an owner or manager can book them
create or replace function pms__check_blacklist() returns trigger
language plpgsql security definer set search_path = public as $$
declare g pms_guests;
begin
  select * into g from pms_guests where id = new.guest_id;
  if g.blacklisted and auth.uid() is not null and coalesce(pms_role(new.property_id), '') not in ('owner','manager') then
    raise exception '% is on the blacklist (%). A manager must make this booking.', g.first_name || coalesce(' ' || g.last_name, ''), coalesce(g.blacklist_reason, 'no reason given');
  end if;
  return new;
end $$;
drop trigger if exists trg_check_blacklist on pms_reservations;
create trigger trg_check_blacklist before insert on pms_reservations for each row execute function pms__check_blacklist();

-- Booking details beyond the basics (one call from the Booking details tab)
create or replace function pms_set_booking_details(p_reservation uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r pms_reservations;
begin
  select * into r from pms_reservations where id = p_reservation for update;
  if not found then raise exception 'Reservation not found'; end if;
  perform pms_require(r.property_id, array['owner','manager','front_desk']);
  update pms_reservations set
    market_segment_id = case when p ? 'market_segment_id' then nullif(p->>'market_segment_id', '')::uuid else market_segment_id end,
    reservation_type_id = case when p ? 'reservation_type_id' then nullif(p->>'reservation_type_id', '')::uuid else reservation_type_id end,
    pickup = case when p ? 'pickup' then nullif(p->'pickup', 'null'::jsonb) else pickup end,
    dropoff = case when p ? 'dropoff' then nullif(p->'dropoff', 'null'::jsonb) else dropoff end
  where id = p_reservation;
  if p ? 'allow_pos' or p ? 'credit_limit' then
    if (p ? 'credit_limit') and pms_role(r.property_id) not in ('owner','manager') then raise exception 'Only a manager sets a credit limit'; end if;
    update pms_stays set
      allow_pos = case when p ? 'allow_pos' then coalesce((p->>'allow_pos')::boolean, true) else allow_pos end,
      credit_limit = case when p ? 'credit_limit' then nullif(p->>'credit_limit', '')::numeric else credit_limit end
    where reservation_id = p_reservation;
  end if;
  perform pms_log(r.property_id, 'reservation.details', 'reservation', p_reservation, p);
end $$;

-- ---------------------------------------------------------------------
-- 5. Folio operations
-- ---------------------------------------------------------------------
-- Payment with a configured method (name on the folio and receipt; optional surcharge)
create or replace function pms_post_payment_method(p_folio uuid, p_amount numeric, p_method uuid, p_reference text default null, p_refund boolean default false)
returns uuid
language plpgsql security definer set search_path = public as $$
declare m pms_payment_methods; f pms_folios; v_line uuid; v_fee numeric;
begin
  select * into f from pms_folios where id = p_folio;
  if not found then raise exception 'Folio not found'; end if;
  select * into m from pms_payment_methods where id = p_method and property_id = f.property_id and active;
  if not found then raise exception 'Payment method not found'; end if;
  v_line := pms_post_payment(p_folio, p_amount, m.kind, p_reference, p_refund);
  update pms_folio_lines set payment_method_name = m.name,
    description = case when p_refund then 'Refund' else 'Payment' end || ' — ' || m.name where id = v_line;
  v_fee := round(case when p_refund then 0 else p_amount * m.surcharge_pct / 100 + m.surcharge_fixed end, 2);
  if v_fee > 0 then
    perform pms_post_charge(p_folio, 'other', m.name || ' charge', v_fee, 'Surcharge');
  end if;
  return v_line;
end $$;

-- Charge from the extra charges list
create or replace function pms_post_extra_charge(p_folio uuid, p_extra uuid, p_qty numeric default 1, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; e pms_extra_charges;
begin
  select * into f from pms_folios where id = p_folio;
  if not found then raise exception 'Folio not found'; end if;
  select * into e from pms_extra_charges where id = p_extra and property_id = f.property_id and active;
  if not found then raise exception 'Extra charge not found'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 1000 then raise exception 'Quantity must be between 0 and 1,000'; end if;
  return pms_post_charge(p_folio, e.category, e.name || case when p_qty <> 1 then ' × ' || trim(to_char(p_qty, 'FM999990.##')) else '' end
    || coalesce(' — ' || nullif(trim(p_note), ''), ''), round(e.amount * p_qty, 2), null);
end $$;

-- Discount from the discount list (percent of room charges or of all charges on the folio)
create or replace function pms_post_discount_type(p_folio uuid, p_type uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; d pms_discount_types; v_base numeric; v_amt numeric;
begin
  select * into f from pms_folios where id = p_folio;
  if not found then raise exception 'Folio not found'; end if;
  select * into d from pms_discount_types where id = p_type and property_id = f.property_id and active;
  if not found then raise exception 'Discount not found'; end if;
  select coalesce(sum(amount), 0) into v_base from pms_folio_lines
   where folio_id = p_folio and not voided and line_type = 'charge' and (d.applies_to = 'all' or category = 'room');
  v_amt := case when d.kind = 'percent' then round(v_base * d.value / 100, 2) else d.value end;
  if v_amt <= 0 then raise exception 'Nothing to discount yet on this folio'; end if;
  return pms_post_discount(p_folio, least(v_amt, greatest(v_base, d.value)), d.name || coalesce(' — ' || nullif(trim(p_note), ''), ''));
end $$;

-- Room charge posting with eZee's sub types
create or replace function pms_post_room_charge(p_folio uuid, p_sub_type text, p_amount numeric, p_comment text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; v_line uuid; v_room text;
begin
  f := pms__open_folio(p_folio);
  perform pms_require(f.property_id, array['owner','manager','front_desk']);
  if p_sub_type not in ('room','day_use','late_checkout','early_checkin','no_show','cancellation') then raise exception 'Unknown room charge type %', p_sub_type; end if;
  select r.number into v_room from pms_stays s left join pms_rooms r on r.id = s.room_id where s.id = f.stay_id;
  v_line := pms_post_charge(p_folio, 'room',
    (case p_sub_type when 'room' then 'Room charge' when 'day_use' then 'Day use' when 'late_checkout' then 'Late check-out'
       when 'early_checkin' then 'Early check-in' when 'no_show' then 'No-show revenue' else 'Cancellation revenue' end)
    || coalesce(' · room ' || v_room, '') || coalesce(' — ' || nullif(trim(p_comment), ''), ''), p_amount, null);
  update pms_folio_lines set sub_type = p_sub_type where id = v_line;
  return v_line;
end $$;

-- Adjustment: a correction (often of a closed day), up or down, by a manager
create or replace function pms_post_adjustment(p_folio uuid, p_amount numeric, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; v_id uuid;
begin
  f := pms__open_folio(p_folio);
  perform pms_require(f.property_id, array['owner','manager']);
  if p_amount is null or p_amount = 0 then raise exception 'Enter the adjustment (negative to reduce the bill)'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount, business_date, posted_by, sub_type)
  values (f.property_id, p_folio, f.stay_id, case when p_amount < 0 then 'discount' else 'charge' end, 'adjustment',
          'Adjustment — ' || trim(p_reason), round(p_amount, 2), pms__bd(f.property_id), auth.uid(), 'adjustment')
  returning id into v_id;
  perform pms_log(f.property_id, 'folio.adjustment', 'folio_line', v_id, jsonb_build_object('folio_no', f.folio_no, 'amount', p_amount, 'reason', p_reason));
  return v_id;
end $$;

-- Paid out: cash from the drawer on the guest's behalf (taxi, pharmacy…), added to their bill
create or replace function pms_post_paid_out(p_folio uuid, p_amount numeric, p_description text, p_paid_to text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; v_drawer uuid; v_id uuid;
begin
  f := pms__open_folio(p_folio);
  perform pms_require(f.property_id, array['owner','manager','front_desk','accountant']);
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if coalesce(trim(p_description), '') = '' then raise exception 'Say what the money was for'; end if;
  v_drawer := pms__drawer(f.property_id);
  if v_drawer is null then raise exception 'Open your cash drawer before paying out cash'; end if;
  insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount, payment_method,
                              business_date, drawer_session_id, posted_by, sub_type)
  values (f.property_id, p_folio, f.stay_id, 'charge', 'paid_out', 'Paid out — ' || trim(p_description) || coalesce(' (to ' || nullif(trim(p_paid_to), '') || ')', ''),
          round(p_amount, 2), 'cash', pms__bd(f.property_id), v_drawer, auth.uid(), 'paid_out')
  returning id into v_id;
  perform pms_log(f.property_id, 'folio.paid_out', 'folio_line', v_id, jsonb_build_object('folio_no', f.folio_no, 'amount', p_amount, 'description', p_description));
  return v_id;
end $$;

-- Meal plan posting for the current business day
create or replace function pms_post_meal_plan(p_folio uuid, p_meal_plan uuid, p_days int default 1) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; m pms_meal_plans; s pms_stays; v_amt numeric;
begin
  select * into f from pms_folios where id = p_folio;
  if not found then raise exception 'Folio not found'; end if;
  select * into m from pms_meal_plans where id = p_meal_plan and property_id = f.property_id and active;
  if not found then raise exception 'Meal plan not found'; end if;
  select * into s from pms_stays where id = f.stay_id;
  if p_days is null or p_days < 1 or p_days > 60 then raise exception 'Days must be between 1 and 60'; end if;
  v_amt := (m.adult_rate * coalesce(s.adults, 1) + m.child_rate * coalesce(s.children, 0)) * p_days;
  if v_amt <= 0 then raise exception 'Set the meal plan prices first (Setup → Meal plans)'; end if;
  return pms_post_charge(p_folio, 'fnb', 'Meal plan ' || m.name || ' — ' || coalesce(s.adults, 1) || ' adult(s)'
    || case when coalesce(s.children, 0) > 0 then ', ' || s.children || ' child(ren)' else '' end
    || case when p_days > 1 then ' × ' || p_days || ' days' else '' end, v_amt, m.code);
end $$;

-- Transport (pick-up / drop-off) to the guest's folio
create or replace function pms_post_transport(p_reservation uuid, p_leg text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r pms_reservations; j jsonb; t pms_transport_types; v_folio uuid;
begin
  select * into r from pms_reservations where id = p_reservation;
  if not found then raise exception 'Reservation not found'; end if;
  j := case p_leg when 'pickup' then r.pickup when 'dropoff' then r.dropoff end;
  if j is null or j->>'type_id' is null then raise exception 'Add the % details first', replace(p_leg, 'pickup', 'pick-up'); end if;
  select * into t from pms_transport_types where id = (j->>'type_id')::uuid and property_id = r.property_id;
  if not found then raise exception 'Transport type not found'; end if;
  if coalesce((j->>'posted')::boolean, false) then raise exception 'Already charged'; end if;
  select f.id into v_folio from pms_folios f where f.reservation_id = p_reservation and f.status = 'open' order by f.folio_no limit 1;
  if v_folio is null then raise exception 'No open folio on this reservation'; end if;
  v_folio := pms_post_charge(v_folio, 'transport', t.name || coalesce(' — ' || nullif(j->>'flight', ''), ''), coalesce(nullif(j->>'rate', '')::numeric, t.rate), null);
  update pms_reservations set pickup = case when p_leg = 'pickup' then pickup || '{"posted": true}' else pickup end,
                              dropoff = case when p_leg = 'dropoff' then dropoff || '{"posted": true}' else dropoff end where id = p_reservation;
  return v_folio;
end $$;

-- Split folio: move chosen lines to a new folio
create or replace function pms_split_folio(p_folio uuid, p_lines uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; v_new uuid; l uuid; n int := 0;
begin
  f := pms__open_folio(p_folio);
  perform pms_require(f.property_id, array['owner','manager','front_desk']);
  if coalesce(array_length(p_lines, 1), 0) = 0 then raise exception 'Choose the lines to move'; end if;
  v_new := pms_add_folio(f.stay_id, null);
  foreach l in array p_lines loop
    if not exists (select 1 from pms_folio_lines where id = l and folio_id = p_folio and not voided) then raise exception 'A chosen line is not on this folio'; end if;
    perform pms_transfer_line(l, v_new);
    n := n + 1;
  end loop;
  perform pms_log(f.property_id, 'folio.split', 'folio', p_folio, jsonb_build_object('folio_no', f.folio_no, 'lines', n));
  return v_new;
end $$;

-- Cut folio: everything from a date onwards goes to a new folio (e.g. company pays from the 15th)
create or replace function pms_cut_folio(p_folio uuid, p_from date) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; v_lines uuid[];
begin
  f := pms__open_folio(p_folio);
  select array_agg(id order by business_date, created_at) into v_lines from pms_folio_lines
   where folio_id = p_folio and not voided and business_date >= p_from;
  if v_lines is null then raise exception 'Nothing on this folio from %', to_char(p_from, 'DD Mon YYYY'); end if;
  return pms_split_folio(p_folio, v_lines);
end $$;

-- File records (the file itself is uploaded to storage first)
create or replace function pms_add_attachment(p_reservation uuid, p_path text, p_name text, p_size bigint, p_type text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r pms_reservations; v_id uuid;
begin
  select * into r from pms_reservations where id = p_reservation;
  if not found then raise exception 'Reservation not found'; end if;
  perform pms_require(r.property_id, array['owner','manager','front_desk','accountant']);
  if split_part(p_path, '/', 1) <> r.property_id::text then raise exception 'Files go in this property''s folder'; end if;
  if p_size > 10485760 then raise exception 'Files must be under 10 MB'; end if;
  insert into pms_attachments(property_id, reservation_id, guest_id, path, file_name, size_bytes, content_type, uploaded_by)
  values (r.property_id, p_reservation, r.guest_id, p_path, left(p_name, 200), p_size, left(p_type, 100), auth.uid()) returning id into v_id;
  perform pms_log(r.property_id, 'reservation.file', 'reservation', p_reservation, jsonb_build_object('file', p_name));
  return v_id;
end $$;

create or replace function pms_remove_attachment(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare a pms_attachments;
begin
  select * into a from pms_attachments where id = p_id;
  if not found then raise exception 'File not found'; end if;
  perform pms_require(a.property_id, array['owner','manager']);
  delete from pms_attachments where id = p_id;
  perform pms_log(a.property_id, 'reservation.file_removed', 'reservation', a.reservation_id, jsonb_build_object('file', a.file_name));
  return a.path;
end $$;

-- Early check-in: posted by itself when switched on and the guest arrives before check-in time
create or replace function pms__early_checkin() returns trigger
language plpgsql security definer set search_path = public as $$
declare p pms_properties; v_cfg jsonb; v_local time; v_amt numeric; v_folio uuid;
begin
  if not (old.status <> 'checked_in' and new.status = 'checked_in') then return null; end if;
  select * into p from pms_properties where id = new.property_id;
  v_cfg := p.settings->'early_checkin';
  if not coalesce((v_cfg->>'auto_post')::boolean, false) then return null; end if;
  if new.arrival <> p.business_date then return null; end if;
  v_local := (now() at time zone coalesce(p.timezone, 'Africa/Dar_es_Salaam'))::time;
  if v_local >= p.check_in_time then return null; end if;
  v_amt := case when v_cfg->>'mode' = 'fixed' then coalesce((v_cfg->>'value')::numeric, 0) else round(new.rate * coalesce((v_cfg->>'value')::numeric, 50) / 100, 2) end;
  if v_amt <= 0 then return null; end if;
  select id into v_folio from pms_folios where stay_id = new.id and status = 'open' order by folio_no limit 1;
  if v_folio is null then return null; end if;
  insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount, business_date, posted_by, source, sub_type)
  values (new.property_id, v_folio, new.id, 'charge', 'room', 'Early check-in (before ' || to_char(p.check_in_time, 'HH24:MI') || ')', v_amt,
          p.business_date, auth.uid(), 'system', 'early_checkin');
  return null;
end $$;
drop trigger if exists trg_early_checkin on pms_stays;
create trigger trg_early_checkin after update of status on pms_stays for each row execute function pms__early_checkin();

-- What a late check-out would cost right now (the desk decides whether to post it)
create or replace function pms_late_checkout_quote(p_stay uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s pms_stays; p pms_properties; v_cfg jsonb; v_local time; v_amt numeric;
begin
  select * into s from pms_stays where id = p_stay;
  if not found then raise exception 'Stay not found'; end if;
  perform pms_require(s.property_id);
  select * into p from pms_properties where id = s.property_id;
  v_cfg := p.settings->'late_checkout';
  v_local := (now() at time zone coalesce(p.timezone, 'Africa/Dar_es_Salaam'))::time;
  v_amt := case when v_cfg->>'mode' = 'fixed' then coalesce((v_cfg->>'value')::numeric, 0) else round(s.rate * coalesce((v_cfg->>'value')::numeric, 50) / 100, 2) end;
  return jsonb_build_object('late', v_local > p.check_out_time and s.departure <= p.business_date and not coalesce((p.settings->>'checkout_24h')::boolean, false),
    'check_out_time', to_char(p.check_out_time, 'HH24:MI'), 'amount', v_amt);
end $$;

-- ---------------------------------------------------------------------
-- 6. POS for in-house guests
-- ---------------------------------------------------------------------
-- Attach a bill to an in-house guest (room service, pool bar tab…); the bill can then go to the room
create or replace function pms_pos_attach_guest(p_bill uuid, p_stay uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; v_name text;
begin
  b := pms__pos_bill(p_bill);
  if p_stay is null then update pms_pos_bills set stay_id = null where id = p_bill; return; end if;
  select 'Room ' || coalesce(r.number, '?') || ' · ' || g.first_name || coalesce(' ' || g.last_name, '') into v_name
  from pms_stays s join pms_reservations res on res.id = s.reservation_id join pms_guests g on g.id = res.guest_id
  left join pms_rooms r on r.id = s.room_id
  where s.id = p_stay and s.property_id = b.property_id and s.status = 'checked_in';
  if v_name is null then raise exception 'That guest is not checked in'; end if;
  update pms_pos_bills set stay_id = p_stay, table_no = coalesce(nullif(table_no, ''), v_name) where id = p_bill;
end $$;

-- Charges to a room respect the stay's "allow POS charges" switch and credit limit
create or replace function pms__room_post_allowed(p_stay uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = public as $$
declare s pms_stays; v_bal numeric;
begin
  select * into s from pms_stays where id = p_stay;
  if not s.allow_pos then raise exception 'NO_POST: charges to this room are switched off; take payment at the outlet'; end if;
  if s.credit_limit is not null then
    select coalesce(sum(b.balance), 0) into v_bal from pms_folio_balances b join pms_folios f on f.id = b.folio_id
     where f.stay_id = p_stay and f.status = 'open';
    if v_bal > s.credit_limit then
      raise exception 'NO_POST: over the room''s credit limit of % (balance now %); ask the guest to pay first', to_char(s.credit_limit, 'FM999,999,999'), to_char(v_bal, 'FM999,999,999');
    end if;
  end if;
end $$;

create or replace function pms__pos_room_rules() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'open' and new.status = 'room' and new.stay_id is not null then perform pms__room_post_allowed(new.stay_id, new.total); end if;
  return new;
end $$;
drop trigger if exists trg_pos_room_rules on pms_pos_bills;
create trigger trg_pos_room_rules before update of status on pms_pos_bills for each row execute function pms__pos_room_rules();

create or replace function pms__external_room_rules() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform pms__room_post_allowed(new.stay_id, new.amount);
  return new;
end $$;
drop trigger if exists trg_external_room_rules on pms_external_charges;
create trigger trg_external_room_rules after insert on pms_external_charges for each row execute function pms__external_room_rules();

-- Split a bill: chosen lines go to a new bill (two people paying separately)
create or replace function pms_pos_split_bill(p_bill uuid, p_items uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; v_new uuid; n int;
begin
  b := pms__pos_bill(p_bill);
  if coalesce(array_length(p_items, 1), 0) = 0 then raise exception 'Choose the items to move'; end if;
  if (select count(*) from pms_pos_bill_items where bill_id = p_bill and id = any(p_items)) <> array_length(p_items, 1) then
    raise exception 'A chosen item is not on this bill';
  end if;
  if not exists (select 1 from pms_pos_bill_items where bill_id = p_bill and not (id = any(p_items))) then
    raise exception 'Leave at least one item on the first bill';
  end if;
  v_new := pms_pos_open_bill(b.outlet_id, coalesce(b.table_no, 'Split') || ' (split)', null);
  update pms_pos_bill_items set bill_id = v_new where bill_id = p_bill and id = any(p_items);
  get diagnostics n = row_count;
  perform pms__pos_total(p_bill); perform pms__pos_total(v_new);
  perform pms_log(b.property_id, 'pos.split', 'pos_bill', p_bill, jsonb_build_object('bill_no', b.bill_no, 'items', n));
  return v_new;
end $$;

-- Pay a POS bill with a configured method
create or replace function pms_pos_settle_method(p_bill uuid, p_method uuid, p_reference text default null) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; m pms_payment_methods;
begin
  select * into b from pms_pos_bills where id = p_bill;
  if not found then raise exception 'Bill not found'; end if;
  select * into m from pms_payment_methods where id = p_method and property_id = b.property_id and active;
  if not found then raise exception 'Payment method not found'; end if;
  perform pms_pos_settle(p_bill, m.kind, p_reference);
  update pms_pos_bills set payment_method_name = m.name where id = p_bill;
end $$;

-- ---------------------------------------------------------------------
-- 7. Users: titles (custom roles), sign-in history, MFA status, audit trail with IP
-- ---------------------------------------------------------------------
create table if not exists pms_sign_ins (
  id          bigserial primary key,
  user_id     uuid not null,
  at          timestamptz not null default now(),
  ip          text,
  user_agent  text
);
create index if not exists ix_sign_ins_user on pms_sign_ins (user_id, at desc);
alter table pms_sign_ins enable row level security;
revoke all on pms_sign_ins from anon, authenticated;

alter table pms_audit_log add column if not exists ip text;
alter table pms_audit_log add column if not exists user_agent text;

create or replace function pms__request_ip() returns text
language sql stable as $$
  select nullif(trim(split_part(coalesce(nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for',
                                         nullif(current_setting('request.headers', true), '')::json->>'cf-connecting-ip', ''), ',', 1)), '')
$$;
create or replace function pms__request_agent() returns text
language sql stable as $$
  select left(nullif(current_setting('request.headers', true), '')::json->>'user-agent', 300)
$$;

create or replace function pms__audit_ip() returns trigger
language plpgsql as $$
begin
  new.ip := coalesce(new.ip, pms__request_ip());
  new.user_agent := coalesce(new.user_agent, pms__request_agent());
  return new;
end $$;
drop trigger if exists trg_audit_ip on pms_audit_log;
create trigger trg_audit_ip before insert on pms_audit_log for each row execute function pms__audit_ip();

-- Called by the app once a session starts
create or replace function pms_record_sign_in() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  -- one row per device per hour is enough
  if exists (select 1 from pms_sign_ins where user_id = auth.uid() and at > now() - interval '1 hour'
               and coalesce(ip, '') = coalesce(pms__request_ip(), '') and coalesce(user_agent, '') = coalesce(pms__request_agent(), '')) then return; end if;
  insert into pms_sign_ins(user_id, ip, user_agent) values (auth.uid(), pms__request_ip(), pms__request_agent());
end $$;

-- Staff list with titles, invites, MFA and last activity (eZee Users screen)
create or replace function pms_list_staff(p_property uuid)
returns table(kind text, id uuid, user_id uuid, email text, display_name text, role text, title text, active boolean,
              mfa boolean, last_sign_in timestamptz, last_ip text)
language plpgsql stable security definer set search_path = public as $$
declare v_mfa boolean := to_regclass('auth.mfa_factors') is not null;
begin
  perform pms_require(p_property, array['owner','manager']);
  return query
    select 'member'::text, m.user_id, m.user_id, u.email::text, m.display_name, m.role, m.title, m.active,
      case when v_mfa then pms__has_mfa(m.user_id) else false end,
      (select max(si.at) from pms_sign_ins si where si.user_id = m.user_id),
      (select si.ip from pms_sign_ins si where si.user_id = m.user_id order by si.at desc limit 1)
    from pms_members m join auth.users u on u.id = m.user_id where m.property_id = p_property
    union all
    select 'invite', i.id, null, i.email, i.display_name, i.role, null, true, false, null, null
    from pms_invites i where i.property_id = p_property and i.accepted_at is null
    order by 1 desc, 4;
end $$;

create or replace function pms__has_mfa(p_user uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v boolean := false;
begin
  if to_regclass('auth.mfa_factors') is null then return false; end if;
  execute 'select exists (select 1 from auth.mfa_factors where user_id = $1 and status::text = ''verified'')' into v using p_user;
  return v;
end $$;

-- Where and when a member signed in (eZee Device activity)
create or replace function pms_staff_devices(p_property uuid, p_user uuid default null)
returns table(user_id uuid, email text, at timestamptz, ip text, user_agent text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager']);
  return query
    select si.user_id, u.email::text, si.at, si.ip, si.user_agent
    from pms_sign_ins si join auth.users u on u.id = si.user_id
    where si.user_id in (select m.user_id from pms_members m where m.property_id = p_property)
      and (p_user is null or si.user_id = p_user)
    order by si.at desc limit 300;
end $$;

-- What a member did (eZee User activity)
create or replace function pms_staff_activity(p_property uuid, p_user uuid default null, p_limit int default 200)
returns table(at timestamptz, user_id uuid, user_name text, action text, entity text, details jsonb, ip text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager']);
  return query
    select a.created_at, a.user_id, coalesce(m.display_name, u.email::text, 'System'), a.action, a.entity, a.details, a.ip
    from pms_audit_log a left join pms_members m on m.property_id = a.property_id and m.user_id = a.user_id
    left join auth.users u on u.id = a.user_id
    where a.property_id = p_property and (p_user is null or a.user_id = p_user)
    order by a.created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end $$;

create or replace function pms_set_member_title(p_property uuid, p_user uuid, p_title text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner']);
  update pms_members set title = nullif(left(trim(coalesce(p_title, '')), 60), '') where property_id = p_property and user_id = p_user;
  if not found then raise exception 'Member not found'; end if;
end $$;

-- Reservation audit trail now shows the IP address too
drop function if exists pms_reservation_trail(uuid);
create or replace function pms_reservation_trail(p_reservation uuid)
returns table(at timestamptz, user_name text, action text, details jsonb, ip text)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid;
begin
  select property_id into v_prop from pms_reservations where id = p_reservation;
  if v_prop is null then raise exception 'Reservation not found'; end if;
  perform pms_require(v_prop);
  return query
    select a.created_at, coalesce(m.display_name, u.email::text, 'system'), a.action, a.details, a.ip
    from pms_audit_log a
    left join pms_members m on m.property_id = a.property_id and m.user_id = a.user_id
    left join auth.users u on u.id = a.user_id
    where a.property_id = v_prop and (
      a.entity_id = p_reservation
      or a.entity_id in (select id from pms_stays where reservation_id = p_reservation)
      or a.entity_id in (select l.id from pms_folio_lines l join pms_folios f on f.id = l.folio_id where f.reservation_id = p_reservation))
    order by a.created_at desc;
end $$;

-- Properties can require two-step sign-in for all staff (Security preferences)
create or replace function pms__mfa_ok_for(p_settings jsonb) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce((p_settings->>'require_mfa')::boolean, false) then return true; end if;
  if to_regclass('auth.mfa_factors') is null then return true; end if;
  return coalesce(nullif(current_setting('request.jwt.claims', true), '')::json->>'aal', '') = 'aal2';
end $$;

create or replace function pms_role(p_property uuid)
returns text language sql stable security definer set search_path = public as $$
  select m.role from pms_members m join pms_properties p on p.id = m.property_id
  where m.property_id = p_property and m.user_id = auth.uid() and m.active
    and (p.status = 'active' or exists (select 1 from pms_platform_admins a where a.user_id = auth.uid()))
    and pms__aal_ok() and pms__mfa_ok_for(p.settings)
$$;

create or replace function pms_my_properties(p_roles text[] default null) returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.property_id from pms_members m join pms_properties p on p.id = m.property_id
  where m.user_id = auth.uid() and m.active and (p_roles is null or m.role = any(p_roles))
    and (p.status = 'active' or exists (select 1 from pms_platform_admins a where a.user_id = auth.uid()))
    and pms__aal_ok() and pms__mfa_ok_for(p.settings)
$$;

-- Which of my properties are waiting for me to turn on two-step sign-in
create or replace function pms_mfa_blocked_properties() returns table(property_id uuid, name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name from pms_members m join pms_properties p on p.id = m.property_id
  where m.user_id = auth.uid() and m.active and p.status = 'active' and not pms__mfa_ok_for(p.settings)
$$;

-- ---------------------------------------------------------------------
-- 8. Notifications: SMS on booking, check-in and check-out (templates in settings.notifications)
-- ---------------------------------------------------------------------
create or replace function pms__fill(p_tpl text, p jsonb) returns text
language plpgsql immutable as $$
declare k text; v text := p_tpl;
begin
  for k in select jsonb_object_keys(p) loop v := replace(v, '{' || k || '}', coalesce(p->>k, '')); end loop;
  return v;
end $$;

create or replace function pms__notify_guest(p_reservation uuid, p_event text) returns void
language plpgsql security definer set search_path = public as $$
declare r pms_reservations; g pms_guests; p pms_properties; v_cfg jsonb; v_tpl text; v_room text;
begin
  select * into r from pms_reservations where id = p_reservation;
  select * into p from pms_properties where id = r.property_id;
  v_cfg := p.settings->'notifications';
  if not coalesce((v_cfg->>(p_event || '_sms'))::boolean, false) then return; end if;
  if not pms__integration_on(r.property_id, 'sms') then return; end if;
  if coalesce(r.external_ref, '') like 'ezee:%' then return; end if;
  select * into g from pms_guests where id = r.guest_id;
  if g.phone is null then return; end if;
  select string_agg(distinct rm.number, ', ') into v_room from pms_stays s join pms_rooms rm on rm.id = s.room_id where s.reservation_id = r.id;
  v_tpl := coalesce(nullif(v_cfg->>(p_event || '_template'), ''), case p_event
    when 'booking' then 'Dear {guest}, your booking #{res_no} at {property} for {arrival} to {departure} is {status}. Karibu!'
    when 'checkin' then 'Karibu {guest}! You are checked in to room {room} at {property}. Call reception on {phone} for anything you need.'
    else 'Asante {guest} for staying at {property}. Safe travels, and see you again!' end);
  perform pms__queue_sms(r.property_id, null, 'manual', g.phone, left(pms__fill(v_tpl, jsonb_build_object(
    'guest', g.first_name, 'property', p.name, 'res_no', r.res_no, 'arrival', to_char(r.arrival, 'DD Mon YYYY'),
    'departure', to_char(r.departure, 'DD Mon YYYY'), 'room', coalesce(v_room, ''), 'phone', coalesce(p.reservation_phone, p.phone, ''),
    'status', case when r.status = 'tentative' then 'on hold' else 'confirmed' end)), 480));
end $$;

create or replace function pms__notify_reservation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform pms__notify_guest(new.id, 'booking');
  return null;
end $$;
drop trigger if exists trg_notify_reservation on pms_reservations;
create trigger trg_notify_reservation after insert on pms_reservations for each row execute function pms__notify_reservation();

create or replace function pms__notify_stay() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status <> 'checked_in' and new.status = 'checked_in'
     and not exists (select 1 from pms_stays s where s.reservation_id = new.reservation_id and s.id <> new.id and s.status = 'checked_in') then
    perform pms__notify_guest(new.reservation_id, 'checkin');
  elsif old.status = 'checked_in' and new.status = 'checked_out'
     and not exists (select 1 from pms_stays s where s.reservation_id = new.reservation_id and s.id <> new.id and s.status = 'checked_in') then
    perform pms__notify_guest(new.reservation_id, 'checkout');
  end if;
  return null;
end $$;
drop trigger if exists trg_notify_stay on pms_stays;
create trigger trg_notify_stay after update of status on pms_stays for each row execute function pms__notify_stay();

-- ---------------------------------------------------------------------
-- 9. Reports: market segments, payment methods
-- ---------------------------------------------------------------------
create or replace function pms_rpt_segments(p_property uuid, p_from date, p_to date)
returns table(segment text, bookings int, room_nights int, room_revenue numeric, adr numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant','front_desk']);
  return query
    with nights as (
      select coalesce(ms.name, 'Not set') seg, s.reservation_id, s.rate
      from pms_stays s join pms_reservations r on r.id = s.reservation_id left join pms_market_segments ms on ms.id = r.market_segment_id
      cross join generate_series(greatest(s.arrival, p_from), least(s.departure - 1, p_to), interval '1 day') d
      where s.property_id = p_property and s.status in ('confirmed','tentative','checked_in','checked_out'))
    select seg, count(distinct reservation_id)::int, count(*)::int, coalesce(sum(rate), 0), round(coalesce(avg(rate), 0), 2)
    from nights group by seg order by 4 desc;
end $$;

create or replace function pms_rpt_payment_methods(p_property uuid, p_from date, p_to date)
returns table(method text, kind text, receipts int, amount numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant','front_desk']);
  return query
    select coalesce(l.payment_method_name, initcap(replace(l.payment_method, '_', ' '))), l.payment_method, count(*)::int, -sum(l.amount)
    from pms_folio_lines l
    where l.property_id = p_property and not l.voided and l.line_type in ('payment','refund')
      and l.business_date between p_from and p_to and l.payment_method <> 'city_ledger'
    group by 1, 2
    union all
    select coalesce(b.payment_method_name, initcap(replace(b.payment_method, '_', ' '))) || ' (POS)', b.payment_method, count(*)::int, sum(b.total)
    from pms_pos_bills b where b.property_id = p_property and b.status = 'settled' and b.business_date between p_from and p_to
    group by 1, 2
    order by 4 desc;
end $$;

-- ---------------------------------------------------------------------
-- 10. Booking engine (public): property page, availability and booking without signing in
-- ---------------------------------------------------------------------
create or replace function pms__public_property(p_code text) returns pms_properties
language plpgsql stable security definer set search_path = public as $$
declare p pms_properties;
begin
  select * into p from pms_properties where lower(code) = lower(trim(coalesce(p_code, ''))) and status = 'active';
  if not found or not coalesce((p.settings->'booking_engine'->>'enabled')::boolean, false) then
    raise exception 'Online booking is not open for this property';
  end if;
  return p;
end $$;

create or replace function pms_public_property(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p pms_properties;
begin
  p := pms__public_property(p_code);
  return jsonb_build_object(
    'code', p.code, 'name', p.name, 'property_type', p.property_type, 'star_rating', p.star_rating,
    'address', concat_ws(', ', p.address, p.address_line2, p.city, p.region, p.country), 'phone', coalesce(p.reservation_phone, p.phone),
    'email', p.email, 'website', p.website, 'logo_url', p.logo_url, 'latitude', p.latitude, 'longitude', p.longitude,
    'currency', p.currency, 'tax_inclusive', p.tax_inclusive, 'tax_rate', p.tax_rate,
    'check_in_time', to_char(p.check_in_time, 'HH24:MI'), 'check_out_time', to_char(p.check_out_time, 'HH24:MI'),
    'business_date', p.business_date, 'highlights', p.highlights, 'amenities', p.amenities,
    'policies', p.policies, 'booking', p.settings->'booking_engine',
    'photos', coalesce((select jsonb_agg(jsonb_build_object('url', ph.url, 'caption', ph.caption, 'room_type_id', ph.room_type_id) order by ph.sort_order)
                         from pms_property_photos ph where ph.property_id = p.id), '[]'),
    'room_types', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description, 'size_sqm', t.size_sqm,
                         'bed_type', t.bed_type, 'max_adults', coalesce(t.max_adults, t.max_occupancy), 'max_children', t.max_children) order by t.sort_order, t.name)
                         from pms_room_types t where t.property_id = p.id and t.active), '[]'));
end $$;

-- Every room type × online rate plan with the price for the stay, or why it can't be booked
create or replace function pms_public_availability(p_code text, p_arrival date, p_departure date, p_adults int default 2, p_children int default 0)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p pms_properties; v_n int; out jsonb := '[]'; t record; rp record; v_total numeric; v_free int; v_why text; x record;
begin
  p := pms__public_property(p_code);
  v_n := p_departure - p_arrival;
  if p_arrival is null or p_departure is null or v_n < 1 then raise exception 'Choose an arrival and a later departure'; end if;
  if p_arrival < p.business_date then raise exception 'Arrival cannot be in the past'; end if;
  if p_arrival > p.business_date + 540 then raise exception 'Bookings open 18 months ahead'; end if;
  if v_n > 30 then raise exception 'For stays over 30 nights, please contact the hotel'; end if;
  if coalesce(p_adults, 0) < 1 or coalesce(p_adults, 0) > 12 or coalesce(p_children, 0) < 0 or coalesce(p_children, 0) > 12 then raise exception 'Check the number of guests'; end if;
  for t in select * from pms_room_types where property_id = p.id and active order by sort_order, name loop
    if p_adults > coalesce(t.max_adults, t.max_occupancy) or p_children > greatest(t.max_children, 0) + greatest(coalesce(t.max_adults, t.max_occupancy) - p_adults, 0) then continue; end if;
    select min(pms__free_of_type(t.id, d::date)) into v_free from generate_series(p_arrival, p_departure - 1, interval '1 day') d;
    for rp in select * from pms_rate_plans where property_id = p.id and active and on_booking_engine order by name loop
      v_why := null;
      if v_free < 1 then v_why := 'Sold out'; end if;
      for x in select * from pms_rate_restrictions r where r.room_type_id = t.id and r.rate_plan_id = rp.id and r.rate_date between p_arrival and p_departure loop
        if x.rate_date < p_departure and x.stop_sell then v_why := coalesce(v_why, 'Not available on these dates'); end if;
        if x.rate_date = p_arrival and x.cta then v_why := coalesce(v_why, 'No arrivals on this day'); end if;
        if x.rate_date = p_departure and x.ctd then v_why := coalesce(v_why, 'No departures on this day'); end if;
        if x.rate_date = p_arrival and x.min_stay > v_n then v_why := coalesce(v_why, 'Minimum stay ' || x.min_stay || ' nights'); end if;
        if x.rate_date = p_arrival and x.max_stay is not null and x.max_stay < v_n then v_why := coalesce(v_why, 'Maximum stay ' || x.max_stay || ' nights'); end if;
      end loop;
      select sum(pms__rate_for(t.id, rp.id, d::date, p_adults, p_children)) into v_total from generate_series(p_arrival, p_departure - 1, interval '1 day') d;
      out := out || jsonb_build_object('room_type_id', t.id, 'room_type', t.name, 'rate_plan_id', rp.id, 'rate_plan', rp.name, 'meal_plan', rp.meal_plan,
        'description', rp.description, 'cancellation_policy', rp.cancellation_policy, 'nights', v_n, 'total', round(v_total, 2),
        'per_night', round(v_total / v_n, 2), 'rooms_left', greatest(v_free, 0), 'available', v_why is null, 'reason', v_why);
    end loop;
  end loop;
  return out;
end $$;

-- Make a booking from the website. Abuse limits: per contact per day, per property per hour.
create or replace function pms_public_book(p_code text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  pr pms_properties; v_be jsonb; v_arr date := (p->>'arrival')::date; v_dep date := (p->>'departure')::date;
  v_ad int := coalesce((p->>'adults')::int, 2); v_ch int := coalesce((p->>'children')::int, 0);
  v_type uuid := (p->>'room_type_id')::uuid; v_plan uuid := (p->>'rate_plan_id')::uuid; v_rooms int := coalesce((p->>'rooms')::int, 1);
  v_first text := left(trim(coalesce(p->>'first_name', '')), 60); v_last text := left(trim(coalesce(p->>'last_name', '')), 60);
  v_email text := lower(left(trim(coalesce(p->>'email', '')), 120)); v_phone text := pms__msisdn(p->>'phone');
  v_offer jsonb; v_status text; v_guest uuid; v_res uuid; v_res_no int; v_stay uuid; v_rate numeric; v_src uuid; i int; v_folio uuid;
  v_req jsonb := null; v_type_name text; v_total numeric;
begin
  pr := pms__public_property(p_code);
  v_be := pr.settings->'booking_engine';
  if v_first = '' or v_last = '' then raise exception 'Enter your first and last name'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if v_phone is null then raise exception 'Enter a mobile number such as 0713 000 111 or +255 713 000 111'; end if;
  if v_rooms < 1 or v_rooms > coalesce((v_be->>'max_rooms')::int, 3) then raise exception 'Book between 1 and % rooms online', coalesce((v_be->>'max_rooms')::int, 3); end if;
  if coalesce((v_be->>'require_terms')::boolean, true) and not coalesce((p->>'accept_terms')::boolean, false) then
    raise exception 'Please read and accept the hotel policies';
  end if;
  -- abuse limits
  if (select count(*) from pms_reservations r join pms_guests g on g.id = r.guest_id where r.property_id = pr.id and r.booked_via = 'website'
        and r.created_at > now() - interval '1 day' and (lower(g.email) = v_email or g.phone = v_phone)) >= 3 then
    raise exception 'You have made several bookings today. Please call the hotel to book more.';
  end if;
  if (select count(*) from pms_reservations r where r.property_id = pr.id and r.booked_via = 'website' and r.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Online booking is busy. Please try again in a few minutes or call the hotel.';
  end if;
  -- the offer must still be bookable, with enough rooms
  select o into v_offer from jsonb_array_elements(pms_public_availability(p_code, v_arr, v_dep, v_ad, v_ch)) o
   where (o->>'room_type_id')::uuid = v_type and (o->>'rate_plan_id')::uuid = v_plan;
  if v_offer is null then raise exception 'That room is not offered for these dates or guests'; end if;
  if not (v_offer->>'available')::boolean then raise exception '%', v_offer->>'reason'; end if;
  if (v_offer->>'rooms_left')::int < v_rooms then raise exception 'Only % room(s) of this type left', v_offer->>'rooms_left'; end if;
  v_status := case when v_be->>'default_status' = 'tentative' then 'tentative' else 'confirmed' end;

  select id into v_guest from pms_guests where property_id = pr.id and (lower(email) = v_email or phone = v_phone) order by created_at desc limit 1;
  if v_guest is null then
    insert into pms_guests(property_id, first_name, last_name, phone, email, nationality)
    values (pr.id, v_first, v_last, v_phone, v_email, nullif(left(trim(coalesce(p->>'nationality', '')), 60), '')) returning id into v_guest;
  end if;
  select id into v_src from pms_business_sources where property_id = pr.id and name = 'Website';
  if v_src is null then insert into pms_business_sources(property_id, name, kind) values (pr.id, 'Website', 'direct') returning id into v_src; end if;

  update pms_properties set next_res_no = next_res_no + 1 where id = pr.id returning next_res_no - 1 into v_res_no;
  insert into pms_reservations(property_id, res_no, guest_id, source_id, rate_plan_id, status, arrival, departure, notes, booked_via)
  values (pr.id, v_res_no, v_guest, v_src, v_plan, v_status, v_arr, v_dep,
          nullif(concat_ws(E'\n', 'Booked online.', nullif(left(trim(coalesce(p->>'requests', '')), 500), ''),
                 case when nullif(p->>'arrival_time', '') is not null then 'Arriving around ' || left(p->>'arrival_time', 20) end), ''), 'website')
  returning id into v_res;
  v_rate := round((v_offer->>'total')::numeric / (v_offer->>'nights')::int, 2);
  for i in 1..v_rooms loop
    insert into pms_stays(property_id, reservation_id, room_type_id, arrival, departure, adults, children, rate, status)
    values (pr.id, v_res, v_type, v_arr, v_dep, v_ad, v_ch, v_rate, v_status) returning id into v_stay;
    insert into pms_folios(property_id, folio_no, reservation_id, stay_id, guest_id)
    values (pr.id, pms__next_folio_no(pr.id), v_res, v_stay, v_guest) returning id into v_folio;
  end loop;
  perform pms__refresh_reservation(v_res);
  insert into pms_audit_log(property_id, user_id, action, entity, entity_id, details)
  values (pr.id, null, 'reservation.create', 'reservation', v_res, jsonb_build_object('res_no', v_res_no, 'via', 'website', 'rooms', v_rooms));

  -- pay now by mobile money (ClickPesa push to the guest's phone) when offered
  v_total := (v_offer->>'total')::numeric * v_rooms;
  if coalesce((p->>'pay_now')::boolean, false) and coalesce((v_be->>'pay_now_mobile')::boolean, false)
     and pms__integration_on(pr.id, 'clickpesa') and pr.currency = 'TZS' then
    declare v_ref text := 'BMG' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 17)); v_amt numeric; v_id uuid;
    begin
      v_amt := ceil(case when coalesce((v_be->>'deposit_pct')::numeric, 100) between 1 and 100
                         then v_total * coalesce((v_be->>'deposit_pct')::numeric, 100) / 100 else v_total end);
      select f.id into v_folio from pms_folios f where f.reservation_id = v_res order by folio_no limit 1;
      insert into pms_payment_requests(property_id, folio_id, order_ref, phone, amount, requested_by)
      values (pr.id, v_folio, v_ref, v_phone, v_amt, null) returning id into v_id;
      perform pms__enqueue(pr.id, 'clickpesa', 'ussd_push', jsonb_build_object('request_id', v_id));
      v_req := jsonb_build_object('order_ref', v_ref, 'amount', v_amt, 'phone', v_phone);
    end;
  end if;
  select name into v_type_name from pms_room_types where id = v_type;
  return jsonb_build_object('res_no', v_res_no, 'status', v_status, 'room_type', v_type_name, 'rooms', v_rooms,
    'arrival', v_arr, 'departure', v_dep, 'total', v_total, 'currency', pr.currency, 'payment_request', v_req);
end $$;

-- Charges and messaging must use the stays/reservations created above
create or replace function pms_public_payment_status(p_code text, p_order_ref text) returns text
language plpgsql stable security definer set search_path = public as $$
declare pr pms_properties;
begin
  pr := pms__public_property(p_code);
  return (select status from pms_payment_requests where property_id = pr.id and order_ref = upper(trim(coalesce(p_order_ref, ''))));
end $$;



-- ---------------------------------------------------------------------
-- 12. Changes to earlier functions
-- ---------------------------------------------------------------------
-- New bookings price extra adults and children above what the room includes
create or replace function pms_create_reservation(
  p_property uuid, p_guest jsonb, p_arrival date, p_departure date, p_rooms jsonb,
  p_source_id uuid default null, p_rate_plan_id uuid default null, p_company_id uuid default null,
  p_status text default 'confirmed', p_notes text default null, p_external_ref text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_prop pms_properties; v_guest uuid; v_res uuid; v_res_no int; v_line jsonb;
  v_stay uuid; v_type uuid; v_room uuid; v_rate numeric; v_min int; v_plan uuid;
begin
  perform pms_require(p_property, array['owner','manager','front_desk']);
  select * into v_prop from pms_properties where id = p_property for update;

  if p_departure <= p_arrival then raise exception 'Departure must be after arrival'; end if;
  if p_arrival < v_prop.business_date then
    raise exception 'Arrival (%) is before the business date (%)', p_arrival, v_prop.business_date;
  end if;
  if p_status not in ('confirmed','tentative') then raise exception 'Status must be confirmed or tentative'; end if;
  if jsonb_array_length(coalesce(p_rooms,'[]'::jsonb)) = 0 then raise exception 'Add at least one room'; end if;

  v_plan := coalesce(p_rate_plan_id,
    (select id from pms_rate_plans where property_id = p_property and active order by name limit 1));

  -- Guest
  if p_guest ? 'id' and nullif(p_guest->>'id','') is not null then
    select id into v_guest from pms_guests where id = (p_guest->>'id')::uuid and property_id = p_property;
    if v_guest is null then raise exception 'Guest not found'; end if;
  else
    if coalesce(trim(p_guest->>'first_name'),'') = '' then raise exception 'Guest first name is required'; end if;
    insert into pms_guests(property_id, title, first_name, last_name, phone, email, nationality, id_type, id_number)
    values (p_property, p_guest->>'title', trim(p_guest->>'first_name'), nullif(trim(p_guest->>'last_name'),''),
            p_guest->>'phone', p_guest->>'email', p_guest->>'nationality', p_guest->>'id_type', p_guest->>'id_number')
    returning id into v_guest;
  end if;

  v_res_no := v_prop.next_res_no;
  update pms_properties set next_res_no = next_res_no + 1 where id = p_property;

  insert into pms_reservations(property_id, res_no, guest_id, company_id, source_id, rate_plan_id,
                               status, arrival, departure, notes, external_ref, created_by)
  values (p_property, v_res_no, v_guest, p_company_id, p_source_id, v_plan,
          p_status, p_arrival, p_departure, p_notes, p_external_ref, auth.uid())
  returning id into v_res;

  for v_line in select * from jsonb_array_elements(p_rooms) loop
    v_room := nullif(v_line->>'room_id','')::uuid;
    v_type := nullif(v_line->>'room_type_id','')::uuid;
    if v_room is not null then
      select room_type_id into v_type from pms_rooms where id = v_room and property_id = p_property;
      if v_type is null then raise exception 'Room not found'; end if;
    end if;
    if v_type is null or not exists (select 1 from pms_room_types where id = v_type and property_id = p_property) then
      raise exception 'Room type is required for each room';
    end if;

    select min(pms_type_availability(v_type, d::date)) into v_min
    from generate_series(p_arrival, p_departure - 1, interval '1 day') d;
    if v_min < 1 then
      raise exception 'No % rooms left for some nights between % and %',
        (select name from pms_room_types where id = v_type), p_arrival, p_departure;
    end if;

    v_rate := coalesce(nullif(v_line->>'rate','')::numeric,
      pms__rate_for(v_type, v_plan, p_arrival, coalesce((v_line->>'adults')::int,1), coalesce((v_line->>'children')::int,0)));

    begin
      insert into pms_stays(property_id, reservation_id, room_type_id, room_id, arrival, departure,
                            adults, children, rate, status)
      values (p_property, v_res, v_type, v_room, p_arrival, p_departure,
              coalesce((v_line->>'adults')::int,1), coalesce((v_line->>'children')::int,0), v_rate, p_status)
      returning id into v_stay;
    exception when exclusion_violation then
      raise exception '%', pms__friendly(sqlerrm);
    end;

    insert into pms_folios(property_id, folio_no, reservation_id, stay_id, guest_id, company_id)
    values (p_property, pms__next_folio_no(p_property), v_res, v_stay, v_guest, p_company_id);
  end loop;

  perform pms_log(p_property, 'reservation.create', 'reservation', v_res,
    jsonb_build_object('res_no', v_res_no, 'arrival', p_arrival, 'departure', p_departure,
                       'rooms', jsonb_array_length(p_rooms)));
  return jsonb_build_object('reservation_id', v_res, 'res_no', v_res_no, 'guest_id', v_guest);
end $$;

-- Night audit: tax wording from the tax list; cash paid out for guests is not revenue
create or replace function pms_run_night_audit(p_property uuid, p_mark_no_shows boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p pms_properties; v_bd date; v_no_shows int := 0; rec record; v_folio uuid; v_tax numeric;
  v_avail int; v_sold int; v_room_rev numeric; v_tax_rev numeric; v_other numeric; v_pay numeric;
  v_n int; v_summary jsonb;
begin
  perform pms_require(p_property, array['owner','manager','front_desk']);
  select * into p from pms_properties where id = p_property for update;
  v_bd := p.business_date;

  -- 1. Departures must be handled by a person
  select count(*) into v_n from pms_stays
  where property_id = p_property and status = 'checked_in' and departure <= v_bd;
  if v_n > 0 then
    raise exception '% guest(s) due out are still checked in. Check them out or extend their stay first.', v_n;
  end if;

  -- 2. Arrivals that never came
  select count(*) into v_n from pms_stays
  where property_id = p_property and status in ('confirmed','tentative') and arrival <= v_bd;
  if v_n > 0 and not p_mark_no_shows then
    raise exception '% arrival(s) not checked in. Check them in, cancel them, or run the audit with "mark as no-show".', v_n;
  end if;
  for rec in select id, reservation_id from pms_stays
           where property_id = p_property and status in ('confirmed','tentative') and arrival <= v_bd loop
    update pms_stays set status = 'no_show' where id = rec.id;
    perform pms__refresh_reservation(rec.reservation_id);
    v_no_shows := v_no_shows + 1;
  end loop;

  -- 3. Room charges for tonight
  for rec in
    select st.id, st.rate, st.reservation_id, rm.number, rt.name as type_name
    from pms_stays st join pms_rooms rm on rm.id = st.room_id join pms_room_types rt on rt.id = st.room_type_id
    where st.property_id = p_property and st.status = 'checked_in'
      and st.arrival <= v_bd and st.departure > v_bd
  loop
    select id into v_folio from pms_folios where stay_id = rec.id and status = 'open' order by folio_no limit 1;
    if v_folio is null then
      insert into pms_folios(property_id, folio_no, reservation_id, stay_id, guest_id)
      select p_property, pms__next_folio_no(p_property), rec.reservation_id, rec.id, r.guest_id
      from pms_reservations r where r.id = rec.reservation_id
      returning id into v_folio;
    end if;

    insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount,
                                business_date, posted_by, source)
    values (p_property, v_folio, rec.id, 'charge', 'room',
            'Room ' || rec.number || ' — ' || rec.type_name || ' — ' || to_char(v_bd, 'DD Mon YYYY'),
            rec.rate, v_bd, auth.uid(), 'night_audit')
    on conflict (stay_id, business_date, category) where source = 'night_audit' and not voided do nothing;

    if not p.tax_inclusive and p.tax_rate > 0 and rec.rate > 0 then
      v_tax := round(rec.rate * p.tax_rate / 100, 2);
      insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount,
                                  business_date, posted_by, source)
      values (p_property, v_folio, rec.id, 'charge', 'tax',
              pms__tax_label(p_property) || ' on room ' || rec.number, v_tax, v_bd, auth.uid(), 'night_audit')
      on conflict (stay_id, business_date, category) where source = 'night_audit' and not voided do nothing;
    end if;
  end loop;

  -- 4. Occupied rooms need servicing tomorrow
  update pms_rooms r set hk_status = 'dirty'
  where r.property_id = p_property and r.hk_status in ('clean','inspected')
    and exists (select 1 from pms_stays s where s.room_id = r.id and s.status = 'checked_in');

  -- 5. Statistics
  select count(*) into v_avail from pms_rooms r where r.property_id = p_property and r.active
    and not exists (select 1 from pms_maintenance_blocks b where b.room_id = r.id and b.status = 'active'
                    and v_bd >= b.from_date and v_bd < b.to_date);
  select count(*) into v_sold from pms_stays where property_id = p_property
    and status in ('checked_in','checked_out') and arrival <= v_bd and departure > v_bd;
  select coalesce(sum(amount) filter (where category = 'room'), 0),
         coalesce(sum(amount) filter (where category = 'tax'), 0),
         coalesce(sum(amount) filter (where line_type in ('charge','discount') and category not in ('room','tax','paid_out')), 0),
         coalesce(-sum(amount) filter (where line_type in ('payment','refund') and payment_method <> 'city_ledger'), 0)
    into v_room_rev, v_tax_rev, v_other, v_pay
  from pms_folio_lines where property_id = p_property and business_date = v_bd and not voided;

  v_summary := jsonb_build_object(
    'adr', case when v_sold > 0 then round(v_room_rev / v_sold, 2) else 0 end,
    'revpar', case when v_avail > 0 then round(v_room_rev / v_avail, 2) else 0 end,
    'expenses', (select coalesce(sum(amount),0) from pms_expense_vouchers
                 where property_id = p_property and business_date = v_bd),
    'arrivals', (select count(*) from pms_stays where property_id = p_property and arrival = v_bd
                 and status in ('checked_in','checked_out')),
    'departures', (select count(*) from pms_stays where property_id = p_property and departure = v_bd
                   and status = 'checked_out'),
    'tax_inclusive', p.tax_inclusive);

  insert into pms_night_audits(property_id, business_date, run_by, rooms_available, rooms_sold,
    occupancy_pct, room_revenue, tax_revenue, other_revenue, payments, no_shows, summary)
  values (p_property, v_bd, auth.uid(), v_avail, v_sold,
    case when v_avail > 0 then round(v_sold * 100.0 / v_avail, 2) else 0 end,
    v_room_rev, v_tax_rev, v_other, v_pay, v_no_shows, v_summary);

  update pms_properties set business_date = v_bd + 1 where id = p_property;

  perform pms_log(p_property, 'night_audit.run', 'property', p_property,
    jsonb_build_object('business_date', v_bd, 'rooms_sold', v_sold, 'room_revenue', v_room_rev, 'no_shows', v_no_shows));

  return jsonb_build_object('closed_date', v_bd, 'new_business_date', v_bd + 1,
    'rooms_sold', v_sold, 'rooms_available', v_avail, 'room_revenue', v_room_rev,
    'tax_revenue', v_tax_rev, 'other_revenue', v_other, 'payments', v_pay, 'no_shows', v_no_shows);
end $$;

-- Paid-outs are not revenue
create or replace function pms_rpt_daily_revenue(p_property uuid, p_from date, p_to date)
returns table(business_date date, room numeric, tax numeric, fnb numeric, other numeric, discounts numeric,
              total_revenue numeric, payments numeric, city_ledger numeric, expenses numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant','front_desk']);
  return query
    with days as (select d::date as d from generate_series(p_from, p_to, interval '1 day') d),
    folio as (
      select l.business_date as d,
        coalesce(sum(l.amount) filter (where l.category = 'room'), 0) as room,
        coalesce(sum(l.amount) filter (where l.category = 'tax'), 0) as tax,
        coalesce(sum(l.amount) filter (where l.category = 'fnb'), 0) as fnb,
        coalesce(sum(l.amount) filter (where l.line_type = 'charge' and l.category not in ('room','tax','fnb','paid_out')), 0) as other,
        coalesce(sum(l.amount) filter (where l.line_type = 'discount'), 0) as disc,
        coalesce(-sum(l.amount) filter (where l.line_type in ('payment','refund') and l.payment_method <> 'city_ledger'), 0) as pay,
        coalesce(-sum(l.amount) filter (where l.payment_method = 'city_ledger'), 0) as cl
      from pms_folio_lines l where l.property_id = p_property and not l.voided and l.business_date between p_from and p_to
      group by l.business_date),
    pos as (
      select b.business_date as d,
        coalesce(sum(b.total) filter (where o.charge_category = 'fnb'), 0) as fnb,
        coalesce(sum(b.total) filter (where o.charge_category <> 'fnb'), 0) as other
      from pms_pos_bills b join pms_pos_outlets o on o.id = b.outlet_id
      where b.property_id = p_property and b.status = 'settled' and b.business_date between p_from and p_to
      group by b.business_date),
    exp as (
      select e.business_date as d, sum(e.amount) as amt from pms_expense_vouchers e
      where e.property_id = p_property and e.business_date between p_from and p_to group by e.business_date)
    select days.d,
      coalesce(f.room, 0), coalesce(f.tax, 0), coalesce(f.fnb, 0) + coalesce(p.fnb, 0), coalesce(f.other, 0) + coalesce(p.other, 0),
      coalesce(f.disc, 0),
      coalesce(f.room, 0) + coalesce(f.tax, 0) + coalesce(f.fnb, 0) + coalesce(f.other, 0) + coalesce(f.disc, 0) + coalesce(p.fnb, 0) + coalesce(p.other, 0),
      coalesce(f.pay, 0) + coalesce(p.fnb, 0) + coalesce(p.other, 0),
      coalesce(f.cl, 0), coalesce(e.amt, 0)
    from days left join folio f on f.d = days.d left join pos p on p.d = days.d left join exp e on e.d = days.d
    order by days.d;
end $$;

-- Re-apply 13's same-property checks and foreign-key indexes to the new tables and columns
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


-- ---------------------------------------------------------------------
-- 11. Grants. App functions for signed-in staff; the four public ones for the website.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn, p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like 'pms\_\_%' or p.prorettype = 'trigger'::regtype)
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.fn);
  end loop;
end $$;
grant execute on function pms_set_booking_details(uuid, jsonb), pms_post_payment_method(uuid, numeric, uuid, text, boolean),
  pms_post_extra_charge(uuid, uuid, numeric, text), pms_post_discount_type(uuid, uuid, text), pms_post_room_charge(uuid, text, numeric, text),
  pms_post_adjustment(uuid, numeric, text), pms_post_paid_out(uuid, numeric, text, text), pms_post_meal_plan(uuid, uuid, int),
  pms_post_transport(uuid, text), pms_split_folio(uuid, uuid[]), pms_cut_folio(uuid, date), pms_add_attachment(uuid, text, text, bigint, text),
  pms_remove_attachment(uuid), pms_late_checkout_quote(uuid), pms_pos_attach_guest(uuid, uuid), pms_pos_split_bill(uuid, uuid[]),
  pms_pos_settle_method(uuid, uuid, text), pms_record_sign_in(), pms_list_staff(uuid), pms_staff_devices(uuid, uuid),
  pms_staff_activity(uuid, uuid, int), pms_set_member_title(uuid, uuid, text), pms_reservation_trail(uuid), pms_mfa_blocked_properties(),
  pms_rpt_segments(uuid, date, date), pms_rpt_payment_methods(uuid, date, date), pms_rate_grid(uuid, date, int),
  pms_save_rate_grid(uuid, jsonb), pms_rate(uuid, uuid, date), pms_rate_for(uuid, uuid, date, int, int), pms_role(uuid),
  pms_my_properties(text[]) to authenticated;
-- Supabase gives anon every new function by default; take that back for all but the website's four
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as fn from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname not like 'pms\_public\_%' loop
    execute format('revoke execute on function %s from public, anon', r.fn);
  end loop;
end $$;
revoke execute on function pms_public_property(text), pms_public_availability(text, date, date, int, int), pms_public_book(text, jsonb),
  pms_public_payment_status(text, text) from public;
grant execute on function pms_public_property(text), pms_public_availability(text, date, date, int, int), pms_public_book(text, jsonb),
  pms_public_payment_status(text, text) to anon, authenticated;
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
revoke all on pms_sign_ins from anon, authenticated;

notify pgrst, 'reload schema';
