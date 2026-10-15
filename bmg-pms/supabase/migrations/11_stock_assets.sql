-- module: stock
-- also: back-office, core
-- =====================================================================
-- BMG PMS 11 — kitchen and bar stock with recipes, and room assets.
--   Stock: items, locations (store, kitchen, bar), an append-only movement ledger,
--   weighted average cost, recipes on menu items. A POS bill that is paid or charged
--   to a room takes its ingredients out of the outlet's location; a void puts them back.
--   Assets: what is in each room, room checks, and missing or damaged items turned
--   into work orders or a charge to the guest.
-- Safe to re-run. Run after 10.
-- =====================================================================

-- a storekeeper runs the stores and the stock count; nothing else
alter table pms_members drop constraint if exists pms_members_role_check;
alter table pms_members add constraint pms_members_role_check
  check (role in ('owner','manager','front_desk','accountant','housekeeping','storekeeper'));

-- ---------------------------------------------------------------------
-- 1. Stock
-- ---------------------------------------------------------------------
create table if not exists pms_stock_locations (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  name         text not null,
  kind         text not null default 'store' check (kind in ('store','kitchen','bar','other')),
  active       boolean not null default true,
  unique (property_id, name)
);

create table if not exists pms_stock_items (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references pms_properties(id) on delete cascade,
  name           text not null,
  unit           text not null default 'pcs',          -- kg, g, l, ml, pcs, btl …
  category       text,
  reorder_level  numeric(14,3) not null default 0 check (reorder_level >= 0),
  avg_cost       numeric(14,4) not null default 0,      -- weighted average cost per unit
  active         boolean not null default true,
  unique (property_id, name)
);

alter table pms_pos_outlets add column if not exists stock_location_id uuid references pms_stock_locations(id) on delete set null;

-- portion of each stock item one menu item uses
create table if not exists pms_recipe_lines (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references pms_properties(id) on delete cascade,
  pos_item_id    uuid not null references pms_pos_items(id) on delete cascade,
  stock_item_id  uuid not null references pms_stock_items(id) on delete restrict,
  qty            numeric(14,4) not null check (qty > 0),
  unique (pos_item_id, stock_item_id)
);

create table if not exists pms_stock_levels (
  item_id      uuid not null references pms_stock_items(id) on delete cascade,
  location_id  uuid not null references pms_stock_locations(id) on delete cascade,
  property_id  uuid not null references pms_properties(id) on delete cascade,
  qty          numeric(14,3) not null default 0,
  primary key (item_id, location_id)
);

create table if not exists pms_stock_moves (
  id             bigserial primary key,
  property_id    uuid not null references pms_properties(id) on delete cascade,
  item_id        uuid not null references pms_stock_items(id),
  location_id    uuid not null references pms_stock_locations(id),
  qty            numeric(14,3) not null check (qty <> 0),     -- + in, − out
  kind           text not null check (kind in ('opening','receive','transfer_in','transfer_out','sale','sale_reversal','waste','count')),
  unit_cost      numeric(14,4) not null default 0,
  value          numeric(14,2) not null default 0,             -- qty × unit cost, signed
  pos_bill_id    uuid references pms_pos_bills(id),
  pos_item_id    uuid references pms_pos_items(id),
  supplier       text,
  reference      text,
  note           text,
  business_date  date not null,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index if not exists idx_pms_stock_moves on pms_stock_moves(property_id, business_date);
create index if not exists idx_pms_stock_moves_item on pms_stock_moves(item_id, location_id);
create index if not exists idx_pms_stock_moves_bill on pms_stock_moves(pos_bill_id);

-- the ledger is append-only; levels follow it
create or replace function pms_trg_stock_moves() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'INSERT' then raise exception 'Stock movements cannot be changed. Post a correcting movement.'; end if;
  insert into pms_stock_levels(item_id, location_id, property_id, qty) values (new.item_id, new.location_id, new.property_id, new.qty)
  on conflict (item_id, location_id) do update set qty = pms_stock_levels.qty + excluded.qty;
  return new;
end $$;
drop trigger if exists trg_stock_moves on pms_stock_moves;
create trigger trg_stock_moves before insert or update or delete on pms_stock_moves for each row execute function pms_trg_stock_moves();

create or replace function pms__stock_item(p_item uuid) returns pms_stock_items
language plpgsql security definer set search_path = public as $$
declare i pms_stock_items;
begin
  select * into i from pms_stock_items where id = p_item for update;
  if not found then raise exception 'Stock item not found'; end if;
  return i;
end $$;

create or replace function pms__stock_location(p_location uuid, p_property uuid) returns pms_stock_locations
language plpgsql stable security definer set search_path = public as $$
declare l pms_stock_locations;
begin
  select * into l from pms_stock_locations where id = p_location and property_id = p_property;
  if not found then raise exception 'Stock location not found'; end if;
  return l;
end $$;

create or replace function pms__on_hand(p_item uuid, p_location uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select qty from pms_stock_levels where item_id = p_item and location_id = p_location), 0)
$$;

