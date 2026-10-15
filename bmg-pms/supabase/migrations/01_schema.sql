-- module: core
-- =====================================================================
-- BMG PMS — 01 SCHEMA
-- Multi-property hotel PMS for BMG Group International Limited
-- Run order: 01_schema → 02_security → 03_functions → 04_night_audit → 05_reports
-- =====================================================================

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- Properties and staff
-- ---------------------------------------------------------------------
create table if not exists pms_properties (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  code             text unique,
  group_name       text not null default 'BMG Group International Limited',
  address          text,
  phone            text,
  email            text,
  tin              text,
  vrn              text,
  currency         text not null default 'TZS',
  tax_rate         numeric(5,2) not null default 18,
  tax_inclusive    boolean not null default true,
  check_in_time    time not null default '14:00',
  check_out_time   time not null default '10:00',
  business_date    date not null default current_date,
  next_res_no      integer not null default 1,
  next_folio_no    integer not null default 1,
  created_at       timestamptz not null default now()
);

create table if not exists pms_members (
  property_id   uuid not null references pms_properties(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('owner','manager','front_desk','accountant','housekeeping')),
  display_name  text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  primary key (property_id, user_id)
);

-- ---------------------------------------------------------------------
-- Inventory and rates
-- ---------------------------------------------------------------------
create table if not exists pms_room_types (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references pms_properties(id) on delete cascade,
  name           text not null,
  code           text,
  base_rate      numeric(14,2) not null default 0,
  max_occupancy  integer not null default 2,
  sort_order     integer not null default 0,
  active         boolean not null default true,
  unique (property_id, name)
);

create table if not exists pms_rooms (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  room_type_id  uuid not null references pms_room_types(id),
  number        text not null,
  floor         text,
  hk_status     text not null default 'clean'
                check (hk_status in ('clean','dirty','inspected','out_of_order')),
  hk_note       text,
  active        boolean not null default true,
  unique (property_id, number)
);

create table if not exists pms_rate_plans (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  meal_plan    text not null default 'RO' check (meal_plan in ('RO','BB','HB','FB','AI')),
  active       boolean not null default true,
  unique (property_id, name)
);

-- Daily rate overrides. If no row exists, the room type base_rate applies.
create table if not exists pms_rates (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  room_type_id  uuid not null references pms_room_types(id) on delete cascade,
  rate_plan_id  uuid not null references pms_rate_plans(id) on delete cascade,
  rate_date     date not null,
  amount        numeric(14,2) not null check (amount >= 0),
  unique (room_type_id, rate_plan_id, rate_date)
);

create table if not exists pms_business_sources (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  kind         text not null default 'direct'
               check (kind in ('direct','walk_in','ota','travel_agent','company','other')),
  commission_pct numeric(5,2) not null default 0,
  active       boolean not null default true,
  unique (property_id, name)
);

create table if not exists pms_companies (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  name          text not null,
  contact_name  text,
  phone         text,
  email         text,
  tin           text,
  credit_limit  numeric(14,2) not null default 0,
  active        boolean not null default true,
  unique (property_id, name)
);

