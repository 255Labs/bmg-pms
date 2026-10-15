-- module: accounting
-- also: core, procurement
-- 24 · QuickBooks Online: each property connects its own QuickBooks company
--
--  What goes to QuickBooks (each property chooses its QuickBooks accounts once, under Accounting → Map accounts):
--    Suppliers            → Vendors (created or matched by name)
--    Supplier invoices    → Bills (stock lines to the inventory account, other lines to their expense account, VAT apart)
--    Supplier payments    → Bill payments against those bills
--    Each closed day      → One journal entry: room, food and drink, other revenue and VAT; discounts; takings by payment
--                           method (front desk and outlets); city ledger; cash expenses; cost of sales, waste and count
--                           differences from stock; the balance to the guest ledger. Sent when the night audit runs.
--  Tokens are kept in a table nobody can read through the API; only the worker (service role) uses them.
--  Every send is a queued job with retries; nothing is sent twice (each record is linked to its QuickBooks id).
-- Safe to re-run.

create table if not exists pms_qbo_connections (
  property_id         uuid primary key references pms_properties(id) on delete cascade,
  realm_id            text not null,
  company_name        text,
  environment         text not null default 'production' check (environment in ('sandbox','production')),
  status              text not null default 'connected' check (status in ('connected','needs_reconnect','disconnected')),
  access_token        text,
  access_expires_at   timestamptz,
  refresh_token       text,
  refresh_expires_at  timestamptz,
  connected_by        uuid,
  connected_at        timestamptz not null default now(),
  last_error          text
);

create table if not exists pms_qbo_states (
  state        text primary key,
  property_id  uuid not null references pms_properties(id) on delete cascade,
  user_id      uuid not null,
  return_url   text,
  created_at   timestamptz not null default now()
);
create index if not exists ix_qbo_states_property on pms_qbo_states (property_id);

create table if not exists pms_qbo_mappings (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  key          text not null,
  qbo_id       text not null,
  qbo_name     text,
  unique (property_id, key)
);

create table if not exists pms_qbo_links (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  entity       text not null check (entity in ('vendor','bill','bill_payment','journal')),
  local_id     text not null,
  qbo_id       text not null,
  sync_token   text,
  synced_at    timestamptz not null default now(),
  unique (property_id, entity, local_id)
);

