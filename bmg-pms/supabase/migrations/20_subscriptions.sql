-- module: billing
-- also: access, core, platform
-- 20 · Monthly subscriptions: BMG charges each property for its use of the PMS
--
--  * Plans (set by platform administrators): a monthly base fee plus optional amounts per active room and
--    per active staff member, and VAT.
--  * Each property has a subscription: its plan (or an agreed price), billing day, trial end, days to pay
--    and days of grace.
--  * On the billing day an invoice is issued for the month ahead with the usage counted that day.
--  * Owners pay from the PMS by mobile money (ClickPesa USSD push to the BMG platform account) or
--    administrators record a bank or cash payment.
--  * Not fully paid by the due date: the subscription is past due and owners see reminders. Still not paid
--    after the grace days: the property is locked. Nobody can work in it; only its owners can open the
--    billing screen and pay. Full payment unlocks it at once.
--  * Payments are confirmed by asking ClickPesa directly, never on a webhook's word (as for guest payments).
-- Safe to re-run.

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists pms_plans (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  currency      text not null default 'TZS' check (currency ~ '^[A-Z]{3}$'),
  base_monthly  numeric(14,2) not null default 0 check (base_monthly >= 0),
  per_room      numeric(14,2) not null default 0 check (per_room >= 0),
  per_user      numeric(14,2) not null default 0 check (per_user >= 0),
  vat_pct       numeric(5,2)  not null default 0 check (vat_pct >= 0 and vat_pct <= 100),
  description   text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists pms_subscriptions (
  property_id     uuid primary key references pms_properties(id) on delete cascade,
  plan_id         uuid references pms_plans(id),
  price_override  numeric(14,2) check (price_override is null or price_override >= 0),  -- agreed fixed monthly price (before VAT)
  billing_day     integer not null default 1 check (billing_day between 1 and 28),
  trial_ends      date,
  due_days        integer not null default 7 check (due_days between 0 and 60),
  grace_days      integer not null default 7 check (grace_days between 0 and 60),
  status          text not null default 'active' check (status in ('trial','active','past_due','locked','cancelled')),
  hold_until      date,            -- an administrator can keep a property open until this date while payment is sorted
  billing_phone   text,
  billing_email   text,
  notes           text,
  updated_at      timestamptz not null default now()
);
alter table pms_properties add column if not exists billing_locked boolean not null default false;

create sequence if not exists pms_invoice_no_seq;
create table if not exists pms_sub_invoices (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  invoice_no    text not null unique,
  period_start  date not null,
  period_end    date not null,
  issued_on     date not null,
  due_on        date not null,
  currency      text not null default 'TZS',
  lines         jsonb not null default '[]'::jsonb,
  subtotal      numeric(14,2) not null check (subtotal >= 0),
  vat           numeric(14,2) not null default 0 check (vat >= 0),
  total         numeric(14,2) not null check (total >= 0),
  paid          numeric(14,2) not null default 0 check (paid >= 0),
  status        text not null default 'open' check (status in ('open','paid','void')),
  void_reason   text,
  created_at    timestamptz not null default now()
);
create unique index if not exists ux_sub_invoices_period on pms_sub_invoices (property_id, period_start) where status <> 'void';
create index if not exists ix_sub_invoices_property on pms_sub_invoices (property_id, period_start desc);
create index if not exists ix_sub_invoices_open on pms_sub_invoices (status, due_on) where status = 'open';

create table if not exists pms_sub_payments (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references pms_sub_invoices(id) on delete cascade,
  property_id   uuid not null references pms_properties(id) on delete cascade,
  amount        numeric(14,2) not null check (amount > 0),
  method        text not null check (method in ('mobile_money','bank','cash','other')),
  status        text not null default 'queued' check (status in ('queued','sent','paid','failed','expired','cancelled')),
  order_ref     text unique,
  phone         text,
  reference     text,
  provider_txn  text,
  error         text,
  requested_by  uuid,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);
create index if not exists ix_sub_payments_invoice on pms_sub_payments (invoice_id);
create index if not exists ix_sub_payments_property on pms_sub_payments (property_id);
create index if not exists ix_sub_payments_open on pms_sub_payments (status) where status in ('queued','sent');
create index if not exists ix_subscriptions_plan on pms_subscriptions (plan_id);

-- Everything here is reached through the functions below; tables are closed to direct API access
do $$
declare t text;
begin
  foreach t in array array['pms_plans','pms_subscriptions','pms_sub_invoices','pms_sub_payments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence pms_invoice_no_seq from anon, authenticated;

alter table pms_plans add column if not exists is_default boolean not null default false;
alter table pms_plans add column if not exists trial_days integer not null default 30;
do $$ begin
  alter table pms_plans add constraint pms_plans_trial_days_check check (trial_days between 0 and 365);
exception when duplicate_object then null; end $$;
create unique index if not exists ux_plans_default on pms_plans (is_default) where is_default;

-- A default plan so a new platform has something to start from (prices are placeholders to edit)
insert into pms_plans(name, base_monthly, per_room, per_user, vat_pct, description, is_default)
select 'Standard', 150000, 10000, 0, 18, 'Base fee plus a monthly amount per active room', not exists (select 1 from pms_plans where is_default)
where not exists (select 1 from pms_plans where name = 'Standard');

-- Every property gets a subscription on the default plan, starting with that plan's free trial
create or replace function pms__new_subscription() returns trigger
language plpgsql security definer set search_path = public as $$
declare pl pms_plans;
begin
  select * into pl from pms_plans where is_default and active;
  insert into pms_subscriptions(property_id, plan_id, status, trial_ends, billing_day)
  values (new.id, pl.id, case when coalesce(pl.trial_days, 30) > 0 then 'trial' else 'active' end,
          case when coalesce(pl.trial_days, 30) > 0 then pms__today(new.timezone) + coalesce(pl.trial_days, 30) end,
          least(extract(day from pms__today(new.timezone))::int, 28))
  on conflict (property_id) do nothing;
  return new;
end $$;
drop trigger if exists trg_new_subscription on pms_properties;
create trigger trg_new_subscription after insert on pms_properties for each row execute function pms__new_subscription();

-- Properties that already exist when billing is switched on: a 30-day trial, so nobody is locked on day one
insert into pms_subscriptions(property_id, plan_id, status, trial_ends, billing_day)
select p.id, (select id from pms_plans where is_default and active), 'trial', pms__today(p.timezone) + 30, least(extract(day from pms__today(p.timezone))::int, 28)
from pms_properties p
on conflict (property_id) do nothing;

-- ---------------------------------------------------------------------
-- Locked properties drop out of every role check (platform administrators still get in)
-- ---------------------------------------------------------------------
create or replace function pms_role(p_property uuid)
returns text language sql stable security definer set search_path = public as $$
  select m.role from pms_members m join pms_properties p on p.id = m.property_id
  where m.property_id = p_property and m.user_id = auth.uid() and m.active
    and ((p.status = 'active' and not p.billing_locked) or exists (select 1 from pms_platform_admins a where a.user_id = auth.uid()))
    and pms__aal_ok() and pms__mfa_ok_for(p.settings)
$$;

create or replace function pms_my_properties(p_roles text[] default null) returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.property_id from pms_members m join pms_properties p on p.id = m.property_id
  where m.user_id = auth.uid() and m.active and (p_roles is null or m.role = any(p_roles))
    and ((p.status = 'active' and not p.billing_locked) or exists (select 1 from pms_platform_admins a where a.user_id = auth.uid()))
    and pms__aal_ok() and pms__mfa_ok_for(p.settings)
$$;

-- ---------------------------------------------------------------------
-- Working out an invoice
-- ---------------------------------------------------------------------
-- The billing period containing p_day for a subscription billed on p_billing_day
create or replace function pms__billing_period(p_day date, p_billing_day int) returns daterange
language sql immutable as $$
  select daterange(s, (s + interval '1 month')::date, '[)')
  from (select case when extract(day from p_day) >= p_billing_day
                    then make_date(extract(year from p_day)::int, extract(month from p_day)::int, p_billing_day)
                    else (make_date(extract(year from p_day)::int, extract(month from p_day)::int, p_billing_day) - interval '1 month')::date end as s) x
$$;

create or replace function pms__issue_invoice(p_property uuid, p_day date) returns uuid
language plpgsql security definer set search_path = public as $$
declare s pms_subscriptions; pl pms_plans; v_period daterange; v_rooms int; v_users int; v_lines jsonb := '[]'; v_sub numeric := 0;
  v_vat numeric; v_id uuid; v_cur text;
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
  v_vat := round(v_sub * coalesce(pl.vat_pct, 0) / 100, 2);
  insert into pms_sub_invoices(property_id, invoice_no, period_start, period_end, issued_on, due_on, currency, lines, subtotal, vat, total)
  values (p_property, 'BMG-' || to_char(p_day, 'YYYY') || '-' || lpad(nextval('pms_invoice_no_seq')::text, 5, '0'),
          lower(v_period), upper(v_period) - 1, p_day, p_day + s.due_days, v_cur, v_lines, v_sub, v_vat, v_sub + v_vat)
  returning id into v_id;
  if v_sub + v_vat = 0 then update pms_sub_invoices set status = 'paid' where id = v_id; end if;
  return v_id;
end $$;

-- Recompute a property's standing from its invoices: active / past due / locked
create or replace function pms__billing_refresh(p_property uuid, p_day date) returns text
language plpgsql security definer set search_path = public as $$
declare s pms_subscriptions; v_overdue date; v_status text;
begin
  select * into s from pms_subscriptions where property_id = p_property for update;
  if not found then update pms_properties set billing_locked = false where id = p_property and billing_locked; return null; end if;
  if s.status = 'cancelled' then return 'cancelled'; end if;
  select min(due_on) into v_overdue from pms_sub_invoices where property_id = p_property and status = 'open' and paid < total and due_on < p_day;
  v_status := case
    when v_overdue is null then case when s.trial_ends is not null and p_day <= s.trial_ends then 'trial' else 'active' end
    when p_day > v_overdue + s.grace_days and (s.hold_until is null or p_day > s.hold_until) then 'locked'
    else 'past_due' end;
  update pms_subscriptions set status = v_status, updated_at = now() where property_id = p_property and status <> v_status;
  update pms_properties set billing_locked = (v_status = 'locked') where id = p_property and billing_locked <> (v_status = 'locked');
  return v_status;
end $$;

-- Daily run (scheduled through the payments worker, or by an administrator): issue due invoices, then update standing
create or replace function pms__billing_run(p_day date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; v_day date; n_inv int := 0; n_locked int := 0; v_id uuid; v_st text; v_before int;
begin
  for s in select sub.*, p.timezone, p.status as property_status from pms_subscriptions sub join pms_properties p on p.id = sub.property_id where sub.status <> 'cancelled' loop
    v_day := coalesce(p_day, pms__today(s.timezone));
    if s.property_status = 'active' then   -- a property suspended by BMG (e.g. closed for renovation) is not invoiced
      select count(*) into v_before from pms_sub_invoices where property_id = s.property_id;
      v_id := pms__issue_invoice(s.property_id, v_day);
      if (select count(*) from pms_sub_invoices where property_id = s.property_id) > v_before then n_inv := n_inv + 1; end if;
    end if;
    v_st := pms__billing_refresh(s.property_id, v_day);
    if v_st = 'locked' then n_locked := n_locked + 1; end if;
  end loop;
  -- phone requests nobody answered within 30 minutes are given up
  update pms_sub_payments set status = 'expired' where status in ('queued','sent') and created_at < now() - interval '30 minutes';
  return jsonb_build_object('invoices_issued', n_inv, 'locked', n_locked);
end $$;

-- Money in: apply to the invoice and unlock when nothing overdue is left
create or replace function pms__apply_sub_payment(p_payment uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = public as $$
declare pay pms_sub_payments; inv pms_sub_invoices; v_tz text;
begin
  select * into pay from pms_sub_payments where id = p_payment for update;
  select * into inv from pms_sub_invoices where id = pay.invoice_id for update;
  update pms_sub_payments set status = 'paid', amount = p_amount, paid_at = now() where id = p_payment;
  update pms_sub_invoices set paid = paid + p_amount, status = case when paid + p_amount >= total then 'paid' else status end where id = inv.id;
  select timezone into v_tz from pms_properties where id = inv.property_id;
  perform pms__billing_refresh(inv.property_id, pms__today(v_tz));
end $$;

-- ---------------------------------------------------------------------
-- Owners (works even while the property is locked, so they can pay)
-- ---------------------------------------------------------------------
create or replace function pms__billing_member(p_property uuid, p_roles text[]) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_role text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if pms_is_super_admin() then return 'admin'; end if;
  select m.role into v_role from pms_members m join pms_properties p on p.id = m.property_id
  where m.property_id = p_property and m.user_id = auth.uid() and m.active and p.status = 'active'
    and pms__aal_ok() and pms__mfa_ok_for(p.settings);
  if v_role is null or not (v_role = any(p_roles)) then raise exception 'Only the property''s owners can see or pay its subscription'; end if;
  return v_role;
end $$;

create or replace function pms_billing_status(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s pms_subscriptions; pl pms_plans; v_tz text;
begin
  perform pms__billing_member(p_property, array['owner','manager']);
  select * into s from pms_subscriptions where property_id = p_property;
  select * into pl from pms_plans where id = s.plan_id;
  select timezone into v_tz from pms_properties where id = p_property;
  return jsonb_build_object(
    'subscription', case when s.property_id is null then null else jsonb_build_object('status', s.status, 'billing_day', s.billing_day,
      'trial_ends', s.trial_ends, 'due_days', s.due_days, 'grace_days', s.grace_days, 'hold_until', s.hold_until,
      'plan', pl.name, 'price_override', s.price_override, 'billing_phone', s.billing_phone, 'billing_email', s.billing_email) end,
    'plan', case when pl.id is null then null else to_jsonb(pl) - 'created_at' end,
    'today', pms__today(v_tz),
    'next_invoice_on', case when s.property_id is null then null else upper(pms__billing_period(greatest(pms__today(v_tz), coalesce(s.trial_ends + 1, pms__today(v_tz))), s.billing_day)) end,
    'balance', coalesce((select sum(total - paid) from pms_sub_invoices where property_id = p_property and status = 'open'), 0),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'invoice_no', i.invoice_no, 'period_start', i.period_start, 'period_end', i.period_end,
        'issued_on', i.issued_on, 'due_on', i.due_on, 'lock_on', i.due_on + s.grace_days + 1, 'currency', i.currency, 'lines', i.lines,
        'subtotal', i.subtotal, 'vat', i.vat, 'total', i.total, 'paid', i.paid, 'status', i.status) order by i.period_start desc)
      from (select * from pms_sub_invoices where property_id = p_property order by period_start desc limit 24) i), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'invoice_id', x.invoice_id, 'amount', x.amount, 'method', x.method, 'status', x.status,
        'reference', coalesce(x.provider_txn, x.reference), 'phone', x.phone, 'error', x.error, 'created_at', x.created_at, 'paid_at', x.paid_at) order by x.created_at desc)
      from (select * from pms_sub_payments where property_id = p_property order by created_at desc limit 50) x), '[]'::jsonb));
