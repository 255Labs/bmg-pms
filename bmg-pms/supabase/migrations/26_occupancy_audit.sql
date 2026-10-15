-- module: audit
-- also: core, integrations, payments
-- 26 · Occupancy audit: people the cameras saw and doors the locks opened, checked against check-ins,
--      check-outs and payments, so nobody stays without being processed and paying.
--
--  Inputs, per room and per day (in the property's own time zone):
--    Cameras   person sightings from the on-site relay (one row per person passing, not per second), placed by
--              camera zone: a room door, the entrance, reception, a corridor, an outlet
--    Locks     door openings from TTLock, split into staff (listed codes and cards) and everyone else
--    PMS       stays with their actual check-in and check-out times, folios and payments
--  Findings, kept until a manager clears them with a reason:
--    used_while_vacant      a person or a guest code in a room with no stay                         high
--    not_checked_in         activity in a room whose booking is still not checked in                high
--    before_check_in        activity well before the guest was checked in                           medium
--    after_check_out        activity well after the guest was checked out                           medium
--    unknown_code           a passcode opened a room that the PMS never issued for it               high
--    checked_out_unpaid     checked out with money still owed (not moved to a company account)     high
--    in_house_unpaid        in house past the first night with nothing paid at all                  medium
--    occupied_no_activity   checked in, yet no door or camera activity all day                      low
--  Staff are recognised by their door codes; a person on a room camera shortly after a staff opening is
--  treated as staff. Time allowances live in settings → audit and can be changed per property.
-- Safe to re-run.

-- ---------------------------------------------------------------------
-- Camera zones: what each camera channel watches
-- ---------------------------------------------------------------------
create table if not exists pms_camera_zones (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  device       text not null default '',                 -- camera MAC address, only when two devices share channel numbers
  channel      text not null check (channel ~ '^[0-9A-Za-z_-]{1,20}$'),
  name         text not null check (length(trim(name)) between 1 and 60),
  kind         text not null default 'room' check (kind in ('room','entrance','reception','corridor','outlet','parking','other')),
  room_id      uuid references pms_rooms(id) on delete cascade,
  active       boolean not null default true,
  check ((kind = 'room') = (room_id is not null)),
  unique (property_id, device, channel)
);
create index if not exists ix_pms_camera_zones_room_id on pms_camera_zones (room_id);

create or replace function pms_trg_camera_zone_tidy() returns trigger
language plpgsql set search_path = public as $$
begin
  new.device := lower(coalesce(trim(new.device), ''));
  new.channel := trim(new.channel);
  if new.kind <> 'room' then new.room_id := null; end if;
  return new;
end $$;
drop trigger if exists trg_camera_zone_tidy on pms_camera_zones;
create trigger trg_camera_zone_tidy before insert or update on pms_camera_zones for each row execute function pms_trg_camera_zone_tidy();

-- Room mappings made before zones existed become room zones
insert into pms_camera_zones(property_id, device, channel, name, kind, room_id)
select x.property_id,
       case when x.external_id ~ ':[^:]+$' and x.external_id like '%:%:%' then regexp_replace(x.external_id, ':[^:]+$', '') else '' end,
       regexp_replace(x.external_id, '^.*:', ''), 'Room ' || r.number, 'room', x.entity_id
from pms_external_ids x join pms_rooms r on r.id = x.entity_id
where x.provider = 'hikvision' and x.entity = 'room' and regexp_replace(x.external_id, '^.*:', '') ~ '^[0-9A-Za-z_-]{1,20}$'
on conflict (property_id, device, channel) do nothing;

-- Sightings: zone, person or not, how long
alter table pms_camera_events add column if not exists zone_id uuid references pms_camera_zones(id) on delete set null;
alter table pms_camera_events add column if not exists target text;
alter table pms_camera_events add column if not exists ended_at timestamptz;
alter table pms_camera_events add column if not exists hits integer;
alter table pms_camera_events add column if not exists person boolean not null default true;
create index if not exists ix_pms_camera_events_zone_id on pms_camera_events (zone_id);
create index if not exists ix_pms_camera_events_day on pms_camera_events (property_id, event_time) where person;

create or replace function pms__camera_zone(p_property uuid, p_device text, p_channel text) returns pms_camera_zones
language sql stable security definer set search_path = public as $$
  select * from pms_camera_zones z where z.property_id = p_property and z.active and z.channel = p_channel
    and z.device in (coalesce(p_device, ''), '') order by (z.device <> '') desc limit 1
$$;

create or replace function pms_svc_ingest_camera_events(p_property uuid, p_events jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform pms__require_service();
  with src as (
    select e, pms__camera_zone(p_property, lower(coalesce(e->>'device', '')), e->>'channel') as z
    from jsonb_array_elements(p_events) e where e ? 'channel' and e ? 'time'),
  ins as (
    insert into pms_camera_events(property_id, device, channel, zone_id, room_id, event_type, event_time, ended_at, target, hits, person, raw)
    select p_property, coalesce(e->>'device', ''), e->>'channel', (z).id,
      coalesce((z).room_id, (select x.entity_id from pms_external_ids x where x.property_id = p_property and x.provider = 'hikvision' and x.entity = 'room'
         and x.external_id in (e->>'channel', coalesce(e->>'device', '') || ':' || (e->>'channel')) limit 1)),
      coalesce(e->>'event_type', 'motion'), (e->>'time')::timestamptz, nullif(e->>'ended', '')::timestamptz,
      nullif(lower(e->>'target'), ''), nullif(e->>'hits', '')::int,
      coalesce(lower(e->>'target'), 'human') = 'human', e
    from src
    on conflict (property_id, device, channel, event_type, event_time) do nothing
    returning 1)
  select count(*) into v_n from ins;
  return v_n;
end $$;

-- Audit texts may go out by SMS to the managers on duty
alter table pms_sms_out drop constraint if exists pms_sms_out_kind_check;
alter table pms_sms_out add constraint pms_sms_out_kind_check check (kind in ('door_code','manual','audit_alert'));

-- ---------------------------------------------------------------------
-- Findings
-- ---------------------------------------------------------------------
create table if not exists pms_audit_findings (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references pms_properties(id) on delete cascade,
  key             text not null,                          -- one finding per thing found; re-runs update it
  day             date not null,
  kind            text not null check (kind in ('used_while_vacant','not_checked_in','before_check_in','after_check_out','unknown_code',
                                                'checked_out_unpaid','in_house_unpaid','occupied_no_activity')),
  severity        text not null check (severity in ('high','medium','low')),
  room_id         uuid references pms_rooms(id) on delete set null,
  stay_id         uuid references pms_stays(id) on delete set null,
  title           text not null,
  evidence        jsonb not null default '{}'::jsonb,
  amount_at_risk  numeric(14,2) not null default 0,
  status          text not null default 'open' check (status in ('open','explained','charged','loss','false_alarm')),
  resolution      text,
  resolved_by     uuid,
  resolved_at     timestamptz,
  alerted_at      timestamptz,
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now(),
  unique (property_id, key)
);
create index if not exists ix_pms_audit_findings_day on pms_audit_findings (property_id, day);
create index if not exists ix_pms_audit_findings_open on pms_audit_findings (property_id) where status = 'open';
create index if not exists ix_pms_audit_findings_room_id on pms_audit_findings (room_id);
create index if not exists ix_pms_audit_findings_stay_id on pms_audit_findings (stay_id);

create or replace function pms__audit_cfg(p_property uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('early_minutes', 60, 'late_minutes', 60, 'staff_minutes', 30, 'unpaid_after_nights', 1, 'alert_phones', '[]'::jsonb)
    || coalesce((select settings->'audit' from pms_properties where id = p_property), '{}'::jsonb)
$$;

-- Money on a stay's folios (and its reservation's shared folios): charges, payments, what is still owed
create or replace function pms__stay_money(p_stay uuid) returns table(charges numeric, paid numeric, balance numeric, company boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(l.amount) filter (where l.line_type = 'charge'), 0),
         coalesce(-sum(l.amount) filter (where l.line_type in ('payment','refund')), 0),
         coalesce(sum(l.amount), 0),
         bool_or(f.company_id is not null) or exists (select 1 from pms_stays s join pms_reservations r on r.id = s.reservation_id where s.id = p_stay and r.company_id is not null)
  from pms_stays s join pms_folios f on f.stay_id = s.id or (f.stay_id is null and f.reservation_id = s.reservation_id)
  left join pms_folio_lines l on l.folio_id = f.id and not l.voided
  where s.id = p_stay
$$;

-- Was a staff code or card used on this room just before (or right at) this moment?
create or replace function pms__staff_near(p_property uuid, p_room uuid, p_at timestamptz, p_staff text[], p_window interval) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pms_door_events d where d.property_id = p_property and d.room_id = p_room and d.success and coalesce(d.is_open, true)
                 and coalesce(d.username, '') = any(p_staff) and p_at between d.event_time - interval '5 minutes' and d.event_time + p_window)
$$;

-- One day for one property. Re-runnable: findings are updated, ones that no longer hold are removed while open,
-- and anything a manager has already cleared stays as they left it.
create or replace function pms__audit_day(p_property uuid, p_day date) returns integer
language plpgsql security definer set search_path = public as $$
declare
  p pms_properties; cfg jsonb; v_from timestamptz; v_to timestamptz; v_staff text[];
  v_early interval; v_late interval; v_staffwin interval; v_keys text[] := '{}'; v_n int := 0; f record; v_new boolean; v_phone text;
begin
  select * into p from pms_properties where id = p_property;
  if p.id is null or not pms__addon_on(p_property, 'revenue_assurance') then return 0; end if;
  cfg := pms__audit_cfg(p_property);
  v_from := p_day::timestamp at time zone p.timezone;
  v_to := (p_day + 1)::timestamp at time zone p.timezone;
  if v_from > now() then return 0; end if;
  v_early := make_interval(mins => (cfg->>'early_minutes')::int);
  v_late := make_interval(mins => (cfg->>'late_minutes')::int);
  v_staffwin := make_interval(mins => (cfg->>'staff_minutes')::int);
  select coalesce(array(select jsonb_array_elements_text(config->'staff_usernames')), '{}') into v_staff
    from pms_integrations where property_id = p_property and provider = 'ttlock';
  v_staff := coalesce(v_staff, '{}');

  for f in
    with stays as (
      select s.id, s.room_id, s.status, s.rate, s.arrival, s.departure, s.reservation_id,
        coalesce(s.checked_in_at, (s.arrival + p.check_in_time) at time zone p.timezone) as cin,
        case when s.status = 'checked_out' then coalesce(s.checked_out_at, (s.departure + p.check_out_time) at time zone p.timezone)
             when s.status = 'checked_in' then 'infinity'::timestamptz end as cout
      from pms_stays s where s.property_id = p_property and s.room_id is not null
        and s.arrival <= p_day + 1 and s.departure >= p_day - 1 and s.status in ('checked_in','checked_out','confirmed','tentative')),
    staff_open as (
      select d.room_id, d.event_time from pms_door_events d
      where d.property_id = p_property and d.room_id is not null and d.success and coalesce(d.is_open, true)
        and coalesce(d.username, '') = any(v_staff) and d.event_time >= v_from - v_staffwin and d.event_time < v_to),
    ev as (
      select d.room_id, d.event_time as t, 'door'::text as src, d.method, nullif(d.username, '') as who,
        nullif(coalesce(d.raw->>'passcode', case when d.method = 'passcode' then d.username end), '') as code
      from pms_door_events d
      where d.property_id = p_property and d.room_id is not null and d.success and coalesce(d.is_open, true)
        and not (coalesce(d.username, '') = any(v_staff)) and d.event_time >= v_from and d.event_time < v_to
      union all
      select c.room_id, c.event_time, 'camera', c.event_type, null, null
      from pms_camera_events c
      where c.property_id = p_property and c.room_id is not null and c.person and c.event_time >= v_from and c.event_time < v_to
        and not exists (select 1 from staff_open so where so.room_id = c.room_id and c.event_time between so.event_time - interval '5 minutes' and so.event_time + v_staffwin)),
    blocked as (
      select b.room_id from pms_maintenance_blocks b where b.property_id = p_property and b.status = 'active' and p_day >= b.from_date and p_day < b.to_date),
    loose as (   -- activity no checked-in stay explains
      select e.* from ev e
      where e.room_id not in (select room_id from blocked)
        and not exists (select 1 from stays s where s.room_id = e.room_id and s.status in ('checked_in','checked_out')
                        and e.t between s.cin - v_early and s.cout + v_late)),
    per_room as (
      select l.room_id, count(*) filter (where l.src = 'door') as doors, count(*) filter (where l.src = 'camera') as people,
        min(l.t) as first_t, max(l.t) as last_t,
        (array_agg(distinct coalesce(l.who, l.method)) filter (where l.src = 'door'))[1:5] as door_by
      from loose l group by l.room_id),
    occ as (
      select r.room_id, r.doors, r.people, r.first_t, r.last_t, r.door_by,
        (select s.id from stays s where s.room_id = r.room_id and s.status in ('confirmed','tentative') and s.arrival <= p_day and s.departure > p_day limit 1) as pending_stay,
        (select s.id from stays s where s.room_id = r.room_id and s.status in ('checked_in','checked_out') and r.first_t < s.cin - v_early
            and s.cin < v_to order by s.cin limit 1) as early_stay,
        (select s.id from stays s where s.room_id = r.room_id and s.status = 'checked_out' and r.last_t > s.cout + v_late
            and s.cout >= v_from - interval '1 day' order by s.cout desc limit 1) as late_stay
      from per_room r)
    -- occupancy findings
    select case when o.pending_stay is not null then 'not_checked_in' when o.early_stay is not null then 'before_check_in'
                when o.late_stay is not null then 'after_check_out' else 'used_while_vacant' end as kind,
      o.room_id, coalesce(o.pending_stay, o.early_stay, o.late_stay) as stay_id,
      jsonb_build_object('door_opens', o.doors, 'people_seen', o.people, 'first', o.first_t, 'last', o.last_t, 'opened_by', to_jsonb(o.door_by)) as evidence,
      null::numeric as amount
    from occ o
    union all
    -- passcodes the PMS never issued for that room
    select 'unknown_code', e.room_id, null::uuid,
      jsonb_build_object('codes', jsonb_agg(distinct e.code), 'door_opens', count(*), 'first', min(e.t), 'last', max(e.t)), null
    from ev e
    where e.src = 'door' and e.code is not null
      and not exists (select 1 from pms_stay_passcodes c where c.property_id = p_property and c.room_id = e.room_id and c.passcode = e.code
                      and e.t between c.valid_from - interval '1 day' and c.valid_to + interval '1 day')
    group by e.room_id
    union all
    -- checked in, yet nothing moved all day (only for finished days and rooms with a lock or camera)
    select 'occupied_no_activity', s.room_id, s.id, jsonb_build_object('nights', s.departure - s.arrival), null
    from stays s
    where s.status in ('checked_in','checked_out') and s.cin < v_from and s.cout > v_to and v_to < now()
      and not exists (select 1 from pms_door_events d where d.property_id = p_property and d.room_id = s.room_id and d.event_time >= v_from and d.event_time < v_to)
      and not exists (select 1 from pms_camera_events c where c.property_id = p_property and c.room_id = s.room_id and c.event_time >= v_from and c.event_time < v_to)
      and (exists (select 1 from pms_external_ids x join pms_integrations i on i.property_id = x.property_id and i.provider = x.provider and i.enabled
                   where x.property_id = p_property and x.entity = 'room' and x.entity_id = s.room_id and x.provider = 'ttlock')
           or exists (select 1 from pms_camera_zones z where z.room_id = s.room_id and z.active))
    union all
    -- money: checked out owing, or in house with nothing paid
    select 'checked_out_unpaid', s.room_id, s.id, jsonb_build_object('charges', m.charges, 'paid', m.paid, 'checked_out', s.cout), m.balance
    from stays s cross join lateral pms__stay_money(s.id) m
    where s.status = 'checked_out' and s.cout >= v_from and s.cout < v_to and m.balance > 1 and not coalesce(m.company, false)
    union all
    select 'in_house_unpaid', s.room_id, s.id, jsonb_build_object('charges', m.charges, 'paid', 0, 'nights_so_far', p_day - s.arrival + 1), m.balance
    from stays s cross join lateral pms__stay_money(s.id) m
    where s.status = 'checked_in' and s.arrival + (cfg->>'unpaid_after_nights')::int <= p_day and s.departure > p_day
      and m.paid <= 0 and m.balance > 1 and not coalesce(m.company, false)
  loop
    declare
      v_key text := case when f.kind in ('checked_out_unpaid','in_house_unpaid') then f.kind || ':' || f.stay_id
                         else f.kind || ':' || p_day || ':' || f.room_id end;
      v_sev text := case when f.kind in ('used_while_vacant','not_checked_in','unknown_code','checked_out_unpaid') then 'high'
                         when f.kind = 'occupied_no_activity' then 'low' else 'medium' end;
      v_room text := (select number from pms_rooms where id = f.room_id);
      v_amt numeric := coalesce(f.amount, case when f.kind in ('used_while_vacant','not_checked_in','before_check_in','after_check_out')
        then coalesce((select nullif(rate, 0) from pms_stays where id = f.stay_id),
                      (select t.base_rate from pms_rooms r join pms_room_types t on t.id = r.room_type_id where r.id = f.room_id), 0) else 0 end);
      v_title text := 'Room ' || coalesce(v_room, '?') || ': ' || case f.kind
        when 'used_while_vacant' then 'used while no guest was booked in'
        when 'not_checked_in' then 'in use, but the booking is not checked in'
        when 'before_check_in' then 'in use before the guest was checked in'
        when 'after_check_out' then 'in use after the guest checked out'
        when 'unknown_code' then 'opened with a code the PMS did not issue'
        when 'checked_out_unpaid' then 'checked out still owing'
        when 'in_house_unpaid' then 'in house with nothing paid'
        else 'checked in, but no activity all day' end;
    begin
      insert into pms_audit_findings(property_id, key, day, kind, severity, room_id, stay_id, title, evidence, amount_at_risk)
      values (p_property, v_key, p_day, f.kind, v_sev, f.room_id, f.stay_id, v_title, f.evidence, round(v_amt, 2))
      on conflict (property_id, key) do update set evidence = excluded.evidence, amount_at_risk = excluded.amount_at_risk, title = excluded.title,
        stay_id = excluded.stay_id, last_seen = now()
        where pms_audit_findings.status = 'open'
      returning (xmax = 0) into v_new;
      v_keys := v_keys || v_key;
      v_n := v_n + 1;
      -- a new high finding: text the managers on the list, once
      if coalesce(v_new, false) and v_sev = 'high' and pms__integration_on(p_property, 'sms') then
        for v_phone in select jsonb_array_elements_text(cfg->'alert_phones') loop
          perform pms__queue_sms(p_property, null, 'audit_alert', v_phone, left(p.name || ' audit: ' || v_title || ' (' || to_char(p_day, 'DD Mon') || '). Open BMG PMS → Occupancy audit.', 160));
        end loop;
        update pms_audit_findings set alerted_at = now() where property_id = p_property and key = v_key;
      end if;
    end;
  end loop;

  -- open findings for this day that no longer hold (the guest was checked in late, the bill was paid) are removed
  delete from pms_audit_findings a where a.property_id = p_property and a.status = 'open' and not (a.key = any(v_keys))
    and ((a.day = p_day and a.kind not in ('checked_out_unpaid','in_house_unpaid'))
      or (a.kind in ('checked_out_unpaid','in_house_unpaid') and a.day = p_day));
  -- money findings that were paid since are removed whatever day they were first seen
  delete from pms_audit_findings a where a.property_id = p_property and a.status = 'open' and a.kind in ('checked_out_unpaid','in_house_unpaid')
    and a.stay_id is not null and (select m.balance <= 1 or (a.kind = 'in_house_unpaid' and m.paid > 0) from pms__stay_money(a.stay_id) m);
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- What staff call
-- ---------------------------------------------------------------------
create or replace function pms_audit_run(p_property uuid, p_from date, p_to date) returns integer
language plpgsql security definer set search_path = public as $$
declare d date; n int := 0;
begin
  perform pms_need(p_property, 'rpt.revenue_assurance');
  perform pms__require_addon(p_property, 'revenue_assurance');
  if p_to < p_from or p_to - p_from > 62 then raise exception 'Choose up to two months at a time'; end if;
  for d in select generate_series(p_from, p_to, interval '1 day')::date loop n := n + pms__audit_day(p_property, d); end loop;
  return n;
end $$;

create or replace function pms_audit_resolve(p_finding uuid, p_status text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare a pms_audit_findings;
begin
  select * into a from pms_audit_findings where id = p_finding for update;
  if a.id is null then raise exception 'Finding not found'; end if;
  perform pms_need(a.property_id, 'rpt.audit_resolve');
  if p_status not in ('open','explained','charged','loss','false_alarm') then raise exception 'Unknown outcome'; end if;
  if p_status <> 'open' and coalesce(length(trim(p_note)), 0) < 5 then raise exception 'Say what was found (at least a few words)'; end if;
  update pms_audit_findings set status = p_status, resolution = case when p_status = 'open' then null else trim(p_note) end,
    resolved_by = case when p_status = 'open' then null else auth.uid() end, resolved_at = case when p_status = 'open' then null else now() end
  where id = p_finding;
  perform pms_log(a.property_id, 'audit.' || p_status, 'audit_finding', p_finding,
    jsonb_build_object('kind', a.kind, 'day', a.day, 'room_id', a.room_id, 'amount', a.amount_at_risk, 'note', p_note));
end $$;

create or replace function pms_audit_settings(p_property uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb := '{}'; k text;
begin
  perform pms_need(p_property, 'config.integrations');
  foreach k in array array['early_minutes','late_minutes','staff_minutes','unpaid_after_nights'] loop
    if p ? k then
      if (p->>k) !~ '^\d{1,4}$' or (p->>k)::int > 1440 then raise exception '% must be a whole number up to 1440', k; end if;
      v := v || jsonb_build_object(k, (p->>k)::int);
    end if;
  end loop;
  if p ? 'alert_phones' then
    if jsonb_typeof(p->'alert_phones') <> 'array' or jsonb_array_length(p->'alert_phones') > 5 then raise exception 'Up to five phone numbers'; end if;
    v := v || jsonb_build_object('alert_phones', p->'alert_phones');
  end if;
  update pms_properties set settings = jsonb_set(coalesce(settings, '{}'), '{audit}', coalesce(settings->'audit', '{}') || v) where id = p_property;
  return pms__audit_cfg(p_property);
end $$;

-- Everything that happened in one room on one day, in order: for checking a finding
create or replace function pms_audit_timeline(p_property uuid, p_room uuid, p_day date)
returns table(at timestamptz, source text, what text, who text, detail text)
language plpgsql stable security definer set search_path = public as $$
declare p pms_properties; v_from timestamptz; v_to timestamptz; v_staff text[];
begin
  perform pms_need(p_property, 'rpt.revenue_assurance');
  select * into p from pms_properties where id = p_property;
  if not exists (select 1 from pms_rooms where id = p_room and property_id = p_property) then raise exception 'Room not found'; end if;
  v_from := (p_day - 1)::timestamp at time zone p.timezone + interval '18 hours';    -- from 6 pm the evening before
  v_to := (p_day + 1)::timestamp at time zone p.timezone + interval '6 hours';       -- to 6 am the morning after
  select coalesce(array(select jsonb_array_elements_text(config->'staff_usernames')), '{}') into v_staff
    from pms_integrations where property_id = p_property and provider = 'ttlock';
  v_staff := coalesce(v_staff, '{}');
  return query
    select x.at, x.source, x.what, x.who, x.detail from (
      select s.checked_in_at as at, 'pms'::text as source, 'Checked in'::text as what, pms__guest_name(g) as who,
        'Res ' || r.res_no || ', ' || s.arrival || ' to ' || s.departure as detail
      from pms_stays s join pms_reservations r on r.id = s.reservation_id join pms_guests g on g.id = r.guest_id
      where s.room_id = p_room and s.checked_in_at between v_from and v_to
      union all
      select s.checked_out_at, 'pms', 'Checked out', pms__guest_name(g), 'Res ' || r.res_no
      from pms_stays s join pms_reservations r on r.id = s.reservation_id join pms_guests g on g.id = r.guest_id
      where s.room_id = p_room and s.checked_out_at between v_from and v_to
      union all
      select d.event_time, 'door', case when not d.success then 'Refused at the door' when coalesce(d.is_open, true) then 'Door opened' else 'Door event' end,
        coalesce(d.username, ''), coalesce(d.method, '') || case when coalesce(d.username, '') = any(v_staff) then ' (staff)' else '' end
      from pms_door_events d where d.property_id = p_property and d.room_id = p_room and d.event_time between v_from and v_to
      union all
      select c.event_time, 'camera', case when c.person then 'Person seen' else 'Movement' end, coalesce(z.name, 'Channel ' || c.channel),
        coalesce(c.event_type, '') || case when c.ended_at is not null then ', ' || greatest(0, round(extract(epoch from c.ended_at - c.event_time)))::int || ' s' else '' end
      from pms_camera_events c left join pms_camera_zones z on z.id = c.zone_id
      where c.property_id = p_property and c.room_id = p_room and c.event_time between v_from and v_to
    ) x where x.at is not null order by x.at;
end $$;

-- ---------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------
-- Day by day: rooms sold against rooms used, people at the entrance against guests, and what was found
create or replace function pms_rpt_audit_daily(p_property uuid, p_from date, p_to date)
returns table(day date, rooms_occupied int, rooms_with_activity int, arrivals int, guests_in_house int, entrance_people int,
              guest_door_opens int, people_in_rooms int, findings int, high int, open_findings int, amount_at_risk numeric)
language plpgsql stable security definer set search_path = public as $$
declare p pms_properties; v_staff text[]; v_win interval := make_interval(mins => (pms__audit_cfg(p_property)->>'staff_minutes')::int);
begin
  perform pms_need(p_property, 'rpt.revenue_assurance');
  if p_to < p_from or p_to - p_from > 366 then raise exception 'Choose up to a year'; end if;
  select * into p from pms_properties where id = p_property;
  select coalesce(array(select jsonb_array_elements_text(config->'staff_usernames')), '{}') into v_staff
    from pms_integrations where property_id = p_property and provider = 'ttlock';
  v_staff := coalesce(v_staff, '{}');
  return query
    with days as (select d::date as d, (d::date)::timestamp at time zone p.timezone as f, (d::date + 1)::timestamp at time zone p.timezone as t
                  from generate_series(p_from, p_to, interval '1 day') d)
    select days.d,
      (select count(*)::int from pms_stays s where s.property_id = p_property and s.status in ('checked_in','checked_out') and s.arrival <= days.d and s.departure > days.d),
      (select count(distinct x.room_id)::int from (
          select d.room_id from pms_door_events d where d.property_id = p_property and d.room_id is not null and d.success and coalesce(d.is_open, true)
            and not (coalesce(d.username, '') = any(v_staff)) and d.event_time >= days.f and d.event_time < days.t
          union all
          select c.room_id from pms_camera_events c where c.property_id = p_property and c.room_id is not null and c.person and c.event_time >= days.f and c.event_time < days.t
            and not pms__staff_near(p_property, c.room_id, c.event_time, v_staff, v_win)) x),
      (select coalesce(sum(s.adults + s.children), 0)::int from pms_stays s where s.property_id = p_property and s.status in ('checked_in','checked_out') and s.arrival = days.d),
      (select coalesce(sum(s.adults + s.children), 0)::int from pms_stays s where s.property_id = p_property and s.status in ('checked_in','checked_out') and s.arrival <= days.d and s.departure > days.d),
      (select count(*)::int from pms_camera_events c join pms_camera_zones z on z.id = c.zone_id
        where c.property_id = p_property and z.kind = 'entrance' and c.person and c.event_time >= days.f and c.event_time < days.t),
      (select count(*)::int from pms_door_events d where d.property_id = p_property and d.room_id is not null and d.success and coalesce(d.is_open, true)
        and not (coalesce(d.username, '') = any(v_staff)) and d.event_time >= days.f and d.event_time < days.t),
      (select count(*)::int from pms_camera_events c where c.property_id = p_property and c.room_id is not null and c.person and c.event_time >= days.f and c.event_time < days.t
        and not pms__staff_near(p_property, c.room_id, c.event_time, v_staff, v_win)),
      (select count(*)::int from pms_audit_findings a where a.property_id = p_property and a.day = days.d),
      (select count(*)::int from pms_audit_findings a where a.property_id = p_property and a.day = days.d and a.severity = 'high'),
      (select count(*)::int from pms_audit_findings a where a.property_id = p_property and a.day = days.d and a.status = 'open'),
      (select coalesce(sum(a.amount_at_risk), 0) from pms_audit_findings a where a.property_id = p_property and a.day = days.d and a.status in ('open','loss'))
    from days order by days.d desc;
end $$;

-- What was found over a period, by kind and outcome
create or replace function pms_rpt_audit_summary(p_property uuid, p_from date, p_to date)
returns table(kind text, severity text, found int, open int, explained int, charged int, loss int, false_alarm int, amount_open numeric, amount_lost numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_need(p_property, 'rpt.revenue_assurance');
  return query
    select a.kind, min(a.severity), count(*)::int,
      count(*) filter (where a.status = 'open')::int, count(*) filter (where a.status = 'explained')::int,
      count(*) filter (where a.status = 'charged')::int, count(*) filter (where a.status = 'loss')::int,
      count(*) filter (where a.status = 'false_alarm')::int,
      coalesce(sum(a.amount_at_risk) filter (where a.status = 'open'), 0), coalesce(sum(a.amount_at_risk) filter (where a.status = 'loss'), 0)
    from pms_audit_findings a where a.property_id = p_property and a.day between p_from and p_to
    group by a.kind order by count(*) desc;
end $$;

-- ---------------------------------------------------------------------
-- Every 30 minutes for every property that has the audit: yesterday and today
-- ---------------------------------------------------------------------
create or replace function pms__audit_run_all() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_today date;
begin
  perform pms__require_service();
  for r in select p.id, p.timezone from pms_properties p
           where coalesce(p.status, 'active') = 'active' and pms__addon_on(p.id, 'revenue_assurance')
             and (pms__integration_on(p.id, 'ttlock') or pms__integration_on(p.id, 'hikvision')) loop
    v_today := (now() at time zone r.timezone)::date;
    n := n + pms__audit_day(r.id, v_today - 1) + pms__audit_day(r.id, v_today);
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Who may read and change
-- ---------------------------------------------------------------------
alter table pms_camera_zones enable row level security;
alter table pms_audit_findings enable row level security;
drop policy if exists pms_camera_zones_read on pms_camera_zones;
drop policy if exists pms_camera_zones_write on pms_camera_zones;
drop policy if exists pms_audit_findings_read on pms_audit_findings;
create policy pms_camera_zones_read on pms_camera_zones for select using (property_id in (select pms_my_properties(null::text[])));
create policy pms_camera_zones_write on pms_camera_zones for all using (pms_has_priv(property_id, 'config.integrations')) with check (pms_has_priv(property_id, 'config.integrations'));
create policy pms_audit_findings_read on pms_audit_findings for select using (pms_has_priv(property_id, 'rpt.revenue_assurance'));
grant select, insert, update, delete on pms_camera_zones to authenticated;
grant select on pms_audit_findings to authenticated;
revoke insert, update, delete on pms_audit_findings from authenticated;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as fn from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname not like 'pms\_public\_%' loop
    execute format('revoke execute on function %s from public, anon', r.fn);
  end loop;
end $$;
revoke execute on function pms_trg_camera_zone_tidy(), pms__camera_zone(uuid, text, text), pms__staff_near(uuid, uuid, timestamptz, text[], interval), pms__audit_cfg(uuid), pms__stay_money(uuid), pms__audit_day(uuid, date),
  pms__audit_run_all(), pms_svc_ingest_camera_events(uuid, jsonb) from authenticated;
grant execute on function pms_audit_run(uuid, date, date), pms_audit_resolve(uuid, text, text), pms_audit_settings(uuid, jsonb),
  pms_audit_timeline(uuid, uuid, date), pms_rpt_audit_daily(uuid, date, date), pms_rpt_audit_summary(uuid, date, date) to authenticated;
select pms__apply_platform_rules();
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';
