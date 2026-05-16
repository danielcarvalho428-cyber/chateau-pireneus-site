-- Schedule abandoned-booking reminder every 2 hours
-- Fires at :30 past each even hour to avoid colliding with the checkin-reminder job.
select cron.schedule(
  'abandoned-booking-reminder',
  '30 */2 * * *',
  $$
  select net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/send-abandoned-booking',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key')
    ),
    body   := '{}'::jsonb
  ) as request_id;
  $$
);

-- Schedule post-stay review request daily at 14:00 Brasília (17:00 UTC)
-- Runs after the check-in reminder (13:00 UTC) to avoid simultaneous DB load.
select cron.schedule(
  'post-stay-review-request',
  '0 17 * * *',
  $$
  select net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/send-review-request',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key')
    ),
    body   := '{}'::jsonb
  ) as request_id;
  $$
);