end $$;

-- Properties this person belongs to that are locked for an unpaid subscription
create or replace function pms_billing_blocked_properties() returns table(property_id uuid, name text, role text, balance numeric, currency text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, m.role,
    coalesce((select sum(total - paid) from pms_sub_invoices i where i.property_id = p.id and i.status = 'open'), 0),
    coalesce((select currency from pms_sub_invoices i where i.property_id = p.id order by period_start desc limit 1), 'TZS')
  from pms_members m join pms_properties p on p.id = m.property_id
  where m.user_id = auth.uid() and m.active and p.status = 'active' and p.billing_locked
$$;

-- Ask the owner's phone for the amount still due on an invoice (mobile money via ClickPesa, BMG's account)
create or replace function pms_billing_pay(p_invoice uuid, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare inv pms_sub_invoices; v_phone text := pms__msisdn(p_phone); v_ref text; v_id uuid; v_due numeric;
begin
  select * into inv from pms_sub_invoices where id = p_invoice;
  if not found then raise exception 'Invoice not found'; end if;
  perform pms__billing_member(inv.property_id, array['owner']);
  if inv.status <> 'open' then raise exception 'This invoice is %', inv.status; end if;
  if inv.currency <> 'TZS' then raise exception 'Mobile money is only in TZS; pay this invoice by bank transfer'; end if;
  if v_phone is null then raise exception 'Enter a mobile number such as 0713 000 111 or +255 713 000 111'; end if;
  v_due := ceil(inv.total - inv.paid);
  if v_due <= 0 then raise exception 'Nothing is left to pay on this invoice'; end if;
  if exists (select 1 from pms_sub_payments where invoice_id = p_invoice and status in ('queued','sent') and created_at > now() - interval '3 minutes') then
    raise exception 'A request for this invoice is already waiting on the phone';
  end if;
  v_ref := 'SUB' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 17));
  insert into pms_sub_payments(invoice_id, property_id, amount, method, status, order_ref, phone, requested_by)
  values (p_invoice, inv.property_id, v_due, 'mobile_money', 'queued', v_ref, v_phone, auth.uid()) returning id into v_id;
  update pms_subscriptions set billing_phone = coalesce(billing_phone, v_phone) where property_id = inv.property_id;
  insert into pms_audit_log(property_id, user_id, action, entity, entity_id, details)
  values (inv.property_id, auth.uid(), 'subscription.pay_request', 'subscription', inv.id, jsonb_build_object('invoice', inv.invoice_no, 'amount', v_due, 'order_ref', v_ref));
  return jsonb_build_object('id', v_id, 'order_ref', v_ref, 'phone', v_phone, 'amount', v_due);
