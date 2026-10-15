-- module: activities
-- also: back-office, front-office, integrations
-- =====================================================================
-- BMG PMS · 14 · Activities on the POS: gym, swimming pool, pool table, spa, tours, events
--   Outlets get a type (gym, pool, games, spa, tours, events…) and post to the folio under their own
--   department (recreation, spa, tours, events) instead of "other".
--   Items can be:
--     product     — sold by quantity; takes stock through its recipe (food, drinks, towels for sale)
--     service     — sold by quantity, no stock (massage 60 min, day pass, guided tour, hall hire)
--     timed       — started and stopped on the till; charged per block (pool table per 30 min, court per hour)
--     membership  — gym or pool membership for N days, optionally a number of visits; creates a member
--   Members and in-house guests are checked in at the door (visits), which gives usage per facility.
-- Safe to re-run. Run after 13.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Outlets and items
-- ---------------------------------------------------------------------
alter table pms_pos_outlets add column if not exists outlet_type text not null default 'restaurant';
alter table pms_pos_outlets drop constraint if exists pms_pos_outlets_outlet_type_check;
alter table pms_pos_outlets add constraint pms_pos_outlets_outlet_type_check check (outlet_type in
  ('restaurant','bar','cafe','room_service','minibar','laundry','gym','pool','games','spa','tours','events','transport','shop','other'));
alter table pms_pos_outlets drop constraint if exists pms_pos_outlets_charge_category_check;
alter table pms_pos_outlets add constraint pms_pos_outlets_charge_category_check check (charge_category in
  ('fnb','laundry','minibar','transport','spa','recreation','tours','events','other'));

-- existing outlets get a sensible type from what they post as, or their name
update pms_pos_outlets set outlet_type = case
    when charge_category in ('laundry','minibar','spa','transport') then charge_category
    when name ~* '\mbar\M' then 'bar' when name ~* 'caf' then 'cafe' when name ~* 'room service' then 'room_service'
    else outlet_type end
  where outlet_type = 'restaurant';

alter table pms_pos_items add column if not exists item_type text not null default 'product';
alter table pms_pos_items add column if not exists duration_minutes integer;      -- timed: length of one charged block
alter table pms_pos_items add column if not exists min_units numeric(6,2) not null default 1;   -- timed: least blocks charged
alter table pms_pos_items add column if not exists grace_minutes integer not null default 0;    -- timed: free minutes before the next block
alter table pms_pos_items add column if not exists resources text[];               -- timed: tables / courts / lanes that can run at once
alter table pms_pos_items add column if not exists validity_days integer;          -- membership: days it lasts
alter table pms_pos_items add column if not exists visits_included integer;        -- membership: visits allowed (empty = unlimited)
alter table pms_pos_items drop constraint if exists pms_pos_items_type_check;
alter table pms_pos_items add constraint pms_pos_items_type_check check (item_type in ('product','service','timed','membership'));
alter table pms_pos_items drop constraint if exists pms_pos_items_timed_check;
alter table pms_pos_items add constraint pms_pos_items_timed_check check (item_type <> 'timed' or (coalesce(duration_minutes, 0) > 0 and min_units > 0));
alter table pms_pos_items drop constraint if exists pms_pos_items_membership_check;
alter table pms_pos_items add constraint pms_pos_items_membership_check check (item_type <> 'membership' or coalesce(validity_days, 0) > 0);
alter table pms_pos_items drop constraint if exists pms_pos_items_numbers_check;
alter table pms_pos_items add constraint pms_pos_items_numbers_check check (grace_minutes >= 0 and (visits_included is null or visits_included > 0));

alter table pms_pos_bill_items add column if not exists started_at timestamptz;
alter table pms_pos_bill_items add column if not exists ended_at timestamptz;
alter table pms_pos_bill_items add column if not exists resource text;
alter table pms_pos_bill_items add column if not exists member_name text;
alter table pms_pos_bill_items add column if not exists member_phone text;
-- One table / court / lane can only run one timer at a time
create unique index if not exists ux_pos_running_resource on pms_pos_bill_items (item_id, resource)
  where started_at is not null and ended_at is null and resource is not null;

