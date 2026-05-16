-- Count promo-code usage only after a reservation is paid, and only once.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS promo_use_counted_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION count_promo_use_for_paid_reservation(p_reservation_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_promo_id UUID;
BEGIN
  SELECT promo_code_id
    INTO v_promo_id
  FROM reservations
  WHERE id = p_reservation_id
    AND promo_code_id IS NOT NULL
    AND promo_use_counted_at IS NULL
    AND (
      payment_status = 'paid'
      OR status = 'confirmed'
      OR booking_status = 'booked'
    )
  FOR UPDATE;

  IF v_promo_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE promo_codes
  SET uses_count = uses_count + 1
  WHERE id = v_promo_id
    AND active = true;

  UPDATE reservations
  SET promo_use_counted_at = NOW()
  WHERE id = p_reservation_id
    AND promo_use_counted_at IS NULL;
END;
$$;