end $$;

-- Where a phone request stands (the pay screen polls this)
create or replace function pms_billing_payment_state(p_payment uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare x pms_sub_payments;
begin
  select * into x from pms_sub_payments where id = p_payment;
  if not found then return null; end if;
  perform pms__billing_member(x.property_id, array['owner','manager']);
  return x.status;
end $$;

-- ---------------------------------------------------------------------
-- Platform administrators
-- ---------------------------------------------------------------------
create or replace function pms_admin_billing_overview() returns table(property_id uuid, property text, code text, status text, billing_locked boolean,
  plan text, price_override numeric, billing_day int, trial_ends date, hold_until date, balance numeric, overdue numeric, last_paid timestamptz,
  rooms int, users int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_admin();
  return query
    select p.id, p.name, p.code, coalesce(s.status, 'none'), p.billing_locked, pl.name, s.price_override, s.billing_day, s.trial_ends, s.hold_until,
      coalesce((select sum(i.total - i.paid) from pms_sub_invoices i where i.property_id = p.id and i.status = 'open'), 0),
      coalesce((select sum(i.total - i.paid) from pms_sub_invoices i where i.property_id = p.id and i.status = 'open' and i.due_on < pms__today(p.timezone)), 0),
      (select max(x.paid_at) from pms_sub_payments x where x.property_id = p.id and x.status = 'paid'),
      (select count(*)::int from pms_rooms r where r.property_id = p.id and r.active),
      (select count(*)::int from pms_members m where m.property_id = p.id and m.active)
    from pms_properties p left join pms_subscriptions s on s.property_id = p.id left join pms_plans pl on pl.id = s.plan_id
    order by p.billing_locked desc, p.name;
end $$;

create or replace function pms_admin_plans() returns setof pms_plans
language plpgsql stable security definer set search_path = public as $$
begin perform pms__require_admin(); return query select * from pms_plans order by active desc, name; end $$;

create or replace function pms_admin_save_plan(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id', '')::uuid;
begin
  perform pms__require_admin();
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Give the plan a name'; end if;
  if v_id is null then
    insert into pms_plans(name, currency, base_monthly, per_room, per_user, vat_pct, description, active, trial_days)
    values (trim(p->>'name'), coalesce(nullif(p->>'currency', ''), 'TZS'), coalesce((p->>'base_monthly')::numeric, 0), coalesce((p->>'per_room')::numeric, 0),
            coalesce((p->>'per_user')::numeric, 0), coalesce((p->>'vat_pct')::numeric, 0), p->>'description', coalesce((p->>'active')::boolean, true),
            coalesce(nullif(p->>'trial_days', '')::int, 30))
    returning id into v_id;
  else
    update pms_plans set name = trim(p->>'name'), currency = coalesce(nullif(p->>'currency', ''), currency),
      base_monthly = coalesce((p->>'base_monthly')::numeric, base_monthly), per_room = coalesce((p->>'per_room')::numeric, per_room),
      per_user = coalesce((p->>'per_user')::numeric, per_user), vat_pct = coalesce((p->>'vat_pct')::numeric, vat_pct),
      description = p->>'description', active = coalesce((p->>'active')::boolean, active),
      trial_days = coalesce(nullif(p->>'trial_days', '')::int, trial_days) where id = v_id;
    if not found then raise exception 'Plan not found'; end if;
  end if;
  if (p->>'is_default')::boolean is true then
    update pms_plans set is_default = false where is_default and id <> v_id;
    update pms_plans set is_default = true, active = true where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function pms_admin_set_subscription(p_property uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_tz text;
begin
  perform pms__require_admin();
  select timezone into v_tz from pms_properties where id = p_property;
  if not found then raise exception 'Property not found'; end if;
  insert into pms_subscriptions(property_id) values (p_property) on conflict do nothing;
  update pms_subscriptions set
    plan_id = case when p ? 'plan_id' then nullif(p->>'plan_id', '')::uuid else plan_id end,
    price_override = case when p ? 'price_override' then nullif(p->>'price_override', '')::numeric else price_override end,
    billing_day = coalesce(nullif(p->>'billing_day', '')::int, billing_day),
    trial_ends = case when p ? 'trial_ends' then nullif(p->>'trial_ends', '')::date else trial_ends end,
    due_days = coalesce(nullif(p->>'due_days', '')::int, due_days),
    grace_days = coalesce(nullif(p->>'grace_days', '')::int, grace_days),
    hold_until = case when p ? 'hold_until' then nullif(p->>'hold_until', '')::date else hold_until end,
    billing_phone = case when p ? 'billing_phone' then nullif(p->>'billing_phone', '') else billing_phone end,
    billing_email = case when p ? 'billing_email' then nullif(p->>'billing_email', '') else billing_email end,
    notes = case when p ? 'notes' then p->>'notes' else notes end,
    status = case when (p->>'cancelled')::boolean is true then 'cancelled' when status = 'cancelled' and (p->>'cancelled')::boolean is false then 'active' else status end,
    updated_at = now()
  where property_id = p_property;
  perform pms__billing_refresh(p_property, pms__today(v_tz));
  insert into pms_audit_log(property_id, user_id, action, entity, entity_id, details)
  values (p_property, auth.uid(), 'subscription.set', 'subscription', p_property, p);
end $$;

create or replace function pms_admin_issue_invoice(p_property uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_tz text; v_no text;
begin
  perform pms__require_admin();
  select timezone into v_tz from pms_properties where id = p_property;
  select i.invoice_no into v_no from pms_sub_invoices i join pms_subscriptions s on s.property_id = i.property_id
  where i.property_id = p_property and i.status <> 'void' and i.period_start = lower(pms__billing_period(pms__today(v_tz), s.billing_day));
  if v_no is not null then raise exception 'This month already has invoice %; void it first to issue a new one', v_no; end if;
  v_id := pms__issue_invoice(p_property, pms__today(v_tz));
  if v_id is null then raise exception 'No invoice: the property has no plan or price, is cancelled, or is still in its trial'; end if;
  perform pms__billing_refresh(p_property, pms__today(v_tz));
  return v_id;
end $$;

create or replace function pms_admin_record_payment(p_invoice uuid, p_amount numeric, p_method text, p_reference text) returns void
language plpgsql security definer set search_path = public as $$
declare inv pms_sub_invoices; v_id uuid;
begin
  perform pms__require_admin();
  select * into inv from pms_sub_invoices where id = p_invoice;
  if not found then raise exception 'Invoice not found'; end if;
  if inv.status <> 'open' then raise exception 'This invoice is %', inv.status; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount received'; end if;
  if p_method not in ('mobile_money','bank','cash','other') then raise exception 'Unknown payment method'; end if;
  if coalesce(trim(p_reference), '') = '' then raise exception 'Enter the bank or receipt reference'; end if;
  insert into pms_sub_payments(invoice_id, property_id, amount, method, status, reference, requested_by)
  values (p_invoice, inv.property_id, p_amount, p_method, 'queued', trim(p_reference), auth.uid()) returning id into v_id;
  perform pms__apply_sub_payment(v_id, p_amount);
  insert into pms_audit_log(property_id, user_id, action, entity, entity_id, details)
  values (inv.property_id, auth.uid(), 'subscription.payment', 'subscription', inv.id, jsonb_build_object('invoice', inv.invoice_no, 'amount', p_amount, 'method', p_method, 'reference', p_reference));
end $$;

create or replace function pms_admin_void_invoice(p_invoice uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare inv pms_sub_invoices; v_tz text;
begin
  perform pms__require_admin();
  select * into inv from pms_sub_invoices where id = p_invoice for update;
  if not found then raise exception 'Invoice not found'; end if;
  if inv.paid > 0 then raise exception 'Money has been paid on this invoice; it cannot be voided'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  update pms_sub_invoices set status = 'void', void_reason = trim(p_reason) where id = p_invoice;
  select timezone into v_tz from pms_properties where id = inv.property_id;
  perform pms__billing_refresh(inv.property_id, pms__today(v_tz));
end $$;

create or replace function pms_admin_invoices(p_property uuid default null) returns setof pms_sub_invoices
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_admin();
  return query select * from pms_sub_invoices where p_property is null or property_id = p_property order by issued_on desc, invoice_no desc limit 500;
end $$;

create or replace function pms_admin_billing_run() returns jsonb
language plpgsql security definer set search_path = public as $$
begin perform pms__require_admin(); return pms__billing_run(null); end $$;

-- ---------------------------------------------------------------------
-- Service (the payments worker): daily run, phone requests, results
-- ---------------------------------------------------------------------
create or replace function pms_svc_billing_run() returns jsonb
language plpgsql security definer set search_path = public as $$
begin perform pms__require_service(); return pms__billing_run(null); end $$;

create or replace function pms_svc_billing_queued() returns table(id uuid, order_ref text, phone text, amount numeric, currency text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_service();
  return query select x.id, x.order_ref, x.phone, x.amount, i.currency from pms_sub_payments x join pms_sub_invoices i on i.id = x.invoice_id
    where x.status = 'queued' and x.method = 'mobile_money' and x.created_at > now() - interval '30 minutes' order by x.created_at;
end $$;

create or replace function pms_svc_billing_sent(p_order_ref text, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  update pms_sub_payments set status = case when p_ok then 'sent' else 'failed' end, error = left(p_error, 500)
  where order_ref = p_order_ref and status = 'queued';
end $$;

create or replace function pms_svc_billing_open() returns table(order_ref text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_service();
  return query select x.order_ref from pms_sub_payments x where x.status = 'sent' and x.created_at > now() - interval '24 hours';
end $$;

create or replace function pms_svc_is_billing_order(p_order_ref text) returns boolean
language sql stable security definer set search_path = public as $$
  select pms__is_service() and exists (select 1 from pms_sub_payments where order_ref = p_order_ref)
$$;

-- ClickPesa's answer (asked directly, never taken from a webhook body)
create or replace function pms_svc_billing_result(p_order_ref text, p_status text, p_collected numeric, p_txn text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x pms_sub_payments; v_st text := upper(coalesce(p_status, ''));
begin
  perform pms__require_service();
  select * into x from pms_sub_payments where order_ref = p_order_ref for update;
  if not found then return jsonb_build_object('result', 'unknown'); end if;
  if x.status = 'paid' then return jsonb_build_object('result', 'already_paid'); end if;
  if v_st in ('SUCCESS','SETTLED','COMPLETED') then
    update pms_sub_payments set provider_txn = p_txn where id = x.id;
    perform pms__apply_sub_payment(x.id, coalesce(nullif(p_collected, 0), x.amount));
    insert into pms_audit_log(property_id, user_id, action, entity, entity_id, details)
    values (x.property_id, null, 'subscription.paid', 'subscription', x.invoice_id, jsonb_build_object('order_ref', p_order_ref, 'amount', coalesce(nullif(p_collected, 0), x.amount), 'txn', p_txn));
    return jsonb_build_object('result', 'paid');
  elsif v_st in ('FAILED','REJECTED','CANCELLED','EXPIRED') then
    update pms_sub_payments set status = 'failed', error = 'ClickPesa: ' || v_st where id = x.id and status <> 'paid';
    return jsonb_build_object('result', 'failed');
  end if;
  return jsonb_build_object('result', 'waiting');
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
revoke execute on function pms__new_subscription() from authenticated;
revoke execute on function pms__billing_period(date, int), pms__issue_invoice(uuid, date), pms__billing_refresh(uuid, date),
  pms__billing_run(date), pms__apply_sub_payment(uuid, numeric), pms__billing_member(uuid, text[]) from authenticated;
revoke execute on function pms_svc_billing_run(), pms_svc_billing_queued(), pms_svc_billing_sent(text, boolean, text), pms_svc_billing_open(),
  pms_svc_is_billing_order(text), pms_svc_billing_result(text, text, numeric, text) from authenticated;
grant execute on function pms_billing_status(uuid), pms_billing_payment_state(uuid), pms_billing_blocked_properties(), pms_billing_pay(uuid, text),
  pms_admin_billing_overview(), pms_admin_plans(), pms_admin_save_plan(jsonb), pms_admin_set_subscription(uuid, jsonb),
  pms_admin_issue_invoice(uuid), pms_admin_record_payment(uuid, numeric, text, text), pms_admin_void_invoice(uuid, text),
  pms_admin_invoices(uuid), pms_admin_billing_run(), pms_role(uuid) to authenticated;
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';
