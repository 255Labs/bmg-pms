-- module: billing
-- also: accounting, back-office, core, operations, platform, procurement, stock
-- 25 · Packages: every module and integration is an add-on with its own price, set per hotel by BMG
--
--  * Price list (platform administrators only): each module and integration with a monthly price and/or a price per
--    active room. "Included" items come with the base plan and cannot be switched off.
--  * Each property has its package: which add-ons are on, and for each an agreed price (instead of the list price),
--    a free-until date, and a note. Only platform administrators change it.
--  * The database enforces the package: an add-on that is off cannot be used (POS bills, activities, stock moves,
--    procurement documents, integrations, QuickBooks, the online booking page).
--  * The monthly invoice lists every paid add-on that is on, with its price.
--  * New properties start with every add-on on. Prices start at 0 so nothing is charged until BMG sets the price list.
-- Safe to re-run.

create table if not exists pms_catalog (
  key             text primary key,
  kind            text not null check (kind in ('module','integration')),
  name            text not null,
  description     text,
  monthly_price   numeric(14,2) not null default 0 check (monthly_price >= 0),
  per_room_price  numeric(14,2) not null default 0 check (per_room_price >= 0),
  included        boolean not null default false,       -- part of the base plan: always on, never charged apart
  default_on      boolean not null default true,        -- switched on for new properties
  active          boolean not null default true,
  sort_order      integer not null default 0,
  updated_at      timestamptz,
  updated_by      uuid
);

insert into pms_catalog(key, kind, name, description, included, sort_order) values
  ('front_office', 'module', 'Front office and night audit', 'Stay view, bookings, check-in and out, folios, cashiering, housekeeping, night audit, reports', true, 1),
  ('city_ledger', 'module', 'City ledger', 'Company accounts, transfers at check-out, receivables', false, 10),
  ('expenses', 'module', 'Expense vouchers', 'Petty cash paid from the drawer', false, 11),
  ('back_office', 'module', 'Agents, exchange rates, packages', 'Travel agents and commission, foreign currency, packages and promotions', false, 12),
  ('guest_services', 'module', 'Guest messages, lost and found', null, false, 13),
  ('booking_engine', 'module', 'Online booking page', 'Direct bookings from the hotel''s own website', false, 14),
  ('pos', 'module', 'Restaurant and bar POS', 'Menus, options, tables, kitchen and bar display, happy hours, split bills, room charges', false, 20),
  ('activities', 'module', 'Activities POS', 'Gym, pool, spa, games, tours: timers, memberships and door check-in', false, 21),
  ('stock', 'module', 'Stock and stores', 'Stores, recipes, stock counts, waste, food cost', false, 22),
  ('procurement', 'module', 'Procurement', 'Suppliers, store requests, purchase orders with approval, deliveries, supplier invoices and payments', false, 23),
  ('assets', 'module', 'Room assets', 'What belongs in each room, room checks, damage charges', false, 24),
  ('revenue_assurance', 'module', 'Revenue assurance', 'Door and camera activity against bookings', false, 25),
  ('import', 'module', 'Import from eZee', 'Guests, bookings and in-house balances from eZee', false, 26),
  ('channex', 'integration', 'Channex channel manager', 'Booking.com, Expedia, Airbnb and more', false, 40),
  ('ttlock', 'integration', 'TTLock door locks', 'A door code per stay', false, 41),
  ('hikvision', 'integration', 'Hikvision cameras', 'Movement per room for revenue assurance', false, 42),
  ('fiscal', 'integration', 'TRA fiscal receipts (VFD)', null, false, 43),
  ('clickpesa', 'integration', 'Mobile money (ClickPesa)', 'Payment requests to guests'' phones', false, 44),
  ('sms', 'integration', 'SMS (Beem)', 'Door codes and guest texts', false, 45),
  ('tendaico', 'integration', 'Tenda ICO tills', 'Outside tills charging to rooms', false, 46),
  ('quickbooks', 'integration', 'QuickBooks Online', 'Suppliers, bills, payments and a daily journal', false, 47)
on conflict (key) do update set kind = excluded.kind, sort_order = excluded.sort_order,
  included = excluded.included, name = case when pms_catalog.updated_by is null then excluded.name else pms_catalog.name end,
  description = case when pms_catalog.updated_by is null then excluded.description else pms_catalog.description end;

create table if not exists pms_property_addons (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references pms_properties(id) on delete cascade,
  key                      text not null references pms_catalog(key) on delete cascade,
  enabled                  boolean not null default true,
  monthly_price_override   numeric(14,2) check (monthly_price_override is null or monthly_price_override >= 0),
  per_room_price_override  numeric(14,2) check (per_room_price_override is null or per_room_price_override >= 0),
  free_until               date,
  note                     text,
  unique (property_id, key)
);
create index if not exists ix_property_addons_key on pms_property_addons (key);

