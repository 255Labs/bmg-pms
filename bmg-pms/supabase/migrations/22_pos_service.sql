-- module: pos
-- also: back-office, front-office, operations, reports, stock
-- 22 · Full-service POS for restaurants, bars, room service and activities
--
--  * Menu: categories (each sends to the kitchen, the bar or nowhere), item availability ("86"), barcodes.
--  * Modifiers: groups such as "Cooking" (pick 1, required) or "Extras" (pick up to 3, each priced), with optional
--    stock use (extra cheese takes 30 g of cheese from the kitchen).
--  * Happy hours and time prices: by outlet, category or item, days of the week and time window; percent off or a price.
--  * Tables: floor per outlet with zones and seats; open a table, move it, merge two bills; server on every bill.
--  * Kitchen: orders are fired to stations (kitchen, bar) with a ticket number per round; the kitchen display moves
--    them from sent → preparing → ready → served; courses, seats and notes travel with each line; sent lines are
--    voided with a reason instead of deleted.
--  * Service charge per outlet. Split tender: any mix of cash (with change), mobile money, card, bank, and the
--    balance charged to the guest's room. Every tender is its own record; drawers, reports and fiscal receipts read them.
--  * End-of-day (Z) report per outlet.
-- Safe to re-run.

-- ---------------------------------------------------------------------
-- Tables and columns
-- ---------------------------------------------------------------------
alter table pms_pos_outlets add column if not exists service_charge_pct numeric(5,2) not null default 0;
alter table pms_pos_outlets add column if not exists uses_tables boolean not null default false;
do $$ begin
  alter table pms_pos_outlets add constraint pms_pos_outlets_service_charge_check check (service_charge_pct between 0 and 30);
exception when duplicate_object then null; end $$;

create table if not exists pms_pos_categories (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  outlet_id    uuid not null references pms_pos_outlets(id) on delete cascade,
  name         text not null,
  station      text not null default 'kitchen' check (station in ('kitchen','bar','none')),
  sort_order   integer not null default 0,
  active       boolean not null default true,
  unique (outlet_id, name)
);
create index if not exists ix_pos_categories_property on pms_pos_categories (property_id);

alter table pms_pos_items add column if not exists category_id uuid references pms_pos_categories(id) on delete set null;
alter table pms_pos_items add column if not exists station text check (station in ('kitchen','bar','none'));
alter table pms_pos_items add column if not exists barcode text;
alter table pms_pos_items add column if not exists available boolean not null default true;
create index if not exists ix_pos_items_category on pms_pos_items (category_id);
create unique index if not exists ux_pos_items_barcode on pms_pos_items (property_id, barcode) where barcode is not null;

create table if not exists pms_pos_modifier_groups (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  outlet_id    uuid not null references pms_pos_outlets(id) on delete cascade,
  name         text not null,
  min_choices  integer not null default 0 check (min_choices >= 0),
  max_choices  integer not null default 1 check (max_choices >= 1),
  active       boolean not null default true,
  check (max_choices >= min_choices),
  unique (outlet_id, name)
);
create index if not exists ix_pos_modifier_groups_property on pms_pos_modifier_groups (property_id);

create table if not exists pms_pos_modifiers (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references pms_properties(id) on delete cascade,
  group_id       uuid not null references pms_pos_modifier_groups(id) on delete cascade,
  name           text not null,
  price          numeric(14,2) not null default 0 check (price >= 0),
  stock_item_id  uuid references pms_stock_items(id) on delete set null,
  stock_qty      numeric(14,4) check (stock_qty is null or stock_qty > 0),
  sort_order     integer not null default 0,
  active         boolean not null default true,
  unique (group_id, name)
);
create index if not exists ix_pos_modifiers_group on pms_pos_modifiers (group_id);
create index if not exists ix_pos_modifiers_property on pms_pos_modifiers (property_id);
create index if not exists ix_pos_modifiers_stock on pms_pos_modifiers (stock_item_id);

create table if not exists pms_pos_item_modifier_groups (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  item_id      uuid not null references pms_pos_items(id) on delete cascade,
  group_id     uuid not null references pms_pos_modifier_groups(id) on delete cascade,
  sort_order   integer not null default 0,
  unique (item_id, group_id)
);
create index if not exists ix_pos_item_mod_groups_group on pms_pos_item_modifier_groups (group_id);
create index if not exists ix_pos_item_mod_groups_property on pms_pos_item_modifier_groups (property_id);

create table if not exists pms_pos_tables (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  outlet_id    uuid not null references pms_pos_outlets(id) on delete cascade,
  name         text not null,
  zone         text,
  seats        integer not null default 4 check (seats between 1 and 50),
  sort_order   integer not null default 0,
  active       boolean not null default true,
  unique (outlet_id, name)
);
create index if not exists ix_pos_tables_property on pms_pos_tables (property_id);

create table if not exists pms_pos_price_rules (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  outlet_id    uuid not null references pms_pos_outlets(id) on delete cascade,
  name         text not null,
  category_id  uuid references pms_pos_categories(id) on delete cascade,
  item_id      uuid references pms_pos_items(id) on delete cascade,
  days         integer[] not null default '{0,1,2,3,4,5,6}',          -- 0 = Sunday
  starts       time not null,
  ends         time not null,                                         -- may be after midnight (ends < starts)
  kind         text not null default 'percent' check (kind in ('percent','price')),
  value        numeric(14,2) not null check (value >= 0),
  active       boolean not null default true,
  check (kind <> 'percent' or value <= 100)
);
create index if not exists ix_pos_price_rules_outlet on pms_pos_price_rules (outlet_id);
create index if not exists ix_pos_price_rules_property on pms_pos_price_rules (property_id);
create index if not exists ix_pos_price_rules_category on pms_pos_price_rules (category_id);
create index if not exists ix_pos_price_rules_item on pms_pos_price_rules (item_id);

alter table pms_pos_bills add column if not exists table_id uuid references pms_pos_tables(id) on delete set null;
alter table pms_pos_bills add column if not exists server_id uuid;
alter table pms_pos_bills add column if not exists guest_name text;
alter table pms_pos_bills add column if not exists service_charge numeric(14,2) not null default 0;
alter table pms_pos_bills add column if not exists paid numeric(14,2) not null default 0;
alter table pms_pos_bills add column if not exists opened_at timestamptz not null default now();
create index if not exists ix_pos_bills_table on pms_pos_bills (table_id) where status = 'open';
create unique index if not exists ux_pos_bills_open_table on pms_pos_bills (table_id) where status = 'open' and table_id is not null;

