-- module: cashiering
-- also: core
-- =====================================================================
-- BMG PMS — 06 FOLIO DETAILS
-- Receipt numbers on payments, tasks linked to reservations, and a
-- per-reservation audit trail for the reservation screen.
-- =====================================================================

-- Sequential receipt number per property for every money-in / money-out line
alter table pms_properties add column if not exists next_receipt_no integer not null default 1;
alter table pms_folio_lines add column if not exists receipt_no integer;

create or replace function pms_trg_receipt_no() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.line_type in ('payment','refund') and coalesce(new.payment_method,'') <> 'city_ledger'
     and new.source <> 'system' and new.receipt_no is null then
    update pms_properties set next_receipt_no = next_receipt_no + 1
    where id = new.property_id returning next_receipt_no - 1 into new.receipt_no;
  end if;
  return new;
end $$;
drop trigger if exists trg_receipt_no on pms_folio_lines;
create trigger trg_receipt_no before insert on pms_folio_lines
  for each row execute function pms_trg_receipt_no();

-- Number existing payments once, oldest first
do $$
declare r record; n int;
begin
  for r in select l.id, l.property_id from pms_folio_lines l
           where l.receipt_no is null and l.line_type in ('payment','refund')
             and coalesce(l.payment_method,'') <> 'city_ledger' and l.source <> 'system'
           order by l.created_at loop
    update pms_properties set next_receipt_no = next_receipt_no + 1
    where id = r.property_id returning next_receipt_no - 1 into n;
    alter table pms_folio_lines disable trigger trg_lines_immutable;
    update pms_folio_lines set receipt_no = n where id = r.id;
    alter table pms_folio_lines enable trigger trg_lines_immutable;
  end loop;
end $$;

-- Tasks that belong to a reservation (late check-out, airport pickup, extra bed…)
alter table pms_work_orders add column if not exists reservation_id uuid references pms_reservations(id) on delete set null;
create index if not exists idx_pms_work_orders_res on pms_work_orders(reservation_id);

-- Everything that happened to one reservation, its rooms and its folios
drop function if exists pms_reservation_trail(uuid);   -- 15 adds the IP column
create or replace function pms_reservation_trail(p_reservation uuid)
returns table(at timestamptz, user_name text, action text, details jsonb)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid;
begin
  select property_id into v_prop from pms_reservations where id = p_reservation;
  if v_prop is null then raise exception 'Reservation not found'; end if;
  perform pms_require(v_prop);
  return query
    select a.created_at, coalesce(m.display_name, u.email::text, 'system'), a.action, a.details
    from pms_audit_log a
    left join pms_members m on m.property_id = a.property_id and m.user_id = a.user_id
    left join auth.users u on u.id = a.user_id
    where a.property_id = v_prop and (
      a.entity_id = p_reservation
      or a.entity_id in (select id from pms_stays where reservation_id = p_reservation)
      or a.entity_id in (select l.id from pms_folio_lines l join pms_folios f on f.id = l.folio_id
                         where f.reservation_id = p_reservation))
    order by a.created_at desc;
end $$;

grant execute on function pms_reservation_trail(uuid) to authenticated;
revoke execute on function pms_trg_receipt_no() from public, authenticated;
notify pgrst, 'reload schema';
