-- Admin helper used by the pricing screen to fetch a room's active base price.
-- The rest of the pricing RPCs already exist in the live database; this one was missing.

create or replace function admin_get_room_base_price(p_room_type text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_price numeric;
begin
  perform require_admin();

  if p_room_type is null or trim(p_room_type) = '' then
    raise exception 'Room type is required';
  end if;

  select rbp.base_price
    into v_base_price
  from room_base_prices rbp
  where rbp.room_type = p_room_type
    and rbp.active = true;

  return v_base_price;
end;
$$;