alter table pms_pos_bill_items add column if not exists modifiers jsonb not null default '[]'::jsonb;
alter table pms_pos_bill_items add column if not exists note text;
alter table pms_pos_bill_items add column if not exists course integer not null default 1;
alter table pms_pos_bill_items add column if not exists seat integer;
alter table pms_pos_bill_items add column if not exists station text;
alter table pms_pos_bill_items add column if not exists kitchen_status text not null default 'new';
alter table pms_pos_bill_items add column if not exists ticket_no integer;
alter table pms_pos_bill_items add column if not exists sent_at timestamptz;
alter table pms_pos_bill_items add column if not exists ready_at timestamptz;
alter table pms_pos_bill_items add column if not exists served_at timestamptz;
alter table pms_pos_bill_items add column if not exists voided boolean not null default false;
alter table pms_pos_bill_items add column if not exists void_reason text;
alter table pms_pos_bill_items add column if not exists price_rule text;
do $$ begin
  alter table pms_pos_bill_items add constraint pms_pos_bill_items_kitchen_status_check check (kitchen_status in ('new','sent','preparing','ready','served','void'));
exception when duplicate_object then null; end $$;
create index if not exists ix_pos_bill_items_kitchen on pms_pos_bill_items (property_id, kitchen_status) where kitchen_status in ('sent','preparing','ready');

create table if not exists pms_pos_payments (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references pms_properties(id) on delete cascade,
  bill_id            uuid not null references pms_pos_bills(id) on delete cascade,
  method             text not null check (method in ('cash','mobile_money','card','bank','other')),
  method_name        text,
  amount             numeric(14,2) not null check (amount > 0),
  tendered           numeric(14,2),
  change_given       numeric(14,2) not null default 0,
  reference          text,
  drawer_session_id  uuid references pms_drawer_sessions(id),
  business_date      date not null,
  voided             boolean not null default false,
  void_reason        text,
  created_at         timestamptz not null default now(),
  created_by         uuid default auth.uid()
);
create index if not exists ix_pos_payments_bill on pms_pos_payments (bill_id);
create index if not exists ix_pos_payments_property on pms_pos_payments (property_id, business_date);
create index if not exists ix_pos_payments_drawer on pms_pos_payments (drawer_session_id) where method = 'cash' and not voided;

-- Bills settled before this migration get one tender each, so every report reads the same place
insert into pms_pos_payments(property_id, bill_id, method, method_name, amount, reference, drawer_session_id, business_date, created_at)
select b.property_id, b.id, b.payment_method, b.payment_method_name, b.total, b.payment_reference, b.drawer_session_id, b.business_date, coalesce(b.closed_at, now())
from pms_pos_bills b
where b.status in ('settled','void') and b.payment_method is not null and b.total > 0
  and not exists (select 1 from pms_pos_payments p where p.bill_id = b.id);
update pms_pos_payments p set voided = true, void_reason = coalesce(b.void_reason, 'Bill voided')
from pms_pos_bills b where b.id = p.bill_id and b.status = 'void' and not p.voided;
update pms_pos_bills b set paid = coalesce((select sum(amount) from pms_pos_payments p where p.bill_id = b.id and not p.voided), 0)
where b.paid = 0 and exists (select 1 from pms_pos_payments p where p.bill_id = b.id and not p.voided);

