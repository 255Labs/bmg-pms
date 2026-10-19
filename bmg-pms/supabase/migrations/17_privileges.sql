-- module: access
-- also: activities, back-office, core, front-office, integrations, night-audit, operations, payments, platform, reports, stock
-- 17 · Privileges: custom roles, per-person access and per-report access
--
-- The six built-in roles stay. On top of them:
--   * a list of abilities (pms_privilege_catalog), each with the built-in roles that have it by default;
--   * custom roles an owner builds from those abilities (e.g. "Front Office Associate", "Revenue Manager"),
--     each resting on a built-in "base" role that decides which records the person can see;
--   * per-person switches that turn single abilities on or off for one person.
-- Every action function now asks pms_need(property, ability) instead of checking a fixed list of roles,
-- so what the Setup screen shows is exactly what the database allows. Owners always have everything and
-- only owners change roles or access, never their own.
-- Safe to re-run.

create table if not exists pms_privilege_catalog (
  key           text primary key,
  grp           text not null,
  label         text not null,
  default_roles text[] not null,
  sort_order    integer not null default 0
);
-- the list is rebuilt on every run so it always matches src/lib/privileges.js
create temp table _cat (key text, grp text, label text, default_roles text[], sort_order int) on commit drop;
insert into _cat values
  ('res.add', 'res', 'Make new bookings', array['owner','manager','front_desk']::text[], 0),
  ('res.edit', 'res', 'Change booking details, packages and promotions', array['owner','manager','front_desk']::text[], 1),
  ('res.amend', 'res', 'Extend, shorten or change dates, guests and rate', array['owner','manager','front_desk']::text[], 2),
  ('res.cancel', 'res', 'Cancel bookings and mark no-shows', array['owner','manager','front_desk']::text[], 3),
  ('res.assign', 'res', 'Assign and move rooms', array['owner','manager','front_desk']::text[], 4),
  ('res.blacklisted', 'res', 'Book a blacklisted guest', array['owner','manager']::text[], 5),
  ('res.import', 'res', 'Import guests and bookings', array['owner','manager']::text[], 6),
  ('res.merge_guests', 'res', 'Merge duplicate guest profiles', array['owner','manager']::text[], 7),
  ('fo.checkin', 'fo', 'Check guests in', array['owner','manager','front_desk']::text[], 8),
  ('fo.checkin_dirty', 'fo', 'Check in to a dirty room', array['owner','manager','front_desk']::text[], 9),
  ('fo.checkout', 'fo', 'Check guests out', array['owner','manager','front_desk']::text[], 10),
  ('fo.undo_checkin', 'fo', 'Undo a check-in (same day)', array['owner','manager']::text[], 11),
  ('fo.undo_checkout', 'fo', 'Undo a check-out (same day)', array['owner','manager']::text[], 12),
  ('fo.night_audit', 'fo', 'Run the night audit', array['owner','manager','front_desk']::text[], 13),
  ('fo.sms', 'fo', 'Text guests and resend door codes', array['owner','manager','front_desk']::text[], 14),
  ('fo.files', 'fo', 'Add files to a booking', array['owner','manager','front_desk','accountant']::text[], 15),
  ('fo.files_delete', 'fo', 'Delete files from a booking', array['owner','manager']::text[], 16),
  ('fo.charge_damage', 'fo', 'Charge a guest for damage or missing items', array['owner','manager','front_desk']::text[], 17),
  ('fo.credit_limit', 'fo', 'Set credit limits and stop outlet charges', array['owner','manager']::text[], 18),
  ('fo.blacklist', 'fo', 'Blacklist a guest', array['owner','manager']::text[], 19),
  ('cash.payment', 'cash', 'Take payments and mobile-money requests', array['owner','manager','front_desk','accountant']::text[], 20),
  ('cash.charge', 'cash', 'Post charges', array['owner','manager','front_desk','accountant']::text[], 21),
  ('cash.room_charge', 'cash', 'Post room charges (day use, late check-out, no-show)', array['owner','manager','front_desk']::text[], 22),
  ('cash.paid_out', 'cash', 'Pay out cash for a guest', array['owner','manager','front_desk','accountant']::text[], 23),
  ('cash.discount', 'cash', 'Give discounts', array['owner','manager']::text[], 24),
  ('cash.adjustment', 'cash', 'Post adjustments', array['owner','manager']::text[], 25),
  ('cash.void', 'cash', 'Void postings', array['owner','manager']::text[], 26),
  ('cash.transfer', 'cash', 'Move charges between folios', array['owner','manager','front_desk']::text[], 27),
  ('cash.folio', 'cash', 'Open, split and cut folios', array['owner','manager','front_desk']::text[], 28),
  ('cash.drawer', 'cash', 'Open a cash drawer', array['owner','manager','front_desk','accountant']::text[], 29),
  ('cash.drawer_any', 'cash', 'Close someone else''s cash drawer', array['owner','manager']::text[], 30),
  ('cash.expense', 'cash', 'Expense vouchers', array['owner','manager','front_desk','accountant']::text[], 31),
  ('cash.city_ledger', 'cash', 'City ledger payments', array['owner','manager','front_desk','accountant']::text[], 32),
  ('cash.fiscal', 'cash', 'Enter fiscal receipt numbers by hand', array['owner','manager','accountant']::text[], 33),
  ('cash.exchange', 'cash', 'Set exchange rates', array['owner','manager','accountant']::text[], 34),
  ('pos.sell', 'pos', 'Sell at outlets and charge bills to rooms', array['owner','manager','front_desk','accountant']::text[], 35),
  ('pos.discount', 'pos', 'Discount outlet bills', array['owner','manager']::text[], 36),
  ('pos.void', 'pos', 'Void outlet bills', array['owner','manager']::text[], 37),
  ('pos.door', 'pos', 'Check people in at the gym, pool or spa', array['owner','manager','front_desk','accountant','housekeeping']::text[], 38),
  ('pos.cancel_membership', 'pos', 'Cancel memberships and passes', array['owner','manager']::text[], 39),
  ('hk.status', 'hk', 'Change room cleaning status', array['owner','manager','front_desk','housekeeping']::text[], 40),
  ('hk.block', 'hk', 'Take rooms out of order and back', array['owner','manager']::text[], 41),
  ('hk.inspect', 'hk', 'Room checks', array['owner','manager','front_desk','housekeeping','storekeeper']::text[], 42),
  ('hk.assets', 'hk', 'Add and retire room assets', array['owner','manager','storekeeper']::text[], 43),
  ('hk.asset_move', 'hk', 'Move room assets', array['owner','manager','storekeeper','housekeeping']::text[], 44),
  ('rates.edit', 'rates', 'Change rates, minimum and maximum nights and closures', array['owner','manager']::text[], 45),
  ('stock.manage', 'stock', 'Receive, move, waste and count stock', array['owner','manager','accountant','storekeeper']::text[], 46),
  ('stock.recipes', 'stock', 'Edit recipes', array['owner','manager','storekeeper']::text[], 47),
  ('config.integrations', 'config', 'Integrations, till keys and channel sync', array['owner','manager']::text[], 48),
  ('config.user_activity', 'config', 'See staff, devices and activity', array['owner','manager']::text[], 49),
  ('rpt.stays', 'rpt', 'Arrivals, departures, in-house, cancellations and no-shows', array['owner','manager','front_desk','accountant']::text[], 50),
  ('rpt.occupancy', 'rpt', 'Occupancy, ADR and RevPAR', array['owner','manager','front_desk','accountant']::text[], 51),
  ('rpt.daily_revenue', 'rpt', 'Daily revenue', array['owner','manager','front_desk','accountant']::text[], 52),
  ('rpt.payments', 'rpt', 'Receipts', array['owner','manager','front_desk','accountant']::text[], 53),
  ('rpt.payment_methods', 'rpt', 'Payments by method', array['owner','manager','front_desk','accountant']::text[], 54),
  ('rpt.cashier', 'rpt', 'Cashier sales', array['owner','manager','front_desk','accountant']::text[], 55),
  ('rpt.ageing', 'rpt', 'Ageing debtors', array['owner','manager','front_desk','accountant']::text[], 56),
  ('rpt.pos_sales', 'rpt', 'Outlet sales', array['owner','manager','front_desk','accountant']::text[], 57),
  ('rpt.activities', 'rpt', 'Activities and facilities', array['owner','manager','front_desk','accountant']::text[], 58),
  ('rpt.segments', 'rpt', 'Market segments', array['owner','manager','front_desk','accountant']::text[], 59),
  ('rpt.commission', 'rpt', 'Agent commission', array['owner','manager','accountant']::text[], 60),
  ('rpt.voids', 'rpt', 'Voids', array['owner','manager','accountant']::text[], 61),
  ('rpt.audit_trail', 'rpt', 'Audit trail', array['owner','manager','accountant']::text[], 62),
  ('rpt.revenue_assurance', 'rpt', 'Revenue assurance', array['owner','manager','accountant']::text[], 63),
  ('rpt.food_cost', 'rpt', 'Food cost', array['owner','manager','accountant','storekeeper']::text[], 64),
  ('rpt.stock', 'rpt', 'Stock levels and usage', array['owner','manager','accountant','storekeeper']::text[], 65),
  ('pos.kitchen', 'pos', 'Kitchen and bar display: start, finish and take items off', array['owner','manager','accountant','storekeeper']::text[], 66),
  ('pos.menu', 'pos', 'Set up menus, options, tables and happy hours', array['owner','manager']::text[], 67),
  ('pos.transfer', 'pos', 'Move, merge and reassign outlet bills', array['owner','manager','front_desk','accountant']::text[], 68),
  ('proc.request', 'proc', 'Ask the store for stock', array['owner','manager','front_desk','accountant','housekeeping','storekeeper']::text[], 69),
  ('proc.issue', 'proc', 'Issue stock from the store', array['owner','manager','accountant','storekeeper']::text[], 70),
  ('proc.order', 'proc', 'Raise purchase orders', array['owner','manager','accountant','storekeeper']::text[], 71),
  ('proc.approve', 'proc', 'Approve purchase orders', array['owner','manager']::text[], 72),
  ('proc.receive', 'proc', 'Receive deliveries', array['owner','manager','accountant','storekeeper']::text[], 73),
  ('proc.invoice', 'proc', 'Enter supplier invoices', array['owner','manager','accountant']::text[], 74),
  ('proc.pay', 'proc', 'Record payments to suppliers', array['owner','manager','accountant']::text[], 75),
  ('proc.suppliers', 'proc', 'Add and change suppliers', array['owner','manager','accountant','storekeeper']::text[], 76),
  ('acct.quickbooks', 'acct', 'Connect and send to QuickBooks', array['owner','manager','accountant']::text[], 77),
  ('rpt.pos_z', 'rpt', 'Outlet end of day', array['owner','manager','front_desk','accountant']::text[], 78),
  ('rpt.purchases', 'rpt', 'Purchases and goods received', array['owner','manager','accountant','storekeeper']::text[], 79),
  ('rpt.creditors', 'rpt', 'Supplier balances (creditors)', array['owner','manager','accountant']::text[], 80),
  ('rpt.audit_resolve', 'rpt', 'Clear occupancy audit findings', array['owner','manager']::text[], 81),
  ('res.reinstate', 'res', 'Reinstate a no-show or cancelled booking', array['owner','manager']::text[], 82),
  ('fo.portal', 'fo', 'Send and stop guest portal links', array['owner','manager','front_desk']::text[], 83),
  ('fo.requests', 'fo', 'See and handle guest portal requests', array['owner','manager','front_desk','housekeeping']::text[], 84),
  ('hk.maintenance', 'hk', 'Put rooms under maintenance and back (housekeeping board)', array['owner','manager','housekeeping']::text[], 85);
