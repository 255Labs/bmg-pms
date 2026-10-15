-- module: payments
-- also: core, integrations
-- =====================================================================
-- BMG PMS 10 — mobile money requests (ClickPesa USSD push) and guest SMS (Beem).
-- Safe to re-run. Run after 09.
-- =====================================================================

alter table pms_integrations drop constraint if exists pms_integrations_provider_check;
alter table pms_integrations add constraint pms_integrations_provider_check
  check (provider in ('channex','ttlock','hikvision','fiscal','tendaico','clickpesa','sms','quickbooks'));
alter table pms_jobs drop constraint if exists pms_jobs_provider_check;
alter table pms_jobs add constraint pms_jobs_provider_check
  check (provider in ('channex','ttlock','hikvision','fiscal','clickpesa','sms','quickbooks'));
-- payments collected by a gateway are their own source: they still get receipt numbers and fiscal receipts
alter table pms_folio_lines drop constraint if exists pms_folio_lines_source_check;
alter table pms_folio_lines add constraint pms_folio_lines_source_check
  check (source in ('manual','night_audit','pos','system','gateway'));

-- Tanzanian numbers in the form ClickPesa and Beem expect: 255XXXXXXXXX, no plus
create or replace function pms__msisdn(p text) returns text
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d ~ '^0[67]\d{8}$' then return '255' || substr(d, 2); end if;
  if d ~ '^[67]\d{8}$' then return '255' || d; end if;
  if d ~ '^255[67]\d{8}$' then return d; end if;
  if d ~ '^\d{10,15}$' and left(d, 1) <> '0' then return d; end if;   -- other countries, already international
  return null;
end $$;

-- ---------------------------------------------------------------------
-- 1. Mobile money requests (USSD push to the guest's phone)
-- ---------------------------------------------------------------------
create table if not exists pms_payment_requests (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references pms_properties(id) on delete cascade,
  folio_id          uuid not null references pms_folios(id),
  provider          text not null default 'clickpesa' check (provider in ('clickpesa')),
  order_ref         text not null unique check (order_ref ~ '^[A-Za-z0-9]{6,40}$'),
  phone             text not null,
  amount            numeric(14,2) not null check (amount > 0),
  currency          text not null default 'TZS',
  status            text not null default 'queued' check (status in ('queued','sent','paid','failed','expired','cancelled')),
  provider_status   text,
  provider_txn      text,
  collected_amount  numeric(14,2),
  folio_line_id     uuid references pms_folio_lines(id),
  error             text,
  note              text,
  requested_by      uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  paid_at           timestamptz
);
create index if not exists idx_pms_payreq_folio on pms_payment_requests(folio_id);
create index if not exists idx_pms_payreq_open on pms_payment_requests(property_id, status, created_at);

create or replace function pms_request_mobile_payment(p_folio uuid, p_phone text, p_amount numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f pms_folios; v_phone text := pms__msisdn(p_phone); v_ref text; v_id uuid; v_cur text;
begin
  f := pms__open_folio(p_folio);
  perform pms_require(f.property_id, array['owner','manager','front_desk','accountant']);
  if not pms__integration_on(f.property_id, 'clickpesa') then raise exception 'Mobile money requests are not switched on for this property'; end if;
  if v_phone is null then raise exception 'Enter a mobile number such as 0713 000 111 or +255 713 000 111'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_amount <> round(p_amount) then raise exception 'Mobile money amounts are whole shillings'; end if;
  select currency into v_cur from pms_properties where id = f.property_id;
  if v_cur <> 'TZS' then raise exception 'Mobile money requests are only in TZS'; end if;
  if exists (select 1 from pms_payment_requests where folio_id = p_folio and status in ('queued','sent') and created_at > now() - interval '3 minutes') then
    raise exception 'A request for this folio is already waiting on the guest''s phone';
  end if;
  v_ref := 'BMG' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 17));
  insert into pms_payment_requests(property_id, folio_id, order_ref, phone, amount, requested_by)
  values (f.property_id, p_folio, v_ref, v_phone, p_amount, auth.uid()) returning id into v_id;
  perform pms__enqueue(f.property_id, 'clickpesa', 'ussd_push', jsonb_build_object('request_id', v_id));
  perform pms_log(f.property_id, 'payment.request', 'payment_request', v_id,
    jsonb_build_object('folio_no', f.folio_no, 'amount', p_amount, 'phone', v_phone, 'order_ref', v_ref));
  return jsonb_build_object('id', v_id, 'order_ref', v_ref, 'phone', v_phone);