create or replace function pms__bd(p_property uuid) returns date
language sql stable security definer set search_path = public as $$ select business_date from pms_properties where id = p_property $$;

-- Goods in (a delivery, or opening stock). Updates the weighted average cost.
create or replace function pms_receive_stock(p_location uuid, p_item uuid, p_qty numeric, p_unit_cost numeric,
  p_supplier text default null, p_reference text default null, p_opening boolean default false) returns bigint
language plpgsql security definer set search_path = public as $$
declare i pms_stock_items; v_total numeric; v_id bigint;
begin
  i := pms__stock_item(p_item);
  perform pms_require(i.property_id, array['owner','manager','accountant','storekeeper']);
  perform pms__stock_location(p_location, i.property_id);
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_unit_cost is null or p_unit_cost < 0 then raise exception 'Enter the cost per %', i.unit; end if;
  select greatest(coalesce(sum(qty), 0), 0) into v_total from pms_stock_levels where item_id = p_item;
  update pms_stock_items set avg_cost = case when v_total + p_qty > 0 then round((v_total * avg_cost + p_qty * p_unit_cost) / (v_total + p_qty), 4) else p_unit_cost end
   where id = p_item;
  insert into pms_stock_moves(property_id, item_id, location_id, qty, kind, unit_cost, value, supplier, reference, business_date, created_by)
  values (i.property_id, p_item, p_location, p_qty, case when p_opening then 'opening' else 'receive' end, p_unit_cost, round(p_qty * p_unit_cost, 2),
          nullif(trim(coalesce(p_supplier, '')), ''), nullif(trim(coalesce(p_reference, '')), ''), pms__bd(i.property_id), auth.uid())
  returning id into v_id;
  perform pms_log(i.property_id, 'stock.receive', 'stock_item', p_item, jsonb_build_object('qty', p_qty, 'unit_cost', p_unit_cost, 'supplier', p_supplier));
  return v_id;
end $$;

