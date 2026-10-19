-- =====================================================================
-- BMG PMS — integration schedules (run once, after deploying the Edge Functions)
-- Needs the pg_cron and pg_net extensions (Database → Extensions in Supabase).
-- 1. Replace the two placeholder values below, then run this whole file.
-- 2. Set the same CRON_SECRET as an Edge Function secret:  supabase secrets set CRON_SECRET=...
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'pms_project_url')
where not exists (select 1 from vault.secrets where name = 'pms_project_url');
select vault.create_secret('REPLACE-WITH-A-LONG-RANDOM-CRON-SECRET', 'pms_cron_secret')
where not exists (select 1 from vault.secrets where name = 'pms_cron_secret');

create or replace function pms_call_function(p_name text) returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'pms_project_url') || '/functions/v1/' || p_name,
    headers := jsonb_build_object('content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pms_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 55000)
$$;
revoke execute on function pms_call_function(text) from public, authenticated, anon;

select cron.schedule('pms-channex-sync', '*/2 * * * *', $$ select pms_call_function('channex-sync') $$);
select cron.schedule('pms-ttlock-sync',  '*/5 * * * *', $$ select pms_call_function('ttlock-sync') $$);
select cron.schedule('pms-fiscal-sync',  '* * * * *',   $$ select pms_call_function('fiscal-sync') $$);
select cron.schedule('pms-payments-sync', '* * * * *',   $$ select pms_call_function('payments-sync') $$);
select cron.schedule('pms-sms-sync',      '* * * * *',   $$ select pms_call_function('sms-sync') $$);
select cron.schedule('pms-email-sync',    '* * * * *',   $$ select pms_call_function('email-sync') $$);
select cron.schedule('pms-quickbooks-sync', '*/5 * * * *', $$ select pms_call_function('quickbooks-sync') $$);

-- BMG subscriptions: invoices, overdue and locks are worked out inside the database every hour, even if the
-- Edge Functions are down (payments-sync also runs it every minute and handles the phone payments)
select cron.schedule('pms-billing-run', '7 * * * *', $$ select pms__billing_run() $$);

-- Occupancy audit: camera sightings and door openings against check-ins, check-outs and payments, every 30 minutes
-- for yesterday and today, at every property with the Revenue assurance add-on and TTLock or Hikvision switched on
select cron.schedule('pms-occupancy-audit', '*/30 * * * *', $$ select pms__audit_run_all() $$);

-- Housekeeping: finished jobs after 30 days, logs after 90, raw camera events after 180
select cron.schedule('pms-cleanup', '30 3 * * *', $$
  delete from pms_jobs where status = 'done' and updated_at < now() - interval '30 days';
  delete from pms_integration_log where created_at < now() - interval '90 days';
  delete from pms_camera_events where event_time < now() - interval '180 days';
  delete from pms_guest_portal_sessions where last_seen_at < now() - interval '30 days';
$$);
