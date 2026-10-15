-- module: procurement
-- also: core, stock
-- 23 · Stores, acquisition and procurement, for restaurants, bars and activities alike
--
--   Suppliers ─► Purchase order ─(approval)─► Goods received (GRN) ─► stock in the receiving store at cost
--                                                         │
--   Supplier invoice ◄── matched to what was ordered and received (quantity and price) ──► Supplier payments
--   Departments (kitchen, bar, gym, spa, housekeeping) ask the main store for stock (store requests); the store
--   issues it, moving stock and its value to that department. Par levels per store drive reorder suggestions,
--   and a suggestion becomes a draft order in one step. Creditors ageing and purchases reports.
--
--  * Every document has its own number per property (PO-00001, GRN-00001, SR-00001, SI-00001).
--  * Segregation of duties: whoever raises an order cannot approve it (owners excepted); orders up to the
--    property's approval limit go straight through for people who may order.
--  * Items are bought in purchase units (a case of 24) and stocked in stock units (bottles).
-- Safe to re-run.

-- ---------------------------------------------------------------------
-- Suppliers and item purchasing details
-- ---------------------------------------------------------------------
create table if not exists pms_suppliers (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references pms_properties(id) on delete cascade,
  name                text not null,
  contact_name        text,
  phone               text,
  email               text,
  tin                 text,
  vrn                 text,
  address             text,
  payment_terms_days  integer not null default 30 check (payment_terms_days between 0 and 365),
  currency            text not null default 'TZS' check (currency ~ '^[A-Z]{3}$'),
  notes               text,
  active              boolean not null default true,
  unique (property_id, name)
);

alter table pms_stock_items add column if not exists sku text;
alter table pms_stock_items add column if not exists purchase_unit text;
alter table pms_stock_items add column if not exists units_per_purchase numeric(14,4) not null default 1;
alter table pms_stock_items add column if not exists default_supplier_id uuid references pms_suppliers(id) on delete set null;
alter table pms_stock_items add column if not exists last_cost numeric(14,4);
do $$ begin
  alter table pms_stock_items add constraint pms_stock_items_units_per_purchase_check check (units_per_purchase > 0);
exception when duplicate_object then null; end $$;
create index if not exists ix_stock_items_supplier on pms_stock_items (default_supplier_id);

-- How much each store should hold
create table if not exists pms_stock_par (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references pms_properties(id) on delete cascade,
  location_id    uuid not null references pms_stock_locations(id) on delete cascade,
  item_id        uuid not null references pms_stock_items(id) on delete cascade,
  par_level      numeric(14,3) not null check (par_level >= 0),
  reorder_level  numeric(14,3) not null default 0 check (reorder_level >= 0),
  unique (location_id, item_id)
);
create index if not exists ix_stock_par_item on pms_stock_par (item_id);
create index if not exists ix_stock_par_property on pms_stock_par (property_id);

alter table pms_stock_locations drop constraint if exists pms_stock_locations_kind_check;
alter table pms_stock_locations add constraint pms_stock_locations_kind_check check (kind in ('store','kitchen','bar','activity','housekeeping','other'));

alter table pms_properties add column if not exists next_po_no integer not null default 1;
alter table pms_properties add column if not exists next_grn_no integer not null default 1;
alter table pms_properties add column if not exists next_request_no integer not null default 1;
alter table pms_properties add column if not exists next_sinv_no integer not null default 1;

-- ---------------------------------------------------------------------
-- Store requests (departments ask the store) and issues
-- ---------------------------------------------------------------------
create table if not exists pms_store_requests (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  request_no      integer not null,
  from_location_id uuid not null references pms_stock_locations(id),
  to_location_id  uuid not null references pms_stock_locations(id),
  status          text not null default 'submitted' check (status in ('submitted','partly_issued','issued','rejected','cancelled')),
  needed_by       date,
  notes           text,
  requested_by    uuid,
  decided_by      uuid,
  reject_reason   text,
  unique (property_id, request_no),
  check (from_location_id <> to_location_id)
);
create index if not exists ix_store_requests_status on pms_store_requests (property_id, status);
create index if not exists ix_store_requests_from on pms_store_requests (from_location_id);
create index if not exists ix_store_requests_to on pms_store_requests (to_location_id);

create table if not exists pms_store_request_lines (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  request_id    uuid not null references pms_store_requests(id) on delete cascade,
  item_id       uuid not null references pms_stock_items(id),
  qty           numeric(14,3) not null check (qty > 0),
  qty_issued    numeric(14,3) not null default 0 check (qty_issued >= 0),
  note          text
);
create index if not exists ix_store_request_lines_request on pms_store_request_lines (request_id);
create index if not exists ix_store_request_lines_item on pms_store_request_lines (item_id);
create index if not exists ix_store_request_lines_property on pms_store_request_lines (property_id);

-- ---------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------
create table if not exists pms_purchase_orders (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  po_no           integer not null,
  supplier_id     uuid not null references pms_suppliers(id),
  location_id     uuid not null references pms_stock_locations(id),
  status          text not null default 'draft' check (status in ('draft','pending_approval','approved','partly_received','received','closed','cancelled')),
  order_date      date not null,
  expected_date   date,
  currency        text not null default 'TZS',
  subtotal        numeric(14,2) not null default 0,
  vat             numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  notes           text,
  submitted_by    uuid,
  approved_by     uuid,
  approved_at     timestamptz,
  cancel_reason   text,
  unique (property_id, po_no)
);
create index if not exists ix_po_status on pms_purchase_orders (property_id, status);
create index if not exists ix_po_supplier on pms_purchase_orders (supplier_id);
create index if not exists ix_po_location on pms_purchase_orders (location_id);