insert into pms_privilege_catalog select * from _cat
on conflict (key) do update set grp = excluded.grp, label = excluded.label, default_roles = excluded.default_roles, sort_order = excluded.sort_order;
delete from pms_privilege_catalog c where not exists (select 1 from _cat x where x.key = c.key);
alter table pms_privilege_catalog enable row level security;
drop policy if exists pms_privilege_catalog_read on pms_privilege_catalog;
create policy pms_privilege_catalog_read on pms_privilege_catalog for select using (auth.uid() is not null);
revoke all on pms_privilege_catalog from anon, authenticated;
grant select on pms_privilege_catalog to authenticated;

-- Custom roles (table from 15) and what each one may do
create table if not exists pms_custom_role_privileges (
  role_id    uuid not null references pms_custom_roles(id) on delete cascade,
  privilege  text not null references pms_privilege_catalog(key) on delete cascade on update cascade,
  primary key (role_id, privilege)
);
create index if not exists ix_crp_privilege on pms_custom_role_privileges (privilege);
alter table pms_custom_role_privileges enable row level security;
drop policy if exists pms_custom_role_privileges_read on pms_custom_role_privileges;
create policy pms_custom_role_privileges_read on pms_custom_role_privileges for select
  using (exists (select 1 from pms_custom_roles r where r.id = role_id and r.property_id in (select pms_my_properties())));