-- ---------------------------------------------------------------------
-- Members and visits
-- ---------------------------------------------------------------------
create table if not exists pms_memberships (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references pms_properties(id) on delete cascade,
  outlet_id        uuid not null references pms_pos_outlets(id),
  item_id          uuid references pms_pos_items(id),
  bill_id          uuid references pms_pos_bills(id),
  bill_item_id     uuid references pms_pos_bill_items(id) on delete set null,
  stay_id          uuid references pms_stays(id),
  member_name      text not null,
  phone            text,
  plan             text not null,
  starts_on        date not null,
  ends_on          date not null,
  visits_included  integer,
  visits_used      integer not null default 0,
  status           text not null default 'active' check (status in ('active','cancelled')),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index if not exists ix_memberships_lookup on pms_memberships (property_id, status, ends_on);
create unique index if not exists ux_memberships_bill_item on pms_memberships (bill_item_id) where bill_item_id is not null;

create table if not exists pms_activity_visits (
  id             bigserial primary key,
  property_id    uuid not null references pms_properties(id) on delete cascade,
  outlet_id      uuid not null references pms_pos_outlets(id),
  kind           text not null check (kind in ('member','resident','walk_in')),
  membership_id  uuid references pms_memberships(id),
  stay_id        uuid references pms_stays(id),
  guest_name     text not null,
  business_date  date not null,
  visited_at     timestamptz not null default now(),
  note           text,
  created_by     uuid
);
create index if not exists ix_visits_outlet_day on pms_activity_visits (outlet_id, business_date);
create index if not exists ix_visits_membership on pms_activity_visits (membership_id);
create index if not exists ix_visits_stay on pms_activity_visits (stay_id);
create index if not exists ix_visits_property on pms_activity_visits (property_id, business_date);
create index if not exists ix_memberships_outlet on pms_memberships (outlet_id);
create index if not exists ix_memberships_item on pms_memberships (item_id);
create index if not exists ix_memberships_bill on pms_memberships (bill_id);
create index if not exists ix_memberships_stay on pms_memberships (stay_id);

alter table pms_memberships enable row level security;
alter table pms_activity_visits enable row level security;
drop policy if exists pms_memberships_read on pms_memberships;
create policy pms_memberships_read on pms_memberships for select using (property_id in (select pms_my_properties(null::text[])));
drop policy if exists pms_activity_visits_read on pms_activity_visits;
create policy pms_activity_visits_read on pms_activity_visits for select using (property_id in (select pms_my_properties(null::text[])));
revoke all on pms_memberships, pms_activity_visits from anon, authenticated;
grant select on pms_memberships, pms_activity_visits to authenticated;

-- ---------------------------------------------------------------------
-- Selling: timers, memberships, and the rules on the bill
-- ---------------------------------------------------------------------
create or replace function pms__pos_item(p_bill pms_pos_bills, p_item uuid) returns pms_pos_items
language plpgsql security definer set search_path = public as $$
declare i pms_pos_items;
begin
  select * into i from pms_pos_items where id = p_item and outlet_id = p_bill.outlet_id and active;
  if not found then raise exception 'Item not on this outlet''s list'; end if;
  return i;
end $$;

-- Start the clock on a pool table, court or lane
create or replace function pms_pos_start_timer(p_bill uuid, p_item uuid, p_resource text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; i pms_pos_items; v_id uuid; v_res text := nullif(trim(coalesce(p_resource, '')), '');
begin
  b := pms__pos_bill(p_bill);
  i := pms__pos_item(b, p_item);
  if i.item_type <> 'timed' then raise exception '% is not sold by time', i.name; end if;
  if coalesce(array_length(i.resources, 1), 0) > 0 then
    if v_res is null then raise exception 'Choose which one: %', array_to_string(i.resources, ', '); end if;
    if not (v_res = any(i.resources)) then raise exception '% is not one of: %', v_res, array_to_string(i.resources, ', '); end if;
  end if;
  begin
    insert into pms_pos_bill_items(bill_id, item_id, name, qty, price, amount, added_by, started_at, resource)
    values (p_bill, p_item, i.name || coalesce(' · ' || v_res, ''), i.min_units, i.price, round(i.min_units * i.price, 2), auth.uid(), now(), v_res)
    returning id into v_id;
  exception when unique_violation then
    raise exception '% is already in use. Stop its timer first.', coalesce(v_res, i.name);
  end;
  perform pms__pos_total(p_bill);
  perform pms_log(b.property_id, 'pos.timer_start', 'pos_bill', p_bill, jsonb_build_object('item', i.name, 'resource', v_res));
  return v_id;
end $$;

-- Stop it: charged per started block after the grace minutes, never below the minimum
create or replace function pms_pos_stop_timer(p_bill_item uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l pms_pos_bill_items; b pms_pos_bills; i pms_pos_items; v_min numeric; v_units numeric;
begin
  select * into l from pms_pos_bill_items where id = p_bill_item for update;
  if not found then raise exception 'Line not found'; end if;
  b := pms__pos_bill(l.bill_id);
  if l.started_at is null or l.ended_at is not null then raise exception 'That timer is not running'; end if;
  select * into i from pms_pos_items where id = l.item_id;
  v_min := extract(epoch from (now() - l.started_at)) / 60.0;
  v_units := greatest(i.min_units, ceil(greatest(v_min - i.grace_minutes, 0) / i.duration_minutes));
  update pms_pos_bill_items set ended_at = now(), qty = v_units, amount = round(v_units * price, 2) where id = p_bill_item;
  perform pms__pos_total(l.bill_id);
  perform pms_log(b.property_id, 'pos.timer_stop', 'pos_bill', l.bill_id,
    jsonb_build_object('item', l.name, 'minutes', round(v_min), 'blocks', v_units, 'amount', round(v_units * l.price, 2)));
  return jsonb_build_object('minutes', round(v_min), 'blocks', v_units, 'amount', round(v_units * l.price, 2));
end $$;

-- Sell a membership: the member's name goes on the line; the membership starts when the bill is paid
create or replace function pms_pos_add_membership(p_bill uuid, p_item uuid, p_name text, p_phone text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare b pms_pos_bills; i pms_pos_items; v_id uuid;
begin
  b := pms__pos_bill(p_bill);
  i := pms__pos_item(b, p_item);
  if i.item_type <> 'membership' then raise exception '% is not a membership', i.name; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter the member''s name'; end if;
  insert into pms_pos_bill_items(bill_id, item_id, name, qty, price, amount, added_by, member_name, member_phone)
  values (p_bill, p_item, i.name || ' · ' || left(trim(p_name), 60), 1, i.price, i.price, auth.uid(), left(trim(p_name), 80), nullif(left(trim(coalesce(p_phone, '')), 20), ''))
  returning id into v_id;
  perform pms__pos_total(p_bill);
  return v_id;
end $$;

-- Rules on every bill line: memberships need a name; a timer only through start/stop
create or replace function pms__pos_line_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if new.item_id is null then return new; end if;
  select item_type into t from pms_pos_items where id = new.item_id;
  if t = 'membership' and coalesce(trim(new.member_name), '') = '' then
    raise exception 'Use "Sell membership" so the member''s name is recorded';
  end if;
  return new;
end $$;
drop trigger if exists trg_pos_line_rules on pms_pos_bill_items;
create trigger trg_pos_line_rules before insert on pms_pos_bill_items for each row execute function pms__pos_line_rules();

-- Closing a bill: no running clocks; paid memberships start; voided ones are cancelled
create or replace function pms__pos_bill_close() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if old.status = 'open' and new.status in ('settled','room') then
    select string_agg(coalesce(l.resource, l.name), ', ') into r from pms_pos_bill_items l
     where l.bill_id = new.id and l.started_at is not null and l.ended_at is null;
    if r.string_agg is not null then raise exception 'Stop the timer for % first', r.string_agg; end if;
    insert into pms_memberships(property_id, outlet_id, item_id, bill_id, bill_item_id, stay_id, member_name, phone, plan,
                                starts_on, ends_on, visits_included, created_by)
    select new.property_id, new.outlet_id, i.id, new.id, l.id, new.stay_id, l.member_name, l.member_phone, i.name,
           new.business_date, new.business_date + (i.validity_days * greatest(l.qty, 1))::int - 1, i.visits_included, auth.uid()
    from pms_pos_bill_items l join pms_pos_items i on i.id = l.item_id
    where l.bill_id = new.id and i.item_type = 'membership'
    on conflict do nothing;
  elsif new.status = 'void' and old.status <> 'void' then
    update pms_memberships set status = 'cancelled' where bill_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists trg_pos_bill_close on pms_pos_bills;
create trigger trg_pos_bill_close before update of status on pms_pos_bills for each row execute function pms__pos_bill_close();

-- What is running right now (the board on the till)
create or replace function pms_pos_running(p_property uuid)
returns table(bill_item_id uuid, bill_id uuid, bill_no int, outlet text, item text, resource text, started_at timestamptz,
              minutes int, price numeric, block_minutes int, min_units numeric, grace_minutes int, estimate numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','front_desk','accountant']);
  return query
    select l.id, b.id, b.bill_no, o.name, i.name, l.resource, l.started_at,
      floor(extract(epoch from (now() - l.started_at)) / 60)::int, l.price, i.duration_minutes, i.min_units, i.grace_minutes,
      round(greatest(i.min_units, ceil(greatest(extract(epoch from (now() - l.started_at)) / 60.0 - i.grace_minutes, 0) / i.duration_minutes)) * l.price, 2)
    from pms_pos_bill_items l join pms_pos_bills b on b.id = l.bill_id join pms_pos_outlets o on o.id = b.outlet_id
    join pms_pos_items i on i.id = l.item_id
    where b.property_id = p_property and b.status = 'open' and l.started_at is not null and l.ended_at is null
    order by l.started_at;
end $$;

-- ---------------------------------------------------------------------
-- At the door: members, in-house guests and walk-ins
-- ---------------------------------------------------------------------
create or replace function pms_activity_check_in(p_outlet uuid, p_membership uuid default null, p_stay uuid default null,
                                                 p_name text default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o pms_pos_outlets; m pms_memberships; v_bd date; v_name text; v_kind text; v_left int;
begin
  select * into o from pms_pos_outlets where id = p_outlet;
  if not found then raise exception 'Outlet not found'; end if;
  perform pms_require(o.property_id, array['owner','manager','front_desk','accountant','housekeeping']);
  v_bd := pms__bd(o.property_id);
  if p_membership is not null then
    select * into m from pms_memberships where id = p_membership and property_id = o.property_id for update;
    if not found then raise exception 'Membership not found'; end if;
    if m.status <> 'active' then raise exception 'This membership was cancelled'; end if;
    if m.outlet_id <> p_outlet then raise exception 'This membership is for another facility'; end if;
    if v_bd < m.starts_on then raise exception 'This membership starts on %', to_char(m.starts_on, 'DD Mon YYYY'); end if;
    if v_bd > m.ends_on then raise exception 'This membership ended on %', to_char(m.ends_on, 'DD Mon YYYY'); end if;
    if m.visits_included is not null and m.visits_used >= m.visits_included then raise exception 'All % visits have been used', m.visits_included; end if;
    update pms_memberships set visits_used = visits_used + 1 where id = m.id;
    v_kind := 'member'; v_name := m.member_name;
    v_left := case when m.visits_included is null then null else m.visits_included - m.visits_used - 1 end;
  elsif p_stay is not null then
    select g.first_name || coalesce(' ' || g.last_name, '') || ' · room ' || coalesce(r.number, '?') into v_name
    from pms_stays s join pms_reservations res on res.id = s.reservation_id join pms_guests g on g.id = res.guest_id
    left join pms_rooms r on r.id = s.room_id
    where s.id = p_stay and s.property_id = o.property_id and s.status = 'checked_in';
    if v_name is null then raise exception 'That guest is not checked in'; end if;
    v_kind := 'resident';
  else
    if coalesce(trim(p_name), '') = '' then raise exception 'Enter the visitor''s name'; end if;
    v_kind := 'walk_in'; v_name := left(trim(p_name), 80);
  end if;
  insert into pms_activity_visits(property_id, outlet_id, kind, membership_id, stay_id, guest_name, business_date, note, created_by)
  values (o.property_id, p_outlet, v_kind, p_membership, p_stay, v_name, v_bd, nullif(left(trim(coalesce(p_note, '')), 200), ''), auth.uid());
  return jsonb_build_object('kind', v_kind, 'name', v_name, 'visits_left', v_left,
    'ends_on', case when v_kind = 'member' then m.ends_on end);
end $$;

create or replace function pms_cancel_membership(p_membership uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare m pms_memberships;
begin
  select * into m from pms_memberships where id = p_membership for update;
  if not found then raise exception 'Membership not found'; end if;
  perform pms_require(m.property_id, array['owner','manager']);
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  update pms_memberships set status = 'cancelled' where id = p_membership;
  perform pms_log(m.property_id, 'membership.cancel', 'membership', p_membership, jsonb_build_object('member', m.member_name, 'reason', p_reason));
end $$;

-- ---------------------------------------------------------------------
-- Report: each facility's takings, hours sold and visitors
-- ---------------------------------------------------------------------
create or replace function pms_rpt_activities(p_property uuid, p_from date, p_to date)
returns table(outlet text, outlet_type text, bills int, revenue numeric, to_rooms numeric, hours_sold numeric,
              member_visits int, resident_visits int, walk_in_visits int, new_memberships int, active_memberships int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant','front_desk']);
  return query
    select o.name, o.outlet_type,
      (select count(*)::int from pms_pos_bills b where b.outlet_id = o.id and b.business_date between p_from and p_to and b.status in ('settled','room')),
      (select coalesce(sum(b.total), 0) from pms_pos_bills b where b.outlet_id = o.id and b.business_date between p_from and p_to and b.status in ('settled','room')),
      (select coalesce(sum(b.total), 0) from pms_pos_bills b where b.outlet_id = o.id and b.business_date between p_from and p_to and b.status = 'room'),
      (select round(coalesce(sum(l.qty * i.duration_minutes), 0) / 60.0, 1) from pms_pos_bill_items l join pms_pos_bills b on b.id = l.bill_id
         join pms_pos_items i on i.id = l.item_id
         where b.outlet_id = o.id and b.business_date between p_from and p_to and b.status in ('settled','room') and i.item_type = 'timed'),
      (select count(*)::int from pms_activity_visits v where v.outlet_id = o.id and v.business_date between p_from and p_to and v.kind = 'member'),
      (select count(*)::int from pms_activity_visits v where v.outlet_id = o.id and v.business_date between p_from and p_to and v.kind = 'resident'),
      (select count(*)::int from pms_activity_visits v where v.outlet_id = o.id and v.business_date between p_from and p_to and v.kind = 'walk_in'),
      (select count(*)::int from pms_memberships m where m.outlet_id = o.id and m.starts_on between p_from and p_to and m.status = 'active'),
      (select count(*)::int from pms_memberships m where m.outlet_id = o.id and m.status = 'active' and m.ends_on >= p_to and m.starts_on <= p_to)
    from pms_pos_outlets o
    where o.property_id = p_property and (o.outlet_type in ('gym','pool','games','spa','tours','events')
      or exists (select 1 from pms_pos_items i where i.outlet_id = o.id and i.item_type in ('timed','membership','service')))
    order by o.name;
end $$;

-- Room charges accept the activity categories
create or replace function pms_post_charge(
  p_folio uuid, p_category text, p_description text, p_amount numeric, p_reference text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; v_id uuid;
begin
  f := pms__open_folio(p_folio);
  perform pms_require(f.property_id, array['owner','manager','front_desk','accountant']);
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_category not in ('room','tax','fnb','laundry','minibar','transport','spa','recreation','tours','events','extra_bed','damage','other') then
    raise exception 'Unknown charge category %', p_category;
  end if;
  insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount,
                              reference, business_date, posted_by)
  values (f.property_id, p_folio, f.stay_id, 'charge', p_category, p_description, round(p_amount,2),
          p_reference, (select business_date from pms_properties where id = f.property_id), auth.uid())
  returning id into v_id;
  perform pms_log(f.property_id, 'folio.charge', 'folio_line', v_id,
    jsonb_build_object('folio_no', f.folio_no, 'amount', p_amount, 'category', p_category));
  return v_id;
end $$;

create or replace function pms_svc_pos_charge(
  p_property uuid, p_source text, p_ref text, p_stay uuid, p_room text, p_amount numeric,
  p_category text default 'fnb', p_outlet text default null, p_description text default null, p_items jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s pms_stays; v_room text; v_folio uuid; v_line uuid; v_bd date; x pms_external_charges; v_desc text;
begin
  perform pms__require_service();
  if coalesce(trim(p_ref), '') = '' then raise exception 'BAD_REQUEST: bill reference is required'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'BAD_REQUEST: amount must be greater than zero'; end if;
  if p_category not in ('fnb','laundry','minibar','transport','spa','recreation','tours','events','damage','other') then
    raise exception 'BAD_REQUEST: unknown category %', p_category;
  end if;

  select * into x from pms_external_charges where property_id = p_property and source = p_source and external_ref = p_ref;
  if found then
    if x.amount <> round(p_amount, 2) then
      raise exception 'CONFLICT: bill % was already charged with a different amount (%)', p_ref, x.amount;
    end if;
    return jsonb_build_object('status', x.status, 'duplicate', true, 'charge_id', x.id, 'folio_line_id', x.folio_line_id, 'amount', x.amount);
  end if;

  select * into s from pms_stays where id = p_stay and property_id = p_property for update;
  if not found or s.status <> 'checked_in' then raise exception 'NOT_IN_HOUSE: this guest is not checked in'; end if;
  select number into v_room from pms_rooms where id = s.room_id;
  if p_room is not null and p_room <> v_room then
    raise exception 'ROOM_MISMATCH: the guest moved to room %; refresh the guest list', v_room;
  end if;
  select id into v_folio from pms_folios where stay_id = s.id and status = 'open' order by folio_no limit 1;
  if v_folio is null then raise exception 'NOT_IN_HOUSE: this guest has no open folio'; end if;
  select business_date into v_bd from pms_properties where id = p_property;

  v_desc := coalesce(nullif(trim(p_description), ''), coalesce(p_outlet, 'POS') || ' bill ' || p_ref);
  insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount, reference, business_date, source)
  values (p_property, v_folio, s.id, 'charge', p_category, v_desc, round(p_amount, 2), p_source || ':' || p_ref, v_bd, 'pos')
  returning id into v_line;
  insert into pms_external_charges(property_id, source, external_ref, outlet, stay_id, folio_id, folio_line_id, amount, description, items)
  values (p_property, p_source, p_ref, p_outlet, s.id, v_folio, v_line, round(p_amount, 2), v_desc, p_items)
  returning * into x;
  perform pms_log(p_property, 'pos.external_charge', 'folio_line', v_line,
    jsonb_build_object('source', p_source, 'ref', p_ref, 'room', v_room, 'amount', p_amount, 'outlet', p_outlet));
  return jsonb_build_object('status', 'posted', 'duplicate', false, 'charge_id', x.id, 'folio_line_id', v_line, 'amount', x.amount, 'room', v_room);
end $$;

-- ---------------------------------------------------------------------
-- New tables follow the same protections as the rest (13): same-property references, internal helpers private
-- ---------------------------------------------------------------------
drop trigger if exists trg_same_property on pms_memberships;
create trigger trg_same_property before insert or update on pms_memberships for each row
  execute function pms__same_property('outlet_id:pms_pos_outlets', 'item_id:pms_pos_items', 'bill_id:pms_pos_bills', 'stay_id:pms_stays');
drop trigger if exists trg_same_property on pms_activity_visits;
create trigger trg_same_property before insert or update on pms_activity_visits for each row
  execute function pms__same_property('outlet_id:pms_pos_outlets', 'membership_id:pms_memberships', 'stay_id:pms_stays');

revoke execute on function pms__pos_item(pms_pos_bills, uuid), pms__pos_line_rules(), pms__pos_bill_close() from public, anon, authenticated;
revoke execute on function pms_pos_start_timer(uuid, uuid, text), pms_pos_stop_timer(uuid), pms_pos_add_membership(uuid, uuid, text, text),
  pms_pos_running(uuid), pms_activity_check_in(uuid, uuid, uuid, text, text), pms_cancel_membership(uuid, text),
  pms_rpt_activities(uuid, date, date), pms_post_charge(uuid, text, text, numeric, text) from public, anon;
grant execute on function pms_pos_start_timer(uuid, uuid, text), pms_pos_stop_timer(uuid), pms_pos_add_membership(uuid, uuid, text, text),
  pms_pos_running(uuid), pms_activity_check_in(uuid, uuid, uuid, text, text), pms_cancel_membership(uuid, text),
  pms_rpt_activities(uuid, date, date), pms_post_charge(uuid, text, text, numeric, text) to authenticated;
revoke execute on function pms_svc_pos_charge(uuid, text, text, uuid, text, numeric, text, text, text, jsonb) from public, anon, authenticated;
do $$ begin execute 'grant execute on function pms_svc_pos_charge(uuid, text, text, uuid, text, numeric, text, text, text, jsonb) to service_role'; exception when undefined_object then null; end $$;

notify pgrst, 'reload schema';