-- Read: the property's owners and managers see their own package; administrators see all. Changes only via functions.
alter table pms_catalog enable row level security;
alter table pms_property_addons enable row level security;
revoke all on pms_catalog, pms_property_addons from anon, authenticated;
grant select on pms_catalog, pms_property_addons to authenticated;
drop policy if exists pms_catalog_read on pms_catalog;
create policy pms_catalog_read on pms_catalog for select using (auth.uid() is not null);
drop policy if exists pms_property_addons_read on pms_property_addons;
create policy pms_property_addons_read on pms_property_addons for select
  using (property_id in (select pms_my_properties(array['owner','manager'])) or pms_is_super_admin());

-- The platform's own tables now include the price list
create or replace function pms__global_tables() returns text[]
language sql immutable as $$
  select array['pms_properties','pms_platform_admins','pms_plans','pms_privilege_catalog','pms_sign_ins',
               'pms_audit_log','pms_integration_log','pms_catalog']
$$;

-- Every property has a row for every add-on (existing ones: on, as they were before packages)
create or replace function pms__seed_addons(p_property uuid, p_new boolean) returns void
language sql security definer set search_path = public as $$
  insert into pms_property_addons(property_id, key, enabled)
  select p_property, c.key, case when p_new then (c.included or c.default_on) else true end from pms_catalog c
  on conflict (property_id, key) do nothing
$$;
select pms__seed_addons(id, false) from pms_properties;

create or replace function pms__new_property_addons() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform pms__seed_addons(new.id, true); return new; end $$;
drop trigger if exists trg_new_property_addons on pms_properties;
create trigger trg_new_property_addons after insert on pms_properties for each row execute function pms__new_property_addons();

-- Is this add-on part of the property's package?
create or replace function pms__addon_on(p_property uuid, p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select c.included or coalesce(a.enabled, false)
                   from pms_catalog c left join pms_property_addons a on a.key = c.key and a.property_id = p_property
                   where c.key = p_key), true)
$$;

