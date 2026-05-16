-- Fill missing availability rows so the booking calendar and hold RPC agree.
-- Missing rows cannot be held by create_booking_and_hold_dates, so they should
-- either exist as open dates or be shown as unavailable by the frontend.

insert into room_availability (room_id, date, status, source, source_updated_at)
select
  r.id,
  d.date,
  'open',
  'manual',
  now()
from rooms r
cross join generate_series(
  current_date,
  (current_date + interval '365 days')::date,
  interval '1 day'
) as d(date)
left join room_availability ra
  on ra.room_id = r.id
 and ra.date = d.date
where r.active = true
  and ra.date is null
on conflict (room_id, date) do nothing;