end $$;

-- Stop waiting on a request. If the guest pays anyway, the payment still lands (see pms_svc_payment_result).
create or replace function pms_cancel_payment_request(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r pms_payment_requests;
begin
  select * into r from pms_payment_requests where id = p_request;
  if not found then raise exception 'Request not found'; end if;
  perform pms_require(r.property_id, array['owner','manager','front_desk','accountant']);
  if r.status not in ('queued','sent') then raise exception 'This request is already %', r.status; end if;
  update pms_payment_requests set status = 'cancelled', updated_at = now() where id = p_request;
  perform pms_log(r.property_id, 'payment.request_cancel', 'payment_request', p_request, jsonb_build_object('order_ref', r.order_ref));
end $$;

create or replace function pms_svc_payment_request(p_request uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when pms__is_service() then to_jsonb(r) end from pms_payment_requests r where r.id = p_request
$$;

create or replace function pms_svc_payment_sent(p_request uuid, p_ok boolean, p_provider_status text, p_txn text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  update pms_payment_requests
     set status = case when status in ('queued','sent') then (case when p_ok then 'sent' else 'failed' end) else status end,
         provider_status = coalesce(p_provider_status, provider_status), provider_txn = coalesce(p_txn, provider_txn),
         error = case when p_ok then null else p_error end, updated_at = now()
   where id = p_request;
end $$;

-- The one place a gateway payment becomes money on a folio. Called with the status ClickPesa reports
-- when asked directly (never with a webhook's own claim). Safe to call any number of times.
create or replace function pms_svc_payment_result(p_order_ref text, p_status text, p_collected numeric, p_txn text, p_raw jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r pms_payment_requests; f pms_folios; v_bd date; v_line uuid; v_amt numeric; v_note text;
begin
  perform pms__require_service();
  select * into r from pms_payment_requests where order_ref = p_order_ref for update;
  if not found then return jsonb_build_object('result', 'unknown_order'); end if;
  if r.status = 'paid' then return jsonb_build_object('result', 'already_paid', 'folio_line_id', r.folio_line_id); end if;

  if upper(p_status) in ('SUCCESS','SETTLED') then
    v_amt := round(coalesce(p_collected, r.amount), 2);
    if v_amt <= 0 then raise exception 'Collected amount is zero for %', p_order_ref; end if;
    select * into f from pms_folios where id = r.folio_id;
    select business_date into v_bd from pms_properties where id = r.property_id;
    if v_amt <> r.amount then v_note := 'Collected ' || v_amt || ' of ' || r.amount || ' requested'; end if;
    if f.status <> 'open' then v_note := concat_ws('; ', v_note, 'Folio was already closed: check the balance'); end if;
    -- posted directly so it lands even if the folio closed meanwhile; money received is never refused
    insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount, payment_method,
                                reference, business_date, source, posted_by)
    values (r.property_id, r.folio_id, f.stay_id, 'payment', 'payment', 'Mobile money via ClickPesa', -v_amt, 'mobile_money',
            coalesce(p_txn, r.order_ref), v_bd, 'gateway', r.requested_by)
    returning id into v_line;
    update pms_payment_requests set status = 'paid', provider_status = upper(p_status), provider_txn = coalesce(p_txn, provider_txn),
           collected_amount = v_amt, folio_line_id = v_line, paid_at = now(), note = v_note, error = null, updated_at = now()
     where id = r.id;
    perform pms_log(r.property_id, 'payment.mobile_money', 'folio_line', v_line,
      jsonb_build_object('order_ref', r.order_ref, 'amount', v_amt, 'txn', p_txn, 'note', v_note));
    return jsonb_build_object('result', 'paid', 'folio_line_id', v_line, 'amount', v_amt, 'note', v_note);
  elsif upper(p_status) = 'FAILED' then
    update pms_payment_requests set status = case when status = 'cancelled' then status else 'failed' end,
           provider_status = 'FAILED', error = coalesce(p_raw->>'message', 'The guest did not approve, or the payment failed'), updated_at = now()
     where id = r.id;
    return jsonb_build_object('result', 'failed');
  else
    update pms_payment_requests set provider_status = upper(p_status), updated_at = now() where id = r.id;
    return jsonb_build_object('result', 'waiting', 'status', upper(p_status));
  end if;
end $$;

-- Requests to ask ClickPesa about: sent in the last day, not settled. Anything older than 30 minutes stops being polled.
create or replace function pms_svc_open_payment_requests() returns table(property_id uuid, order_ref text, age_minutes int)
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  update pms_payment_requests set status = 'expired', error = 'No answer from the guest''s phone within 30 minutes', updated_at = now()
   where status = 'sent' and created_at < now() - interval '30 minutes';
  return query select r.property_id, r.order_ref, (extract(epoch from now() - r.created_at) / 60)::int
    from pms_payment_requests r where r.status = 'sent' and r.created_at > now() - interval '30 minutes' order by r.created_at;
end $$;

create or replace function pms_svc_payment_property(p_order_ref text) returns uuid
language sql stable security definer set search_path = public as $$
  select case when pms__is_service() then property_id end from pms_payment_requests where order_ref = p_order_ref
$$;

-- ---------------------------------------------------------------------
-- 2. Outgoing SMS (door codes, and anything staff send by hand)
-- ---------------------------------------------------------------------
create table if not exists pms_sms_out (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  stay_id       uuid references pms_stays(id) on delete set null,
  kind          text not null default 'manual' check (kind in ('door_code','manual')),
  to_phone      text not null,
  body          text not null check (length(body) between 1 and 640),
  status        text not null default 'queued' check (status in ('queued','sent','failed')),
  provider_ref  text,
  error         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create index if not exists idx_pms_sms_stay on pms_sms_out(stay_id);

create or replace function pms__queue_sms(p_property uuid, p_stay uuid, p_kind text, p_phone text, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_phone text := pms__msisdn(p_phone);
begin
  if v_phone is null then return null; end if;
  insert into pms_sms_out(property_id, stay_id, kind, to_phone, body, created_by) values (p_property, p_stay, p_kind, v_phone, left(p_body, 640), auth.uid())
  returning id into v_id;
  perform pms__enqueue(p_property, 'sms', 'send_sms', jsonb_build_object('sms_id', v_id));
  return v_id;
end $$;

-- Text for a door-code SMS, from the property's template (Integrations → SMS) or the default
create or replace function pms__door_code_text(p_code pms_stay_passcodes) returns text
language plpgsql stable security definer set search_path = public as $$
declare t text; v_guest text; v_room text; v_prop text; v_dep date; v_tz text;
begin
  select coalesce(nullif(config->>'door_code_template', ''),
         'Karibu {guest}! Your door code for room {room} at {property} is {code}. It works until {until}.')
    into t from pms_integrations where property_id = p_code.property_id and provider = 'sms';
  select g.first_name, r.number, p.name, s.departure, p.timezone into v_guest, v_room, v_prop, v_dep, v_tz
    from pms_stays s join pms_reservations rs on rs.id = s.reservation_id join pms_guests g on g.id = rs.guest_id
    join pms_rooms r on r.id = p_code.room_id join pms_properties p on p.id = s.property_id where s.id = p_code.stay_id;
  return replace(replace(replace(replace(replace(coalesce(t, ''), '{guest}', coalesce(v_guest, 'guest')), '{room}', coalesce(v_room, '')),
         '{property}', coalesce(v_prop, '')), '{code}', p_code.passcode),
         '{until}', to_char(p_code.valid_to at time zone coalesce(v_tz, 'Africa/Dar_es_Salaam'), 'FMDD Mon HH24:MI'));
end $$;

-- When a door code is issued, text it to the guest if SMS is on and door-code texts are not switched off
create or replace function pms_trg_door_code_sms() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_phone text; v_cfg jsonb;
begin
  if new.status <> 'issued' or (tg_op = 'UPDATE' and old.status = 'issued') then return null; end if;
  select config into v_cfg from pms_integrations where property_id = new.property_id and provider = 'sms' and enabled;
  if v_cfg is null or coalesce((v_cfg->>'send_door_codes')::boolean, true) = false then return null; end if;
  select g.phone into v_phone from pms_stays s join pms_reservations rs on rs.id = s.reservation_id join pms_guests g on g.id = rs.guest_id where s.id = new.stay_id;
  perform pms__queue_sms(new.property_id, new.stay_id, 'door_code', v_phone, pms__door_code_text(new));
  return null;
end $$;
drop trigger if exists trg_door_code_sms on pms_stay_passcodes;
create trigger trg_door_code_sms after insert or update of status on pms_stay_passcodes for each row execute function pms_trg_door_code_sms();

-- Front desk: send (or re-send) the door code, or any short message, to an in-house guest
create or replace function pms_send_door_code_sms(p_stay uuid, p_phone text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare s pms_stays; c pms_stay_passcodes; v_phone text; v_id uuid;
begin
  s := pms__stay(p_stay);
  perform pms_require(s.property_id, array['owner','manager','front_desk']);
  if not pms__integration_on(s.property_id, 'sms') then raise exception 'SMS is not switched on for this property'; end if;
  select * into c from pms_stay_passcodes where stay_id = p_stay and status = 'issued' order by created_at desc limit 1;
  if not found then raise exception 'This stay has no active door code yet'; end if;
  select coalesce(p_phone, g.phone) into v_phone from pms_reservations rs join pms_guests g on g.id = rs.guest_id where rs.id = s.reservation_id;
  v_id := pms__queue_sms(s.property_id, p_stay, 'door_code', v_phone, pms__door_code_text(c));
  if v_id is null then raise exception 'Add a valid mobile number for the guest first'; end if;
  perform pms_log(s.property_id, 'sms.door_code', 'stay', p_stay, jsonb_build_object('to', pms__msisdn(v_phone)));
  return v_id;
end $$;

create or replace function pms_send_sms(p_property uuid, p_phone text, p_body text, p_stay uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform pms_require(p_property, array['owner','manager','front_desk']);
  if not pms__integration_on(p_property, 'sms') then raise exception 'SMS is not switched on for this property'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Write a message'; end if;
  v_id := pms__queue_sms(p_property, p_stay, 'manual', p_phone, trim(p_body));
  if v_id is null then raise exception 'Enter a mobile number such as 0713 000 111'; end if;
  perform pms_log(p_property, 'sms.send', 'sms', v_id, jsonb_build_object('to', pms__msisdn(p_phone)));
  return v_id;
end $$;

create or replace function pms_svc_sms(p_sms uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when pms__is_service() then to_jsonb(m) end from pms_sms_out m where m.id = p_sms
$$;

create or replace function pms_svc_sms_result(p_sms uuid, p_ok boolean, p_ref text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  update pms_sms_out set status = case when p_ok then 'sent' else 'failed' end, provider_ref = coalesce(p_ref, provider_ref),
         error = case when p_ok then null else p_error end, sent_at = case when p_ok then now() else sent_at end where id = p_sms;
end $$;

-- ---------------------------------------------------------------------
-- 3. Setup helper: may this signed-in person see the provider catalogues?
-- ---------------------------------------------------------------------
create or replace function pms_can_manage_integrations(p_property uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(pms_role(p_property) in ('owner','manager'), false)
$$;

-- ---------------------------------------------------------------------
-- 4. Health now covers the two new services
-- ---------------------------------------------------------------------
create or replace function pms_integration_health(p_property uuid)
returns table(provider text, enabled boolean, status text, last_ok_at timestamptz, last_error text,
              failed_jobs int, queued_jobs int, oldest_queued_minutes int, detail text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare pr text; v_on boolean; v_ok timestamptz; v_err text; v_errat timestamptz; v_failed int; v_queued int; v_age int;
        v_status text; v_detail text; v_last_event timestamptz; v_stale int;
begin
  if not pms_is_member(p_property) then raise exception 'Not a member of this property'; end if;
  foreach pr in array array['channex','ttlock','hikvision','fiscal','tendaico','clickpesa','sms'] loop
    select coalesce(i.enabled, false) into v_on from pms_integrations i where i.property_id = p_property and i.provider = pr;
    v_on := coalesce(v_on, false);
    select max(created_at) into v_ok from pms_integration_log where property_id = p_property and provider = pr and ok;
    v_err := null; v_errat := null;
    select l.error, l.created_at into v_err, v_errat from pms_integration_log l
      where l.property_id = p_property and l.provider = pr and not l.ok
        and not coalesce(l.status_code between 400 and 499 and l.status_code not in (401, 403), false)
      order by l.created_at desc limit 1;
    select count(*) filter (where j.status = 'failed')::int, count(*) filter (where j.status in ('queued','running'))::int,
           coalesce(extract(epoch from now() - min(j.created_at) filter (where j.status in ('queued','running'))) / 60, 0)::int
      into v_failed, v_queued, v_age
      from pms_jobs j where j.property_id = p_property and j.provider = pr;
    v_detail := null;
    v_stale := case pr when 'channex' then 30 when 'ttlock' then 30 when 'hikvision' then 1440 else null end;

    if pr = 'hikvision' then
      select max(event_time) into v_last_event from pms_camera_events where property_id = p_property;
      v_ok := greatest(v_ok, v_last_event);
    elsif pr = 'tendaico' then
      select max(last_used_at) into v_ok from pms_api_keys where property_id = p_property and provider = 'tendaico';
      v_on := v_on or exists (select 1 from pms_api_keys where property_id = p_property and provider = 'tendaico' and revoked_at is null);
    end if;

    if not v_on then v_status := 'off';
    elsif v_failed > 0 then v_status := 'error'; v_detail := v_failed || ' task(s) failed and need a retry';
    elsif v_err is not null and (v_ok is null or v_errat > v_ok) then v_status := 'error'; v_detail := 'Last call failed: ' || left(v_err, 160);
    elsif v_age > 15 then v_status := 'warning'; v_detail := 'Tasks waiting ' || v_age || ' minutes; is the schedule running?';
    elsif v_stale is not null and (v_ok is null or v_ok < now() - make_interval(mins => v_stale)) then
      v_status := 'warning';
      v_detail := case when v_ok is null then 'No successful contact yet'
                       else 'No successful contact for ' || (extract(epoch from now() - v_ok) / 60)::int || ' minutes' end;
    else v_status := 'ok';
    end if;

    provider := pr; enabled := v_on; status := v_status; last_ok_at := v_ok;
    last_error := case when v_err is not null and (v_ok is null or v_errat > v_ok) then v_err end;
    failed_jobs := coalesce(v_failed, 0); queued_jobs := coalesce(v_queued, 0); oldest_queued_minutes := coalesce(v_age, 0); detail := v_detail;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
alter table pms_payment_requests enable row level security;
drop policy if exists pms_payment_requests_read on pms_payment_requests;
create policy pms_payment_requests_read on pms_payment_requests for select using (pms_is_member(property_id));
revoke all on pms_payment_requests from authenticated;
grant select on pms_payment_requests to authenticated;

alter table pms_sms_out enable row level security;
drop policy if exists pms_sms_out_read on pms_sms_out;
create policy pms_sms_out_read on pms_sms_out for select using (pms_is_member(property_id));
revoke all on pms_sms_out from authenticated;
grant select on pms_sms_out to authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'pms_svc_%' or p.proname like 'pms\_\_%' escape '\' or p.proname like 'pms_trg_%') loop
    execute format('revoke execute on function %s from public', f.sig);
    begin execute format('revoke execute on function %s from authenticated', f.sig); exception when undefined_object then null; end;
    begin execute format('revoke execute on function %s from anon', f.sig); exception when undefined_object then null; end;
    if f.sig::text like 'pms_svc_%' then
      begin execute format('grant execute on function %s to service_role', f.sig); exception when undefined_object then null; end;
    end if;
  end loop;
end $$;
grant execute on function pms_request_mobile_payment(uuid, text, numeric) to authenticated;
grant execute on function pms_cancel_payment_request(uuid) to authenticated;
grant execute on function pms_send_door_code_sms(uuid, text) to authenticated;
grant execute on function pms_send_sms(uuid, text, text, uuid) to authenticated;
grant execute on function pms_can_manage_integrations(uuid) to authenticated;
grant execute on function pms_integration_health(uuid) to authenticated;
grant execute on function pms_role(uuid) to authenticated;
grant execute on function pms_is_member(uuid) to authenticated;
notify pgrst, 'reload schema';