revoke all on pms_custom_role_privileges from anon, authenticated;
grant select on pms_custom_role_privileges to authenticated;
-- Roles are now changed only through pms_save_custom_role (owners); everyone at the property may read them
drop policy if exists pms_custom_roles_write on pms_custom_roles;
revoke insert, update, delete on pms_custom_roles from authenticated;

alter table pms_members add column if not exists custom_role_id uuid references pms_custom_roles(id) on delete set null;
alter table pms_members add column if not exists overrides jsonb not null default '{}'::jsonb;
alter table pms_invites add column if not exists custom_role_id uuid references pms_custom_roles(id) on delete set null;
create index if not exists ix_members_custom_role on pms_members (custom_role_id);
create index if not exists ix_invites_custom_role on pms_invites (custom_role_id);
do $$ begin
  alter table pms_members add constraint pms_members_overrides_obj check (jsonb_typeof(overrides) = 'object');
exception when duplicate_object then null; end $$;

-- Owners hold everything; a role change that leaves the custom role's base drops the custom role
create or replace function pms__guard_member_access() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'owner' then new.custom_role_id := null; new.overrides := '{}'::jsonb; end if;
  if new.custom_role_id is not null and not exists (
       select 1 from pms_custom_roles r where r.id = new.custom_role_id and r.property_id = new.property_id and r.base_role = new.role) then
    new.custom_role_id := null;
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_member_access on pms_members;
create trigger trg_guard_member_access before insert or update on pms_members for each row execute function pms__guard_member_access();