do $$
declare t text;
begin
  -- tokens: no policy at all, nothing granted; only security-definer functions and the service role touch them
  foreach t in array array['pms_qbo_connections','pms_qbo_states'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
  foreach t in array array['pms_qbo_mappings','pms_qbo_links'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (pms_has_priv(property_id, ''acct.quickbooks''))', t || '_read', t);
  end loop;
end $$;

-- The accounts a property needs to map. Revenue keys follow the charge categories in use.
create or replace function pms__qbo_keys(p_property uuid) returns table(key text, label text, kind text, used_for text)
language sql stable security definer set search_path = public as $$
  with cats as (
    select distinct category from pms_folio_lines where property_id = p_property and line_type = 'charge'
    union select distinct charge_category from pms_pos_outlets where property_id = p_property
    union select unnest(array['room','tax','fnb','other']))
  select 'revenue:' || category, case category when 'room' then 'Room revenue' when 'tax' then 'VAT and levies collected (liability)'
      when 'fnb' then 'Food and drink revenue' when 'paid_out' then 'Cash paid out for guests (cash account)'
      else initcap(replace(category, '_', ' ')) || ' revenue' end, 'income', 'daily journal'
  from cats
  union all select * from (values
    ('discounts', 'Discounts allowed', 'expense', 'daily journal'),
    ('payment:cash', 'Cash on hand', 'asset', 'daily journal, supplier payments'),
    ('payment:mobile_money', 'Mobile money account', 'asset', 'daily journal, supplier payments'),
    ('payment:card', 'Card clearing account', 'asset', 'daily journal'),
    ('payment:bank', 'Bank account', 'asset', 'daily journal, supplier payments'),
    ('payment:cheque', 'Cheque account', 'asset', 'supplier payments'),
    ('payment:other', 'Other payments', 'asset', 'daily journal'),
    ('payment:city_ledger', 'Accounts receivable (city ledger)', 'asset', 'daily journal'),
    ('guest_ledger', 'Guest ledger (in-house balances and deposits)', 'asset', 'daily journal'),
    ('expenses', 'Petty cash expenses', 'expense', 'daily journal'),
    ('inventory', 'Inventory (stock)', 'asset', 'bills, daily journal'),
    ('cogs', 'Cost of sales', 'expense', 'daily journal'),
    ('stock_waste', 'Stock waste', 'expense', 'daily journal'),
    ('stock_variance', 'Stock count differences', 'expense', 'daily journal'),
    ('purchases', 'Purchases that are not stock', 'expense', 'bills'),
    ('vat_input', 'VAT on purchases (input VAT)', 'asset', 'bills')) v(key, label, kind, used_for)
  union all
  select distinct 'expense:' || expense_code, expense_code || ' (supplier invoice lines)', 'expense', 'bills'
  from pms_supplier_invoice_lines where property_id = p_property and expense_code is not null
$$;

create or replace function pms__qbo_account(p_property uuid, p_key text) returns text
language sql stable security definer set search_path = public as $$
  select qbo_id from pms_qbo_mappings where property_id = p_property and key = p_key
$$;

create or replace function pms__qbo_on(p_property uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pms_qbo_connections where property_id = p_property and status = 'connected')
    and coalesce((select (settings->'quickbooks'->>'auto')::boolean from pms_properties where id = p_property), true)
$$;

-- ---------------------------------------------------------------------
-- What the property's people see and do
-- ---------------------------------------------------------------------
create or replace function pms_qbo_status(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c pms_qbo_connections;
begin
  perform pms_need(p_property, 'acct.quickbooks');
  select * into c from pms_qbo_connections where property_id = p_property;
  return jsonb_build_object(
    'connected', c.status = 'connected', 'status', coalesce(c.status, 'not_connected'), 'company', c.company_name, 'environment', c.environment,
    'connected_at', c.connected_at, 'last_error', c.last_error,
    'auto', coalesce((select (settings->'quickbooks'->>'auto')::boolean from pms_properties where id = p_property), true),
    'start_date', (select settings->'quickbooks'->>'start_date' from pms_properties where id = p_property),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('key', k.key, 'label', k.label, 'kind', k.kind, 'used_for', k.used_for,
        'qbo_id', m.qbo_id, 'qbo_name', m.qbo_name) order by k.kind, k.label), '[]')
        from pms__qbo_keys(p_property) k left join pms_qbo_mappings m on m.property_id = p_property and m.key = k.key),
    'jobs', (select jsonb_build_object('queued', count(*) filter (where status in ('queued','running')), 'failed', count(*) filter (where status = 'failed'),
        'done_today', count(*) filter (where status = 'done' and updated_at > now() - interval '1 day'))
        from pms_jobs where property_id = p_property and provider = 'quickbooks'),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'status', status, 'error', last_error, 'payload', payload, 'at', updated_at) order by id desc), '[]')
        from (select * from pms_jobs where property_id = p_property and provider = 'quickbooks' order by id desc limit 30) j));
end $$;

-- Starts connecting: a one-time state the QuickBooks sign-in page sends back
create or replace function pms_qbo_begin(p_property uuid, p_return_url text default null) returns text
language plpgsql security definer set search_path = public as $$
declare v text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  perform pms_need(p_property, 'acct.quickbooks');
  delete from pms_qbo_states where created_at < now() - interval '15 minutes';
  insert into pms_qbo_states(state, property_id, user_id, return_url) values (v, p_property, auth.uid(), p_return_url);
  return v;
end $$;

create or replace function pms_qbo_disconnect(p_property uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'acct.quickbooks');
  update pms_qbo_connections set status = 'disconnected', access_token = null, refresh_token = null where property_id = p_property;
  update pms_jobs set status = 'failed', last_error = 'QuickBooks disconnected' where property_id = p_property and provider = 'quickbooks' and status = 'queued';
  perform pms_log(p_property, 'quickbooks.disconnect', 'property', p_property, '{}'::jsonb);
end $$;

create or replace function pms_qbo_set_mapping(p_property uuid, p_key text, p_qbo_id text, p_qbo_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'acct.quickbooks');
  if not exists (select 1 from pms__qbo_keys(p_property) k where k.key = p_key) then raise exception 'Unknown account key %', p_key; end if;
  if coalesce(trim(p_qbo_id), '') = '' then
    delete from pms_qbo_mappings where property_id = p_property and key = p_key;
  else
    insert into pms_qbo_mappings(property_id, key, qbo_id, qbo_name) values (p_property, p_key, trim(p_qbo_id), p_qbo_name)
    on conflict (property_id, key) do update set qbo_id = excluded.qbo_id, qbo_name = excluded.qbo_name;
  end if;
end $$;

