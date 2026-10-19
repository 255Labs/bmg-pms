-- module: front-office
-- also: core
-- 31 · Housekeeping portal: one board for the housekeeping manager to tick every room Cleaned, Not yet, or Under maintenance
--
--  - The board shows each room with what is happening in it today (guest in, due out, arriving, vacant), its cleaning
--    status, who last changed it and when, and any open maintenance. No guest names: housekeeping does not need them.
--  - "Cleaned" and "Not yet" need the ability to change cleaning status (housekeeping, desk, managers).
--    "Under maintenance" needs its own ability and a reason: the room turns out of order and a maintenance work order
--    opens for it. Taking the room out of maintenance closes that work order.
--  - Every change is kept (room status history), so the manager sees who cleaned what and when.
-- Safe to re-run.

alter table pms_rooms add column if not exists hk_updated_at timestamptz;
alter table pms_rooms add column if not exists hk_updated_by uuid;
alter table pms_work_orders add column if not exists source text;

create table if not exists pms_room_status_log (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  room_id      uuid not null references pms_rooms(id) on delete cascade,
  from_status  text,
  to_status    text not null,
  note         text,
  changed_by   uuid,
  changed_at   timestamptz not null default now()
);
create index if not exists ix_room_status_log_room on pms_room_status_log (room_id, changed_at desc);
create index if not exists ix_room_status_log_day on pms_room_status_log (property_id, changed_at desc);
alter table pms_room_status_log enable row level security;
revoke all on pms_room_status_log from anon, authenticated;
grant select on pms_room_status_log to authenticated;
drop policy if exists pms_room_status_log_read on pms_room_status_log;
create policy pms_room_status_log_read on pms_room_status_log for select using (pms_has_priv(property_id, 'hk.status'));

-- Every cleaning-status change, from any screen, is stamped and kept
create or replace function pms_trg_room_status_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.hk_status is distinct from old.hk_status then
    new.hk_updated_at := now();
    new.hk_updated_by := auth.uid();
    insert into pms_room_status_log(property_id, room_id, from_status, to_status, note, changed_by, created_by)
    values (new.property_id, new.id, old.hk_status, new.hk_status, new.hk_note, auth.uid(), auth.uid());
  end if;
  return new;
end $$;
drop trigger if exists trg_room_status_log on pms_rooms;
create trigger trg_room_status_log before update of hk_status on pms_rooms for each row execute function pms_trg_room_status_log();

-- The board
create or replace function pms_hk_board(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_bd date;
begin
  perform pms_need(p_property, 'hk.status');
  select business_date into v_bd from pms_properties where id = p_property;
  return jsonb_build_object(
    'business_date', v_bd,
    'can_maintain', pms_has_priv(p_property, 'hk.maintenance'),
    'rooms', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'number', r.number, 'floor', r.floor, 'type', t.name, 'hk_status', r.hk_status, 'hk_note', r.hk_note,
        'occupancy', case when ih.id is not null then case when ih.departure = v_bd then 'due_out' else 'occupied' end
                          when arr.id is not null then 'arriving' when b.id is not null then 'blocked' else 'vacant' end,
        'departure', ih.departure, 'block_reason', b.reason,
        'updated_at', r.hk_updated_at,
        'updated_by', (select coalesce(m.display_name, split_part(u.email, '@', 1)) from auth.users u left join pms_members m on m.user_id = u.id and m.property_id = r.property_id where u.id = r.hk_updated_by),
        'work_orders', (select count(*) from pms_work_orders w where w.room_id = r.id and w.status in ('open','in_progress')))
        order by t.sort_order, r.number), '[]')
      from pms_rooms r join pms_room_types t on t.id = r.room_type_id
      left join lateral (select s.id, s.departure from pms_stays s where s.room_id = r.id and s.status = 'checked_in' limit 1) ih on true
      left join lateral (select s.id from pms_stays s where s.room_id = r.id and s.status in ('confirmed','tentative') and s.arrival = v_bd limit 1) arr on true
      left join lateral (select b.id, b.reason from pms_maintenance_blocks b where b.room_id = r.id and b.status = 'active'
                         and v_bd >= b.from_date and v_bd < b.to_date limit 1) b on true
      where r.property_id = p_property and r.active),
    'today', (select coalesce(jsonb_agg(jsonb_build_object('room', rm.number, 'to', l.to_status, 'at', l.changed_at,
        'by', (select coalesce(m.display_name, split_part(u.email, '@', 1)) from auth.users u left join pms_members m on m.user_id = u.id and m.property_id = l.property_id where u.id = l.changed_by))
        order by l.changed_at desc), '[]')
      from (select * from pms_room_status_log where property_id = p_property and changed_at > now() - interval '24 hours' order by changed_at desc limit 40) l
      join pms_rooms rm on rm.id = l.room_id));
end $$;

-- Tick a room: cleaned, not yet, inspected, or under maintenance (with a reason)
create or replace function pms_hk_set(p_room uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r pms_rooms; v_note text := nullif(left(trim(coalesce(p_note, '')), 300), '');
begin
  select * into r from pms_rooms where id = p_room for update;
  if not found then raise exception 'Room not found'; end if;
  if p_status not in ('clean','dirty','inspected','maintenance') then raise exception 'Unknown status %', p_status; end if;
  if p_status = 'maintenance' or r.hk_status = 'out_of_order' then
    perform pms_need(r.property_id, 'hk.maintenance');
  else
    perform pms_need(r.property_id, 'hk.status');
  end if;
  if p_status = 'inspected' then perform pms_need(r.property_id, 'hk.inspect'); end if;
  if p_status = 'maintenance' then
    if v_note is null then raise exception 'Say what needs fixing'; end if;
    update pms_rooms set hk_status = 'out_of_order', hk_note = v_note where id = p_room;
    if not exists (select 1 from pms_work_orders where room_id = p_room and source = 'hk_board' and status in ('open','in_progress')) then
      insert into pms_work_orders(property_id, room_id, title, description, category, priority, status, source, created_by)
      values (r.property_id, p_room, left('Room ' || r.number || ': ' || v_note, 200), v_note, 'maintenance', 'high', 'open', 'hk_board', auth.uid());
    end if;
  else
    update pms_rooms set hk_status = p_status, hk_note = v_note where id = p_room;
    if r.hk_status = 'out_of_order' then
      update pms_work_orders set status = 'done', completed_at = now() where room_id = p_room and source = 'hk_board' and status in ('open','in_progress');
    end if;
  end if;
  perform pms_log(r.property_id, 'room.status', 'room', p_room, jsonb_build_object('from', r.hk_status, 'to', case when p_status = 'maintenance' then 'out_of_order' else p_status end, 'note', v_note, 'via', 'housekeeping board'));
end $$;

revoke execute on function pms_trg_room_status_log() from public, anon, authenticated;
revoke execute on function pms_hk_board(uuid), pms_hk_set(uuid, text, text) from public, anon;
grant execute on function pms_hk_board(uuid), pms_hk_set(uuid, text, text) to authenticated;
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;

select pms__apply_platform_rules();
notify pgrst, 'reload schema';