create table if not exists pms_po_lines (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references pms_properties(id) on delete cascade,
  po_id          uuid not null references pms_purchase_orders(id) on delete cascade,
  item_id        uuid references pms_stock_items(id),
  description    text not null,
  qty            numeric(14,3) not null check (qty > 0),           -- purchase units
  unit           text,
  unit_price     numeric(14,4) not null check (unit_price >= 0),    -- per purchase unit, before VAT
  vat_pct        numeric(5,2) not null default 0 check (vat_pct between 0 and 100),
  amount         numeric(14,2) not null,                            -- qty × unit price, before VAT
  qty_received   numeric(14,3) not null default 0 check (qty_received >= 0)
);
create index if not exists ix_po_lines_po on pms_po_lines (po_id);
create index if not exists ix_po_lines_item on pms_po_lines (item_id);
create index if not exists ix_po_lines_property on pms_po_lines (property_id);

-- ---------------------------------------------------------------------
-- Goods received
-- ---------------------------------------------------------------------
create table if not exists pms_goods_receipts (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  grn_no          integer not null,
  po_id           uuid references pms_purchase_orders(id),
  supplier_id     uuid not null references pms_suppliers(id),
  location_id     uuid not null references pms_stock_locations(id),
  received_on     date not null,
  delivery_note   text,
  total           numeric(14,2) not null default 0,                 -- before VAT
  vat             numeric(14,2) not null default 0,
  notes           text,
  unique (property_id, grn_no)
);
create index if not exists ix_grn_po on pms_goods_receipts (po_id);
create index if not exists ix_grn_supplier on pms_goods_receipts (supplier_id);
create index if not exists ix_grn_location on pms_goods_receipts (location_id);

create table if not exists pms_grn_lines (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references pms_properties(id) on delete cascade,
  grn_id              uuid not null references pms_goods_receipts(id) on delete cascade,
  po_line_id          uuid references pms_po_lines(id),
  item_id             uuid not null references pms_stock_items(id),
  qty                 numeric(14,3) not null check (qty > 0),       -- purchase units
  units_per_purchase  numeric(14,4) not null default 1 check (units_per_purchase > 0),
  unit_cost           numeric(14,4) not null check (unit_cost >= 0), -- per purchase unit, before VAT
  vat_pct             numeric(5,2) not null default 0,
  amount              numeric(14,2) not null,
  qty_invoiced        numeric(14,3) not null default 0,
  batch               text,
  expiry_date         date
);
create index if not exists ix_grn_lines_grn on pms_grn_lines (grn_id);
create index if not exists ix_grn_lines_po_line on pms_grn_lines (po_line_id);
create index if not exists ix_grn_lines_item on pms_grn_lines (item_id);
create index if not exists ix_grn_lines_property on pms_grn_lines (property_id);

alter table pms_stock_moves add column if not exists grn_line_id uuid references pms_grn_lines(id);
alter table pms_stock_moves add column if not exists store_request_id uuid references pms_store_requests(id);
create index if not exists ix_stock_moves_grn_line on pms_stock_moves (grn_line_id);
create index if not exists ix_stock_moves_request on pms_stock_moves (store_request_id);

-- ---------------------------------------------------------------------
-- Supplier invoices and payments
-- ---------------------------------------------------------------------
create table if not exists pms_supplier_invoices (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  internal_no     integer not null,
  supplier_id     uuid not null references pms_suppliers(id),
  invoice_no      text not null,                                    -- the supplier's number
  invoice_date    date not null,
  due_date        date not null,
  po_id           uuid references pms_purchase_orders(id),
  subtotal        numeric(14,2) not null default 0,
  vat             numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  paid            numeric(14,2) not null default 0,
  status          text not null default 'open' check (status in ('open','paid','void')),
  match_status    text not null default 'not_linked' check (match_status in ('matched','variance','not_linked')),
  match_notes     text,
  approved_by     uuid,                                             -- needed before paying an invoice with a variance
  void_reason     text,
  unique (property_id, internal_no),
  unique (property_id, supplier_id, invoice_no)
);
create index if not exists ix_sinv_supplier on pms_supplier_invoices (supplier_id);
create index if not exists ix_sinv_po on pms_supplier_invoices (po_id);
create index if not exists ix_sinv_open on pms_supplier_invoices (property_id, due_date) where status = 'open';

create table if not exists pms_supplier_invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  invoice_id    uuid not null references pms_supplier_invoices(id) on delete cascade,
  grn_line_id   uuid references pms_grn_lines(id),
  item_id       uuid references pms_stock_items(id),
  description   text not null,
  qty           numeric(14,3) not null check (qty > 0),
  unit_price    numeric(14,4) not null check (unit_price >= 0),
  vat_pct       numeric(5,2) not null default 0,
  amount        numeric(14,2) not null,
  expense_code  text                                                -- for lines that are not stock (repairs, services)
);
create index if not exists ix_sinv_lines_invoice on pms_supplier_invoice_lines (invoice_id);
create index if not exists ix_sinv_lines_grn on pms_supplier_invoice_lines (grn_line_id);
create index if not exists ix_sinv_lines_item on pms_supplier_invoice_lines (item_id);
create index if not exists ix_sinv_lines_property on pms_supplier_invoice_lines (property_id);