-- ---------------------------------------------------------------------
-- Guests and reservations
-- ---------------------------------------------------------------------
create table if not exists pms_guests (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  title        text,
  first_name   text not null,
  last_name    text,
  phone        text,
  email        text,
  nationality  text,
  id_type      text,
  id_number    text,
  address      text,
  notes        text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_pms_guests_name on pms_guests(property_id, lower(first_name), lower(last_name));

create table if not exists pms_reservations (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  res_no        integer not null,
  guest_id      uuid not null references pms_guests(id),
  company_id    uuid references pms_companies(id),
  source_id     uuid references pms_business_sources(id),
  rate_plan_id  uuid references pms_rate_plans(id),
  status        text not null default 'confirmed'
                check (status in ('tentative','confirmed','checked_in','checked_out','cancelled','no_show','partial')),
  arrival       date not null,
  departure     date not null,
  external_ref  text,                 -- OTA / Channex booking id
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  unique (property_id, res_no)
);

-- One row per room on a reservation
create table if not exists pms_stays (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references pms_properties(id) on delete cascade,
  reservation_id   uuid not null references pms_reservations(id) on delete cascade,
  room_type_id     uuid not null references pms_room_types(id),
  room_id          uuid references pms_rooms(id),
  arrival          date not null,
  departure        date not null,
  adults           integer not null default 1,
  children         integer not null default 0,
  rate             numeric(14,2) not null default 0,
  status           text not null default 'confirmed'
                   check (status in ('tentative','confirmed','checked_in','checked_out','cancelled','no_show')),
  checked_in_at    timestamptz,
  checked_out_at   timestamptz,
  created_at       timestamptz not null default now(),
  check (departure > arrival),
  -- A physical room can never hold two live stays on the same night
  constraint pms_stays_no_double_booking exclude using gist (
    room_id with =,
    daterange(arrival, departure) with &&
  ) where (room_id is not null and status in ('tentative','confirmed','checked_in'))
);
create index if not exists idx_pms_stays_dates on pms_stays(property_id, arrival, departure);

create table if not exists pms_maintenance_blocks (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  room_id      uuid not null references pms_rooms(id) on delete cascade,
  from_date    date not null,
  to_date      date not null,
  reason       text not null,
  status       text not null default 'active' check (status in ('active','released')),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  check (to_date > from_date),
  constraint pms_blocks_no_overlap exclude using gist (
    room_id with =,
    daterange(from_date, to_date) with &&
  ) where (status = 'active')
);

-- ---------------------------------------------------------------------
-- Cashiering
-- ---------------------------------------------------------------------
create table if not exists pms_drawer_sessions (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references pms_properties(id) on delete cascade,
  user_id        uuid not null,
  opened_at      timestamptz not null default now(),
  opening_float  numeric(14,2) not null default 0,
  closed_at      timestamptz,
  expected_cash  numeric(14,2),
  counted_cash   numeric(14,2),
  variance       numeric(14,2),
  status         text not null default 'open' check (status in ('open','closed')),
  notes          text
);
create unique index if not exists uq_pms_one_open_drawer
  on pms_drawer_sessions(property_id, user_id) where status = 'open';

create table if not exists pms_folios (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  folio_no        integer not null,
  reservation_id  uuid references pms_reservations(id) on delete cascade,
  stay_id         uuid references pms_stays(id) on delete cascade,
  guest_id        uuid references pms_guests(id),
  company_id      uuid references pms_companies(id),
  status          text not null default 'open' check (status in ('open','closed')),
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  unique (property_id, folio_no)
);

-- amount is SIGNED: charges positive, payments and discounts negative,
-- refunds positive. Folio balance = sum(amount) of non-void lines.
create table if not exists pms_folio_lines (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references pms_properties(id) on delete cascade,
  folio_id           uuid not null references pms_folios(id) on delete cascade,
  stay_id            uuid references pms_stays(id) on delete set null,
  line_type          text not null check (line_type in ('charge','payment','refund','discount')),
  category           text not null,
  description        text not null,
  amount             numeric(14,2) not null,
  payment_method     text check (payment_method in ('cash','mobile_money','card','bank','city_ledger','other')),
  reference          text,
  business_date      date not null,
  drawer_session_id  uuid references pms_drawer_sessions(id),
  source             text not null default 'manual' check (source in ('manual','night_audit','pos','system')),
  posted_by          uuid,
  created_at         timestamptz not null default now(),
  voided             boolean not null default false,
  void_reason        text,
  voided_by          uuid,
  voided_at          timestamptz
);
create index if not exists idx_pms_lines_folio on pms_folio_lines(folio_id);
create index if not exists idx_pms_lines_date on pms_folio_lines(property_id, business_date);
-- Night audit can post each nightly charge only once per stay per category
create unique index if not exists uq_pms_night_charge
  on pms_folio_lines(stay_id, business_date, category)
  where source = 'night_audit' and not voided;

-- Company receivables (accounts transferred out of guest folios)
create table if not exists pms_city_ledger (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  company_id      uuid not null references pms_companies(id),
  folio_id        uuid references pms_folios(id),
  entry_type      text not null check (entry_type in ('invoice','payment')),
  description     text not null,
  amount          numeric(14,2) not null,       -- invoice positive, payment negative
  payment_method  text,
  reference       text,
  business_date   date not null,
  posted_by       uuid,
  created_at      timestamptz not null default now()
);

create table if not exists pms_expense_vouchers (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references pms_properties(id) on delete cascade,
  voucher_no         serial,
  business_date      date not null,
  category           text not null,
  description        text not null,
  amount             numeric(14,2) not null check (amount > 0),
  payment_method     text not null default 'cash'
                     check (payment_method in ('cash','mobile_money','card','bank','other')),
  paid_to            text,
  reference          text,
  drawer_session_id  uuid references pms_drawer_sessions(id),
  created_by         uuid,
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------
create table if not exists pms_work_orders (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  room_id       uuid references pms_rooms(id) on delete set null,
  title         text not null,
  description   text,
  category      text not null default 'maintenance'
                check (category in ('maintenance','housekeeping','engineering','it','other')),
  priority      text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status        text not null default 'open' check (status in ('open','in_progress','done','cancelled')),
  assigned_to   text,
  due_date      date,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- ---------------------------------------------------------------------
-- Night audit, audit trail, integrations
-- ---------------------------------------------------------------------
create table if not exists pms_night_audits (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references pms_properties(id) on delete cascade,
  business_date    date not null,
  run_by           uuid,
  run_at           timestamptz not null default now(),
  rooms_available  integer not null,
  rooms_sold       integer not null,
  occupancy_pct    numeric(5,2) not null,
  room_revenue     numeric(14,2) not null,
  tax_revenue      numeric(14,2) not null,
  other_revenue    numeric(14,2) not null,
  payments         numeric(14,2) not null,
  no_shows         integer not null default 0,
  summary          jsonb,
  unique (property_id, business_date)
);

create table if not exists pms_audit_log (
  id           bigserial primary key,
  property_id  uuid references pms_properties(id) on delete cascade,
  user_id      uuid,
  action       text not null,
  entity       text,
  entity_id    uuid,
  details      jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists idx_pms_audit_log on pms_audit_log(property_id, created_at desc);

-- Integration settings (Channex, TTLock, Hikvision). Secrets stay in Edge Function
-- environment variables, NOT in this table.
create table if not exists pms_integrations (
  property_id  uuid not null references pms_properties(id) on delete cascade,
  provider     text not null check (provider in ('channex','ttlock','hikvision')),
  enabled      boolean not null default false,
  config       jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  primary key (property_id, provider)
);

-- Maps PMS records to external ids: Channex room type / rate plan ids,
-- TTLock lockId per room, Hikvision camera channel per area.
create table if not exists pms_external_ids (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  provider     text not null check (provider in ('channex','ttlock','hikvision')),
  entity       text not null check (entity in ('room','room_type','rate_plan','property')),
  entity_id    uuid not null,
  external_id  text not null,
  unique (provider, entity, entity_id)
);

-- ---------------------------------------------------------------------
-- Folio balance view
-- ---------------------------------------------------------------------
create or replace view pms_folio_balances with (security_invoker = true) as
select f.id as folio_id,
       f.property_id,
       coalesce(sum(l.amount) filter (where not l.voided and l.amount > 0), 0) as total_debits,
       coalesce(-sum(l.amount) filter (where not l.voided and l.amount < 0), 0) as total_credits,
       coalesce(sum(l.amount) filter (where not l.voided), 0) as balance
from pms_folios f
left join pms_folio_lines l on l.folio_id = f.id
group by f.id, f.property_id;
