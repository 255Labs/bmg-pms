-- module: back-office
-- also: core, front-office, reports
-- =====================================================================
-- BMG PMS — 07 BACK OFFICE
-- POS outlets, travel agents / sales persons / commission, currencies and
-- exchange rates, lost and found, guest messages, packages and promotions.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Booking parties
-- ---------------------------------------------------------------------
create table if not exists pms_travel_agents (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  name            text not null,
  contact_name    text,
  phone           text,
  email           text,
  commission_pct  numeric(5,2) not null default 10 check (commission_pct between 0 and 100),
  active          boolean not null default true,
  unique (property_id, name)
);

create table if not exists pms_sales_persons (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  phone        text,
  email        text,
  active       boolean not null default true,
  unique (property_id, name)
);

alter table pms_reservations add column if not exists travel_agent_id uuid references pms_travel_agents(id);
alter table pms_reservations add column if not exists sales_person_id uuid references pms_sales_persons(id);
alter table pms_reservations add column if not exists promotion_code text;

-- Edit who the booking belongs to after it is made
create or replace function pms_update_reservation(
  p_reservation uuid, p_source_id uuid, p_company_id uuid, p_travel_agent_id uuid,
  p_sales_person_id uuid, p_notes text
) returns void
language plpgsql security definer set search_path = public as $$
declare r pms_reservations;
begin
  select * into r from pms_reservations where id = p_reservation for update;
  if not found then raise exception 'Reservation not found'; end if;
  perform pms_require(r.property_id, array['owner','manager','front_desk']);
  if p_company_id is not null and not exists (select 1 from pms_companies where id = p_company_id and property_id = r.property_id) then raise exception 'Company not found'; end if;
  if p_travel_agent_id is not null and not exists (select 1 from pms_travel_agents where id = p_travel_agent_id and property_id = r.property_id) then raise exception 'Travel agent not found'; end if;
  if p_sales_person_id is not null and not exists (select 1 from pms_sales_persons where id = p_sales_person_id and property_id = r.property_id) then raise exception 'Sales person not found'; end if;
  if p_source_id is not null and not exists (select 1 from pms_business_sources where id = p_source_id and property_id = r.property_id) then raise exception 'Source not found'; end if;
  update pms_reservations set source_id = p_source_id, company_id = p_company_id, travel_agent_id = p_travel_agent_id,
    sales_person_id = p_sales_person_id, notes = nullif(trim(p_notes), '')
  where id = p_reservation;
  -- New folios follow the company; existing open folios with no company pick it up too
  update pms_folios set company_id = p_company_id where reservation_id = p_reservation and status = 'open' and company_id is distinct from p_company_id
    and (company_id is null or company_id = r.company_id);
  perform pms_log(r.property_id, 'reservation.update', 'reservation', p_reservation, jsonb_build_object(
    'source', p_source_id, 'company', p_company_id, 'agent', p_travel_agent_id, 'sales', p_sales_person_id));
end $$;

-- ---------------------------------------------------------------------
-- Currencies and exchange rates (property currency stays the base)
-- ---------------------------------------------------------------------
create table if not exists pms_exchange_rates (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  currency        text not null check (currency ~ '^[A-Z]{3}$'),
  rate            numeric(14,4) not null check (rate > 0),   -- base units per 1 foreign unit
  effective_date  date not null,
  set_by          uuid,
  created_at      timestamptz not null default now(),
  unique (property_id, currency, effective_date)
);

alter table pms_folio_lines add column if not exists fx_currency text;
alter table pms_folio_lines add column if not exists fx_amount numeric(14,2);
alter table pms_folio_lines add column if not exists fx_rate numeric(14,4);

