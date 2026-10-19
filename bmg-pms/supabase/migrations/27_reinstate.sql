-- module: front-office
-- also: cashiering
-- 27 · Reinstate a no-show or a cancelled booking (the guest turned up after all, or it was marked by mistake)
--
--  The booking goes back to "confirmed" with the same guest, rate, folio and history.
--  - If the arrival day has already passed (a no-show from last night's audit), the stay now starts today:
--    the missed nights are not stayed and are not charged as room nights.
--  - If the room has been given to someone else meanwhile, the booking comes back without a room so the desk
--    can assign another one (the guest is never put into a room that is already taken).
--  - A no-show or cancellation fee already posted can be voided in the same step ("waive the fee").
--  - Only while the booking's dates are not over; after that, make a new booking.
--  Needs the ability "Reinstate a no-show or cancelled booking" (owners and managers by default).
-- Safe to re-run.

create or replace function pms_reinstate_stay(p_stay uuid, p_reason text, p_waive_fee boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v pms_stays; v_bd date; v_arrival date; v_room uuid; v_room_released boolean := false; v_voided int := 0;
begin
  v := pms__stay(p_stay);
  perform pms_need(v.property_id, 'res.reinstate');
  if v.status not in ('no_show','cancelled') then raise exception 'Only a no-show or cancelled booking can be reinstated'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Say why the booking is being reinstated'; end if;
  select business_date into v_bd from pms_properties where id = v.property_id;
  if v.departure <= v_bd then
    raise exception 'The booked dates are over (departure %). Make a new booking for the guest instead.', v.departure;
  end if;
  v_arrival := greatest(v.arrival, v_bd);
  v_room := v.room_id;

  begin
    update pms_stays set status = 'confirmed', arrival = v_arrival, checked_in_at = null, checked_out_at = null where id = p_stay;
  exception when exclusion_violation then
    -- the room was sold to someone else for these nights: bring the booking back without a room
    update pms_stays set status = 'confirmed', arrival = v_arrival, room_id = null, checked_in_at = null, checked_out_at = null where id = p_stay;
    v_room_released := true;
  end;

  if p_waive_fee then
    update pms_folio_lines set voided = true, void_reason = 'Fee waived on reinstatement: ' || trim(p_reason), voided_by = auth.uid(), voided_at = now()
    where stay_id = p_stay and sub_type in ('no_show','cancellation') and not voided;
    get diagnostics v_voided = row_count;
  end if;
  update pms_folios set status = 'open', closed_at = null where stay_id = p_stay and status = 'closed';
  perform pms__refresh_reservation(v.reservation_id);
  perform pms_log(v.property_id, 'stay.reinstate', 'stay', p_stay, jsonb_build_object('reason', trim(p_reason), 'was', v.status,
    'arrival_was', v.arrival, 'arrival', v_arrival, 'room_released', v_room_released, 'fees_voided', v_voided));
  return jsonb_build_object('arrival', v_arrival, 'arrival_moved', v_arrival <> v.arrival, 'room_released', v_room_released, 'room_id', case when v_room_released then null else v_room end,
    'fees_voided', v_voided);
end $$;

revoke execute on function pms_reinstate_stay(uuid, text, boolean) from public, anon;
grant execute on function pms_reinstate_stay(uuid, text, boolean) to authenticated;
select pms__apply_platform_rules();
notify pgrst, 'reload schema';
