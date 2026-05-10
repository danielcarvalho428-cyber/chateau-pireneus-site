-- Schedule the check-in reminder email to run daily at 10:00 Brasília time (13:00 UTC)
-- Requires pg_cron extension (enabled on Supabase by default)
select cron.schedule(
  'checkin-reminder-daily',
  '0 13 * * *',
  $$
  select net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/send-checkin-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key')
    ),
    body   := '{}'::jsonb
  ) as request_id;
  $$
);
