-- module: night-audit
-- =====================================================================
-- BMG PMS — 04 NIGHT AUDIT
-- Closes the business day: checks pending arrivals/departures, posts
-- room (and tax) charges for every in-house stay, marks occupied rooms
-- dirty, stores the day's statistics and rolls the business date.
-- =====================================================================

create or replace function pms_night_audit_check(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_bd date;
begin
  perform pms_require(p_property);
  select business_date into v_bd from pms_properties where id = p_property;
  return jsonb_build_object(
    'business_date', v_bd,
    'pending_arrivals', coalesce((
      select jsonb_agg(jsonb_build_object('stay_id', s.id, 'res_no', r.res_no,
        'guest', trim(coalesce(g.title||' ','') || g.first_name || ' ' || coalesce(g.last_name,'')),
        'room', rm.number, 'arrival', s.arrival) order by r.res_no)
      from pms_stays s join pms_reservations r on r.id = s.reservation_id
      join pms_guests g on g.id = r.guest_id left join pms_rooms rm on rm.id = s.room_id
      where s.property_id = p_property and s.status in ('confirmed','tentative') and s.arrival <= v_bd), '[]'::jsonb),
    'pending_departures', coalesce((
      select jsonb_agg(jsonb_build_object('stay_id', s.id, 'res_no', r.res_no,
        'guest', trim(coalesce(g.title||' ','') || g.first_name || ' ' || coalesce(g.last_name,'')),
        'room', rm.number, 'departure', s.departure) order by r.res_no)
      from pms_stays s join pms_reservations r on r.id = s.reservation_id
      join pms_guests g on g.id = r.guest_id left join pms_rooms rm on rm.id = s.room_id
      where s.property_id = p_property and s.status = 'checked_in' and s.departure <= v_bd), '[]'::jsonb),
    'in_house', (select count(*) from pms_stays where property_id = p_property and status = 'checked_in'),
    'open_drawers', (select count(*) from pms_drawer_sessions where property_id = p_property and status = 'open')
  );
end $$;

create or replace function pms_run_night_audit(p_property uuid, p_mark_no_shows boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p pms_properties; v_bd date; v_no_shows int := 0; rec record; v_folio uuid; v_tax numeric;
  v_avail int; v_sold int; v_room_rev numeric; v_tax_rev numeric; v_other numeric; v_pay numeric;
  v_n int; v_summary jsonb;
begin
  perform pms_require(p_property, array['owner','manager','front_desk']);
  select * into p from pms_properties where id = p_property for update;
  v_bd := p.business_date;

  -- 1. Departures must be handled by a person
  select count(*) into v_n from pms_stays
  where property_id = p_property and status = 'checked_in' and departure <= v_bd;
  if v_n > 0 then
    raise exception '% guest(s) due out are still checked in. Check them out or extend their stay first.', v_n;
  end if;

  -- 2. Arrivals that never came
  select count(*) into v_n from pms_stays
  where property_id = p_property and status in ('confirmed','tentative') and arrival <= v_bd;
  if v_n > 0 and not p_mark_no_shows then
    raise exception '% arrival(s) not checked in. Check them in, cancel them, or run the audit with "mark as no-show".', v_n;
  end if;
  for rec in select id, reservation_id from pms_stays
           where property_id = p_property and status in ('confirmed','tentative') and arrival <= v_bd loop
    update pms_stays set status = 'no_show' where id = rec.id;
    perform pms__refresh_reservation(rec.reservation_id);
    v_no_shows := v_no_shows + 1;
  end loop;

  -- 3. Room charges for tonight
  for rec in
    select st.id, st.rate, st.reservation_id, rm.number, rt.name as type_name
    from pms_stays st join pms_rooms rm on rm.id = st.room_id join pms_room_types rt on rt.id = st.room_type_id
    where st.property_id = p_property and st.status = 'checked_in'
      and st.arrival <= v_bd and st.departure > v_bd
  loop
    select id into v_folio from pms_folios where stay_id = rec.id and status = 'open' order by folio_no limit 1;
    if v_folio is null then
      insert into pms_folios(property_id, folio_no, reservation_id, stay_id, guest_id)
      select p_property, pms__next_folio_no(p_property), rec.reservation_id, rec.id, r.guest_id
      from pms_reservations r where r.id = rec.reservation_id
      returning id into v_folio;
    end if;

    insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount,
                                business_date, posted_by, source)
    values (p_property, v_folio, rec.id, 'charge', 'room',
            'Room ' || rec.number || ' — ' || rec.type_name || ' — ' || to_char(v_bd, 'DD Mon YYYY'),
            rec.rate, v_bd, auth.uid(), 'night_audit')
    on conflict (stay_id, business_date, category) where source = 'night_audit' and not voided do nothing;

    if not p.tax_inclusive and p.tax_rate > 0 and rec.rate > 0 then
      v_tax := round(rec.rate * p.tax_rate / 100, 2);
      insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount,
                                  business_date, posted_by, source)
      values (p_property, v_folio, rec.id, 'charge', 'tax',
              'VAT ' || p.tax_rate || '% on room ' || rec.number, v_tax, v_bd, auth.uid(), 'night_audit')
      on conflict (stay_id, business_date, category) where source = 'night_audit' and not voided do nothing;
    end if;
  end loop;

  -- 4. Occupied rooms need servicing tomorrow
  update pms_rooms r set hk_status = 'dirty'
  where r.property_id = p_property and r.hk_status in ('clean','inspected')
    and exists (select 1 from pms_stays s where s.room_id = r.id and s.status = 'checked_in');

  -- 5. Statistics
  select count(*) into v_avail from pms_rooms r where r.property_id = p_property and r.active
    and not exists (select 1 from pms_maintenance_blocks b where b.room_id = r.id and b.status = 'active'
                    and v_bd >= b.from_date and v_bd < b.to_date);
  select count(*) into v_sold from pms_stays where property_id = p_property
    and status in ('checked_in','checked_out') and arrival <= v_bd and departure > v_bd;
  select coalesce(sum(amount) filter (where category = 'room'), 0),
         coalesce(sum(amount) filter (where category = 'tax'), 0),
         coalesce(sum(amount) filter (where line_type in ('charge','discount') and category not in ('room','tax')), 0),
         coalesce(-sum(amount) filter (where line_type in ('payment','refund') and payment_method <> 'city_ledger'), 0)
    into v_room_rev, v_tax_rev, v_other, v_pay
  from pms_folio_lines where property_id = p_property and business_date = v_bd and not voided;

  v_summary := jsonb_build_object(
    'adr', case when v_sold > 0 then round(v_room_rev / v_sold, 2) else 0 end,
    'revpar', case when v_avail > 0 then round(v_room_rev / v_avail, 2) else 0 end,
    'expenses', (select coalesce(sum(amount),0) from pms_expense_vouchers
                 where property_id = p_property and business_date = v_bd),
    'arrivals', (select count(*) from pms_stays where property_id = p_property and arrival = v_bd
                 and status in ('checked_in','checked_out')),
    'departures', (select count(*) from pms_stays where property_id = p_property and departure = v_bd
                   and status = 'checked_out'),
    'tax_inclusive', p.tax_inclusive);

  insert into pms_night_audits(property_id, business_date, run_by, rooms_available, rooms_sold,
    occupancy_pct, room_revenue, tax_revenue, other_revenue, payments, no_shows, summary)
  values (p_property, v_bd, auth.uid(), v_avail, v_sold,
    case when v_avail > 0 then round(v_sold * 100.0 / v_avail, 2) else 0 end,
    v_room_rev, v_tax_rev, v_other, v_pay, v_no_shows, v_summary);

  update pms_properties set business_date = v_bd + 1 where id = p_property;

  perform pms_log(p_property, 'night_audit.run', 'property', p_property,
    jsonb_build_object('business_date', v_bd, 'rooms_sold', v_sold, 'room_revenue', v_room_rev, 'no_shows', v_no_shows));

  return jsonb_build_object('closed_date', v_bd, 'new_business_date', v_bd + 1,
    'rooms_sold', v_sold, 'rooms_available', v_avail, 'room_revenue', v_room_rev,
    'tax_revenue', v_tax_rev, 'other_revenue', v_other, 'payments', v_pay, 'no_shows', v_no_shows);
end $$;

grant execute on function pms_night_audit_check(uuid) to authenticated;
grant execute on function pms_run_night_audit(uuid, boolean) to authenticated;
