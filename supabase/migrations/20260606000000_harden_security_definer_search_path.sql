-- Harden SECURITY DEFINER functions against search_path hijacking.

create or replace function is_current_user_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from admins a
    where a.id = auth.uid()
       or to_jsonb(a)->>'user_id' = auth.uid()::text
  );
$$;

create or replace function increment_promo_uses(p_promo_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update promo_codes
  set uses_count = uses_count + 1
  where id = p_promo_id
    and active = true;
end;
$$;

create or replace function count_promo_use_for_paid_reservation(p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_promo_id uuid;
begin
  select promo_code_id
    into v_promo_id
  from reservations
  where id = p_reservation_id
    and promo_code_id is not null
    and promo_use_counted_at is null
    and (
      payment_status = 'paid'
      or status = 'confirmed'
      or booking_status = 'booked'
    )
  for update;

  if v_promo_id is null then
    return;
  end if;

  update promo_codes
  set uses_count = uses_count + 1
  where id = v_promo_id
    and active = true;

  update reservations
  set promo_use_counted_at = now()
  where id = p_reservation_id
    and promo_use_counted_at is null;
end;
$$;
