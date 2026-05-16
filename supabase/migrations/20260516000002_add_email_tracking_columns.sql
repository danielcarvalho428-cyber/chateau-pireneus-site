-- Track abandoned-booking reminder and post-stay review emails
-- so each is sent exactly once per reservation.
alter table reservations
  add column if not exists abandoned_email_sent_at timestamptz,
  add column if not exists review_email_sent_at    timestamptz;

-- Track cancellation details for refund enforcement.
alter table reservations
  add column if not exists cancelled_at     timestamptz,
  add column if not exists refund_rule      text,
  add column if not exists refund_amount    numeric(10,2),
  add column if not exists stripe_refund_id text;

-- Track optional add-ons selected at checkout.
alter table reservations
  add column if not exists addons        jsonb    default '[]',
  add column if not exists addons_amount numeric(10,2) default 0;