create table if not exists pms_supplier_payments (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  supplier_id   uuid not null references pms_suppliers(id),
  invoice_id    uuid not null references pms_supplier_invoices(id),
  amount        numeric(14,2) not null check (amount > 0),
  method        text not null check (method in ('bank','mobile_money','cash','cheque','other')),
  reference     text,
  paid_on       date not null,
  voided        boolean not null default false,
  void_reason   text
);
create index if not exists ix_spay_supplier on pms_supplier_payments (supplier_id);
create index if not exists ix_spay_invoice on pms_supplier_payments (invoice_id);

-- ---------------------------------------------------------------------
-- Who may read; changes only through the functions below (suppliers and pars directly, by ability)
-- ---------------------------------------------------------------------
do $$
declare t text; who text := 'array[''owner'',''manager'',''accountant'',''storekeeper'']';
begin
  foreach t in array array['pms_suppliers','pms_stock_par','pms_store_requests','pms_store_request_lines','pms_purchase_orders','pms_po_lines',
    'pms_goods_receipts','pms_grn_lines','pms_supplier_invoices','pms_supplier_invoice_lines','pms_supplier_payments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format('revoke insert, update, delete on %I from authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
  -- stock people read the store side; money (invoices and payments) is for owners, managers and accountants
  foreach t in array array['pms_suppliers','pms_stock_par','pms_purchase_orders','pms_po_lines','pms_goods_receipts','pms_grn_lines'] loop
    execute format('create policy %I on %I for select using (property_id in (select pms_my_properties(%s)))', t || '_read', t, who);
  end loop;
  foreach t in array array['pms_supplier_invoices','pms_supplier_invoice_lines','pms_supplier_payments'] loop
    execute format('create policy %I on %I for select using (property_id in (select pms_my_properties(array[''owner'',''manager'',''accountant''])))', t || '_read', t);
  end loop;
  -- every member can follow store requests (departments raise them)
  foreach t in array array['pms_store_requests','pms_store_request_lines'] loop
    execute format('create policy %I on %I for select using (property_id in (select pms_my_properties(null::text[])))', t || '_read', t);
  end loop;
  execute 'create policy pms_suppliers_write on pms_suppliers for all using (pms_has_priv(property_id, ''proc.suppliers'')) with check (pms_has_priv(property_id, ''proc.suppliers''))';
  execute 'grant insert, update on pms_suppliers to authenticated';
  execute 'create policy pms_stock_par_write on pms_stock_par for all using (pms_has_priv(property_id, ''stock.manage'')) with check (pms_has_priv(property_id, ''stock.manage''))';
  execute 'grant insert, update, delete on pms_stock_par to authenticated';
end $$;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function pms__next_no(p_property uuid, p_col text) returns int
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  execute format('update pms_properties set %I = %I + 1 where id = $1 returning %I - 1', p_col, p_col, p_col) into v using p_property;
  return v;
end $$;

-- Stock in at cost: weighted average, last cost, traceable to the delivery line
create or replace function pms__stock_in(p_property uuid, p_item uuid, p_location uuid, p_qty numeric, p_unit_cost numeric,
  p_supplier text, p_reference text, p_grn_line uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_total numeric;
begin
  select greatest(coalesce(sum(qty), 0), 0) into v_total from pms_stock_levels where item_id = p_item;
  update pms_stock_items set avg_cost = case when v_total + p_qty > 0 then round((v_total * avg_cost + p_qty * p_unit_cost) / (v_total + p_qty), 4) else p_unit_cost end,
    last_cost = p_unit_cost where id = p_item;
  insert into pms_stock_moves(property_id, item_id, location_id, qty, kind, unit_cost, value, supplier, reference, grn_line_id, business_date, created_by)
  values (p_property, p_item, p_location, p_qty, 'receive', p_unit_cost, round(p_qty * p_unit_cost, 2), p_supplier, p_reference, p_grn_line, pms__bd(p_property), auth.uid());
end $$;

create or replace function pms__po(p_po uuid) returns pms_purchase_orders
language plpgsql security definer set search_path = public as $$
declare po pms_purchase_orders;
begin
  select * into po from pms_purchase_orders where id = p_po for update;
  if not found then raise exception 'Purchase order not found'; end if;
  return po;
end $$;

create or replace function pms__po_totals(p_po uuid) returns void
language sql security definer set search_path = public as $$
  update pms_purchase_orders o set
    subtotal = coalesce((select sum(amount) from pms_po_lines where po_id = o.id), 0),
    vat = coalesce((select sum(round(amount * vat_pct / 100, 2)) from pms_po_lines where po_id = o.id), 0),
    total = coalesce((select sum(amount + round(amount * vat_pct / 100, 2)) from pms_po_lines where po_id = o.id), 0)
  where o.id = p_po
$$;

-- ---------------------------------------------------------------------
-- Store requests and issues
-- ---------------------------------------------------------------------
-- p: {from_location_id, to_location_id, needed_by, notes, lines:[{item_id, qty, note}]}
create or replace function pms_store_request(p_property uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; l jsonb;
begin
  perform pms_need(p_property, 'proc.request');
  perform pms__stock_location((p->>'from_location_id')::uuid, p_property);
  perform pms__stock_location((p->>'to_location_id')::uuid, p_property);
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then raise exception 'Add at least one item'; end if;
  insert into pms_store_requests(property_id, request_no, from_location_id, to_location_id, needed_by, notes, requested_by)
  values (p_property, pms__next_no(p_property, 'next_request_no'), (p->>'from_location_id')::uuid, (p->>'to_location_id')::uuid,
          nullif(p->>'needed_by', '')::date, nullif(trim(coalesce(p->>'notes', '')), ''), auth.uid())
  returning id into v_id;
  for l in select * from jsonb_array_elements(p->'lines') loop
    if not exists (select 1 from pms_stock_items where id = (l->>'item_id')::uuid and property_id = p_property and active) then raise exception 'Item not found'; end if;
    insert into pms_store_request_lines(property_id, request_id, item_id, qty, note)
    values (p_property, v_id, (l->>'item_id')::uuid, (l->>'qty')::numeric, nullif(trim(coalesce(l->>'note', '')), ''));
  end loop;
  perform pms_log(p_property, 'store.request', 'store_request', v_id, p);
  return v_id;
end $$;

-- Issue what the store can: p_lines [{line_id, qty}] or null = everything outstanding
create or replace function pms_store_issue(p_request uuid, p_lines jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r pms_store_requests; l record; v_qty numeric; v_have numeric; i pms_stock_items; v_bd date; n int := 0; v_value numeric := 0;
begin
  select * into r from pms_store_requests where id = p_request for update;
  if not found then raise exception 'Request not found'; end if;
  perform pms_need(r.property_id, 'proc.issue');
  if r.status not in ('submitted','partly_issued') then raise exception 'This request is %', replace(r.status, '_', ' '); end if;
  v_bd := pms__bd(r.property_id);
  for l in select * from pms_store_request_lines where request_id = p_request and qty_issued < qty loop
    v_qty := case when p_lines is null then l.qty - l.qty_issued
                  else coalesce((select (x->>'qty')::numeric from jsonb_array_elements(p_lines) x where (x->>'line_id')::uuid = l.id), 0) end;
    continue when v_qty <= 0;
    if v_qty > l.qty - l.qty_issued then raise exception 'More than was asked for'; end if;
    select * into i from pms_stock_items where id = l.item_id for update;
    v_have := pms__on_hand(l.item_id, r.from_location_id);
    if v_have < v_qty then raise exception 'Only % % of % in the store', v_have, i.unit, i.name; end if;
    insert into pms_stock_moves(property_id, item_id, location_id, qty, kind, unit_cost, value, reference, note, store_request_id, business_date, created_by) values
      (r.property_id, l.item_id, r.from_location_id, -v_qty, 'transfer_out', i.avg_cost, -round(v_qty * i.avg_cost, 2), 'SR-' || lpad(r.request_no::text, 5, '0'), 'Issued', p_request, v_bd, auth.uid()),
      (r.property_id, l.item_id, r.to_location_id, v_qty, 'transfer_in', i.avg_cost, round(v_qty * i.avg_cost, 2), 'SR-' || lpad(r.request_no::text, 5, '0'), 'Issued', p_request, v_bd, auth.uid());
    update pms_store_request_lines set qty_issued = qty_issued + v_qty where id = l.id;
    n := n + 1; v_value := v_value + round(v_qty * i.avg_cost, 2);
  end loop;
  if n = 0 then raise exception 'Nothing to issue'; end if;
  update pms_store_requests set decided_by = auth.uid(),
    status = case when exists (select 1 from pms_store_request_lines where request_id = p_request and qty_issued < qty) then 'partly_issued' else 'issued' end
  where id = p_request;
  perform pms_log(r.property_id, 'store.issue', 'store_request', p_request, jsonb_build_object('lines', n, 'value', v_value));
  return jsonb_build_object('lines', n, 'value', v_value);
end $$;

create or replace function pms_store_reject(p_request uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r pms_store_requests;
begin
  select * into r from pms_store_requests where id = p_request for update;
  if not found then raise exception 'Request not found'; end if;
  if r.requested_by = auth.uid() and r.status = 'submitted' then
    update pms_store_requests set status = 'cancelled' where id = p_request; return;   -- the requester withdraws it
  end if;
  perform pms_need(r.property_id, 'proc.issue');
  if r.status not in ('submitted','partly_issued') then raise exception 'This request is %', replace(r.status, '_', ' '); end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  update pms_store_requests set status = case when r.status = 'partly_issued' then 'issued' else 'rejected' end,
    reject_reason = trim(p_reason), decided_by = auth.uid() where id = p_request;
end $$;

-- ---------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------
-- p: {id?, supplier_id, location_id, expected_date, notes, lines:[{item_id?, description?, qty, unit_price, vat_pct}]}
create or replace function pms_po_save(p_property uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; po pms_purchase_orders; l jsonb; i pms_stock_items; s pms_suppliers;
begin
  perform pms_need(p_property, 'proc.order');
  select * into s from pms_suppliers where id = (p->>'supplier_id')::uuid and property_id = p_property and active;
  if not found then raise exception 'Choose a supplier'; end if;
  perform pms__stock_location((p->>'location_id')::uuid, p_property);
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then raise exception 'Add at least one line'; end if;
  if v_id is null then
    insert into pms_purchase_orders(property_id, po_no, supplier_id, location_id, order_date, expected_date, currency, notes)
    values (p_property, pms__next_no(p_property, 'next_po_no'), s.id, (p->>'location_id')::uuid, pms__bd(p_property),
            nullif(p->>'expected_date', '')::date, s.currency, nullif(trim(coalesce(p->>'notes', '')), ''))
    returning id into v_id;
  else
    po := pms__po(v_id);
    if po.property_id <> p_property then raise exception 'Purchase order not found'; end if;
    if po.status not in ('draft','pending_approval') then raise exception 'Only draft orders can be changed'; end if;
    update pms_purchase_orders set supplier_id = s.id, location_id = (p->>'location_id')::uuid, expected_date = nullif(p->>'expected_date', '')::date,
      currency = s.currency, notes = nullif(trim(coalesce(p->>'notes', '')), ''), status = 'draft', approved_by = null, approved_at = null where id = v_id;
    delete from pms_po_lines where po_id = v_id;
  end if;
  for l in select * from jsonb_array_elements(p->'lines') loop
    i := null;
    if nullif(l->>'item_id', '') is not null then
      select * into i from pms_stock_items where id = (l->>'item_id')::uuid and property_id = p_property;
      if not found then raise exception 'Item not found'; end if;
    elsif coalesce(trim(l->>'description'), '') = '' then raise exception 'Each line needs an item or a description';
    end if;
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'Quantities must be greater than zero'; end if;
    if coalesce((l->>'unit_price')::numeric, -1) < 0 then raise exception 'Enter a price for each line'; end if;
    insert into pms_po_lines(property_id, po_id, item_id, description, qty, unit, unit_price, vat_pct, amount)
    values (p_property, v_id, i.id, coalesce(nullif(trim(l->>'description'), ''), i.name), (l->>'qty')::numeric,
            coalesce(nullif(l->>'unit', ''), i.purchase_unit, i.unit), (l->>'unit_price')::numeric, coalesce((l->>'vat_pct')::numeric, 0),
            round((l->>'qty')::numeric * (l->>'unit_price')::numeric, 2));
  end loop;
  perform pms__po_totals(v_id);
  return v_id;
end $$;

-- Submit: within the approval limit (or for an approver) it is approved straight away, otherwise it waits
create or replace function pms_po_submit(p_po uuid) returns text
language plpgsql security definer set search_path = public as $$
declare po pms_purchase_orders; v_limit numeric;
begin
  po := pms__po(p_po);
  perform pms_need(po.property_id, 'proc.order');
  if po.status <> 'draft' then raise exception 'Only draft orders can be submitted'; end if;
  select coalesce((settings->'procurement'->>'approval_limit')::numeric, 0) into v_limit from pms_properties where id = po.property_id;
  if po.total <= v_limit then
    update pms_purchase_orders set status = 'approved', submitted_by = auth.uid(), approved_by = auth.uid(), approved_at = now() where id = p_po;
    perform pms_log(po.property_id, 'po.approved', 'purchase_order', p_po, jsonb_build_object('po_no', po.po_no, 'total', po.total, 'within_limit', v_limit));
    return 'approved';
  end if;
  update pms_purchase_orders set status = 'pending_approval', submitted_by = auth.uid() where id = p_po;
  perform pms_log(po.property_id, 'po.submitted', 'purchase_order', p_po, jsonb_build_object('po_no', po.po_no, 'total', po.total));
  return 'pending_approval';
end $$;

create or replace function pms_po_approve(p_po uuid, p_approve boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare po pms_purchase_orders;
begin
  po := pms__po(p_po);
  perform pms_need(po.property_id, 'proc.approve');
  if po.status <> 'pending_approval' then raise exception 'This order is not waiting for approval'; end if;
  if po.submitted_by = auth.uid() and pms_role(po.property_id) <> 'owner' then raise exception 'Someone other than the person who raised it must approve it'; end if;
  if p_approve then
    update pms_purchase_orders set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_po;
  else
    if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
    update pms_purchase_orders set status = 'draft', notes = trim(coalesce(notes || E'\n', '') || 'Sent back: ' || trim(p_reason)) where id = p_po;
  end if;
  perform pms_log(po.property_id, case when p_approve then 'po.approved' else 'po.returned' end, 'purchase_order', p_po,
    jsonb_build_object('po_no', po.po_no, 'total', po.total, 'reason', p_reason));
end $$;

create or replace function pms_po_cancel(p_po uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare po pms_purchase_orders;
begin
  po := pms__po(p_po);
  perform pms_need(po.property_id, 'proc.order');
  if po.status in ('received','closed','cancelled') then raise exception 'This order is %', po.status; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  update pms_purchase_orders set status = case when po.status = 'partly_received' then 'closed' else 'cancelled' end, cancel_reason = trim(p_reason) where id = p_po;
  perform pms_log(po.property_id, 'po.cancelled', 'purchase_order', p_po, jsonb_build_object('po_no', po.po_no, 'reason', p_reason));
end $$;

-- What to reorder: below the store's reorder level (or the item's), up to par, in purchase units
create or replace function pms_reorder_suggestions(p_property uuid, p_location uuid default null)
returns table(location_id uuid, location text, item_id uuid, item text, unit text, on_hand numeric, reorder_level numeric, par_level numeric,
              suggest_stock_units numeric, purchase_unit text, units_per_purchase numeric, suggest_purchase_units numeric,
              supplier_id uuid, supplier text, last_cost numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'proc.order');
  return query
    with targets as (
      select pp.location_id, pp.item_id, pp.reorder_level, pp.par_level from pms_stock_par pp where pp.property_id = p_property
      union all
      select l.id, i.id, i.reorder_level, i.reorder_level * 2 from pms_stock_items i cross join pms_stock_locations l
      where i.property_id = p_property and l.property_id = p_property and l.kind = 'store' and i.reorder_level > 0
        and not exists (select 1 from pms_stock_par pp where pp.item_id = i.id and pp.location_id = l.id))
    select t.location_id, l.name, i.id, i.name, i.unit, pms__on_hand(i.id, t.location_id), t.reorder_level, t.par_level,
      greatest(t.par_level - pms__on_hand(i.id, t.location_id), 0),
      coalesce(i.purchase_unit, i.unit), i.units_per_purchase,
      ceil(greatest(t.par_level - pms__on_hand(i.id, t.location_id), 0) / i.units_per_purchase),
      s.id, s.name, coalesce(i.last_cost, i.avg_cost) * i.units_per_purchase
    from targets t join pms_stock_items i on i.id = t.item_id and i.active join pms_stock_locations l on l.id = t.location_id and l.active
    left join pms_suppliers s on s.id = i.default_supplier_id
    where (p_location is null or t.location_id = p_location) and pms__on_hand(i.id, t.location_id) <= t.reorder_level
    order by s.name nulls last, l.name, i.name;
end $$;

-- ---------------------------------------------------------------------
-- Goods received
-- ---------------------------------------------------------------------
-- p: {po_id?, supplier_id (when no PO), location_id (when no PO), delivery_note, notes,
--     lines:[{po_line_id?, item_id (when no PO line), qty, unit_cost?, vat_pct?, batch?, expiry_date?}]}
create or replace function pms_grn_post(p_property uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare po pms_purchase_orders; v_sup uuid; v_loc uuid; v_id uuid; l jsonb; pl pms_po_lines; i pms_stock_items; v_qty numeric; v_cost numeric;
  v_upp numeric; v_vat numeric; v_line uuid; v_no int; v_sname text;
begin
  perform pms_need(p_property, 'proc.receive');
  if nullif(p->>'po_id', '') is not null then
    po := pms__po((p->>'po_id')::uuid);
    if po.property_id <> p_property then raise exception 'Purchase order not found'; end if;
    if po.status not in ('approved','partly_received') then raise exception 'Only approved orders can be received (this one is %)', replace(po.status, '_', ' '); end if;
    v_sup := po.supplier_id; v_loc := po.location_id;
  else
    v_sup := (p->>'supplier_id')::uuid; v_loc := (p->>'location_id')::uuid;
    if not exists (select 1 from pms_suppliers where id = v_sup and property_id = p_property) then raise exception 'Choose a supplier'; end if;
    perform pms__stock_location(v_loc, p_property);
  end if;
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then raise exception 'Add what was delivered'; end if;
  select name into v_sname from pms_suppliers where id = v_sup;
  v_no := pms__next_no(p_property, 'next_grn_no');
  insert into pms_goods_receipts(property_id, grn_no, po_id, supplier_id, location_id, received_on, delivery_note, notes)
  values (p_property, v_no, po.id, v_sup, v_loc, pms__bd(p_property), nullif(trim(coalesce(p->>'delivery_note', '')), ''), nullif(trim(coalesce(p->>'notes', '')), ''))
  returning id into v_id;
  for l in select * from jsonb_array_elements(p->'lines') loop
    v_qty := coalesce((l->>'qty')::numeric, 0);
    continue when v_qty = 0;
    if v_qty < 0 then raise exception 'Quantities must be greater than zero'; end if;
    pl := null;
    if nullif(l->>'po_line_id', '') is not null then
      select * into pl from pms_po_lines where id = (l->>'po_line_id')::uuid and po_id = po.id for update;
      if not found then raise exception 'That line is not on this order'; end if;
      if pl.item_id is null then raise exception '% is not a stock item; enter it on the supplier invoice instead', pl.description; end if;
      if pl.qty_received + v_qty > pl.qty then raise exception 'More % than was ordered (% left)', pl.description, pl.qty - pl.qty_received; end if;
      select * into i from pms_stock_items where id = pl.item_id for update;
      v_cost := coalesce((l->>'unit_cost')::numeric, pl.unit_price); v_vat := coalesce((l->>'vat_pct')::numeric, pl.vat_pct);
      update pms_po_lines set qty_received = qty_received + v_qty where id = pl.id;
    else
      if po.id is not null then raise exception 'Every line of a delivery against an order must be one of its lines'; end if;
      select * into i from pms_stock_items where id = (l->>'item_id')::uuid and property_id = p_property for update;
      if not found then raise exception 'Item not found'; end if;
      v_cost := (l->>'unit_cost')::numeric; v_vat := coalesce((l->>'vat_pct')::numeric, 0);
      if v_cost is null or v_cost < 0 then raise exception 'Enter the cost of %', i.name; end if;
    end if;
    v_upp := i.units_per_purchase;
    insert into pms_grn_lines(property_id, grn_id, po_line_id, item_id, qty, units_per_purchase, unit_cost, vat_pct, amount, batch, expiry_date)
    values (p_property, v_id, pl.id, i.id, v_qty, v_upp, v_cost, v_vat, round(v_qty * v_cost, 2), nullif(l->>'batch', ''), nullif(l->>'expiry_date', '')::date)
    returning id into v_line;
    perform pms__stock_in(p_property, i.id, v_loc, v_qty * v_upp, round(v_cost / v_upp, 4), v_sname, 'GRN-' || lpad(v_no::text, 5, '0'), v_line);
  end loop;
  if not exists (select 1 from pms_grn_lines where grn_id = v_id) then raise exception 'Nothing was received'; end if;
  update pms_goods_receipts set total = (select sum(amount) from pms_grn_lines where grn_id = v_id),
    vat = (select sum(round(amount * vat_pct / 100, 2)) from pms_grn_lines where grn_id = v_id) where id = v_id;
  if po.id is not null then
    update pms_purchase_orders set status = case when exists (select 1 from pms_po_lines where po_id = po.id and qty_received < qty) then 'partly_received' else 'received' end
    where id = po.id;
  end if;
  perform pms_log(p_property, 'grn.posted', 'goods_receipt', v_id, jsonb_build_object('grn_no', v_no, 'po_no', po.po_no, 'supplier', v_sname));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Supplier invoices: three-way match against order and delivery
-- ---------------------------------------------------------------------
-- p: {supplier_id, invoice_no, invoice_date, due_date?, po_id?, lines:[{grn_line_id?, item_id?, description?, qty, unit_price, vat_pct, expense_code?}]}
create or replace function pms_supplier_invoice_save(p_property uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare s pms_suppliers; v_id uuid; l jsonb; g pms_grn_lines; v_po_price numeric; v_notes text[] := '{}'; v_linked int := 0; v_date date;
  i pms_stock_items;
begin
  perform pms_need(p_property, 'proc.invoice');
  select * into s from pms_suppliers where id = (p->>'supplier_id')::uuid and property_id = p_property;
  if not found then raise exception 'Choose a supplier'; end if;
  if coalesce(trim(p->>'invoice_no'), '') = '' then raise exception 'Enter the supplier''s invoice number'; end if;
  if exists (select 1 from pms_supplier_invoices where property_id = p_property and supplier_id = s.id and invoice_no = trim(p->>'invoice_no') and status <> 'void') then
    raise exception 'Invoice % from % is already entered', trim(p->>'invoice_no'), s.name;
  end if;
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then raise exception 'Add the invoice lines'; end if;
  v_date := coalesce(nullif(p->>'invoice_date', '')::date, pms__bd(p_property));
  insert into pms_supplier_invoices(property_id, internal_no, supplier_id, invoice_no, invoice_date, due_date, po_id)
  values (p_property, pms__next_no(p_property, 'next_sinv_no'), s.id, trim(p->>'invoice_no'), v_date,
          coalesce(nullif(p->>'due_date', '')::date, v_date + s.payment_terms_days), nullif(p->>'po_id', '')::uuid)
  returning id into v_id;
  for l in select * from jsonb_array_elements(p->'lines') loop
    if coalesce((l->>'qty')::numeric, 0) <= 0 or coalesce((l->>'unit_price')::numeric, -1) < 0 then raise exception 'Each line needs a quantity and a price'; end if;
    g := null; i := null;
    if nullif(l->>'grn_line_id', '') is not null then
      select gl.* into g from pms_grn_lines gl join pms_goods_receipts gr on gr.id = gl.grn_id
      where gl.id = (l->>'grn_line_id')::uuid and gr.supplier_id = s.id for update of gl;
      if not found then raise exception 'That delivery line is not from %', s.name; end if;
      select * into i from pms_stock_items where id = g.item_id;
      v_linked := v_linked + 1;
      if g.qty_invoiced + (l->>'qty')::numeric > g.qty then
        v_notes := v_notes || format('%s: invoiced %s, received %s', i.name, trim_scale(g.qty_invoiced + (l->>'qty')::numeric), trim_scale(g.qty));
      end if;
      select pl.unit_price into v_po_price from pms_po_lines pl where pl.id = g.po_line_id;
      if abs((l->>'unit_price')::numeric - coalesce(v_po_price, g.unit_cost)) > 0.005 then
        v_notes := v_notes || format('%s: price %s, %s %s', i.name, trim_scale(round((l->>'unit_price')::numeric, 2)), case when v_po_price is null then 'delivered at' else 'ordered at' end, trim_scale(round(coalesce(v_po_price, g.unit_cost), 2)));
      end if;
      update pms_grn_lines set qty_invoiced = qty_invoiced + (l->>'qty')::numeric where id = g.id;
    elsif nullif(l->>'item_id', '') is not null then
      select * into i from pms_stock_items where id = (l->>'item_id')::uuid and property_id = p_property;
    end if;
    insert into pms_supplier_invoice_lines(property_id, invoice_id, grn_line_id, item_id, description, qty, unit_price, vat_pct, amount, expense_code)
    values (p_property, v_id, g.id, coalesce(g.item_id, i.id), coalesce(nullif(trim(l->>'description'), ''), i.name, 'Item'),
            (l->>'qty')::numeric, (l->>'unit_price')::numeric, coalesce((l->>'vat_pct')::numeric, 0),
            round((l->>'qty')::numeric * (l->>'unit_price')::numeric, 2), nullif(trim(coalesce(l->>'expense_code', '')), ''));
  end loop;
  update pms_supplier_invoices set
    subtotal = (select sum(amount) from pms_supplier_invoice_lines where invoice_id = v_id),
    vat = (select sum(round(amount * vat_pct / 100, 2)) from pms_supplier_invoice_lines where invoice_id = v_id),
    total = (select sum(amount + round(amount * vat_pct / 100, 2)) from pms_supplier_invoice_lines where invoice_id = v_id),
    match_status = case when v_linked = 0 then 'not_linked' when cardinality(v_notes) > 0 then 'variance' else 'matched' end,
    match_notes = nullif(array_to_string(v_notes, '; '), '')
  where id = v_id;
  perform pms_log(p_property, 'supplier_invoice.entered', 'supplier_invoice', v_id, jsonb_build_object('supplier', s.name, 'invoice_no', p->>'invoice_no'));
  return v_id;
end $$;

-- A manager accepts an invoice whose quantities or prices differ from what was ordered and received
create or replace function pms_supplier_invoice_approve(p_invoice uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v pms_supplier_invoices;
begin
  select * into v from pms_supplier_invoices where id = p_invoice for update;
  if not found then raise exception 'Invoice not found'; end if;
  perform pms_need(v.property_id, 'proc.approve');
  if v.match_status <> 'variance' then raise exception 'Only invoices with a difference need approval'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Say why it is accepted'; end if;
  update pms_supplier_invoices set approved_by = auth.uid(), match_notes = match_notes || ' · Accepted: ' || trim(p_note) where id = p_invoice;
  perform pms_log(v.property_id, 'supplier_invoice.accepted', 'supplier_invoice', p_invoice, jsonb_build_object('note', p_note));
end $$;

create or replace function pms_supplier_pay(p_invoice uuid, p_amount numeric, p_method text, p_reference text, p_paid_on date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v pms_supplier_invoices; v_id uuid;
begin
  select * into v from pms_supplier_invoices where id = p_invoice for update;
  if not found then raise exception 'Invoice not found'; end if;
  perform pms_need(v.property_id, 'proc.pay');
  if v.status <> 'open' then raise exception 'This invoice is %', v.status; end if;
  if v.match_status = 'variance' and v.approved_by is null then raise exception 'This invoice differs from the order or delivery; a manager must accept it first'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount'; end if;
  if p_amount > v.total - v.paid then raise exception 'Only % is owed on this invoice', v.total - v.paid; end if;
  if p_method not in ('bank','mobile_money','cash','cheque','other') then raise exception 'Unknown payment method'; end if;
  if p_method <> 'cash' and coalesce(trim(p_reference), '') = '' then raise exception 'Enter the payment reference'; end if;
  insert into pms_supplier_payments(property_id, supplier_id, invoice_id, amount, method, reference, paid_on)
  values (v.property_id, v.supplier_id, p_invoice, p_amount, p_method, nullif(trim(coalesce(p_reference, '')), ''), coalesce(p_paid_on, pms__bd(v.property_id)))
  returning id into v_id;
  update pms_supplier_invoices set paid = paid + p_amount, status = case when paid + p_amount >= total then 'paid' else 'open' end where id = p_invoice;
  perform pms_log(v.property_id, 'supplier.paid', 'supplier_invoice', p_invoice, jsonb_build_object('amount', p_amount, 'method', p_method, 'reference', p_reference));
  return v_id;
end $$;

create or replace function pms_supplier_invoice_void(p_invoice uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v pms_supplier_invoices;
begin
  select * into v from pms_supplier_invoices where id = p_invoice for update;
  if not found then raise exception 'Invoice not found'; end if;
  perform pms_need(v.property_id, 'proc.invoice');
  if v.paid > 0 then raise exception 'Payments have been made against this invoice'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  update pms_grn_lines g set qty_invoiced = g.qty_invoiced - l.qty from pms_supplier_invoice_lines l where l.invoice_id = p_invoice and l.grn_line_id = g.id;
  update pms_supplier_invoices set status = 'void', void_reason = trim(p_reason) where id = p_invoice;
  perform pms_log(v.property_id, 'supplier_invoice.void', 'supplier_invoice', p_invoice, jsonb_build_object('reason', p_reason));
end $$;

-- ---------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------
create or replace function pms_rpt_creditors(p_property uuid, p_as_of date default null)
returns table(supplier_id uuid, supplier text, invoices int, balance numeric, not_due numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_day date;
begin
  perform pms_need(p_property, 'rpt.creditors');
  v_day := coalesce(p_as_of, pms__bd(p_property));
  return query
    select s.id, s.name, count(i.id)::int, coalesce(sum(i.total - i.paid), 0),
      coalesce(sum(i.total - i.paid) filter (where i.due_date >= v_day), 0),
      coalesce(sum(i.total - i.paid) filter (where v_day - i.due_date between 1 and 30), 0),
      coalesce(sum(i.total - i.paid) filter (where v_day - i.due_date between 31 and 60), 0),
      coalesce(sum(i.total - i.paid) filter (where v_day - i.due_date between 61 and 90), 0),
      coalesce(sum(i.total - i.paid) filter (where v_day - i.due_date > 90), 0)
    from pms_suppliers s join pms_supplier_invoices i on i.supplier_id = s.id and i.status = 'open'
    where s.property_id = p_property
    group by s.id, s.name order by 4 desc;
end $$;

create or replace function pms_rpt_purchases(p_property uuid, p_from date, p_to date)
returns table(supplier text, item text, unit text, qty numeric, value numeric, deliveries int, avg_unit_cost numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'rpt.purchases');
  return query
    select s.name, i.name, i.unit, sum(gl.qty * gl.units_per_purchase), sum(gl.amount), count(distinct g.id)::int,
      round(sum(gl.amount) / nullif(sum(gl.qty * gl.units_per_purchase), 0), 2)
    from pms_goods_receipts g join pms_grn_lines gl on gl.grn_id = g.id join pms_suppliers s on s.id = g.supplier_id join pms_stock_items i on i.id = gl.item_id
    where g.property_id = p_property and g.received_on between p_from and p_to
    group by s.name, i.name, i.unit order by 5 desc;
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
revoke execute on function pms__next_no(uuid, text), pms__stock_in(uuid, uuid, uuid, numeric, numeric, text, text, uuid), pms__po(uuid), pms__po_totals(uuid) from authenticated;
grant execute on function pms_store_request(uuid, jsonb), pms_store_issue(uuid, jsonb), pms_store_reject(uuid, text),
  pms_po_save(uuid, jsonb), pms_po_submit(uuid), pms_po_approve(uuid, boolean, text), pms_po_cancel(uuid, text), pms_reorder_suggestions(uuid, uuid),
  pms_grn_post(uuid, jsonb), pms_supplier_invoice_save(uuid, jsonb), pms_supplier_invoice_approve(uuid, text), pms_supplier_pay(uuid, numeric, text, text, date),
  pms_supplier_invoice_void(uuid, text), pms_rpt_creditors(uuid, date), pms_rpt_purchases(uuid, date, date) to authenticated;
select pms__apply_platform_rules();
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';