-- Store → kitchen or bar. A store cannot issue more than it holds.
create or replace function pms_transfer_stock(p_from uuid, p_to uuid, p_item uuid, p_qty numeric, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare i pms_stock_items; v_have numeric; v_bd date;
begin
  i := pms__stock_item(p_item);
  perform pms_require(i.property_id, array['owner','manager','accountant','storekeeper']);
  perform pms__stock_location(p_from, i.property_id); perform pms__stock_location(p_to, i.property_id);
  if p_from = p_to then raise exception 'Choose two different locations'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  v_have := pms__on_hand(p_item, p_from);
  if v_have < p_qty then raise exception 'Only % % of % in stock there', v_have, i.unit, i.name; end if;
  v_bd := pms__bd(i.property_id);
  insert into pms_stock_moves(property_id, item_id, location_id, qty, kind, unit_cost, value, note, business_date, created_by) values
    (i.property_id, p_item, p_from, -p_qty, 'transfer_out', i.avg_cost, -round(p_qty * i.avg_cost, 2), p_note, v_bd, auth.uid()),
    (i.property_id, p_item, p_to, p_qty, 'transfer_in', i.avg_cost, round(p_qty * i.avg_cost, 2), p_note, v_bd, auth.uid());
  perform pms_log(i.property_id, 'stock.transfer', 'stock_item', p_item, jsonb_build_object('qty', p_qty, 'from', p_from, 'to', p_to));
end $$;

-- Spoilt, burnt, expired or dropped
create or replace function pms_record_waste(p_location uuid, p_item uuid, p_qty numeric, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare i pms_stock_items;
begin
  i := pms__stock_item(p_item);
  perform pms_require(i.property_id, array['owner','manager','accountant','storekeeper']);
  perform pms__stock_location(p_location, i.property_id);
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Say why it was wasted'; end if;
  insert into pms_stock_moves(property_id, item_id, location_id, qty, kind, unit_cost, value, note, business_date, created_by)
  values (i.property_id, p_item, p_location, -p_qty, 'waste', i.avg_cost, -round(p_qty * i.avg_cost, 2), p_reason, pms__bd(i.property_id), auth.uid());
  perform pms_log(i.property_id, 'stock.waste', 'stock_item', p_item, jsonb_build_object('qty', p_qty, 'reason', p_reason));
end $$;

-- Physical count: rows [{item_id, counted}]. The system moves to what was counted; the difference is the variance.
create or replace function pms_stock_count(p_location uuid, p_counts jsonb, p_note text default null)
returns table(item_id uuid, item text, unit text, expected numeric, counted numeric, variance numeric, variance_value numeric)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare l pms_stock_locations; r jsonb; i pms_stock_items; v_have numeric; v_cnt numeric; v_bd date;
begin
  select * into l from pms_stock_locations where id = p_location;
  if not found then raise exception 'Stock location not found'; end if;
  perform pms_require(l.property_id, array['owner','manager','accountant','storekeeper']);
  v_bd := pms__bd(l.property_id);
  for r in select * from jsonb_array_elements(coalesce(p_counts, '[]')) loop
    v_cnt := nullif(r->>'counted', '')::numeric;
    continue when v_cnt is null;
    if v_cnt < 0 then raise exception 'Counts cannot be negative'; end if;
    i := pms__stock_item((r->>'item_id')::uuid);
    if i.property_id <> l.property_id then raise exception 'Stock item not found'; end if;
    v_have := pms__on_hand(i.id, p_location);
    if v_cnt <> v_have then
      insert into pms_stock_moves(property_id, item_id, location_id, qty, kind, unit_cost, value, note, business_date, created_by)
      values (l.property_id, i.id, p_location, v_cnt - v_have, 'count', i.avg_cost, round((v_cnt - v_have) * i.avg_cost, 2),
              coalesce(p_note, 'Stock count'), v_bd, auth.uid());
    end if;
    item_id := i.id; item := i.name; unit := i.unit; expected := v_have; counted := v_cnt; variance := v_cnt - v_have;
    variance_value := round((v_cnt - v_have) * i.avg_cost, 2);
    return next;
  end loop;
  perform pms_log(l.property_id, 'stock.count', 'stock_location', p_location, jsonb_build_object('items', jsonb_array_length(coalesce(p_counts, '[]'))));
end $$;

-- Replace a menu item's recipe: [{stock_item_id, qty}] (an empty list clears it)
create or replace function pms_set_recipe(p_pos_item uuid, p_lines jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare it pms_pos_items; r jsonb; n int := 0;
begin
  select * into it from pms_pos_items where id = p_pos_item;
  if not found then raise exception 'Menu item not found'; end if;
  perform pms_require(it.property_id, array['owner','manager','storekeeper']);
  delete from pms_recipe_lines where pos_item_id = p_pos_item;
  for r in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    continue when nullif(r->>'qty', '') is null or (r->>'qty')::numeric <= 0;
    if not exists (select 1 from pms_stock_items where id = (r->>'stock_item_id')::uuid and property_id = it.property_id) then
      raise exception 'Stock item not found';
    end if;
    insert into pms_recipe_lines(property_id, pos_item_id, stock_item_id, qty) values (it.property_id, p_pos_item, (r->>'stock_item_id')::uuid, (r->>'qty')::numeric)
    on conflict (pos_item_id, stock_item_id) do update set qty = pms_recipe_lines.qty + excluded.qty;
    n := n + 1;
  end loop;
  perform pms_log(it.property_id, 'stock.recipe', 'pos_item', p_pos_item, jsonb_build_object('lines', n));
  return n;
end $$;

-- A bill paid or charged to a room uses up its recipes; a void puts them back. Never blocks a sale:
-- a kitchen can go below zero, and the stock count shows it.
create or replace function pms_trg_pos_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_loc uuid;
begin
  select stock_location_id into v_loc from pms_pos_outlets where id = new.outlet_id;
  if v_loc is null then return null; end if;
  if old.status = 'open' and new.status in ('settled','room') then
    insert into pms_stock_moves(property_id, item_id, location_id, qty, kind, unit_cost, value, pos_bill_id, pos_item_id, reference, business_date, created_by)
    select new.property_id, rl.stock_item_id, v_loc, -(bi.qty * rl.qty), 'sale', si.avg_cost, -round(bi.qty * rl.qty * si.avg_cost, 2),
           new.id, bi.item_id, 'Bill #' || new.bill_no, new.business_date, auth.uid()
      from pms_pos_bill_items bi
      join pms_recipe_lines rl on rl.pos_item_id = bi.item_id
      join pms_stock_items si on si.id = rl.stock_item_id
     where bi.bill_id = new.id;
  elsif new.status = 'void' and old.status in ('settled','room') then
    insert into pms_stock_moves(property_id, item_id, location_id, qty, kind, unit_cost, value, pos_bill_id, pos_item_id, reference, note, business_date, created_by)
    select m.property_id, m.item_id, m.location_id, -m.qty, 'sale_reversal', m.unit_cost, -m.value, m.pos_bill_id, m.pos_item_id, m.reference,
           'Bill voided', pms__bd(new.property_id), auth.uid()
      from pms_stock_moves m where m.pos_bill_id = new.id and m.kind = 'sale';
  end if;
  return null;
end $$;
drop trigger if exists trg_pos_stock on pms_pos_bills;
create trigger trg_pos_stock after update of status on pms_pos_bills for each row execute function pms_trg_pos_stock();

-- Reports
create or replace function pms_rpt_stock_levels(p_property uuid)
returns table(item_id uuid, item text, category text, unit text, location_id uuid, location text, qty numeric,
              total_qty numeric, reorder_level numeric, avg_cost numeric, value numeric, low boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not pms_is_member(p_property) then raise exception 'Not a member of this property'; end if;
  return query
    select i.id, i.name, i.category, i.unit, l.id, l.name, coalesce(s.qty, 0)::numeric,
           coalesce(sum(coalesce(s.qty, 0)) over (partition by i.id), 0)::numeric, i.reorder_level, i.avg_cost,
           round(coalesce(s.qty, 0) * i.avg_cost, 2),
           coalesce(sum(coalesce(s.qty, 0)) over (partition by i.id), 0) <= i.reorder_level and i.reorder_level > 0
      from pms_stock_items i
      cross join pms_stock_locations l
      left join pms_stock_levels s on s.item_id = i.id and s.location_id = l.id
     where i.property_id = p_property and l.property_id = p_property and i.active and l.active
     order by i.name, l.name;
end $$;

-- Food and beverage cost by menu item: what was sold, what its recipes used, and the cost as a share of sales
create or replace function pms_rpt_food_cost(p_property uuid, p_from date, p_to date)
returns table(outlet text, menu_item text, qty_sold numeric, revenue numeric, recipe_cost numeric, cost_pct numeric, has_recipe boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant','storekeeper']);
  return query
    with sold as (
      select o.name as outlet, bi.item_id, max(bi.name) as name, sum(bi.qty) as qty, sum(bi.amount) as revenue
        from pms_pos_bills b join pms_pos_bill_items bi on bi.bill_id = b.id join pms_pos_outlets o on o.id = b.outlet_id
       where b.property_id = p_property and b.status in ('settled','room') and b.business_date between p_from and p_to
       group by o.name, bi.item_id),
    cost as (
      select m.pos_item_id, -sum(m.value) as cost from pms_stock_moves m
       where m.property_id = p_property and m.kind in ('sale','sale_reversal') and m.business_date between p_from and p_to
       group by m.pos_item_id)
    select s.outlet, s.name, s.qty, s.revenue, coalesce(c.cost, 0)::numeric,
           case when s.revenue > 0 then round(coalesce(c.cost, 0) * 100 / s.revenue, 1) end,
           exists (select 1 from pms_recipe_lines rl where rl.pos_item_id = s.item_id)
      from sold s left join cost c on c.pos_item_id = s.item_id
     order by s.outlet, s.revenue desc;
end $$;

-- Usage and losses by item over a period: opening, in, used by sales, wasted, count variance, closing
create or replace function pms_rpt_stock_usage(p_property uuid, p_from date, p_to date)
returns table(item text, unit text, opening numeric, received numeric, sold numeric, wasted numeric, count_variance numeric, closing numeric, loss_value numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant','storekeeper']);
  return query
    select i.name, i.unit,
      coalesce(sum(m.qty) filter (where m.business_date < p_from), 0)::numeric,
      coalesce(sum(m.qty) filter (where m.business_date between p_from and p_to and m.kind in ('receive','opening')), 0)::numeric,
      coalesce(-sum(m.qty) filter (where m.business_date between p_from and p_to and m.kind in ('sale','sale_reversal')), 0)::numeric,
      coalesce(-sum(m.qty) filter (where m.business_date between p_from and p_to and m.kind = 'waste'), 0)::numeric,
      coalesce(sum(m.qty) filter (where m.business_date between p_from and p_to and m.kind = 'count'), 0)::numeric,
      coalesce(sum(m.qty) filter (where m.business_date <= p_to), 0)::numeric,
      coalesce(-sum(m.value) filter (where m.business_date between p_from and p_to and m.kind = 'waste'), 0)
        - coalesce(sum(m.value) filter (where m.business_date between p_from and p_to and m.kind = 'count'), 0)
    from pms_stock_items i left join pms_stock_moves m on m.item_id = i.id
    where i.property_id = p_property
    group by i.id, i.name, i.unit
    having count(m.id) > 0
    order by i.name;
end $$;

-- ---------------------------------------------------------------------
-- 2. Room assets
-- ---------------------------------------------------------------------
create table if not exists pms_asset_types (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references pms_properties(id) on delete cascade,
  name              text not null,
  category          text not null default 'furniture' check (category in ('furniture','electronics','linen','fixture','amenity','other')),
  replacement_cost  numeric(14,2) not null default 0 check (replacement_cost >= 0),
  active            boolean not null default true,
  unique (property_id, name)
);

create table if not exists pms_assets (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references pms_properties(id) on delete cascade,
  asset_type_id    uuid not null references pms_asset_types(id),
  room_id          uuid references pms_rooms(id) on delete set null,     -- null = public area or store
  location_note    text,
  tag              text,                                                  -- asset tag or serial number
  qty              integer not null default 1 check (qty > 0),
  condition        text not null default 'good' check (condition in ('good','fair','damaged','missing','retired')),
  purchase_date    date,
  cost             numeric(14,2),
  notes            text,
  last_checked_at  timestamptz,
  last_checked_by  uuid,
  created_at       timestamptz not null default now()
);
create unique index if not exists uq_pms_asset_tag on pms_assets(property_id, tag) where tag is not null;
create index if not exists idx_pms_assets_room on pms_assets(room_id);

create table if not exists pms_asset_events (
  id             bigserial primary key,
  property_id    uuid not null references pms_properties(id) on delete cascade,
  asset_id       uuid not null references pms_assets(id) on delete cascade,
  kind           text not null check (kind in ('added','checked','damaged','missing','found','repaired','moved','retired','charged')),
  condition      text,
  from_room_id   uuid references pms_rooms(id) on delete set null,
  to_room_id     uuid references pms_rooms(id) on delete set null,
  stay_id        uuid references pms_stays(id) on delete set null,
  work_order_id  uuid references pms_work_orders(id) on delete set null,
  folio_line_id  uuid references pms_folio_lines(id),
  amount         numeric(14,2),
  note           text,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index if not exists idx_pms_asset_events on pms_asset_events(asset_id, created_at);

create table if not exists pms_room_inspections (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  room_id       uuid not null references pms_rooms(id) on delete cascade,
  stay_id       uuid references pms_stays(id) on delete set null,     -- the guest who just left, if any
  checked       int not null default 0,
  issues        int not null default 0,
  note          text,
  inspected_by  uuid,
  created_at    timestamptz not null default now()
);

-- Add assets to a room (or to every room of a room type)
create or replace function pms_add_assets(p_property uuid, p_asset_type uuid, p_room uuid default null, p_room_type uuid default null,
  p_qty int default 1, p_tag text default null, p_cost numeric default null, p_location_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_id uuid;
begin
  perform pms_require(p_property, array['owner','manager','storekeeper']);
  if not exists (select 1 from pms_asset_types where id = p_asset_type and property_id = p_property) then raise exception 'Asset type not found'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Quantity must be at least 1'; end if;
  if p_room_type is not null and p_tag is not null then raise exception 'A tag belongs to one item; add tagged items room by room'; end if;
  for r in select id from pms_rooms where property_id = p_property and active
             and ((p_room_type is not null and room_type_id = p_room_type) or (p_room_type is null and id is not distinct from p_room))
           union all select null where p_room is null and p_room_type is null loop
    insert into pms_assets(property_id, asset_type_id, room_id, qty, tag, cost, location_note)
    values (p_property, p_asset_type, r.id, p_qty, nullif(trim(coalesce(p_tag, '')), ''), p_cost, p_location_note) returning id into v_id;
    insert into pms_asset_events(property_id, asset_id, kind, condition, to_room_id, created_by) values (p_property, v_id, 'added', 'good', r.id, auth.uid());
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'No rooms matched'; end if;
  perform pms_log(p_property, 'asset.add', 'asset_type', p_asset_type, jsonb_build_object('count', n, 'room', p_room, 'room_type', p_room_type));
  return n;
end $$;

create or replace function pms_move_asset(p_asset uuid, p_room uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare a pms_assets;
begin
  select * into a from pms_assets where id = p_asset for update;
  if not found then raise exception 'Asset not found'; end if;
  perform pms_require(a.property_id, array['owner','manager','storekeeper','housekeeping']);
  if p_room is not null and not exists (select 1 from pms_rooms where id = p_room and property_id = a.property_id) then raise exception 'Room not found'; end if;
  update pms_assets set room_id = p_room where id = p_asset;
  insert into pms_asset_events(property_id, asset_id, kind, from_room_id, to_room_id, note, created_by) values (a.property_id, p_asset, 'moved', a.room_id, p_room, p_note, auth.uid());
end $$;

-- Room check. Items: [{asset_id, condition: good|fair|damaged|missing, note}]. Damaged or missing items open a work order
-- (once per item while it is still open) and, when the check follows a guest's stay, are listed for a possible charge.
create or replace function pms_inspect_room(p_room uuid, p_items jsonb, p_stay uuid default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rm pms_rooms; r jsonb; a pms_assets; t pms_asset_types; v_cond text; v_wo uuid; v_issues jsonb := '[]'; v_insp uuid; n int := 0;
begin
  select * into rm from pms_rooms where id = p_room;
  if not found then raise exception 'Room not found'; end if;
  perform pms_require(rm.property_id, array['owner','manager','front_desk','housekeeping','storekeeper']);
  if p_stay is not null and not exists (select 1 from pms_stays where id = p_stay and room_id = p_room) then raise exception 'That stay was not in this room'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    select * into a from pms_assets where id = (r->>'asset_id')::uuid and room_id = p_room for update;
    if not found then raise exception 'An item on the list is not in room %', rm.number; end if;
    v_cond := coalesce(nullif(r->>'condition', ''), 'good');
    if v_cond not in ('good','fair','damaged','missing') then raise exception 'Unknown condition %', v_cond; end if;
    select * into t from pms_asset_types where id = a.asset_type_id;
    update pms_assets set condition = v_cond, last_checked_at = now(), last_checked_by = auth.uid() where id = a.id;
    n := n + 1;
    if v_cond in ('damaged','missing') and a.condition not in ('damaged','missing') then
      insert into pms_work_orders(property_id, room_id, title, description, category, priority, created_by)
      values (rm.property_id, p_room, initcap(v_cond) || ': ' || t.name || ' in room ' || rm.number,
              nullif(trim(coalesce(r->>'note', '')), ''), 'maintenance', case when v_cond = 'missing' then 'high' else 'normal' end, auth.uid())
      returning id into v_wo;
      insert into pms_asset_events(property_id, asset_id, kind, condition, stay_id, work_order_id, note, created_by)
      values (rm.property_id, a.id, v_cond, v_cond, p_stay, v_wo, r->>'note', auth.uid());
      v_issues := v_issues || jsonb_build_object('asset_id', a.id, 'item', t.name, 'condition', v_cond,
        'replacement_cost', coalesce(a.cost, t.replacement_cost), 'work_order_id', v_wo);
    elsif v_cond in ('good','fair') and a.condition in ('damaged','missing') then
      insert into pms_asset_events(property_id, asset_id, kind, condition, note, created_by)
      values (rm.property_id, a.id, case when a.condition = 'missing' then 'found' else 'repaired' end, v_cond, r->>'note', auth.uid());
    else
      insert into pms_asset_events(property_id, asset_id, kind, condition, stay_id, note, created_by) values (rm.property_id, a.id, 'checked', v_cond, p_stay, r->>'note', auth.uid());
    end if;
  end loop;
  insert into pms_room_inspections(property_id, room_id, stay_id, checked, issues, note, inspected_by)
  values (rm.property_id, p_room, p_stay, n, jsonb_array_length(v_issues), p_note, auth.uid()) returning id into v_insp;
  perform pms_log(rm.property_id, 'room.inspect', 'room', p_room, jsonb_build_object('checked', n, 'issues', jsonb_array_length(v_issues), 'stay', p_stay));
  return jsonb_build_object('inspection_id', v_insp, 'checked', n, 'issues', v_issues);
end $$;

-- Charge the guest for a damaged or missing item: posts a damage line on their folio (open or reopened by the desk)
create or replace function pms_charge_asset(p_asset uuid, p_stay uuid, p_amount numeric, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare a pms_assets; t pms_asset_types; s pms_stays; v_folio uuid; v_line uuid; v_room text;
begin
  select * into a from pms_assets where id = p_asset;
  if not found then raise exception 'Asset not found'; end if;
  perform pms_require(a.property_id, array['owner','manager','front_desk']);
  select * into s from pms_stays where id = p_stay and property_id = a.property_id;
  if not found then raise exception 'Stay not found'; end if;
  select id into v_folio from pms_folios where stay_id = p_stay and status = 'open' order by folio_no limit 1;
  if v_folio is null then raise exception 'The guest''s folio is closed. Charge the company account or reopen the bill at the front desk.'; end if;
  if exists (select 1 from pms_asset_events where asset_id = p_asset and stay_id = p_stay and kind = 'charged') then
    raise exception 'This item was already charged to this stay';
  end if;
  select * into t from pms_asset_types where id = a.asset_type_id;
  select number into v_room from pms_rooms where id = a.room_id;
  v_line := pms_post_charge(v_folio, 'damage', initcap(a.condition) || ' ' || lower(t.name) || coalesce(' (room ' || v_room || ')', ''), p_amount, coalesce(a.tag, null));
  insert into pms_asset_events(property_id, asset_id, kind, condition, stay_id, folio_line_id, amount, note, created_by)
  values (a.property_id, p_asset, 'charged', a.condition, p_stay, v_line, p_amount, p_note, auth.uid());
  return v_line;
end $$;

create or replace function pms_retire_asset(p_asset uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare a pms_assets;
begin
  select * into a from pms_assets where id = p_asset for update;
  if not found then raise exception 'Asset not found'; end if;
  perform pms_require(a.property_id, array['owner','manager','storekeeper']);
  if coalesce(trim(p_reason), '') = '' then raise exception 'Say why it is being retired'; end if;
  update pms_assets set condition = 'retired' where id = p_asset;
  insert into pms_asset_events(property_id, asset_id, kind, condition, note, created_by) values (a.property_id, p_asset, 'retired', 'retired', p_reason, auth.uid());
end $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pms_stock_locations','pms_stock_items','pms_recipe_lines','pms_stock_levels','pms_stock_moves',
                           'pms_asset_types','pms_assets','pms_asset_events','pms_room_inspections'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (pms_is_member(property_id))', t || '_read', t);
    execute format('revoke all on %I from authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;
-- simple setup lists are edited directly by managers and storekeepers
do $$
declare t text;
begin
  foreach t in array array['pms_stock_locations','pms_stock_items','pms_asset_types'] loop
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format('create policy %I on %I for all using (pms_role(property_id) in (''owner'',''manager'',''storekeeper'')) with check (pms_role(property_id) in (''owner'',''manager'',''storekeeper''))', t || '_write', t);
    execute format('grant insert, update on %I to authenticated', t);
  end loop;
end $$;
-- avg_cost only moves through receiving
revoke update on pms_stock_items from authenticated;
grant update (name, unit, category, reorder_level, active) on pms_stock_items to authenticated;
grant update (stock_location_id) on pms_pos_outlets to authenticated;
grant usage, select on sequence pms_stock_moves_id_seq, pms_asset_events_id_seq to authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'pms\_\_%' escape '\' or p.proname like 'pms_trg_%') loop
    execute format('revoke execute on function %s from public', f.sig);
    begin execute format('revoke execute on function %s from authenticated', f.sig); exception when undefined_object then null; end;
    begin execute format('revoke execute on function %s from anon', f.sig); exception when undefined_object then null; end;
  end loop;
end $$;
grant execute on function pms_receive_stock(uuid, uuid, numeric, numeric, text, text, boolean) to authenticated;
grant execute on function pms_transfer_stock(uuid, uuid, uuid, numeric, text) to authenticated;
grant execute on function pms_record_waste(uuid, uuid, numeric, text) to authenticated;
grant execute on function pms_stock_count(uuid, jsonb, text) to authenticated;
grant execute on function pms_set_recipe(uuid, jsonb) to authenticated;
grant execute on function pms_rpt_stock_levels(uuid) to authenticated;
grant execute on function pms_rpt_food_cost(uuid, date, date) to authenticated;
grant execute on function pms_rpt_stock_usage(uuid, date, date) to authenticated;
grant execute on function pms_add_assets(uuid, uuid, uuid, uuid, int, text, numeric, text) to authenticated;
grant execute on function pms_move_asset(uuid, uuid, text) to authenticated;
grant execute on function pms_inspect_room(uuid, jsonb, uuid, text) to authenticated;
grant execute on function pms_charge_asset(uuid, uuid, numeric, text) to authenticated;
grant execute on function pms_retire_asset(uuid, text) to authenticated;
grant execute on function pms_role(uuid) to authenticated;
grant execute on function pms_is_member(uuid) to authenticated;
notify pgrst, 'reload schema';