-- ---------------------------------------------------------------------
-- The check
-- ---------------------------------------------------------------------
create or replace function pms__priv_ok(p_property uuid, p_user uuid, p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when m.role = 'owner' then true
      when m.overrides ? p_key then coalesce((m.overrides->>p_key)::boolean, false)
      when m.custom_role_id is not null then exists (
        select 1 from pms_custom_role_privileges x join pms_custom_roles r on r.id = x.role_id
        where x.role_id = m.custom_role_id and x.privilege = p_key and r.active)
      else m.role = any(c.default_roles) end
    from pms_members m join pms_privilege_catalog c on c.key = p_key
    where m.property_id = p_property and m.user_id = p_user and m.active), false)
$$;

-- Signed in, an active member (with two-step sign-in where required), and holding the ability. Returns the role.
create or replace function pms_need(p_property uuid, p_key text) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_role text; v_label text;
begin
  v_role := pms_require(p_property);
  if not pms__priv_ok(p_property, auth.uid(), p_key) then
    select label into v_label from pms_privilege_catalog where key = p_key;
    raise exception 'You cannot perform this: %. Ask an owner to give you this access.', coalesce(v_label, p_key);
  end if;
  return v_role;
end $$;

create or replace function pms_has_priv(p_property uuid, p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select pms_role(p_property) is not null and pms__priv_ok(p_property, auth.uid(), p_key)
$$;

-- Everything the signed-in person may do at this property (the app shows and hides buttons from this)
create or replace function pms_my_privileges(p_property uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(c.key order by c.sort_order), '{}') from pms_privilege_catalog c
  where pms_role(p_property) is not null and pms__priv_ok(p_property, auth.uid(), c.key)
$$;

-- ---------------------------------------------------------------------
-- Every action function asks for its ability instead of a fixed list of roles
-- ---------------------------------------------------------------------
do $$
declare
  m text[] := array[
    'pms_create_reservation','res.add', 'pms_update_reservation','res.edit', 'pms_set_booking_details','res.edit',
    'pms_apply_package','res.edit', 'pms_apply_promotion','res.edit', 'pms_amend_stay','res.amend',
    'pms_cancel_stay','res.cancel', 'pms_assign_room','res.assign',
    'pms_import_guests','res.import', 'pms_import_reservations','res.import',
    'pms_check_in','fo.checkin', 'pms_check_out','fo.checkout', 'pms_run_night_audit','fo.night_audit',
    'pms_send_sms','fo.sms', 'pms_send_door_code_sms','fo.sms',
    'pms_add_attachment','fo.files', 'pms_remove_attachment','fo.files_delete', 'pms_charge_asset','fo.charge_damage',
    'pms_post_payment','cash.payment', 'pms_request_mobile_payment','cash.payment', 'pms_cancel_payment_request','cash.payment',
    'pms_post_charge','cash.charge', 'pms_post_room_charge','cash.room_charge', 'pms_post_paid_out','cash.paid_out',
    'pms_post_discount','cash.discount', 'pms_post_adjustment','cash.adjustment', 'pms_void_line','cash.void',
    'pms_transfer_line','cash.transfer', 'pms_add_folio','cash.folio', 'pms_split_folio','cash.folio',
    'pms_open_drawer','cash.drawer', 'pms_add_expense','cash.expense', 'pms_city_ledger_payment','cash.city_ledger',
    'pms_fiscal_manual','cash.fiscal', 'pms_set_exchange_rate','cash.exchange',
    'pms__pos_bill','pos.sell', 'pms_pos_open_bill','pos.sell', 'pms_pos_running','pos.sell',
    'pms_pos_discount','pos.discount', 'pms_pos_void_bill','pos.void',
    'pms_activity_check_in','pos.door', 'pms_cancel_membership','pos.cancel_membership',
    'pms_set_room_status','hk.status', 'pms_block_room','hk.block', 'pms_release_block','hk.block',
    'pms_inspect_room','hk.inspect', 'pms_add_assets','hk.assets', 'pms_retire_asset','hk.assets', 'pms_move_asset','hk.asset_move',
    'pms_save_rate_grid','rates.edit', 'pms_set_restrictions','rates.edit',
    'pms_receive_stock','stock.manage', 'pms_transfer_stock','stock.manage', 'pms_record_waste','stock.manage',
    'pms_stock_count','stock.manage', 'pms_set_recipe','stock.recipes',
    'pms_create_api_key','config.integrations', 'pms_revoke_api_key','config.integrations',
    'pms_retry_job','config.integrations', 'pms_channex_full_sync','config.integrations',
    'pms_list_staff','config.user_activity', 'pms_staff_activity','config.user_activity', 'pms_staff_devices','config.user_activity',
    'pms_rpt_stays','rpt.stays', 'pms_rpt_occupancy','rpt.occupancy', 'pms_rpt_daily_revenue','rpt.daily_revenue',
    'pms_rpt_payments','rpt.payments', 'pms_rpt_payment_methods','rpt.payment_methods', 'pms_rpt_cashier','rpt.cashier',
    'pms_rpt_ageing','rpt.ageing', 'pms_rpt_pos_sales','rpt.pos_sales', 'pms_rpt_activities','rpt.activities',
    'pms_rpt_segments','rpt.segments', 'pms_rpt_commission','rpt.commission', 'pms_rpt_voids','rpt.voids',
    'pms_rpt_audit_trail','rpt.audit_trail', 'pms_rpt_revenue_assurance','rpt.revenue_assurance',
    'pms_rpt_food_cost','rpt.food_cost', 'pms_rpt_stock_levels','rpt.stock', 'pms_rpt_stock_usage','rpt.stock'];
  -- finer checks inside functions: function, text to find, replacement
  r text[] := array[
    'pms_check_in',
      $x$if v_hk = 'dirty' and not p_allow_dirty then raise exception 'ROOM_DIRTY: Room is dirty'; end if;$x$,
      $x$if v_hk = 'dirty' and not p_allow_dirty then raise exception 'ROOM_DIRTY: Room is dirty'; end if;
  if v_hk = 'dirty' then perform pms_need(v.property_id, 'fo.checkin_dirty'); end if;$x$,
    'pms_close_drawer', $x$pms_role(s.property_id) not in ('owner','manager')$x$,
      $x$not pms__priv_ok(s.property_id, auth.uid(), 'cash.drawer_any')$x$,
    'pms_set_booking_details', $x$pms_role(r.property_id) not in ('owner','manager') then raise exception 'Only a manager sets a credit limit'$x$,
      $x$not pms__priv_ok(r.property_id, auth.uid(), 'fo.credit_limit') then raise exception 'You cannot perform this: Set credit limits'$x$,
    'pms__guard_guest', $x$coalesce(pms_role(new.property_id), '') not in ('owner','manager')$x$,
      $x$not pms__priv_ok(new.property_id, auth.uid(), 'fo.blacklist')$x$,
    'pms__guard_guest', $x$'Only a manager can change the blacklist'$x$, $x$'You cannot perform this: Blacklist a guest'$x$,
    'pms__check_blacklist', $x$coalesce(pms_role(new.property_id), '') not in ('owner','manager')$x$,
      $x$not pms__priv_ok(new.property_id, auth.uid(), 'res.blacklisted')$x$,
    'pms__check_blacklist', 'A manager must make this booking.', 'Someone allowed to book blacklisted guests must make this booking.',
    'pms_can_manage_integrations', $x$coalesce(pms_role(p_property) in ('owner','manager'), false)$x$,
      $x$coalesce(pms_role(p_property) is not null and pms__priv_ok(p_property, auth.uid(), 'config.integrations'), false)$x$,
    'pms_claim_invites', $x$insert into pms_members(property_id, user_id, role, display_name, active) values (i.property_id, auth.uid(), i.role, i.display_name, true)
    on conflict (property_id, user_id) do update set role = excluded.role, active = true;$x$,
      $x$insert into pms_members(property_id, user_id, role, display_name, active, custom_role_id) values (i.property_id, auth.uid(), i.role, i.display_name, true, i.custom_role_id)
    on conflict (property_id, user_id) do update set role = excluded.role, active = true, custom_role_id = excluded.custom_role_id;$x$];
  f record; d text; n text; i int; hits int;
begin
  for i in 1 .. array_length(m, 1) / 2 loop
    hits := 0;
    for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = m[2*i-1] loop
      d := pg_get_functiondef(f.oid);
      n := regexp_replace(d, 'pms_require\(([^,();]+),\s*array\[[^\]]*\]\)', 'pms_need(\1, ''' || m[2*i] || ''')', 'g');
      if n <> d then execute n; hits := hits + 1;
      elsif position('pms_need(' in d) > 0 then hits := hits + 1; end if;
    end loop;
    if hits = 0 then raise exception 'privileges: % has no role check to replace', m[2*i-1]; end if;
  end loop;
  for i in 1 .. array_length(r, 1) / 3 loop
    hits := 0;
    for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = r[3*i-2] loop
      d := pg_get_functiondef(f.oid);
      if position(r[3*i] in d) > 0 then hits := hits + 1;
      elsif position(r[3*i-1] in d) > 0 then execute replace(d, r[3*i-1], r[3*i]); hits := hits + 1; end if;
    end loop;
    if hits = 0 then raise exception 'privileges: text not found in %: %', r[3*i-2], left(r[3*i-1], 60); end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Managing roles and access (owners only, never their own)
-- ---------------------------------------------------------------------
create or replace function pms__check_privs(p_privs text[]) returns void
language plpgsql stable security definer set search_path = public as $$
declare k text;
begin
  foreach k in array coalesce(p_privs, '{}') loop
    if not exists (select 1 from pms_privilege_catalog where key = k) then raise exception 'Unknown ability %', k; end if;
  end loop;
end $$;

-- Create (p_id null) or change a custom role. p_privileges null on create = start from the base role's defaults.
create or replace function pms_save_custom_role(p_property uuid, p_id uuid, p_name text, p_base_role text,
  p_description text default null, p_privileges text[] default null, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_id; v_old pms_custom_roles;
begin
  perform pms_require(p_property, array['owner']);
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the role a name'; end if;
  if p_base_role not in ('manager','front_desk','accountant','housekeeping','storekeeper') then
    raise exception 'A custom role rests on manager, front desk, accountant, housekeeping or storekeeper';
  end if;
  perform pms__check_privs(p_privileges);
  if v_id is null then
    insert into pms_custom_roles(property_id, name, base_role, description, active)
    values (p_property, trim(p_name), p_base_role, p_description, coalesce(p_active, true)) returning id into v_id;
    insert into pms_custom_role_privileges(role_id, privilege)
    select v_id, c.key from pms_privilege_catalog c
    where (p_privileges is null and p_base_role = any(c.default_roles)) or c.key = any(coalesce(p_privileges, '{}'));
  else
    select * into v_old from pms_custom_roles where id = v_id and property_id = p_property for update;
    if not found then raise exception 'Role not found'; end if;
    update pms_custom_roles set name = trim(p_name), base_role = p_base_role, description = p_description,
      active = coalesce(p_active, active) where id = v_id;
    if p_privileges is not null then
      delete from pms_custom_role_privileges where role_id = v_id and privilege <> all(p_privileges);
      insert into pms_custom_role_privileges(role_id, privilege) select v_id, unnest(p_privileges) on conflict do nothing;
    end if;
    -- people holding the role move with its base
    if v_old.base_role <> p_base_role then
      update pms_members set role = p_base_role where custom_role_id = v_id and role <> 'owner';
      update pms_invites set role = p_base_role where custom_role_id = v_id and accepted_at is null;
    end if;
  end if;
  perform pms_log(p_property, case when p_id is null then 'role.create' else 'role.update' end, 'custom_role', v_id,
    jsonb_build_object('name', p_name, 'base_role', p_base_role, 'privileges', p_privileges, 'active', p_active));
  return v_id;
end $$;

create or replace function pms_delete_custom_role(p_role uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r pms_custom_roles;
begin
  select * into r from pms_custom_roles where id = p_role;
  if not found then raise exception 'Role not found'; end if;
  perform pms_require(r.property_id, array['owner']);
  if exists (select 1 from pms_members where custom_role_id = p_role) then
    raise exception 'People still have this role. Give them another role first, or switch the role off.';
  end if;
  delete from pms_custom_roles where id = p_role;
  perform pms_log(r.property_id, 'role.delete', 'custom_role', p_role, jsonb_build_object('name', r.name));
end $$;

-- Give a person (or an open invite, by its id) a custom role and/or switch single abilities on or off for them.
-- p_overrides: {"cash.void": true, "res.cancel": false}; keys left out follow the role.
create or replace function pms_set_member_access(p_property uuid, p_user uuid, p_custom_role uuid, p_overrides jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare v_member pms_members; v_role pms_custom_roles; k text; v jsonb;
begin
  perform pms_require(p_property, array['owner']);
  if p_user = auth.uid() then raise exception 'You cannot change your own access'; end if;
  p_overrides := coalesce(p_overrides, '{}'::jsonb);
  if jsonb_typeof(p_overrides) <> 'object' then raise exception 'Overrides must be an object'; end if;
  for k, v in select * from jsonb_each(p_overrides) loop
    if not exists (select 1 from pms_privilege_catalog where key = k) then raise exception 'Unknown ability %', k; end if;
    if jsonb_typeof(v) <> 'boolean' then raise exception 'Each ability is on (true) or off (false)'; end if;
  end loop;
  if p_custom_role is not null then
    select * into v_role from pms_custom_roles where id = p_custom_role and property_id = p_property;
    if not found then raise exception 'Role not found at this property'; end if;
  end if;
  select * into v_member from pms_members where property_id = p_property and user_id = p_user for update;
  if found then
    if v_member.role = 'owner' then raise exception 'Owners always have full access'; end if;
    update pms_members set role = coalesce(v_role.base_role, role), custom_role_id = p_custom_role, overrides = p_overrides
    where property_id = p_property and user_id = p_user;
  else
    -- an invite that has not been taken up yet
    update pms_invites set role = coalesce(v_role.base_role, role), custom_role_id = p_custom_role
    where id = p_user and property_id = p_property and accepted_at is null and role <> 'owner';
    if not found then raise exception 'Person not found at this property'; end if;
  end if;
  perform pms_log(p_property, 'member.access', 'member', p_user,
    jsonb_build_object('custom_role', v_role.name, 'overrides', p_overrides));
end $$;

-- Who has which role and switches (Setup → Team)
create or replace function pms_staff_access(p_property uuid)
returns table(user_id uuid, kind text, role text, custom_role_id uuid, custom_role text, overrides jsonb, privileges text[])
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'config.user_activity');
  return query
    select m.user_id, 'member'::text, m.role, m.custom_role_id, r.name, m.overrides,
      (select coalesce(array_agg(c.key order by c.sort_order), '{}') from pms_privilege_catalog c where pms__priv_ok(p_property, m.user_id, c.key))
    from pms_members m left join pms_custom_roles r on r.id = m.custom_role_id where m.property_id = p_property
    union all
    select i.id, 'invite', i.role, i.custom_role_id, r.name, '{}'::jsonb, null::text[]
    from pms_invites i left join pms_custom_roles r on r.id = i.custom_role_id
    where i.property_id = p_property and i.accepted_at is null;
end $$;

-- Copy one person's role and switches from this property to every other property where the caller is an owner
-- and the person is a member (eZee "Copy privileges to all hotels"). Custom roles are matched by name and
-- created where missing.
create or replace function pms_copy_access_to_all(p_property uuid, p_user uuid) returns int
language plpgsql security definer set search_path = public as $$
declare src pms_members; src_role pms_custom_roles; t record; v_role uuid; n int := 0;
begin
  perform pms_require(p_property, array['owner']);
  if p_user = auth.uid() then raise exception 'You cannot change your own access'; end if;
  select * into src from pms_members where property_id = p_property and user_id = p_user;
  if not found then raise exception 'Person not found at this property'; end if;
  if src.role = 'owner' then raise exception 'Owners always have full access'; end if;
  if src.custom_role_id is not null then select * into src_role from pms_custom_roles where id = src.custom_role_id; end if;
  for t in select m.property_id from pms_members m
           where m.user_id = p_user and m.property_id <> p_property and m.role <> 'owner'
             and pms_role(m.property_id) = 'owner' loop
    v_role := null;
    if src_role.id is not null then
      select id into v_role from pms_custom_roles where property_id = t.property_id and lower(name) = lower(src_role.name);
      if v_role is null then
        insert into pms_custom_roles(property_id, name, base_role, description, active)
        values (t.property_id, src_role.name, src_role.base_role, src_role.description, src_role.active) returning id into v_role;
      else
        update pms_custom_roles set base_role = src_role.base_role, active = src_role.active where id = v_role;
        delete from pms_custom_role_privileges where role_id = v_role;
      end if;
      insert into pms_custom_role_privileges(role_id, privilege) select v_role, privilege from pms_custom_role_privileges where role_id = src_role.id;
    end if;
    update pms_members set role = src.role, custom_role_id = v_role, overrides = src.overrides
    where property_id = t.property_id and user_id = p_user;
    perform pms_log(t.property_id, 'member.access', 'member', p_user, jsonb_build_object('copied_from', p_property));
    n := n + 1;
  end loop;
  return n;
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
revoke execute on function pms__priv_ok(uuid, uuid, text), pms__check_privs(text[]), pms__guard_member_access() from authenticated;
grant execute on function pms_need(uuid, text), pms_has_priv(uuid, text), pms_my_privileges(uuid),
  pms_save_custom_role(uuid, uuid, text, text, text, text[], boolean), pms_delete_custom_role(uuid),
  pms_set_member_access(uuid, uuid, uuid, jsonb), pms_staff_access(uuid), pms_copy_access_to_all(uuid, uuid) to authenticated;
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';