create or replace function pms__require_addon(p_property uuid, p_key text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not pms__addon_on(p_property, p_key) then
    raise exception '% is not part of this property''s package. Ask BMG to add it.', (select name from pms_catalog where key = p_key);
  end if;
end $$;

-- The screens follow the package: the features the app reads are kept in step with the add-ons
create or replace function pms__addons_to_features() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update pms_properties p set features = coalesce(p.features, '{}'::jsonb) || jsonb_build_object(
      'pos', pms__addon_on(p.id, 'pos') or pms__addon_on(p.id, 'activities'),
      'stock', pms__addon_on(p.id, 'stock'), 'procurement', pms__addon_on(p.id, 'procurement'),
      'city_ledger', pms__addon_on(p.id, 'city_ledger'), 'expenses', pms__addon_on(p.id, 'expenses'),
      'back_office', pms__addon_on(p.id, 'back_office'), 'guest_services', pms__addon_on(p.id, 'guest_services'),
      'assets', pms__addon_on(p.id, 'assets'), 'import', pms__addon_on(p.id, 'import'),
      'accounting', pms__addon_on(p.id, 'quickbooks'),
      'integrations', exists (select 1 from pms_catalog c where c.kind = 'integration' and pms__addon_on(p.id, c.key)) or pms__addon_on(p.id, 'revenue_assurance'))
  where p.id = new.property_id;
  if new.key = 'booking_engine' and not new.enabled then
    update pms_properties set settings = jsonb_set(coalesce(settings, '{}'), '{booking_engine,enabled}', 'false')
    where id = new.property_id and coalesce((settings->'booking_engine'->>'enabled')::boolean, false);
  end if;
  if not new.enabled then
    update pms_integrations set enabled = false where property_id = new.property_id and provider = new.key and enabled;
  end if;
  return null;
end $$;
drop trigger if exists trg_addons_to_features on pms_property_addons;
create trigger trg_addons_to_features after insert or update on pms_property_addons for each row execute function pms__addons_to_features();

-- Old control-panel module switches (features) now change the package instead
create or replace function pms__features_to_addons() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; v_key text;
begin
  if pg_trigger_depth() > 1 or new.features is not distinct from old.features then return new; end if;
  for k in select jsonb_object_keys(new.features) loop
    continue when (new.features->>k) is not distinct from (old.features->>k);
    v_key := case k when 'integrations' then null when 'accounting' then 'quickbooks' else k end;
    if v_key is not null and exists (select 1 from pms_catalog where key = v_key and not included) then
      update pms_property_addons set enabled = coalesce((new.features->>k)::boolean, true) where property_id = new.id and key = v_key;
      if v_key = 'pos' then update pms_property_addons set enabled = coalesce((new.features->>k)::boolean, true) where property_id = new.id and key = 'activities'; end if;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists trg_features_to_addons on pms_properties;
create trigger trg_features_to_addons after update of features on pms_properties for each row execute function pms__features_to_addons();

-- ---------------------------------------------------------------------
-- Enforcement where each add-on is used
-- ---------------------------------------------------------------------
create or replace function pms__addon_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_type text;
begin
  if tg_table_name = 'pms_pos_bills' then
    select outlet_type into v_type from pms_pos_outlets where id = new.outlet_id;
    perform pms__require_addon(new.property_id, case when v_type in ('gym','pool','games','spa','tours','events') then 'activities' else 'pos' end);
  elsif tg_table_name = 'pms_stock_moves' then
    if new.kind in ('opening','receive','transfer_in','transfer_out','waste','count') and new.grn_line_id is null and new.store_request_id is null then
      perform pms__require_addon(new.property_id, 'stock');
    end if;
  elsif tg_table_name in ('pms_purchase_orders','pms_goods_receipts','pms_supplier_invoices','pms_store_requests') then
    perform pms__require_addon(new.property_id, 'procurement');
  elsif tg_table_name = 'pms_integrations' then
    if new.enabled then perform pms__require_addon(new.property_id, new.provider); end if;
  elsif tg_table_name = 'pms_qbo_states' then
    perform pms__require_addon(new.property_id, 'quickbooks');
  elsif tg_table_name = 'pms_properties' then
    if coalesce((new.settings->'booking_engine'->>'enabled')::boolean, false)
       and not coalesce((old.settings->'booking_engine'->>'enabled')::boolean, false) then
      perform pms__require_addon(new.id, 'booking_engine');
    end if;
  elsif tg_table_name = 'pms_city_ledger' then
    perform pms__require_addon(new.property_id, 'city_ledger');
  elsif tg_table_name = 'pms_expense_vouchers' then
    perform pms__require_addon(new.property_id, 'expenses');
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['pms_pos_bills','pms_stock_moves','pms_purchase_orders','pms_goods_receipts','pms_supplier_invoices',
    'pms_store_requests','pms_qbo_states','pms_city_ledger','pms_expense_vouchers'] loop
    execute format('drop trigger if exists trg_addon_guard on %I', t);
    execute format('create trigger trg_addon_guard before insert on %I for each row execute function pms__addon_guard()', t);
  end loop;
  execute 'drop trigger if exists trg_addon_guard on pms_integrations';
  execute 'create trigger trg_addon_guard before insert or update of enabled on pms_integrations for each row execute function pms__addon_guard()';
  execute 'drop trigger if exists trg_addon_guard on pms_properties';
  execute 'create trigger trg_addon_guard before update of settings on pms_properties for each row execute function pms__addon_guard()';
end $$;

-- The public booking page closes when its add-on is switched off
create or replace function pms__public_property(p_code text) returns pms_properties
language plpgsql stable security definer set search_path = public as $$
declare p pms_properties;
begin
  select * into p from pms_properties where lower(code) = lower(trim(coalesce(p_code, ''))) and status = 'active' and not billing_locked;
  if not found or not coalesce((p.settings->'booking_engine'->>'enabled')::boolean, false) or not pms__addon_on(p.id, 'booking_engine') then
    raise exception 'Online booking is not open for this property';
  end if;
  return p;
end $$;

-- ---------------------------------------------------------------------
-- The monthly invoice lists the paid add-ons
-- ---------------------------------------------------------------------
create or replace function pms__addon_lines(p_property uuid, p_day date) returns jsonb
language sql stable security definer set search_path = public as $$
  with rooms as (select count(*)::int n from pms_rooms where property_id = p_property and active),
  priced as (
    select c.name, c.sort_order, coalesce(a.monthly_price_override, c.monthly_price) as monthly,
           coalesce(a.per_room_price_override, c.per_room_price) as per_room, a.monthly_price_override is not null or a.per_room_price_override is not null as agreed
    from pms_catalog c join pms_property_addons a on a.key = c.key and a.property_id = p_property
    where a.enabled and not c.included and c.active and (a.free_until is null or a.free_until < p_day))
  select coalesce(jsonb_agg(x order by s), '[]') from (
    select p.sort_order * 10 s, jsonb_build_object('label', p.name || case when p.agreed then ' (agreed price)' else '' end, 'qty', 1, 'unit', p.monthly, 'amount', p.monthly, 'addon', true) x
      from priced p where p.monthly > 0
    union all
    select p.sort_order * 10 + 1, jsonb_build_object('label', p.name || ', per active room', 'qty', r.n, 'unit', p.per_room, 'amount', r.n * p.per_room, 'addon', true)
      from priced p, rooms r where p.per_room > 0 and r.n > 0) t
$$;

create or replace function pms__issue_invoice(p_property uuid, p_day date) returns uuid
language plpgsql security definer set search_path = public as $$
declare s pms_subscriptions; pl pms_plans; v_period daterange; v_rooms int; v_users int; v_lines jsonb := '[]'; v_sub numeric := 0;
  v_vat numeric; v_id uuid; v_cur text; v_addons jsonb;
begin
  select * into s from pms_subscriptions where property_id = p_property;
  if not found or s.status = 'cancelled' then return null; end if;
  if s.trial_ends is not null and p_day <= s.trial_ends then return null; end if;
  select * into pl from pms_plans where id = s.plan_id;
  if pl.id is null and s.price_override is null then return null; end if;
  v_period := pms__billing_period(p_day, s.billing_day);
  select id into v_id from pms_sub_invoices where property_id = p_property and period_start = lower(v_period) and status <> 'void';
  if v_id is not null then return v_id; end if;
  select count(*) into v_rooms from pms_rooms where property_id = p_property and active;
  select count(*) into v_users from pms_members where property_id = p_property and active;
  v_cur := coalesce(pl.currency, 'TZS');
  if s.price_override is not null then
    v_lines := jsonb_build_array(jsonb_build_object('label', 'PMS subscription (agreed price)', 'qty', 1, 'unit', s.price_override, 'amount', s.price_override));
    v_sub := s.price_override;
  else
    if pl.base_monthly > 0 then
      v_lines := v_lines || jsonb_build_object('label', pl.name || ' plan, monthly fee', 'qty', 1, 'unit', pl.base_monthly, 'amount', pl.base_monthly);
      v_sub := v_sub + pl.base_monthly;
    end if;
    if pl.per_room > 0 then
      v_lines := v_lines || jsonb_build_object('label', 'Active rooms', 'qty', v_rooms, 'unit', pl.per_room, 'amount', v_rooms * pl.per_room);
      v_sub := v_sub + v_rooms * pl.per_room;
    end if;
    if pl.per_user > 0 then
      v_lines := v_lines || jsonb_build_object('label', 'Active staff accounts', 'qty', v_users, 'unit', pl.per_user, 'amount', v_users * pl.per_user);
      v_sub := v_sub + v_users * pl.per_user;
    end if;
  end if;
  -- add-ons are charged on top of the plan or the agreed price
  v_addons := pms__addon_lines(p_property, p_day);
  v_lines := v_lines || v_addons;
  v_sub := v_sub + coalesce((select sum((x->>'amount')::numeric) from jsonb_array_elements(v_addons) x), 0);
  v_vat := round(v_sub * coalesce(pl.vat_pct, 0) / 100, 2);
  insert into pms_sub_invoices(property_id, invoice_no, period_start, period_end, issued_on, due_on, currency, lines, subtotal, vat, total)
  values (p_property, 'BMG-' || to_char(p_day, 'YYYY') || '-' || lpad(nextval('pms_invoice_no_seq')::text, 5, '0'),
          lower(v_period), upper(v_period) - 1, p_day, p_day + s.due_days, v_cur, v_lines, v_sub, v_vat, v_sub + v_vat)
  returning id into v_id;
  if v_sub + v_vat = 0 then update pms_sub_invoices set status = 'paid' where id = v_id; end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Platform administrators: the price list and each property's package
-- ---------------------------------------------------------------------
create or replace function pms_admin_catalog() returns table(key text, kind text, name text, description text, monthly_price numeric, per_room_price numeric,
  included boolean, default_on boolean, active boolean, sort_order int, properties_on int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_admin();
  return query select c.key, c.kind, c.name, c.description, c.monthly_price, c.per_room_price, c.included, c.default_on, c.active, c.sort_order,
    (select count(*)::int from pms_property_addons a where a.key = c.key and a.enabled)
  from pms_catalog c order by c.sort_order, c.name;
end $$;

create or replace function pms_admin_save_catalog(p_key text, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare c pms_catalog;
begin
  perform pms__require_admin();
  select * into c from pms_catalog where key = p_key for update;
  if not found then raise exception 'Unknown add-on'; end if;
  update pms_catalog set
    name = coalesce(nullif(trim(p->>'name'), ''), name), description = case when p ? 'description' then nullif(trim(p->>'description'), '') else description end,
    monthly_price = coalesce((p->>'monthly_price')::numeric, monthly_price), per_room_price = coalesce((p->>'per_room_price')::numeric, per_room_price),
    default_on = coalesce((p->>'default_on')::boolean, default_on), active = coalesce((p->>'active')::boolean, active),
    updated_at = now(), updated_by = auth.uid()
  where key = p_key;
  insert into pms_audit_log(property_id, user_id, action, entity, entity_id, details)
  values (null, auth.uid(), 'catalog.price', 'catalog', null, jsonb_build_object('key', p_key, 'before', jsonb_build_object('monthly', c.monthly_price, 'per_room', c.per_room_price), 'change', p));
end $$;

create or replace function pms_admin_property_addons(p_property uuid) returns table(key text, kind text, name text, included boolean, enabled boolean,
  list_monthly numeric, list_per_room numeric, monthly_price_override numeric, per_room_price_override numeric, free_until date, note text,
  monthly_now numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_admin();
  return query
    select c.key, c.kind, c.name, c.included, c.included or coalesce(a.enabled, false), c.monthly_price, c.per_room_price,
      a.monthly_price_override, a.per_room_price_override, a.free_until, a.note,
      case when c.included or not coalesce(a.enabled, false) or (a.free_until is not null and a.free_until >= current_date) then 0
           else coalesce(a.monthly_price_override, c.monthly_price)
              + coalesce(a.per_room_price_override, c.per_room_price) * (select count(*) from pms_rooms r where r.property_id = p_property and r.active) end
    from pms_catalog c left join pms_property_addons a on a.key = c.key and a.property_id = p_property
    where c.active
    order by c.sort_order, c.name;
end $$;

-- p: {enabled?, monthly_price_override? ('' = list price), per_room_price_override?, free_until?, note?}
create or replace function pms_admin_set_addon(p_property uuid, p_key text, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare c pms_catalog;
begin
  perform pms__require_admin();
  select * into c from pms_catalog where key = p_key;
  if not found then raise exception 'Unknown add-on'; end if;
  if c.included and (p->>'enabled')::boolean is false then raise exception '% comes with every plan and cannot be switched off', c.name; end if;
  insert into pms_property_addons(property_id, key, enabled) values (p_property, p_key, true) on conflict (property_id, key) do nothing;
  update pms_property_addons set
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    monthly_price_override = case when p ? 'monthly_price_override' then nullif(p->>'monthly_price_override', '')::numeric else monthly_price_override end,
    per_room_price_override = case when p ? 'per_room_price_override' then nullif(p->>'per_room_price_override', '')::numeric else per_room_price_override end,
    free_until = case when p ? 'free_until' then nullif(p->>'free_until', '')::date else free_until end,
    note = case when p ? 'note' then nullif(trim(p->>'note'), '') else note end
  where property_id = p_property and key = p_key;
  insert into pms_audit_log(property_id, user_id, action, entity, entity_id, details)
  values (p_property, auth.uid(), 'package.change', 'property', p_property, jsonb_build_object('addon', p_key) || p);
end $$;

-- Owners and managers: their package and what each item costs them; and what else could be added
create or replace function pms_my_package(p_property uuid) returns table(key text, kind text, name text, description text, included boolean, enabled boolean,
  monthly numeric, per_room numeric, free_until date)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__billing_member(p_property, array['owner','manager']);
  return query
    select c.key, c.kind, c.name, c.description, c.included, c.included or coalesce(a.enabled, false),
      case when c.included then 0 else coalesce(a.monthly_price_override, c.monthly_price) end,
      case when c.included then 0 else coalesce(a.per_room_price_override, c.per_room_price) end, a.free_until
    from pms_catalog c left join pms_property_addons a on a.key = c.key and a.property_id = p_property
    where c.active order by c.included desc, c.sort_order;
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
revoke execute on function pms__seed_addons(uuid, boolean), pms__new_property_addons(), pms__addon_on(uuid, text), pms__require_addon(uuid, text),
  pms__addons_to_features(), pms__features_to_addons(), pms__addon_guard(), pms__addon_lines(uuid, date), pms__global_tables() from authenticated;
grant execute on function pms_admin_catalog(), pms_admin_save_catalog(text, jsonb), pms_admin_property_addons(uuid), pms_admin_set_addon(uuid, text, jsonb),
  pms_my_package(uuid) to authenticated;
select pms__apply_platform_rules();
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';
