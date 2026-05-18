-- Durable FNRH delivery tracking and automatic retry support.
-- This gives the pousada an auditable record of attempts instead of relying on
-- browser-only best effort submission.

alter table reservations
  add column if not exists fnrh_status text not null default 'not_submitted',
  add column if not exists fnrh_submitted_at timestamptz,
  add column if not exists fnrh_last_attempt_at timestamptz,
  add column if not exists fnrh_attempt_count integer not null default 0,
  add column if not exists fnrh_last_error text;

alter table reservations
  drop constraint if exists reservations_fnrh_status_check;

alter table reservations
  add constraint reservations_fnrh_status_check
  check (fnrh_status in ('not_submitted', 'pending', 'submitted', 'failed'));

create table if not exists fnrh_submission_attempts (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid references reservations(id) on delete cascade,
  user_id uuid references auth.users(id),
  status text not null check (status in ('pending', 'submitted', 'failed')),
  http_status integer,
  error_msg text,
  response_body jsonb,
  attempted_at timestamptz not null default now()
);

create index if not exists fnrh_submission_attempts_reservation_idx
  on fnrh_submission_attempts (reservation_id, attempted_at desc);

create index if not exists reservations_fnrh_retry_idx
  on reservations (fnrh_status, fnrh_last_attempt_at)
  where fnrh_status in ('pending', 'failed');

alter table fnrh_submission_attempts enable row level security;

drop policy if exists "Admins view fnrh submission attempts" on fnrh_submission_attempts;
create policy "Admins view fnrh submission attempts" on fnrh_submission_attempts
  for select
  to authenticated
  using (is_current_user_admin());

drop policy if exists "Guests view own fnrh submission attempts" on fnrh_submission_attempts;
create policy "Guests view own fnrh submission attempts" on fnrh_submission_attempts
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Retry failed or stuck FNRH submissions every 30 minutes.
select cron.schedule(
  'fnrh-submission-retry',
  '*/30 * * * *',
  $$
  select net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/submit-fnrh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key')
    ),
    body   := jsonb_build_object('retry_failed', true, 'limit', 25)
  ) as request_id;
  $$
);