create or replace function pms_qbo_settings(p_property uuid, p_auto boolean, p_start_date date) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'acct.quickbooks');
  update pms_properties set settings = jsonb_set(coalesce(settings, '{}'), '{quickbooks}',
    jsonb_strip_nulls(jsonb_build_object('auto', p_auto, 'start_date', p_start_date))) where id = p_property;
end $$;

-- Send (or send again) a day's journal; and retry failed sends
create or replace function pms_qbo_send_day(p_property uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'acct.quickbooks');
  if not exists (select 1 from pms_qbo_connections where property_id = p_property and status = 'connected') then raise exception 'Connect QuickBooks first'; end if;
  if p_date >= pms__bd(p_property) then raise exception 'Only days closed by the night audit can be sent'; end if;
  perform pms__enqueue(p_property, 'quickbooks', 'journal', jsonb_build_object('date', p_date), 'qbo:journal:' || p_property || ':' || p_date);
end $$;

create or replace function pms_qbo_retry(p_property uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform pms_need(p_property, 'acct.quickbooks');
  update pms_jobs set status = 'queued', attempts = 0, run_after = now(), last_error = null
  where property_id = p_property and provider = 'quickbooks' and status = 'failed';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- What is sent, queued automatically
-- ---------------------------------------------------------------------
create or replace function pms__qbo_queue() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_start date;
begin
  if not pms__qbo_on(new.property_id) then return null; end if;
  select (settings->'quickbooks'->>'start_date')::date into v_start from pms_properties where id = new.property_id;
  if tg_table_name = 'pms_suppliers' then
    perform pms__enqueue(new.property_id, 'quickbooks', 'vendor', jsonb_build_object('supplier_id', new.id), 'qbo:vendor:' || new.id);
  elsif tg_table_name = 'pms_supplier_invoices' then
    if v_start is not null and new.invoice_date < v_start then return null; end if;
    if new.status = 'void' then
      if exists (select 1 from pms_qbo_links where property_id = new.property_id and entity = 'bill' and local_id = new.id::text) then
        perform pms__enqueue(new.property_id, 'quickbooks', 'bill_void', jsonb_build_object('invoice_id', new.id), 'qbo:bill:' || new.id);
      end if;
    elsif new.total > 0 and (tg_op = 'INSERT' or old.total is distinct from new.total) then
      perform pms__enqueue(new.property_id, 'quickbooks', 'bill', jsonb_build_object('invoice_id', new.id), 'qbo:bill:' || new.id);
    end if;
  elsif tg_table_name = 'pms_supplier_payments' then
    if v_start is not null and new.paid_on < v_start then return null; end if;
    perform pms__enqueue(new.property_id, 'quickbooks', 'bill_payment', jsonb_build_object('payment_id', new.id), 'qbo:payment:' || new.id);
  elsif tg_table_name = 'pms_night_audits' then
    if v_start is not null and new.business_date < v_start then return null; end if;
    perform pms__enqueue(new.property_id, 'quickbooks', 'journal', jsonb_build_object('date', new.business_date), 'qbo:journal:' || new.property_id || ':' || new.business_date);
  end if;
  return null;
end $$;
drop trigger if exists trg_qbo_supplier on pms_suppliers;
create trigger trg_qbo_supplier after insert or update of name, phone, email, tin, address on pms_suppliers for each row execute function pms__qbo_queue();
drop trigger if exists trg_qbo_invoice on pms_supplier_invoices;
create trigger trg_qbo_invoice after insert or update of total, status on pms_supplier_invoices for each row execute function pms__qbo_queue();
drop trigger if exists trg_qbo_payment on pms_supplier_payments;
create trigger trg_qbo_payment after insert on pms_supplier_payments for each row execute function pms__qbo_queue();
drop trigger if exists trg_qbo_audit on pms_night_audits;
create trigger trg_qbo_audit after insert on pms_night_audits for each row execute function pms__qbo_queue();

-- ---------------------------------------------------------------------
-- The day's journal, worked out here so it is the same everywhere
-- ---------------------------------------------------------------------
create or replace function pms__qbo_journal(p_property uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_lines jsonb := '[]'; r record; v_dr numeric := 0; v_cr numeric := 0; v_missing text[] := '{}'; v_acc text; v_out jsonb := '[]';
begin
  for r in
    -- folio charges by category: credit revenue
    select 'revenue:' || l.category as key, 'Credit' as side, sum(l.amount) as amt, 'Folio ' || replace(l.category, '_', ' ') as descr
      from pms_folio_lines l where l.property_id = p_property and l.business_date = p_date and not l.voided and l.line_type = 'charge' group by l.category
    union all
    select 'discounts', 'Debit', -sum(l.amount), 'Discounts'
      from pms_folio_lines l where l.property_id = p_property and l.business_date = p_date and not l.voided and l.line_type = 'discount'
    union all
    select 'payment:' || coalesce(l.payment_method, 'other'), 'Debit', -sum(l.amount), 'Front desk ' || replace(coalesce(l.payment_method, 'other'), '_', ' ')
      from pms_folio_lines l where l.property_id = p_property and l.business_date = p_date and not l.voided and l.line_type in ('payment','refund')
      group by l.payment_method
    union all
    -- outlets: what was paid at the outlet (the room part is on the folio already)
    select 'revenue:' || o.charge_category, 'Credit', sum(b.paid), 'Outlets ' || replace(o.charge_category, '_', ' ')
      from pms_pos_bills b join pms_pos_outlets o on o.id = b.outlet_id
      where b.property_id = p_property and b.business_date = p_date and b.status in ('settled','room') group by o.charge_category
    union all
    select 'payment:' || p.method, 'Debit', sum(p.amount), 'Outlets ' || replace(p.method, '_', ' ')
      from pms_pos_payments p join pms_pos_bills b on b.id = p.bill_id
      where b.property_id = p_property and b.business_date = p_date and b.status in ('settled','room') and not p.voided group by p.method
    union all
    select 'expenses', 'Debit', sum(e.amount), 'Petty cash expenses' from pms_expense_vouchers e where e.property_id = p_property and e.business_date = p_date
    union all
    select 'payment:cash', 'Credit', sum(e.amount), 'Petty cash paid out' from pms_expense_vouchers e where e.property_id = p_property and e.business_date = p_date
    union all
    -- stock used, wasted and counted
    select case m.kind when 'waste' then 'stock_waste' when 'count' then 'stock_variance' else 'cogs' end, 'Debit', -sum(m.value),
           case m.kind when 'waste' then 'Stock waste' when 'count' then 'Stock count differences' else 'Cost of sales' end
      from pms_stock_moves m where m.property_id = p_property and m.business_date = p_date and m.kind in ('sale','sale_reversal','waste','count')
      group by case m.kind when 'waste' then 'stock_waste' when 'count' then 'stock_variance' else 'cogs' end,
               case m.kind when 'waste' then 'Stock waste' when 'count' then 'Stock count differences' else 'Cost of sales' end
    union all
    select 'inventory', 'Credit', -sum(m.value), 'Stock used, wasted or counted'
      from pms_stock_moves m where m.property_id = p_property and m.business_date = p_date and m.kind in ('sale','sale_reversal','waste','count')
  loop
    continue when coalesce(r.amt, 0) = 0;
    v_acc := pms__qbo_account(p_property, r.key);
    if v_acc is null then v_missing := v_missing || r.key; end if;
    -- a negative amount posts on the other side
    v_lines := v_lines || jsonb_build_object('key', r.key, 'account', v_acc, 'description', r.descr,
      'side', case when r.amt > 0 then r.side else case r.side when 'Debit' then 'Credit' else 'Debit' end end, 'amount', round(abs(r.amt), 2));
  end loop;
  select coalesce(sum((x->>'amount')::numeric) filter (where x->>'side' = 'Debit'), 0), coalesce(sum((x->>'amount')::numeric) filter (where x->>'side' = 'Credit'), 0)
    into v_dr, v_cr from jsonb_array_elements(v_lines) x;
  if v_cr <> v_dr then
    v_acc := pms__qbo_account(p_property, 'guest_ledger');
    if v_acc is null then v_missing := v_missing || 'guest_ledger'::text; end if;
    v_lines := v_lines || jsonb_build_object('key', 'guest_ledger', 'account', v_acc, 'description', 'Guest ledger movement',
      'side', case when v_cr > v_dr then 'Debit' else 'Credit' end, 'amount', abs(v_cr - v_dr));
  end if;
  return jsonb_build_object('date', p_date, 'doc_number', 'PMS-' || to_char(p_date, 'YYYYMMDD'), 'lines', v_lines,
    'missing', (select coalesce(jsonb_agg(distinct m), '[]') from unnest(v_missing) m));
end $$;

-- Owners can look at a day's journal before it goes
create or replace function pms_qbo_preview_day(p_property uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'acct.quickbooks');
  return pms__qbo_journal(p_property, p_date);
end $$;

-- ---------------------------------------------------------------------
-- Service functions for the worker and the sign-in callback
-- ---------------------------------------------------------------------
create or replace function pms_svc_qbo_consume_state(p_state text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s pms_qbo_states;
begin
  perform pms__require_service();
  delete from pms_qbo_states where state = p_state returning * into s;
  if s.state is null or s.created_at < now() - interval '15 minutes' then return null; end if;
  return jsonb_build_object('property_id', s.property_id, 'user_id', s.user_id, 'return_url', s.return_url);
end $$;

create or replace function pms_svc_qbo_save(p_property uuid, p_realm text, p_env text, p_access text, p_access_expires timestamptz,
  p_refresh text, p_refresh_expires timestamptz, p_company text default null, p_user uuid default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  insert into pms_qbo_connections(property_id, realm_id, environment, status, access_token, access_expires_at, refresh_token, refresh_expires_at, company_name, connected_by, connected_at)
  values (p_property, p_realm, p_env, 'connected', p_access, p_access_expires, p_refresh, p_refresh_expires, p_company, p_user, now())
  on conflict (property_id) do update set
    realm_id = excluded.realm_id, environment = excluded.environment, status = 'connected', access_token = excluded.access_token,
    access_expires_at = excluded.access_expires_at, refresh_token = coalesce(excluded.refresh_token, pms_qbo_connections.refresh_token),
    refresh_expires_at = coalesce(excluded.refresh_expires_at, pms_qbo_connections.refresh_expires_at),
    company_name = coalesce(excluded.company_name, pms_qbo_connections.company_name),
    connected_by = coalesce(excluded.connected_by, pms_qbo_connections.connected_by),
    connected_at = case when excluded.connected_by is not null then now() else pms_qbo_connections.connected_at end, last_error = null;
  if p_user is not null then
    insert into pms_audit_log(property_id, user_id, action, entity, entity_id, details)
    values (p_property, p_user, 'quickbooks.connect', 'property', p_property, jsonb_build_object('company', p_company, 'environment', p_env));
  end if;
end $$;

create or replace function pms_svc_qbo_broken(p_property uuid, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  update pms_qbo_connections set status = 'needs_reconnect', last_error = left(p_error, 500) where property_id = p_property;
end $$;

create or replace function pms_svc_qbo_connections() returns setof pms_qbo_connections
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_service();
  return query select * from pms_qbo_connections where status = 'connected';
end $$;

create or replace function pms_svc_qbo_link(p_property uuid, p_entity text, p_local text, p_qbo_id text, p_sync text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  if p_qbo_id is null then
    delete from pms_qbo_links where property_id = p_property and entity = p_entity and local_id = p_local;
  else
    insert into pms_qbo_links(property_id, entity, local_id, qbo_id, sync_token) values (p_property, p_entity, p_local, p_qbo_id, p_sync)
    on conflict (property_id, entity, local_id) do update set qbo_id = excluded.qbo_id, sync_token = excluded.sync_token, synced_at = now();
  end if;
end $$;

-- Everything the worker needs for one job, with QuickBooks ids already resolved
create or replace function pms_svc_qbo_payload(p_job bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare j pms_jobs; s pms_suppliers; v pms_supplier_invoices; pay pms_supplier_payments; v_missing text[] := '{}'; v_lines jsonb := '[]';
  l record; v_acc text; v_key text; v_link pms_qbo_links;
begin
  perform pms__require_service();
  select * into j from pms_jobs where id = p_job;
  if j.kind = 'vendor' then
    select * into s from pms_suppliers where id = (j.payload->>'supplier_id')::uuid;
    select * into v_link from pms_qbo_links where property_id = j.property_id and entity = 'vendor' and local_id = s.id::text;
    return jsonb_build_object('local_id', s.id, 'qbo_id', v_link.qbo_id, 'sync_token', v_link.sync_token, 'name', s.name, 'phone', s.phone,
      'email', s.email, 'tin', s.tin, 'address', s.address, 'contact', s.contact_name, 'terms_days', s.payment_terms_days, 'currency', s.currency);
  elsif j.kind in ('bill','bill_void') then
    select * into v from pms_supplier_invoices where id = (j.payload->>'invoice_id')::uuid;
    select * into v_link from pms_qbo_links where property_id = j.property_id and entity = 'bill' and local_id = v.id::text;
    for l in select * from pms_supplier_invoice_lines where invoice_id = v.id order by description loop
      v_key := case when l.item_id is not null then 'inventory' when l.expense_code is not null then 'expense:' || l.expense_code else 'purchases' end;
      v_acc := pms__qbo_account(j.property_id, v_key);
      if v_acc is null then v_missing := v_missing || v_key; end if;
      v_lines := v_lines || jsonb_build_object('description', l.description || ' × ' || trim(to_char(l.qty, 'FM999999990.###')), 'amount', l.amount, 'account', v_acc);
    end loop;
    if v.vat > 0 then
      v_acc := pms__qbo_account(j.property_id, 'vat_input');
      if v_acc is null then v_missing := v_missing || 'vat_input'::text; end if;
      v_lines := v_lines || jsonb_build_object('description', 'VAT', 'amount', v.vat, 'account', v_acc);
    end if;
    return jsonb_build_object('local_id', v.id, 'qbo_id', v_link.qbo_id, 'sync_token', v_link.sync_token, 'status', v.status,
      'doc_number', left(v.invoice_no, 21), 'txn_date', v.invoice_date, 'due_date', v.due_date, 'total', v.total,
      'vendor_qbo_id', (select qbo_id from pms_qbo_links where property_id = j.property_id and entity = 'vendor' and local_id = v.supplier_id::text),
      'supplier_id', v.supplier_id, 'lines', v_lines,
      'note', 'BMG PMS SI-' || lpad(v.internal_no::text, 5, '0') || coalesce(' · ' || v.match_notes, ''),
      'missing', (select coalesce(jsonb_agg(distinct m), '[]') from unnest(v_missing) m));
  elsif j.kind = 'bill_payment' then
    select * into pay from pms_supplier_payments where id = (j.payload->>'payment_id')::uuid;
    v_acc := pms__qbo_account(j.property_id, 'payment:' || pay.method);
    return jsonb_build_object('local_id', pay.id, 'amount', pay.amount, 'txn_date', pay.paid_on, 'reference', pay.reference, 'voided', pay.voided,
      'bank_account', v_acc, 'missing', case when v_acc is null then jsonb_build_array('payment:' || pay.method) else '[]'::jsonb end,
      'vendor_qbo_id', (select qbo_id from pms_qbo_links where property_id = j.property_id and entity = 'vendor' and local_id = pay.supplier_id::text),
      'bill_qbo_id', (select qbo_id from pms_qbo_links where property_id = j.property_id and entity = 'bill' and local_id = pay.invoice_id::text),
      'qbo_id', (select qbo_id from pms_qbo_links where property_id = j.property_id and entity = 'bill_payment' and local_id = pay.id::text),
      'supplier_id', pay.supplier_id, 'invoice_id', pay.invoice_id);
  elsif j.kind = 'journal' then
    select * into v_link from pms_qbo_links where property_id = j.property_id and entity = 'journal' and local_id = j.payload->>'date';
    return pms__qbo_journal(j.property_id, (j.payload->>'date')::date)
      || jsonb_build_object('local_id', j.payload->>'date', 'qbo_id', v_link.qbo_id, 'sync_token', v_link.sync_token);
  end if;
  return null;
end $$;

-- Queue the vendor first when a bill or payment needs one that is not in QuickBooks yet
create or replace function pms_svc_qbo_need_vendor(p_property uuid, p_supplier uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  perform pms__enqueue(p_property, 'quickbooks', 'vendor', jsonb_build_object('supplier_id', p_supplier), 'qbo:vendor:' || p_supplier);
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
revoke execute on function pms__qbo_keys(uuid), pms__qbo_account(uuid, text), pms__qbo_on(uuid), pms__qbo_queue(), pms__qbo_journal(uuid, date),
  pms_svc_qbo_consume_state(text), pms_svc_qbo_save(uuid, text, text, text, timestamptz, text, timestamptz, text, uuid), pms_svc_qbo_broken(uuid, text),
  pms_svc_qbo_connections(), pms_svc_qbo_link(uuid, text, text, text, text), pms_svc_qbo_payload(bigint), pms_svc_qbo_need_vendor(uuid, uuid) from authenticated;
grant execute on function pms_qbo_status(uuid), pms_qbo_begin(uuid, text), pms_qbo_disconnect(uuid), pms_qbo_set_mapping(uuid, text, text, text),
  pms_qbo_settings(uuid, boolean, date), pms_qbo_send_day(uuid, date), pms_qbo_retry(uuid), pms_qbo_preview_day(uuid, date) to authenticated;
select pms__apply_platform_rules();
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';