-- ---------------------------------------------------------------------
-- Who may read and change the new tables
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  -- menu set-up: everyone at the property reads (the kitchen too); "Set up menus" changes
  foreach t in array array['pms_pos_categories','pms_pos_modifier_groups','pms_pos_modifiers','pms_pos_item_modifier_groups','pms_pos_tables','pms_pos_price_rules'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (property_id in (select pms_my_properties(null::text[])))', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format('create policy %I on %I for all using (pms_has_priv(property_id, ''pos.menu'')) with check (pms_has_priv(property_id, ''pos.menu''))', t || '_write', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
  -- tenders: money, read like the bills themselves; written only through the functions below
  execute 'alter table pms_pos_payments enable row level security';
  execute 'drop policy if exists pms_pos_payments_read on pms_pos_payments';
  execute 'create policy pms_pos_payments_read on pms_pos_payments for select using (property_id in (select pms_my_properties(array[''owner'',''manager'',''front_desk'',''accountant''])))';
  execute 'revoke insert, update, delete on pms_pos_payments from authenticated';
  execute 'grant select on pms_pos_payments to authenticated';
end $$;

-- ---------------------------------------------------------------------
-- Prices, totals, stock
-- ---------------------------------------------------------------------
-- The price of an item right now at its outlet: a happy-hour or time price wins over the menu price
create or replace function pms__pos_price(p_item pms_pos_items, p_at timestamptz default now()) returns table(price numeric, rule text)
language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_local timestamp; v_dow int; v_t time; r pms_pos_price_rules;
begin
  select timezone into v_tz from pms_properties where id = p_item.property_id;
  v_local := p_at at time zone coalesce(v_tz, 'Africa/Dar_es_Salaam');
  v_dow := extract(dow from v_local)::int; v_t := v_local::time;
  select * into r from pms_pos_price_rules x
  where x.outlet_id = p_item.outlet_id and x.active
    and (x.item_id = p_item.id or (x.item_id is null and (x.category_id is null or x.category_id = p_item.category_id)))
    and ((x.starts <= x.ends and v_t >= x.starts and v_t < x.ends and v_dow = any(x.days))
      or (x.starts > x.ends and ((v_t >= x.starts and v_dow = any(x.days)) or (v_t < x.ends and ((v_dow + 6) % 7) = any(x.days)))))
  order by (x.item_id is not null) desc, (x.category_id is not null) desc,
    case when x.kind = 'price' then x.value else p_item.price * (100 - x.value) / 100 end
  limit 1;
  if r.id is null then return query select p_item.price, null::text; return; end if;
  return query select case when r.kind = 'price' then r.value else round(p_item.price * (100 - r.value) / 100, 2) end, r.name;
end $$;

-- Subtotal of live lines, less discount, plus the outlet's service charge
create or replace function pms__pos_total(p_bill uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_sub numeric; v_disc numeric; v_pct numeric; v_svc numeric; v_paid numeric; v_total numeric;
begin
  select coalesce(sum(amount) filter (where not voided), 0) into v_sub from pms_pos_bill_items where bill_id = p_bill;
  select b.discount, o.service_charge_pct, b.paid into v_disc, v_pct, v_paid
  from pms_pos_bills b join pms_pos_outlets o on o.id = b.outlet_id where b.id = p_bill;
  v_disc := least(coalesce(v_disc, 0), v_sub);
  v_svc := round((v_sub - v_disc) * coalesce(v_pct, 0) / 100, 2);
  v_total := greatest(0, v_sub - v_disc + v_svc);
  if v_total < coalesce(v_paid, 0) then
    raise exception 'The bill would come to less than has already been paid (%). Remove a payment first.', v_paid;
  end if;
  update pms_pos_bills set subtotal = v_sub, discount = v_disc, service_charge = v_svc, total = v_total where id = p_bill;
end $$;

-- Stock leaves the outlet when the bill closes: recipes of live lines, plus modifiers that use stock
create or replace function pms_trg_pos_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_loc uuid;
begin
  select stock_location_id into v_loc from pms_pos_outlets where id = new.outlet_id;
  if v_loc is null then return null; end if;
  if old.status = 'open' and new.status in ('settled','room') then
    insert into pms_stock_moves(property_id, item_id, location_id, qty, kind, unit_cost, value, pos_bill_id, pos_item_id, reference, business_date, created_by)
    select new.property_id, u.stock_item_id, v_loc, -u.qty, 'sale', si.avg_cost, -round(u.qty * si.avg_cost, 2), new.id, u.pos_item_id,
           'Bill #' || new.bill_no, new.business_date, auth.uid()
    from (
      select rl.stock_item_id, bi.item_id as pos_item_id, sum(bi.qty * rl.qty) as qty
      from pms_pos_bill_items bi join pms_recipe_lines rl on rl.pos_item_id = bi.item_id
      where bi.bill_id = new.id and not bi.voided
      group by rl.stock_item_id, bi.item_id
      union all
      select (m->>'stock_item_id')::uuid, bi.item_id, sum(bi.qty * (m->>'stock_qty')::numeric)
      from pms_pos_bill_items bi cross join lateral jsonb_array_elements(bi.modifiers) m
      where bi.bill_id = new.id and not bi.voided and m->>'stock_item_id' is not null and (m->>'stock_qty') is not null
      group by 1, 2
    ) u join pms_stock_items si on si.id = u.stock_item_id;
  elsif new.status = 'void' and old.status in ('settled','room') then
    insert into pms_stock_moves(property_id, item_id, location_id, qty, kind, unit_cost, value, pos_bill_id, pos_item_id, reference, note, business_date, created_by)
    select m.property_id, m.item_id, m.location_id, -m.qty, 'sale_reversal', m.unit_cost, -m.value, m.pos_bill_id, m.pos_item_id, m.reference,
           'Bill voided', pms__bd(new.property_id), auth.uid()
      from pms_stock_moves m where m.pos_bill_id = new.id and m.kind = 'sale';
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- Opening bills and tables
-- ---------------------------------------------------------------------
-- Open (or return the open) bill on a table
create or replace function pms_pos_open_table(p_table uuid, p_covers int default null, p_guest text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare t pms_pos_tables; v_id uuid;
begin
  select * into t from pms_pos_tables where id = p_table and active;
  if not found then raise exception 'Table not found'; end if;
  perform pms_need(t.property_id, 'pos.sell');
  select id into v_id from pms_pos_bills where table_id = p_table and status = 'open';
  if v_id is not null then return v_id; end if;
  v_id := pms_pos_open_bill(t.outlet_id, t.name, p_covers);
  update pms_pos_bills set table_id = p_table, server_id = auth.uid(), guest_name = nullif(trim(coalesce(p_guest, '')), '') where id = v_id;
  return v_id;
end $$;

-- The floor: every table with what is on it
create or replace function pms_pos_floor(p_outlet uuid)
returns table(table_id uuid, name text, zone text, seats int, bill_id uuid, bill_no int, covers int, total numeric, paid numeric,
              opened_at timestamptz, server text, waiting int, ready int)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid;
begin
  select property_id into v_prop from pms_pos_outlets where id = p_outlet;
  perform pms_need(v_prop, 'pos.sell');
  return query
    select t.id, t.name, t.zone, t.seats, b.id, b.bill_no, b.covers, b.total, b.paid, b.opened_at,
      (select coalesce(m.display_name, split_part(u.email, '@', 1)) from auth.users u left join pms_members m on m.user_id = u.id and m.property_id = v_prop where u.id = b.server_id),
      (select count(*)::int from pms_pos_bill_items l where l.bill_id = b.id and l.kitchen_status in ('sent','preparing')),
      (select count(*)::int from pms_pos_bill_items l where l.bill_id = b.id and l.kitchen_status = 'ready')
    from pms_pos_tables t left join pms_pos_bills b on b.table_id = t.id and b.status = 'open'
    where t.outlet_id = p_outlet and t.active
    order by t.zone nulls first, t.sort_order, t.name;
end $$;

create or replace function pms_pos_move_table(p_bill uuid, p_table uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; t pms_pos_tables;
begin
  b := pms__pos_bill(p_bill);
  perform pms_need(b.property_id, 'pos.transfer');
  select * into t from pms_pos_tables where id = p_table and outlet_id = b.outlet_id and active;
  if not found then raise exception 'That table is not in this outlet'; end if;
  if exists (select 1 from pms_pos_bills where table_id = p_table and status = 'open' and id <> p_bill) then
    raise exception 'Table % already has an open bill. Merge the bills instead.', t.name;
  end if;
  update pms_pos_bills set table_id = p_table, table_no = t.name where id = p_bill;
  perform pms_log(b.property_id, 'pos.move_table', 'pos_bill', p_bill, jsonb_build_object('bill_no', b.bill_no, 'table', t.name));
end $$;

-- Everything on one bill moves to another; the emptied bill is closed as merged
create or replace function pms_pos_merge_bills(p_keep uuid, p_drop uuid) returns void
language plpgsql security definer set search_path = public as $$
declare k pms_pos_bills; d pms_pos_bills;
begin
  if p_keep = p_drop then raise exception 'Choose two different bills'; end if;
  k := pms__pos_bill(p_keep); d := pms__pos_bill(p_drop);
  perform pms_need(k.property_id, 'pos.transfer');
  if k.property_id <> d.property_id or k.outlet_id <> d.outlet_id then raise exception 'Only bills of the same outlet can be merged'; end if;
  update pms_pos_bill_items set bill_id = p_keep where bill_id = p_drop;
  update pms_pos_payments set bill_id = p_keep where bill_id = p_drop;
  update pms_pos_bills set paid = 0, discount = 0 where id = p_drop;
  update pms_pos_bills set paid = coalesce((select sum(amount) from pms_pos_payments where bill_id = p_keep and not voided), 0),
    covers = coalesce(k.covers, 0) + coalesce(d.covers, 0) where id = p_keep;
  perform pms__pos_total(p_drop); perform pms__pos_total(p_keep);
  update pms_pos_bills set status = 'void', void_reason = 'Merged into bill #' || k.bill_no, closed_at = now() where id = p_drop;
  perform pms_log(k.property_id, 'pos.merge', 'pos_bill', p_keep, jsonb_build_object('bill_no', k.bill_no, 'merged', d.bill_no));
end $$;

create or replace function pms_pos_set_server(p_bill uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills;
begin
  b := pms__pos_bill(p_bill);
  perform pms_need(b.property_id, 'pos.transfer');
  if not exists (select 1 from pms_members where property_id = b.property_id and user_id = p_user and active) then raise exception 'Not a member of this property'; end if;
  update pms_pos_bills set server_id = p_user where id = p_bill;
end $$;

-- ---------------------------------------------------------------------
-- Ordering
-- ---------------------------------------------------------------------
-- Add an item with its modifiers, note, course and seat. Checks the modifier rules and availability.
create or replace function pms_pos_order(p_bill uuid, p_item uuid, p_qty numeric default 1, p_modifiers uuid[] default '{}',
  p_note text default null, p_course int default 1, p_seat int default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; i pms_pos_items; g record; v_mods jsonb := '[]'; v_extra numeric := 0; v_price numeric; v_rule text;
  v_station text; v_name text; v_id uuid; n int;
begin
  b := pms__pos_bill(p_bill);
  perform pms_need(b.property_id, 'pos.sell');
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  i := pms__pos_item(b, p_item);
  if not i.available then raise exception '% is not available right now', i.name; end if;
  if i.item_type = 'membership' then raise exception 'Use "Sell membership" so the member''s name is recorded'; end if;
  if i.item_type = 'timed' then raise exception 'Use "Start timer" for %', i.name; end if;
  -- every modifier must belong to a group on this item; each group within its limits
  if exists (select 1 from unnest(coalesce(p_modifiers, '{}')) m(id)
             where not exists (select 1 from pms_pos_modifiers x join pms_pos_item_modifier_groups ig on ig.group_id = x.group_id
                               where x.id = m.id and ig.item_id = i.id and x.active)) then
    raise exception 'A chosen option does not belong to %', i.name;
  end if;
  for g in select mg.* from pms_pos_modifier_groups mg join pms_pos_item_modifier_groups ig on ig.group_id = mg.id
           where ig.item_id = i.id and mg.active loop
    select count(*) into n from pms_pos_modifiers x where x.group_id = g.id and x.id = any(coalesce(p_modifiers, '{}'));
    if n < g.min_choices then raise exception 'Choose % for %', case when g.min_choices = 1 then 'one ' || lower(g.name) else g.min_choices || ' ' || lower(g.name) end, i.name; end if;
    if n > g.max_choices then raise exception 'Choose at most % for % (%)', g.max_choices, i.name, lower(g.name); end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'group', mg.name, 'name', x.name, 'price', x.price,
           'stock_item_id', x.stock_item_id, 'stock_qty', x.stock_qty) order by mg.name, x.sort_order), '[]'), coalesce(sum(x.price), 0)
    into v_mods, v_extra
  from pms_pos_modifiers x join pms_pos_modifier_groups mg on mg.id = x.group_id where x.id = any(coalesce(p_modifiers, '{}'));
  select price, rule into v_price, v_rule from pms__pos_price(i);
  select coalesce(i.station, c.station, case when o.outlet_type in ('bar','pool') then 'bar'
                                             when o.outlet_type in ('restaurant','cafe','room_service') then 'kitchen' else 'none' end)
    into v_station
  from pms_pos_outlets o left join pms_pos_categories c on c.id = i.category_id where o.id = i.outlet_id;
  v_name := i.name || case when jsonb_array_length(v_mods) > 0
    then ' (' || (select string_agg(m->>'name', ', ') from jsonb_array_elements(v_mods) m) || ')' else '' end;
  insert into pms_pos_bill_items(bill_id, item_id, name, qty, price, amount, added_by, modifiers, note, course, seat, station, kitchen_status, price_rule)
  values (p_bill, i.id, v_name, p_qty, v_price + v_extra, round(p_qty * (v_price + v_extra), 2), auth.uid(), v_mods,
          nullif(trim(coalesce(p_note, '')), ''), greatest(coalesce(p_course, 1), 1), p_seat, v_station,
          case when v_station = 'none' then 'served' else 'new' end, v_rule)
  returning id into v_id;
  perform pms__pos_total(p_bill);
  return v_id;
end $$;

-- The old quick add keeps working and now follows prices, stations and modifier rules too
create or replace function pms_pos_add_item(p_bill uuid, p_item uuid, p_qty numeric default 1, p_name text default null, p_price numeric default null) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills;
begin
  if p_item is not null then perform pms_pos_order(p_bill, p_item, p_qty); return; end if;
  b := pms__pos_bill(p_bill);
  perform pms_need(b.property_id, 'pos.sell');
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if coalesce(trim(p_name),'') = '' or p_price is null or p_price < 0 then raise exception 'Name and price are required for an open item'; end if;
  insert into pms_pos_bill_items(bill_id, item_id, name, qty, price, amount, added_by, station, kitchen_status)
  values (p_bill, null, trim(p_name), p_qty, p_price, round(p_qty * p_price, 2), auth.uid(), 'none', 'served');
  perform pms__pos_total(p_bill);
end $$;

-- Lines not yet sent can simply be removed; sent ones must be voided with a reason
create or replace function pms_pos_remove_item(p_bill_item uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l pms_pos_bill_items; b pms_pos_bills;
begin
  select * into l from pms_pos_bill_items where id = p_bill_item;
  if not found then raise exception 'Line not found'; end if;
  b := pms__pos_bill(l.bill_id);
  perform pms_need(b.property_id, 'pos.sell');
  if l.kitchen_status in ('sent','preparing','ready') or (l.kitchen_status = 'served' and l.sent_at is not null) then
    raise exception '% has gone to the %. Void it with a reason instead.', l.name, coalesce(l.station, 'kitchen');
  end if;
  delete from pms_pos_bill_items where id = p_bill_item;
  perform pms__pos_total(l.bill_id);
end $$;

create or replace function pms_pos_void_item(p_bill_item uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare l pms_pos_bill_items; b pms_pos_bills;
begin
  select * into l from pms_pos_bill_items where id = p_bill_item for update;
  if not found then raise exception 'Line not found'; end if;
  b := pms__pos_bill(l.bill_id);
  perform pms_need(b.property_id, 'pos.void');
  if l.voided then raise exception 'Already voided'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  update pms_pos_bill_items set voided = true, void_reason = trim(p_reason), kitchen_status = 'void' where id = p_bill_item;
  perform pms__pos_total(l.bill_id);
  perform pms_log(b.property_id, 'pos.void_item', 'pos_bill', l.bill_id, jsonb_build_object('bill_no', b.bill_no, 'item', l.name, 'amount', l.amount, 'reason', p_reason));
end $$;

-- ---------------------------------------------------------------------
-- Kitchen and bar
-- ---------------------------------------------------------------------
-- Fire new lines (or one course) to their stations; returns the tickets to print
create or replace function pms_pos_send(p_bill uuid, p_course int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; v_ticket int; v_out jsonb;
begin
  b := pms__pos_bill(p_bill);
  perform pms_need(b.property_id, 'pos.sell');
  if not exists (select 1 from pms_pos_bill_items where bill_id = p_bill and kitchen_status = 'new' and (p_course is null or course = p_course)) then
    raise exception 'Nothing new to send';
  end if;
  select coalesce(max(ticket_no), 0) + 1 into v_ticket from pms_pos_bill_items where bill_id = p_bill;
  update pms_pos_bill_items set kitchen_status = 'sent', sent_at = now(), ticket_no = v_ticket
  where bill_id = p_bill and kitchen_status = 'new' and (p_course is null or course = p_course);
  select coalesce(jsonb_agg(t order by t->>'station'), '[]') into v_out from (
    select jsonb_build_object('station', l.station, 'ticket', v_ticket, 'bill_no', b.bill_no, 'table', coalesce(b.table_no, 'Counter'),
      'covers', b.covers, 'sent_at', now(),
      'server', (select coalesce(m.display_name, split_part(u.email, '@', 1)) from auth.users u left join pms_members m on m.user_id = u.id and m.property_id = b.property_id where u.id = coalesce(b.server_id, b.created_by)),
      'items', jsonb_agg(jsonb_build_object('name', l.name, 'qty', l.qty, 'note', l.note, 'course', l.course, 'seat', l.seat,
               'modifiers', (select coalesce(jsonb_agg(m->>'name'), '[]') from jsonb_array_elements(l.modifiers) m)) order by l.course, l.added_at)) t
    from pms_pos_bill_items l where l.bill_id = p_bill and l.ticket_no = v_ticket group by l.station) x;
  perform pms_log(b.property_id, 'pos.send', 'pos_bill', p_bill, jsonb_build_object('bill_no', b.bill_no, 'ticket', v_ticket));
  return v_out;
end $$;

-- The kitchen display: everything sent and not yet served, oldest first
create or replace function pms_pos_kitchen(p_property uuid, p_station text default null)
returns table(line_id uuid, bill_id uuid, bill_no int, outlet text, table_name text, ticket_no int, item text, qty numeric,
              modifiers jsonb, note text, course int, seat int, station text, status text, sent_at timestamptz, minutes int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'pos.kitchen');
  return query
    select l.id, b.id, b.bill_no, o.name, coalesce(b.table_no, 'Counter'), l.ticket_no, l.name, l.qty, l.modifiers, l.note, l.course, l.seat,
      l.station, l.kitchen_status, l.sent_at, floor(extract(epoch from now() - l.sent_at) / 60)::int
    from pms_pos_bill_items l join pms_pos_bills b on b.id = l.bill_id join pms_pos_outlets o on o.id = b.outlet_id
    where l.property_id = p_property and l.kitchen_status in ('sent','preparing','ready') and b.status <> 'void'
      and (p_station is null or l.station = p_station)
    order by l.sent_at, b.bill_no, l.course;
end $$;

create or replace function pms_pos_kitchen_bump(p_lines uuid[], p_status text) returns int
language plpgsql security definer set search_path = public as $$
declare v_prop uuid; n int;
begin
  if p_status not in ('preparing','ready','served') then raise exception 'Unknown kitchen status'; end if;
  select distinct property_id into v_prop from pms_pos_bill_items where id = any(p_lines);
  if v_prop is null then raise exception 'Nothing to update'; end if;
  if (select count(distinct property_id) from pms_pos_bill_items where id = any(p_lines)) > 1 then raise exception 'Lines from more than one property'; end if;
  if p_status = 'served' then perform pms_need(v_prop, 'pos.sell'); else perform pms_need(v_prop, 'pos.kitchen'); end if;
  update pms_pos_bill_items set kitchen_status = p_status,
    ready_at = case when p_status = 'ready' then now() else ready_at end,
    served_at = case when p_status = 'served' then now() else served_at end
  where id = any(p_lines) and kitchen_status in ('sent','preparing','ready') and not voided;
  get diagnostics n = row_count;
  return n;
end $$;

-- "86": take an item off (or back on) while the kitchen has run out
create or replace function pms_pos_set_available(p_item uuid, p_available boolean) returns void
language plpgsql security definer set search_path = public as $$
declare i pms_pos_items;
begin
  select * into i from pms_pos_items where id = p_item;
  if not found then raise exception 'Item not found'; end if;
  if not (pms_has_priv(i.property_id, 'pos.kitchen') or pms_has_priv(i.property_id, 'pos.menu')) then perform pms_need(i.property_id, 'pos.menu'); end if;
  update pms_pos_items set available = p_available where id = p_item;
  perform pms_log(i.property_id, case when p_available then 'pos.item_on' else 'pos.item_off' end, 'pos_item', p_item, jsonb_build_object('item', i.name));
end $$;

-- ---------------------------------------------------------------------
-- Paying: split tender, change, balance to the room
-- ---------------------------------------------------------------------
-- Timed items must be stopped before a bill is paid or charged
create or replace function pms__pos_check_timers(p_bill uuid) returns void
language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  select string_agg(coalesce(l.resource, l.name), ', ') into v from pms_pos_bill_items l
  where l.bill_id = p_bill and l.started_at is not null and l.ended_at is null;
  if v is not null then raise exception 'Stop the timer for % first', v; end if;
end $$;

create or replace function pms__pos_close_if_paid(p_bill uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; v_main text; v_names text; v_drawer uuid;
begin
  select * into b from pms_pos_bills where id = p_bill;
  if b.status <> 'open' or b.total <= 0 or b.paid < b.total then return false; end if;
  if exists (select 1 from pms_pos_bill_items l where l.bill_id = p_bill and l.started_at is not null and l.ended_at is null) then return false; end if;
  select method into v_main from pms_pos_payments where bill_id = p_bill and not voided group by method order by sum(amount) desc limit 1;
  select string_agg(distinct coalesce(method_name, initcap(replace(method, '_', ' '))), ' + ') into v_names from pms_pos_payments where bill_id = p_bill and not voided;
  select drawer_session_id into v_drawer from pms_pos_payments where bill_id = p_bill and not voided and method = 'cash' order by created_at desc limit 1;
  update pms_pos_bills set status = 'settled', payment_method = v_main, payment_method_name = v_names,
    payment_reference = (select string_agg(reference, ', ') from pms_pos_payments where bill_id = p_bill and not voided and reference is not null),
    drawer_session_id = v_drawer, closed_at = now() where id = p_bill;
  perform pms_log(b.property_id, 'pos.settle', 'pos_bill', p_bill, jsonb_build_object('bill_no', b.bill_no, 'amount', b.total, 'method', v_names));
  return true;
end $$;

-- Take one payment towards a bill. Cash may be more than due: the change is worked out.
create or replace function pms_pos_pay(p_bill uuid, p_method uuid, p_amount numeric, p_reference text default null, p_tendered numeric default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; m pms_payment_methods; v_due numeric; v_amt numeric; v_change numeric := 0; v_drawer uuid; v_closed boolean;
begin
  b := pms__pos_bill(p_bill);
  perform pms_need(b.property_id, 'pos.sell');
  select * into m from pms_payment_methods where id = p_method and property_id = b.property_id and active;
  if not found then raise exception 'Payment method not found'; end if;
  if m.kind not in ('cash','mobile_money','card','bank','other') then raise exception 'Use "Charge to room" for room charges'; end if;
  if b.total <= 0 then raise exception 'Add items before taking payment'; end if;
  perform pms__pos_check_timers(p_bill);
  v_due := b.total - b.paid;
  if v_due <= 0 then raise exception 'Nothing is left to pay'; end if;
  v_amt := coalesce(p_amount, v_due);
  if v_amt <= 0 then raise exception 'Enter the amount'; end if;
  if m.kind = 'cash' then
    if p_tendered is not null and p_tendered < v_amt then raise exception 'Cash given is less than the amount'; end if;
    if v_amt > v_due then v_change := v_amt - v_due; v_amt := v_due; end if;
    if p_tendered is not null then v_change := p_tendered - v_amt; end if;
    v_drawer := pms__drawer(b.property_id);
    if v_drawer is null then raise exception 'Open your cash drawer before taking cash'; end if;
  else
    if v_amt > v_due then raise exception 'Only % is left to pay', v_due; end if;
    if m.kind in ('mobile_money','card','bank') and coalesce(trim(p_reference), '') = '' then raise exception 'A transaction reference is required'; end if;
  end if;
  insert into pms_pos_payments(property_id, bill_id, method, method_name, amount, tendered, change_given, reference, drawer_session_id, business_date)
  values (b.property_id, p_bill, m.kind, m.name, v_amt, coalesce(p_tendered, case when m.kind = 'cash' then v_amt + v_change end), v_change,
          nullif(trim(coalesce(p_reference, '')), ''), v_drawer, (select business_date from pms_properties where id = b.property_id));
  update pms_pos_bills set paid = paid + v_amt where id = p_bill;
  v_closed := pms__pos_close_if_paid(p_bill);
  return jsonb_build_object('paid', b.paid + v_amt, 'due', greatest(b.total - b.paid - v_amt, 0), 'change', v_change, 'settled', v_closed);
end $$;

-- Take back a payment taken by mistake (bill still open)
create or replace function pms_pos_remove_payment(p_payment uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare p pms_pos_payments; b pms_pos_bills;
begin
  select * into p from pms_pos_payments where id = p_payment for update;
  if not found or p.voided then raise exception 'Payment not found'; end if;
  b := pms__pos_bill(p.bill_id);
  perform pms_need(b.property_id, 'pos.void');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if p.drawer_session_id is not null and exists (select 1 from pms_drawer_sessions where id = p.drawer_session_id and status = 'closed') then
    raise exception 'This cash was counted in a closed drawer';
  end if;
  update pms_pos_payments set voided = true, void_reason = trim(p_reason) where id = p_payment;
  update pms_pos_bills set paid = paid - p.amount where id = p.bill_id;
  perform pms_log(b.property_id, 'pos.remove_payment', 'pos_bill', p.bill_id, jsonb_build_object('bill_no', b.bill_no, 'amount', p.amount, 'method', p.method, 'reason', p_reason));
end $$;

-- One tender for the whole bill (older screens and quick settle)
create or replace function pms_pos_settle(p_bill uuid, p_method text, p_reference text default null) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; v_drawer uuid; v_due numeric;
begin
  b := pms__pos_bill(p_bill);
  perform pms_need(b.property_id, 'pos.sell');
  if b.total <= 0 then raise exception 'Add items before settling'; end if;
  if p_method not in ('cash','mobile_money','card','bank','other') then raise exception 'Unknown payment method'; end if;
  if p_method in ('mobile_money','card','bank') and coalesce(trim(p_reference),'') = '' then raise exception 'A transaction reference is required'; end if;
  if p_method = 'cash' then
    v_drawer := pms__drawer(b.property_id);
    if v_drawer is null then raise exception 'Open your cash drawer before taking cash'; end if;
  end if;
  perform pms__pos_check_timers(p_bill);
  v_due := b.total - b.paid;
  if v_due > 0 then
    insert into pms_pos_payments(property_id, bill_id, method, amount, reference, drawer_session_id, business_date)
    values (b.property_id, p_bill, p_method, v_due, nullif(trim(coalesce(p_reference, '')), ''), v_drawer, (select business_date from pms_properties where id = b.property_id));
    update pms_pos_bills set paid = paid + v_due where id = p_bill;
  end if;
  perform pms__pos_close_if_paid(p_bill);
end $$;

create or replace function pms_pos_settle_method(p_bill uuid, p_method uuid, p_reference text default null) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; m pms_payment_methods;
begin
  select * into b from pms_pos_bills where id = p_bill;
  if not found then raise exception 'Bill not found'; end if;
  select * into m from pms_payment_methods where id = p_method and property_id = b.property_id and active;
  if not found then raise exception 'Payment method not found'; end if;
  perform pms__pos_check_timers(p_bill);
  perform pms_pos_pay(p_bill, p_method, b.total - b.paid, p_reference);
end $$;

-- Whatever is still unpaid goes to the guest's room folio
create or replace function pms_pos_post_to_room(p_bill uuid, p_stay uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; s pms_stays; o pms_pos_outlets; v_folio uuid; v_line uuid; v_room text; v_due numeric;
begin
  b := pms__pos_bill(p_bill);
  perform pms_need(b.property_id, 'pos.sell');
  v_due := b.total - b.paid;
  if b.total <= 0 then raise exception 'Add items before posting'; end if;
  if v_due <= 0 then raise exception 'Nothing is left to charge'; end if;
  select * into s from pms_stays where id = p_stay and property_id = b.property_id;
  if not found or s.status <> 'checked_in' then raise exception 'Room charges can only go to a checked-in guest'; end if;
  select id into v_folio from pms_folios where stay_id = p_stay and status = 'open' order by folio_no limit 1;
  if v_folio is null then raise exception 'This guest has no open folio'; end if;
  select * into o from pms_pos_outlets where id = b.outlet_id;
  select number into v_room from pms_rooms where id = s.room_id;
  perform pms__pos_check_timers(p_bill);
  v_line := pms_post_charge(v_folio, o.charge_category, o.name || ' bill #' || b.bill_no, v_due, 'POS ' || b.bill_no);
  update pms_pos_bills set status = 'room', stay_id = p_stay, folio_line_id = v_line, closed_at = now() where id = p_bill;
  perform pms_log(b.property_id, 'pos.room', 'pos_bill', p_bill, jsonb_build_object('bill_no', b.bill_no, 'amount', v_due, 'room', v_room, 'paid_first', b.paid));
  return v_line;
end $$;

-- A void takes back every payment too (unless counted in a closed drawer)
create or replace function pms_pos_void_bill(p_bill uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills;
begin
  b := pms__pos_bill(p_bill, false);
  perform pms_need(b.property_id, 'pos.void');
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  if b.status = 'void' then raise exception 'Already void'; end if;
  if exists (select 1 from pms_pos_payments p join pms_drawer_sessions d on d.id = p.drawer_session_id
             where p.bill_id = p_bill and not p.voided and p.method = 'cash' and d.status = 'closed') then
    raise exception 'This cash was counted in a closed drawer and cannot be voided';
  end if;
  if b.status = 'room' then perform pms_void_line(b.folio_line_id, 'POS bill #' || b.bill_no || ' voided: ' || p_reason); end if;
  update pms_pos_payments set voided = true, void_reason = 'Bill voided: ' || trim(p_reason) where bill_id = p_bill and not voided;
  update pms_pos_bills set status = 'void', void_reason = p_reason, closed_at = coalesce(closed_at, now()) where id = p_bill;
  update pms_pos_bill_items set kitchen_status = 'void' where bill_id = p_bill and kitchen_status in ('new','sent','preparing','ready');
  perform pms_log(b.property_id, 'pos.void', 'pos_bill', p_bill, jsonb_build_object('bill_no', b.bill_no, 'amount', b.total, 'reason', p_reason));
end $$;

-- ---------------------------------------------------------------------
-- Everything that reads POS money now reads the tenders
-- ---------------------------------------------------------------------
create or replace function pms_drawer_expected(p_session uuid) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare s pms_drawer_sessions;
begin
  select * into s from pms_drawer_sessions where id = p_session;
  if not found then return null; end if;
  if not pms__can_see(s.property_id) then raise exception 'You are not a member of this property'; end if;
  return s.opening_float
       - coalesce((select sum(l.amount) from pms_folio_lines l
                   where l.drawer_session_id = s.id and not l.voided and l.payment_method = 'cash'), 0)
       + coalesce((select sum(c.amount) * -1 from pms_city_ledger c
                   where c.entry_type = 'payment' and c.payment_method = 'cash' and c.reference = 'drawer:' || s.id::text), 0)
       + coalesce((select sum(p.amount) from pms_pos_payments p
                   where p.drawer_session_id = s.id and p.method = 'cash' and not p.voided), 0)
       - coalesce((select sum(e.amount) from pms_expense_vouchers e where e.drawer_session_id = s.id), 0);
end $$;

create or replace function pms_rpt_pos_sales(p_property uuid, p_from date, p_to date)
returns table(outlet text, bills int, walk_in numeric, to_rooms numeric, discounts numeric, total numeric, cash numeric, voided int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'rpt.pos_sales');
  return query
    select o.name,
      count(*) filter (where b.status in ('settled','room'))::int,
      coalesce(sum(b.paid) filter (where b.status in ('settled','room')), 0),
      coalesce(sum(b.total - b.paid) filter (where b.status = 'room'), 0),
      coalesce(sum(b.discount) filter (where b.status in ('settled','room')), 0),
      coalesce(sum(b.total) filter (where b.status in ('settled','room')), 0),
      coalesce((select sum(p.amount) from pms_pos_payments p join pms_pos_bills bb on bb.id = p.bill_id
                where bb.outlet_id = o.id and bb.status in ('settled','room') and bb.business_date between p_from and p_to
                  and p.method = 'cash' and not p.voided), 0),
      count(*) filter (where b.status = 'void' and coalesce(b.void_reason, '') not like 'Merged into%')::int
    from pms_pos_outlets o
    left join pms_pos_bills b on b.outlet_id = o.id and b.business_date between p_from and p_to
    where o.property_id = p_property
    group by o.id, o.name order by o.name;
end $$;

create or replace function pms_rpt_payment_methods(p_property uuid, p_from date, p_to date)
returns table(method text, kind text, receipts int, amount numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'rpt.payment_methods');
  return query
    select coalesce(l.payment_method_name, initcap(replace(l.payment_method, '_', ' '))), l.payment_method, count(*)::int, -sum(l.amount)
    from pms_folio_lines l
    where l.property_id = p_property and not l.voided and l.line_type in ('payment','refund')
      and l.business_date between p_from and p_to and l.payment_method <> 'city_ledger'
    group by 1, 2
    union all
    select coalesce(p.method_name, initcap(replace(p.method, '_', ' '))) || ' (POS)', p.method, count(*)::int, sum(p.amount)
    from pms_pos_payments p join pms_pos_bills b on b.id = p.bill_id
    where p.property_id = p_property and not p.voided and b.status in ('settled','room') and b.business_date between p_from and p_to
    group by 1, 2
    order by 4 desc;
end $$;

-- Daily revenue: outlet takings come from tenders; the part charged to rooms is already on the folio
create or replace function pms_rpt_daily_revenue(p_property uuid, p_from date, p_to date)
returns table(business_date date, room numeric, tax numeric, fnb numeric, other numeric, discounts numeric,
              total_revenue numeric, payments numeric, city_ledger numeric, expenses numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'rpt.daily_revenue');
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
        coalesce(sum(b.paid) filter (where o.charge_category = 'fnb'), 0) as fnb,
        coalesce(sum(b.paid) filter (where o.charge_category <> 'fnb'), 0) as other
      from pms_pos_bills b join pms_pos_outlets o on o.id = b.outlet_id
      where b.property_id = p_property and b.status in ('settled','room') and b.business_date between p_from and p_to
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

-- End of day for one outlet: sales, tenders, voids, discounts, best sellers, by server
create or replace function pms_rpt_pos_z(p_outlet uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o pms_pos_outlets;
begin
  select * into o from pms_pos_outlets where id = p_outlet;
  if not found then raise exception 'Outlet not found'; end if;
  perform pms_need(o.property_id, 'rpt.pos_z');
  return jsonb_build_object(
    'outlet', o.name, 'date', p_date,
    'bills', (select count(*) from pms_pos_bills where outlet_id = p_outlet and business_date = p_date and status in ('settled','room')),
    'covers', (select coalesce(sum(covers), 0) from pms_pos_bills where outlet_id = p_outlet and business_date = p_date and status in ('settled','room')),
    'gross', (select coalesce(sum(subtotal), 0) from pms_pos_bills where outlet_id = p_outlet and business_date = p_date and status in ('settled','room')),
    'discounts', (select coalesce(sum(discount), 0) from pms_pos_bills where outlet_id = p_outlet and business_date = p_date and status in ('settled','room')),
    'service_charge', (select coalesce(sum(service_charge), 0) from pms_pos_bills where outlet_id = p_outlet and business_date = p_date and status in ('settled','room')),
    'net', (select coalesce(sum(total), 0) from pms_pos_bills where outlet_id = p_outlet and business_date = p_date and status in ('settled','room')),
    'to_rooms', (select coalesce(sum(total - paid), 0) from pms_pos_bills where outlet_id = p_outlet and business_date = p_date and status = 'room'),
    'open_bills', (select count(*) from pms_pos_bills where outlet_id = p_outlet and business_date = p_date and status = 'open'),
    'tenders', (select coalesce(jsonb_agg(jsonb_build_object('method', m, 'count', c, 'amount', a) order by a desc), '[]') from (
        select coalesce(p.method_name, initcap(replace(p.method, '_', ' '))) m, count(*) c, sum(p.amount) a
        from pms_pos_payments p join pms_pos_bills b on b.id = p.bill_id
        where b.outlet_id = p_outlet and b.business_date = p_date and b.status in ('settled','room') and not p.voided group by 1) t),
    'voided_bills', (select coalesce(jsonb_agg(jsonb_build_object('bill_no', bill_no, 'amount', total, 'reason', void_reason)), '[]') from pms_pos_bills
        where outlet_id = p_outlet and business_date = p_date and status = 'void' and coalesce(void_reason, '') not like 'Merged into%'),
    'voided_items', (select coalesce(jsonb_agg(jsonb_build_object('bill_no', b.bill_no, 'item', l.name, 'amount', l.amount, 'reason', l.void_reason)), '[]')
        from pms_pos_bill_items l join pms_pos_bills b on b.id = l.bill_id where b.outlet_id = p_outlet and b.business_date = p_date and l.voided),
    'top_items', (select coalesce(jsonb_agg(x order by (x->>'amount')::numeric desc), '[]') from (
        select jsonb_build_object('item', coalesce(i.name, l.name), 'qty', sum(l.qty), 'amount', sum(l.amount)) x
        from pms_pos_bill_items l join pms_pos_bills b on b.id = l.bill_id left join pms_pos_items i on i.id = l.item_id
        where b.outlet_id = p_outlet and b.business_date = p_date and b.status in ('settled','room') and not l.voided
        group by coalesce(i.name, l.name) order by sum(l.amount) desc limit 10) t),
    'servers', (select coalesce(jsonb_agg(jsonb_build_object('server', s, 'bills', c, 'amount', a) order by a desc), '[]') from (
        select coalesce(m.display_name, split_part(u.email, '@', 1), 'Unknown') s, count(*) c, sum(b.total) a
        from pms_pos_bills b left join auth.users u on u.id = coalesce(b.server_id, b.created_by)
        left join pms_members m on m.user_id = u.id and m.property_id = b.property_id
        where b.outlet_id = p_outlet and b.business_date = p_date and b.status in ('settled','room') group by 1) t));
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
revoke execute on function pms__pos_check_timers(uuid), pms__pos_price(pms_pos_items, timestamptz), pms__pos_total(uuid), pms__pos_close_if_paid(uuid), pms_trg_pos_stock() from authenticated;
grant execute on function pms_pos_open_table(uuid, int, text), pms_pos_floor(uuid), pms_pos_move_table(uuid, uuid), pms_pos_merge_bills(uuid, uuid),
  pms_pos_set_server(uuid, uuid), pms_pos_order(uuid, uuid, numeric, uuid[], text, int, int), pms_pos_add_item(uuid, uuid, numeric, text, numeric),
  pms_pos_remove_item(uuid), pms_pos_void_item(uuid, text), pms_pos_send(uuid, int), pms_pos_kitchen(uuid, text), pms_pos_kitchen_bump(uuid[], text),
  pms_pos_set_available(uuid, boolean), pms_pos_pay(uuid, uuid, numeric, text, numeric), pms_pos_remove_payment(uuid, text),
  pms_pos_settle(uuid, text, text), pms_pos_settle_method(uuid, uuid, text), pms_pos_post_to_room(uuid, uuid), pms_pos_void_bill(uuid, text),
  pms_rpt_pos_sales(uuid, date, date), pms_rpt_payment_methods(uuid, date, date), pms_rpt_daily_revenue(uuid, date, date), pms_rpt_pos_z(uuid, date),
  pms_drawer_expected(uuid) to authenticated;
select pms__apply_platform_rules();
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';
