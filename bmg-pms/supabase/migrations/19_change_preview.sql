-- module: front-office
-- 19 · Look before you change: room moves and amendments show what they do to the room charges
--
-- pms_change_preview answers "what happens to the charges if I do this?" for a room move or an amendment
-- (dates, guests) without changing anything. The desk then confirms and chooses whether the nights still to
-- charge keep the current rate or take the rate the new room, dates or guest numbers would normally get.
-- Nights the night audit has already charged never change; only nights still to post are affected.
-- pms_move_room moves the guest and, if asked, sets the new rate in the same step.
-- Safe to re-run.

create or replace function pms__nights_to_post(p_stay uuid, p_arrival date, p_departure date, p_bd date) returns date[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(d::date order by d), '{}')
  from generate_series(greatest(p_arrival, p_bd), p_departure - 1, interval '1 day') d
  where not exists (select 1 from pms_folio_lines l where l.stay_id = p_stay and l.source = 'night_audit'
                    and l.category = 'room' and not l.voided and l.business_date = d::date)
$$;

create or replace function pms_change_preview(p_stay uuid, p_room uuid default null, p_arrival date default null,
  p_departure date default null, p_adults int default null, p_children int default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v pms_stays; v_bd date; v_plan uuid; v_type uuid; v_arr date; v_dep date; v_ad int; v_ch int;
  v_old date[]; v_new date[]; v_sum numeric := 0; d date; v_from text; v_from_type text; v_to text; v_to_type text; v_suggest numeric;
begin
  select * into v from pms_stays where id = p_stay;   -- read only: no row lock, so the API can run it in a read-only transaction
  if not found then raise exception 'Stay not found'; end if;
  perform pms_require(v.property_id, array['owner','manager','front_desk']);
  select business_date into v_bd from pms_properties where id = v.property_id;
  select rate_plan_id into v_plan from pms_reservations where id = v.reservation_id;
  if v_plan is null then select id into v_plan from pms_rate_plans where property_id = v.property_id and active order by name limit 1; end if;
  v_type := v.room_type_id;
  if p_room is not null then
    select room_type_id, number into v_type, v_to from pms_rooms where id = p_room and property_id = v.property_id;
    if v_type is null then raise exception 'Room not found'; end if;
  end if;
  v_arr := coalesce(p_arrival, v.arrival); v_dep := coalesce(p_departure, v.departure);
  v_ad := coalesce(p_adults, v.adults); v_ch := coalesce(p_children, v.children);
  if v_dep <= v_arr then raise exception 'Departure must be after arrival'; end if;

  v_old := pms__nights_to_post(p_stay, v.arrival, v.departure, v_bd);
  v_new := pms__nights_to_post(p_stay, v_arr, v_dep, v_bd);
  foreach d in array v_new loop
    v_sum := v_sum + coalesce(pms__rate_for(v_type, v_plan, d, v_ad, v_ch), 0);
  end loop;
  v_suggest := case when cardinality(v_new) > 0 then round(v_sum / cardinality(v_new), 2) else v.rate end;

  select r.number, t.name into v_from, v_from_type from pms_room_types t left join pms_rooms r on r.id = v.room_id where t.id = v.room_type_id;
  select name into v_to_type from pms_room_types where id = v_type;

  return jsonb_build_object(
    'status', v.status,
    'from_room', v_from, 'from_type', v_from_type, 'to_room', coalesce(v_to, v_from), 'to_type', v_to_type,
    'type_changed', v_type <> v.room_type_id,
    'nights_before', v.departure - v.arrival, 'nights_after', v_dep - v_arr,
    'to_post_before', cardinality(v_old), 'to_post_after', cardinality(v_new),
    'current_rate', v.rate, 'suggested_rate', v_suggest,
    'charges_before', v.rate * cardinality(v_old),
    'charges_keep', v.rate * cardinality(v_new),
    'charges_suggested', v_suggest * cardinality(v_new),
    'currency', (select currency from pms_properties where id = v.property_id));
end $$;

-- Move the guest; optionally set the rate for the nights still to post in the same step
create or replace function pms_move_room(p_stay uuid, p_room uuid, p_rate numeric default null, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v pms_stays;
begin
  v := pms__stay(p_stay);
  perform pms_assign_room(p_stay, p_room);   -- checks "assign and move rooms", availability and dirty-room rules
  if p_rate is not null and p_rate <> v.rate then
    perform pms_need(v.property_id, 'res.amend');
    if p_rate < 0 then raise exception 'The rate cannot be negative'; end if;
    update pms_stays set rate = p_rate where id = p_stay;
  end if;
  perform pms_log(v.property_id, 'stay.move', 'stay', p_stay, jsonb_build_object(
    'room', (select number from pms_rooms where id = p_room), 'old_rate', v.rate, 'rate', coalesce(p_rate, v.rate),
    'reason', nullif(trim(coalesce(p_reason, '')), '')));
end $$;

-- Amend with the rate the desk chose and the reason, in one step
create or replace function pms_change_stay(p_stay uuid, p_arrival date, p_departure date, p_adults int, p_children int,
  p_rate numeric default null, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v pms_stays;
begin
  v := pms__stay(p_stay);
  if p_rate is not null and p_rate <> v.rate then perform pms_need(v.property_id, 'res.amend'); end if;
  perform pms_amend_stay(p_stay, p_arrival, p_departure, p_rate, p_adults, p_children);
  if nullif(trim(coalesce(p_reason, '')), '') is not null then
    perform pms_log(v.property_id, 'stay.amend_reason', 'stay', p_stay, jsonb_build_object('reason', trim(p_reason)));
  end if;
end $$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as fn from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname not like 'pms\_public\_%' loop
    execute format('revoke execute on function %s from public, anon', r.fn);
  end loop;
end $$;
revoke execute on function pms__nights_to_post(uuid, date, date, date) from authenticated;
grant execute on function pms_change_preview(uuid, uuid, date, date, int, int), pms_move_room(uuid, uuid, numeric, text),
  pms_change_stay(uuid, date, date, int, int, numeric, text) to authenticated;
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';