create or replace function pms_set_exchange_rate(p_property uuid, p_currency text, p_rate numeric, p_date date default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_date date;
begin
  perform pms_require(p_property, array['owner','manager','accountant']);
  if upper(p_currency) = (select currency from pms_properties where id = p_property) then raise exception 'That is the base currency'; end if;
  if p_rate is null or p_rate <= 0 then raise exception 'Rate must be greater than zero'; end if;
  v_date := coalesce(p_date, (select business_date from pms_properties where id = p_property));
  insert into pms_exchange_rates(property_id, currency, rate, effective_date, set_by)
  values (p_property, upper(p_currency), p_rate, v_date, auth.uid())
  on conflict (property_id, currency, effective_date) do update set rate = excluded.rate, set_by = excluded.set_by, created_at = now();
  perform pms_log(p_property, 'fx.rate', 'property', p_property, jsonb_build_object('currency', upper(p_currency), 'rate', p_rate, 'date', v_date));
end $$;

create or replace function pms_fx_rate(p_property uuid, p_currency text, p_date date) returns numeric
language sql stable security definer set search_path = public as $$
  select rate from pms_exchange_rates
  where property_id = p_property and currency = upper(p_currency) and effective_date <= p_date
  order by effective_date desc limit 1
$$;

-- Take a payment in a foreign currency; the folio is credited in the base currency
create or replace function pms_post_payment_fx(
  p_folio uuid, p_currency text, p_foreign_amount numeric, p_method text, p_reference text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; p pms_properties; v_rate numeric; v_base numeric; v_line uuid;
begin
  select * into f from pms_folios where id = p_folio;
  if not found then raise exception 'Folio not found'; end if;
  select * into p from pms_properties where id = f.property_id;
  if p_foreign_amount is null or p_foreign_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  v_rate := pms_fx_rate(f.property_id, p_currency, p.business_date);
  if v_rate is null then raise exception 'No exchange rate set for %. Set today''s rate under Back office → Exchange rates.', upper(p_currency); end if;
  v_base := round(p_foreign_amount * v_rate, 2);
  v_line := pms_post_payment(p_folio, v_base, p_method, p_reference, false);
  update pms_folio_lines set fx_currency = upper(p_currency), fx_amount = p_foreign_amount, fx_rate = v_rate,
    description = description || ' (' || upper(p_currency) || ' ' || to_char(p_foreign_amount, 'FM999,999,990.00') || ' @ ' || to_char(v_rate, 'FM999,990.####') || ')'
  where id = v_line;
  return v_line;
end $$;

-- ---------------------------------------------------------------------
-- POS outlets
-- ---------------------------------------------------------------------
create table if not exists pms_pos_outlets (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references pms_properties(id) on delete cascade,
  name             text not null,
  charge_category  text not null default 'fnb' check (charge_category in ('fnb','laundry','minibar','transport','spa','other')),
  active           boolean not null default true,
  unique (property_id, name)
);

create table if not exists pms_pos_items (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  outlet_id    uuid not null references pms_pos_outlets(id) on delete cascade,
  name         text not null,
  group_name   text,
  price        numeric(14,2) not null check (price >= 0),
  active       boolean not null default true,
  sort_order   integer not null default 0
);

alter table pms_properties add column if not exists next_bill_no integer not null default 1;

create table if not exists pms_pos_bills (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references pms_properties(id) on delete cascade,
  outlet_id          uuid not null references pms_pos_outlets(id),
  bill_no            integer not null,
  business_date      date not null,
  table_no           text,
  covers             integer,
  status             text not null default 'open' check (status in ('open','settled','room','void')),
  subtotal           numeric(14,2) not null default 0,
  discount           numeric(14,2) not null default 0,
  total              numeric(14,2) not null default 0,
  payment_method     text check (payment_method in ('cash','mobile_money','card','bank','other')),
  payment_reference  text,
  drawer_session_id  uuid references pms_drawer_sessions(id),
  stay_id            uuid references pms_stays(id),
  folio_line_id      uuid references pms_folio_lines(id),
  void_reason        text,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  closed_at          timestamptz,
  unique (property_id, bill_no)
);
create index if not exists idx_pms_pos_bills_date on pms_pos_bills(property_id, business_date);

create table if not exists pms_pos_bill_items (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references pms_pos_bills(id) on delete cascade,
  item_id    uuid references pms_pos_items(id),
  name       text not null,
  qty        numeric(10,2) not null check (qty > 0),
  price      numeric(14,2) not null check (price >= 0),
  amount     numeric(14,2) not null,
  added_by   uuid,
  added_at   timestamptz not null default now()
);

create or replace function pms__pos_bill(p_bill uuid, p_open boolean default true) returns pms_pos_bills
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills;
begin
  select * into b from pms_pos_bills where id = p_bill for update;
  if not found then raise exception 'Bill not found'; end if;
  perform pms_require(b.property_id, array['owner','manager','front_desk','accountant']);
  if p_open and b.status <> 'open' then raise exception 'Bill #% is already %', b.bill_no, b.status; end if;
  return b;
end $$;

create or replace function pms__pos_total(p_bill uuid) returns void
language sql security definer set search_path = public as $$
  update pms_pos_bills b set subtotal = coalesce((select sum(amount) from pms_pos_bill_items where bill_id = b.id), 0),
    total = greatest(0, coalesce((select sum(amount) from pms_pos_bill_items where bill_id = b.id), 0) - b.discount)
  where b.id = p_bill
$$;

create or replace function pms_pos_open_bill(p_outlet uuid, p_table text default null, p_covers int default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare o pms_pos_outlets; v_no int; v_id uuid;
begin
  select * into o from pms_pos_outlets where id = p_outlet and active;
  if not found then raise exception 'Outlet not found'; end if;
  perform pms_require(o.property_id, array['owner','manager','front_desk','accountant']);
  update pms_properties set next_bill_no = next_bill_no + 1 where id = o.property_id returning next_bill_no - 1 into v_no;
  insert into pms_pos_bills(property_id, outlet_id, bill_no, business_date, table_no, covers, created_by)
  values (o.property_id, p_outlet, v_no, (select business_date from pms_properties where id = o.property_id), p_table, p_covers, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function pms_pos_add_item(p_bill uuid, p_item uuid, p_qty numeric default 1, p_name text default null, p_price numeric default null) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; i pms_pos_items; v_name text; v_price numeric;
begin
  b := pms__pos_bill(p_bill);
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_item is not null then
    select * into i from pms_pos_items where id = p_item and outlet_id = b.outlet_id;
    if not found then raise exception 'Item not on this outlet''s menu'; end if;
    v_name := i.name; v_price := i.price;
  else
    if coalesce(trim(p_name),'') = '' or p_price is null or p_price < 0 then raise exception 'Name and price are required for an open item'; end if;
    v_name := trim(p_name); v_price := p_price;
  end if;
  insert into pms_pos_bill_items(bill_id, item_id, name, qty, price, amount, added_by)
  values (p_bill, p_item, v_name, p_qty, v_price, round(p_qty * v_price, 2), auth.uid());
  perform pms__pos_total(p_bill);
end $$;

create or replace function pms_pos_remove_item(p_bill_item uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_bill uuid;
begin
  select bill_id into v_bill from pms_pos_bill_items where id = p_bill_item;
  if v_bill is null then raise exception 'Line not found'; end if;
  perform pms__pos_bill(v_bill);
  delete from pms_pos_bill_items where id = p_bill_item;
  perform pms__pos_total(v_bill);
end $$;

create or replace function pms_pos_discount(p_bill uuid, p_amount numeric, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills;
begin
  b := pms__pos_bill(p_bill);
  perform pms_require(b.property_id, array['owner','manager']);
  if p_amount < 0 or p_amount > b.subtotal then raise exception 'Discount must be between 0 and the bill subtotal'; end if;
  if coalesce(trim(p_reason),'') = '' and p_amount > 0 then raise exception 'A reason is required'; end if;
  update pms_pos_bills set discount = round(p_amount, 2) where id = p_bill;
  perform pms__pos_total(p_bill);
  perform pms_log(b.property_id, 'pos.discount', 'pos_bill', p_bill, jsonb_build_object('bill_no', b.bill_no, 'amount', p_amount, 'reason', p_reason));
end $$;

-- Walk-in: paid at the outlet
create or replace function pms_pos_settle(p_bill uuid, p_method text, p_reference text default null) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; v_drawer uuid;
begin
  b := pms__pos_bill(p_bill);
  if b.total <= 0 then raise exception 'Add items before settling'; end if;
  if p_method not in ('cash','mobile_money','card','bank','other') then raise exception 'Unknown payment method'; end if;
  if p_method in ('mobile_money','card','bank') and coalesce(trim(p_reference),'') = '' then raise exception 'A transaction reference is required'; end if;
  if p_method = 'cash' then
    v_drawer := pms__drawer(b.property_id);
    if v_drawer is null then raise exception 'Open your cash drawer before taking cash'; end if;
  end if;
  update pms_pos_bills set status = 'settled', payment_method = p_method, payment_reference = p_reference,
    drawer_session_id = v_drawer, closed_at = now() where id = p_bill;
  perform pms_log(b.property_id, 'pos.settle', 'pos_bill', p_bill, jsonb_build_object('bill_no', b.bill_no, 'amount', b.total, 'method', p_method));
end $$;

-- In-house guest: charge to their room folio
create or replace function pms_pos_post_to_room(p_bill uuid, p_stay uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; s pms_stays; o pms_pos_outlets; v_folio uuid; v_line uuid; v_room text;
begin
  b := pms__pos_bill(p_bill);
  if b.total <= 0 then raise exception 'Add items before posting'; end if;
  select * into s from pms_stays where id = p_stay and property_id = b.property_id;
  if not found or s.status <> 'checked_in' then raise exception 'Room charges can only go to a checked-in guest'; end if;
  select id into v_folio from pms_folios where stay_id = p_stay and status = 'open' order by folio_no limit 1;
  if v_folio is null then raise exception 'This guest has no open folio'; end if;
  select * into o from pms_pos_outlets where id = b.outlet_id;
  select number into v_room from pms_rooms where id = s.room_id;
  v_line := pms_post_charge(v_folio, o.charge_category, o.name || ' bill #' || b.bill_no, b.total, 'POS ' || b.bill_no);
  update pms_pos_bills set status = 'room', stay_id = p_stay, folio_line_id = v_line, closed_at = now() where id = p_bill;
  perform pms_log(b.property_id, 'pos.room', 'pos_bill', p_bill, jsonb_build_object('bill_no', b.bill_no, 'amount', b.total, 'room', v_room));
  return v_line;
end $$;

create or replace function pms_pos_void_bill(p_bill uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills;
begin
  b := pms__pos_bill(p_bill, false);
  perform pms_require(b.property_id, array['owner','manager']);
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  if b.status = 'void' then raise exception 'Already void'; end if;
  if b.status = 'settled' and b.drawer_session_id is not null and exists (select 1 from pms_drawer_sessions where id = b.drawer_session_id and status = 'closed') then
    raise exception 'This cash was counted in a closed drawer and cannot be voided';
  end if;
  if b.status = 'room' then perform pms_void_line(b.folio_line_id, 'POS bill #' || b.bill_no || ' voided: ' || p_reason); end if;
  update pms_pos_bills set status = 'void', void_reason = p_reason, closed_at = coalesce(closed_at, now()) where id = p_bill;
  perform pms_log(b.property_id, 'pos.void', 'pos_bill', p_bill, jsonb_build_object('bill_no', b.bill_no, 'amount', b.total, 'reason', p_reason));
end $$;

-- Drawer now includes cash taken at outlets
create or replace function pms_drawer_expected(p_session uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select s.opening_float
       - coalesce((select sum(l.amount) from pms_folio_lines l
                   where l.drawer_session_id = s.id and not l.voided and l.payment_method = 'cash'), 0)
       + coalesce((select sum(c.amount) * -1 from pms_city_ledger c
                   where c.entry_type = 'payment' and c.payment_method = 'cash'
                     and c.reference = 'drawer:' || s.id::text), 0)
       + coalesce((select sum(b.total) from pms_pos_bills b
                   where b.drawer_session_id = s.id and b.status = 'settled' and b.payment_method = 'cash'), 0)
       - coalesce((select sum(e.amount) from pms_expense_vouchers e
                   where e.drawer_session_id = s.id), 0)
  from pms_drawer_sessions s where s.id = p_session
$$;

-- ---------------------------------------------------------------------
-- Guest services
-- ---------------------------------------------------------------------
create table if not exists pms_lost_found (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  found_on      date not null default current_date,
  location      text,
  room_id       uuid references pms_rooms(id) on delete set null,
  description   text not null,
  found_by      text,
  status        text not null default 'stored' check (status in ('stored','returned','disposed')),
  returned_to   text,
  returned_on   date,
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create table if not exists pms_guest_messages (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  reservation_id  uuid references pms_reservations(id) on delete cascade,
  message         text not null,
  from_name       text,
  status          text not null default 'pending' check (status in ('pending','delivered')),
  taken_by        uuid,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);

create table if not exists pms_packages (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references pms_properties(id) on delete cascade,
  name           text not null,
  room_type_id   uuid references pms_room_types(id) on delete cascade,
  price_mode     text not null default 'per_night' check (price_mode in ('per_night','per_stay')),
  price          numeric(14,2) not null check (price > 0),
  min_nights     integer not null default 1,
  inclusions     text,
  valid_from     date,
  valid_to       date,
  active         boolean not null default true,
  unique (property_id, name)
);

create table if not exists pms_promotions (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  code            text not null,
  name            text not null,
  discount_pct    numeric(5,2) check (discount_pct > 0 and discount_pct <= 100),
  min_nights      integer not null default 1,
  valid_from      date,
  valid_to        date,
  active          boolean not null default true,
  unique (property_id, code)
);

-- Re-price the live stays of a reservation from a package
create or replace function pms_apply_package(p_reservation uuid, p_package uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r pms_reservations; k pms_packages; s pms_stays; v_n int; v_rate numeric;
begin
  select * into r from pms_reservations where id = p_reservation;
  if not found then raise exception 'Reservation not found'; end if;
  perform pms_require(r.property_id, array['owner','manager','front_desk']);
  select * into k from pms_packages where id = p_package and property_id = r.property_id and active;
  if not found then raise exception 'Package not found'; end if;
  if k.valid_from is not null and r.arrival < k.valid_from or k.valid_to is not null and r.arrival > k.valid_to then
    raise exception 'Package is not valid for an arrival on %', r.arrival;
  end if;
  for s in select * from pms_stays where reservation_id = p_reservation and status in ('tentative','confirmed','checked_in') loop
    if k.room_type_id is not null and s.room_type_id <> k.room_type_id then raise exception 'Package is for a different room type'; end if;
    v_n := s.departure - s.arrival;
    if v_n < k.min_nights then raise exception 'Package needs at least % nights', k.min_nights; end if;
    v_rate := case when k.price_mode = 'per_stay' then round(k.price / v_n, 2) else k.price end;
    update pms_stays set rate = v_rate where id = s.id;
  end loop;
  update pms_reservations set notes = trim(coalesce(notes || E'\n', '') || 'Package: ' || k.name || coalesce(' (' || k.inclusions || ')', ''))
  where id = p_reservation;
  perform pms_log(r.property_id, 'reservation.package', 'reservation', p_reservation, jsonb_build_object('package', k.name));
end $$;

-- Apply a promotion code: percentage off the nightly rate of live stays
create or replace function pms_apply_promotion(p_reservation uuid, p_code text) returns numeric
language plpgsql security definer set search_path = public as $$
declare r pms_reservations; pr pms_promotions; s pms_stays;
begin
  select * into r from pms_reservations where id = p_reservation;
  if not found then raise exception 'Reservation not found'; end if;
  perform pms_require(r.property_id, array['owner','manager','front_desk']);
  if r.promotion_code is not null then raise exception 'Promotion % is already applied', r.promotion_code; end if;
  select * into pr from pms_promotions where property_id = r.property_id and upper(code) = upper(trim(p_code)) and active;
  if not found then raise exception 'Promotion code not recognised'; end if;
  if pr.valid_from is not null and r.arrival < pr.valid_from or pr.valid_to is not null and r.arrival > pr.valid_to then
    raise exception 'Promotion is not valid for an arrival on %', r.arrival;
  end if;
  if (r.departure - r.arrival) < pr.min_nights then raise exception 'Promotion needs at least % nights', pr.min_nights; end if;
  for s in select * from pms_stays where reservation_id = p_reservation and status in ('tentative','confirmed','checked_in') loop
    update pms_stays set rate = round(s.rate * (1 - pr.discount_pct / 100), 2) where id = s.id;
  end loop;
  update pms_reservations set promotion_code = pr.code where id = p_reservation;
  perform pms_log(r.property_id, 'reservation.promotion', 'reservation', p_reservation, jsonb_build_object('code', pr.code, 'pct', pr.discount_pct));
  return pr.discount_pct;
end $$;

-- ---------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------
create or replace function pms_rpt_pos_sales(p_property uuid, p_from date, p_to date)
returns table(outlet text, bills int, walk_in numeric, to_rooms numeric, discounts numeric, total numeric, cash numeric, voided int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant','front_desk']);
  return query
    select o.name,
      count(*) filter (where b.status in ('settled','room'))::int,
      coalesce(sum(b.total) filter (where b.status = 'settled'), 0),
      coalesce(sum(b.total) filter (where b.status = 'room'), 0),
      coalesce(sum(b.discount) filter (where b.status in ('settled','room')), 0),
      coalesce(sum(b.total) filter (where b.status in ('settled','room')), 0),
      coalesce(sum(b.total) filter (where b.status = 'settled' and b.payment_method = 'cash'), 0),
      count(*) filter (where b.status = 'void')::int
    from pms_pos_outlets o
    left join pms_pos_bills b on b.outlet_id = o.id and b.business_date between p_from and p_to
    where o.property_id = p_property
    group by o.name order by o.name;
end $$;

create or replace function pms_rpt_commission(p_property uuid, p_from date, p_to date)
returns table(party_type text, party text, res_no int, guest text, arrival date, departure date,
              room_revenue numeric, commission_pct numeric, commission numeric, sales_person text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant']);
  return query
    with rev as (
      select f.reservation_id, coalesce(sum(l.amount), 0) as amt
      from pms_folio_lines l join pms_folios f on f.id = l.folio_id
      where l.property_id = p_property and l.category = 'room' and not l.voided and l.business_date between p_from and p_to
      group by f.reservation_id)
    select case when ta.id is not null then 'Travel agent' when bs.commission_pct > 0 then 'Source' else 'Sales person' end,
      coalesce(ta.name, bs.name, sp.name, '—'), r.res_no, pms__guest_name(g), r.arrival, r.departure,
      rev.amt, coalesce(ta.commission_pct, nullif(bs.commission_pct, 0), 0),
      round(rev.amt * coalesce(ta.commission_pct, nullif(bs.commission_pct, 0), 0) / 100, 2),
      sp.name
    from rev
    join pms_reservations r on r.id = rev.reservation_id
    join pms_guests g on g.id = r.guest_id
    left join pms_travel_agents ta on ta.id = r.travel_agent_id
    left join pms_business_sources bs on bs.id = r.source_id
    left join pms_sales_persons sp on sp.id = r.sales_person_id
    where ta.id is not null or bs.commission_pct > 0 or sp.id is not null
    order by 2, r.res_no;
end $$;

-- Daily revenue now includes walk-in POS sales
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
        coalesce(sum(l.amount) filter (where l.line_type = 'charge' and l.category not in ('room','tax','fnb')), 0) as other,
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

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pms_travel_agents','pms_sales_persons','pms_exchange_rates','pms_pos_outlets','pms_pos_items',
                           'pms_pos_bills','pms_lost_found','pms_guest_messages','pms_packages','pms_promotions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (pms_is_member(property_id))', t || '_read', t);
  end loop;
  -- maintained by owners and managers
  foreach t in array array['pms_travel_agents','pms_sales_persons','pms_pos_outlets','pms_pos_items','pms_packages','pms_promotions'] loop
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format($p$create policy %I on %I for all using (pms_role(property_id) in ('owner','manager'))
      with check (pms_role(property_id) in ('owner','manager'))$p$, t || '_write', t);
  end loop;
  -- every member logs lost property and messages
  foreach t in array array['pms_lost_found','pms_guest_messages'] loop
    execute format('drop policy if exists %I on %I', t || '_ins', t);
    execute format('create policy %I on %I for insert with check (pms_is_member(property_id))', t || '_ins', t);
    execute format('drop policy if exists %I on %I', t || '_upd', t);
    execute format('create policy %I on %I for update using (pms_is_member(property_id)) with check (pms_is_member(property_id))', t || '_upd', t);
  end loop;
end $$;

alter table pms_pos_bill_items enable row level security;
drop policy if exists pms_pos_bill_items_read on pms_pos_bill_items;
create policy pms_pos_bill_items_read on pms_pos_bill_items for select
  using (exists (select 1 from pms_pos_bills b where b.id = bill_id and pms_is_member(b.property_id)));

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function pms_update_reservation(uuid, uuid, uuid, uuid, uuid, text) to authenticated;
grant execute on function pms_set_exchange_rate(uuid, text, numeric, date) to authenticated;
grant execute on function pms_fx_rate(uuid, text, date) to authenticated;
grant execute on function pms_post_payment_fx(uuid, text, numeric, text, text) to authenticated;
grant execute on function pms_pos_open_bill(uuid, text, int) to authenticated;
grant execute on function pms_pos_add_item(uuid, uuid, numeric, text, numeric) to authenticated;
grant execute on function pms_pos_remove_item(uuid) to authenticated;
grant execute on function pms_pos_discount(uuid, numeric, text) to authenticated;
grant execute on function pms_pos_settle(uuid, text, text) to authenticated;
grant execute on function pms_pos_post_to_room(uuid, uuid) to authenticated;
grant execute on function pms_pos_void_bill(uuid, text) to authenticated;
grant execute on function pms_apply_package(uuid, uuid) to authenticated;
grant execute on function pms_apply_promotion(uuid, text) to authenticated;
grant execute on function pms_rpt_pos_sales(uuid, date, date) to authenticated;
grant execute on function pms_rpt_commission(uuid, date, date) to authenticated;
revoke execute on function pms__pos_bill(uuid, boolean) from public, authenticated;
revoke execute on function pms__pos_total(uuid) from public, authenticated;
notify pgrst, 'reload schema';
