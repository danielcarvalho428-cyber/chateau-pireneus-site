-- Add Airbnb iCal URL column to rooms so the sync-airbnb-calendars
-- edge function can fetch external calendar feeds per room.
alter table rooms
  add column if not exists airbnb_ical_url text;
