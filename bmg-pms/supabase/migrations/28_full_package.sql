-- module: billing
-- also: integrations, operations, payments
-- 28 · Hotel subscriptions: every feature priced on its own, or one "Full package" price for everything
--
--  - A plan can be a Full package: every module and integration is included and switched on, and the monthly
--    invoice shows one package line instead of a line per add-on. Other plans stay à la carte (plan fee plus
--    each add-on at its own price, as before).
--  - pms_package_quote shows, for one hotel, what it pays now feature by feature, the à la carte total, and what
--    each Full package plan would cost instead, so BMG and the owner can compare.
--  - Guest mobile-money payments (ClickPesa for guests' folios and the booking page) are switched off for now:
--    no longer sold, switched off at every hotel, and "pay now" removed from booking pages. BMG still collects
--    the hotels' own subscriptions through BMG's ClickPesa account. The code stays, ready to switch back on.
-- Safe to re-run.

alter table pms_plans add column if not exists all_addons boolean not null default false;

insert into pms_plans(name, currency, base_monthly, per_room, per_user, vat_pct, description, active, trial_days, all_addons)
values ('Full package', 'TZS', 0, 0, 0, 18, 'Every module and integration included, one monthly price', false, 30, true)
on conflict (name) do nothing;

create or replace function pms_admin_save_plan(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id', '')::uuid;
begin
  perform pms__require_admin();
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Give the plan a name'; end if;
  if v_id is null then
    insert into pms_plans(name, currency, base_monthly, per_room, per_user, vat_pct, description, active, trial_days, all_addons)
    values (trim(p->>'name'), coalesce(nullif(p->>'currency', ''), 'TZS'), coalesce((p->>'base_monthly')::numeric, 0), coalesce((p->>'per_room')::numeric, 0),
            coalesce((p->>'per_user')::numeric, 0), coalesce((p->>'vat_pct')::numeric, 0), p->>'description', coalesce((p->>'active')::boolean, true),
            coalesce(nullif(p->>'trial_days', '')::int, 30), coalesce((p->>'all_addons')::boolean, false))
    returning id into v_id;
  else
    update pms_plans set name = trim(p->>'name'), currency = coalesce(nullif(p->>'currency', ''), currency),
      base_monthly = coalesce((p->>'base_monthly')::numeric, base_monthly), per_room = coalesce((p->>'per_room')::numeric, per_room),
      per_user = coalesce((p->>'per_user')::numeric, per_user), vat_pct = coalesce((p->>'vat_pct')::numeric, vat_pct),
      description = p->>'description', active = coalesce((p->>'active')::boolean, active),
      trial_days = coalesce(nullif(p->>'trial_days', '')::int, trial_days),
      all_addons = coalesce((p->>'all_addons')::boolean, all_addons) where id = v_id;
    if not found then raise exception 'Plan not found'; end if;
  end if;
  if (p->>'is_default')::boolean is true then
    update pms_plans set is_default = false where is_default and id <> v_id;
    update pms_plans set is_default = true, active = true where id = v_id;
  end if;
  -- hotels on a Full package plan get everything switched on
  if coalesce((p->>'all_addons')::boolean, false) then
    perform pms__full_package_on(s.property_id) from pms_subscriptions s where s.plan_id = v_id;
  end if;
  return v_id;
end $$;

-- Everything sold switched on for a hotel (used when it moves to a Full package plan)
create or replace function pms__full_package_on(p_property uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into pms_property_addons(property_id, key, enabled)
  select p_property, c.key, true from pms_catalog c where c.active and not c.included
  on conflict (property_id, key) do update set enabled = true where pms_property_addons.enabled = false;
end $$;

create or replace function pms_trg_sub_full_package() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.plan_id is not null and (tg_op = 'INSERT' or new.plan_id is distinct from old.plan_id)
     and exists (select 1 from pms_plans where id = new.plan_id and all_addons) then
    perform pms__full_package_on(new.property_id);
  end if;
  return new;
end $$;
drop trigger if exists trg_sub_full_package on pms_subscriptions;
create trigger trg_sub_full_package after insert or update of plan_id on pms_subscriptions for each row execute function pms_trg_sub_full_package();

-- Add-on lines on the monthly invoice: none on a Full package (it is all in the package price)
create or replace function pms__addon_lines(p_property uuid, p_day date) returns jsonb
language sql stable security definer set search_path = public as $$
  with rooms as (select count(*)::int n from pms_rooms where property_id = p_property and active),
  full_pkg as (select exists (select 1 from pms_subscriptions s join pms_plans pl on pl.id = s.plan_id
                              where s.property_id = p_property and pl.all_addons and s.price_override is null) as yes),
  priced as (
    select c.name, c.sort_order, coalesce(a.monthly_price_override, c.monthly_price) as monthly,
           coalesce(a.per_room_price_override, c.per_room_price) as per_room, a.monthly_price_override is not null or a.per_room_price_override is not null as agreed
    from pms_catalog c join pms_property_addons a on a.key = c.key and a.property_id = p_property, full_pkg
    where not full_pkg.yes and a.enabled and not c.included and c.active and (a.free_until is null or a.free_until < p_day))
  select coalesce(jsonb_agg(x order by s), '[]') from (
    select p.sort_order * 10 s, jsonb_build_object('label', p.name || case when p.agreed then ' (agreed price)' else '' end, 'qty', 1, 'unit', p.monthly, 'amount', p.monthly, 'addon', true) x
      from priced p where p.monthly > 0
    union all
    select p.sort_order * 10 + 1, jsonb_build_object('label', p.name || ', per active room', 'qty', r.n, 'unit', p.per_room, 'amount', r.n * p.per_room, 'addon', true)
      from priced p, rooms r where p.per_room > 0 and r.n > 0) t
$$;

-- What one hotel pays: each feature, the à la carte total, and what a Full package would cost instead
create or replace function pms__package_quote(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s pms_subscriptions; pl pms_plans; v_rooms int; v_users int; v_base numeric := 0; v_addons numeric := 0; v_items jsonb; v_full jsonb;
begin
  select * into s from pms_subscriptions where property_id = p_property;
  select * into pl from pms_plans where id = s.plan_id;
  select count(*) into v_rooms from pms_rooms where property_id = p_property and active;
  select count(*) into v_users from pms_members where property_id = p_property and active;
  v_base := case when s.price_override is not null then s.price_override
                 when pl.id is not null then pl.base_monthly + pl.per_room * v_rooms + pl.per_user * v_users else 0 end;
  select coalesce(jsonb_agg(jsonb_build_object('key', c.key, 'name', c.name, 'kind', c.kind, 'included', c.included,
           'enabled', c.included or coalesce(a.enabled, false),
           'monthly', case when c.included then 0 else coalesce(a.monthly_price_override, c.monthly_price) + coalesce(a.per_room_price_override, c.per_room_price) * v_rooms end,
           'free', a.free_until is not null and a.free_until >= current_date) order by c.included desc, c.sort_order), '[]')
    into v_items
  from pms_catalog c left join pms_property_addons a on a.key = c.key and a.property_id = p_property where c.active;
  select coalesce(sum((x->>'monthly')::numeric), 0) into v_addons from jsonb_array_elements(v_items) x
   where (x->>'enabled')::boolean and not (x->>'included')::boolean and not (x->>'free')::boolean;
  select coalesce(jsonb_agg(jsonb_build_object('plan_id', f.id, 'plan', f.name, 'monthly', f.base_monthly + f.per_room * v_rooms + f.per_user * v_users,
           'active', f.active) order by f.base_monthly), '[]')
    into v_full from pms_plans f where f.all_addons and (f.active or f.id = s.plan_id);
  return jsonb_build_object(
    'plan', pl.name, 'full_package', coalesce(pl.all_addons, false) and s.price_override is null, 'agreed_price', s.price_override,
    'rooms', v_rooms, 'staff', v_users, 'currency', coalesce(pl.currency, 'TZS'), 'vat_pct', coalesce(pl.vat_pct, 18),
    'plan_monthly', v_base,
    'addons_monthly', case when coalesce(pl.all_addons, false) and s.price_override is null then 0 else v_addons end,
    'total_monthly', v_base + case when coalesce(pl.all_addons, false) and s.price_override is null then 0 else v_addons end,
    'a_la_carte_addons', v_addons,
    'items', v_items, 'full_package_options', v_full);
end $$;

create or replace function pms_admin_package_quote(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_admin();
  return pms__package_quote(p_property);
end $$;

create or replace function pms_package_quote(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__billing_member(p_property, array['owner','manager']);
  return pms__package_quote(p_property);
end $$;

-- ---------------------------------------------------------------------
-- Guest mobile money: off for now (BMG's own subscription collection is untouched)
-- ---------------------------------------------------------------------
update pms_catalog set active = false, default_on = false where key = 'clickpesa';
update pms_property_addons set enabled = false where key = 'clickpesa' and enabled;
update pms_integrations set enabled = false where provider = 'clickpesa' and enabled;
update pms_properties set settings = jsonb_set(settings, '{booking_engine,pay_now_mobile}', 'false'::jsonb)
where settings->'booking_engine' ? 'pay_now_mobile' and (settings->'booking_engine'->>'pay_now_mobile')::boolean;

revoke execute on function pms__full_package_on(uuid), pms_trg_sub_full_package(), pms__addon_lines(uuid, date), pms__package_quote(uuid) from public, anon, authenticated;
revoke execute on function pms_admin_package_quote(uuid), pms_package_quote(uuid), pms_admin_save_plan(jsonb) from public, anon;
grant execute on function pms_admin_package_quote(uuid), pms_package_quote(uuid), pms_admin_save_plan(jsonb) to authenticated;
select pms__apply_platform_rules();
notify pgrst, 'reload schema';
