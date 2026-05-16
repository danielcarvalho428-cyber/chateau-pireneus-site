-- Sync Airbnb iCal calendars every 4 hours to block/unblock dates
-- and prevent double bookings from external channels.
select cron.schedule(
  'airbnb-ical-sync',
  '0 */4 * * *',
  $$
  select net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/sync-airbnb-calendars',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key')
    ),
    body   := '{}'::jsonb
  ) as request_id;
  $$
);
