-- Promo codes table
CREATE TABLE IF NOT EXISTS promo_codes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,
  description    TEXT,
  discount_type  TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
  min_nights     INT,
  min_amount     NUMERIC(10,2),
  valid_from     DATE,
  valid_until    DATE,
  max_uses       INT,
  uses_count     INT NOT NULL DEFAULT 0,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;

-- Admins: full access
CREATE POLICY "admins_all_promo_codes" ON promo_codes
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.id = auth.uid()
    )
  );

-- Public validation: anyone can read active codes (needed for client-side feedback)
-- Actual discount is enforced server-side in the edge function
CREATE POLICY "public_read_active_promo_codes" ON promo_codes
  FOR SELECT TO anon, authenticated
  USING (active = true);

-- Add discount fields to reservations
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS promo_code_id   UUID REFERENCES promo_codes(id),
  ADD COLUMN IF NOT EXISTS promo_code      TEXT,
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) DEFAULT 0;

-- Trigger to keep updated_at fresh on promo_codes
CREATE TRIGGER trg_promo_codes_updated_at
  BEFORE UPDATE ON promo_codes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Safe atomic increment used by checkoutstripe edge function
CREATE OR REPLACE FUNCTION increment_promo_uses(p_promo_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE promo_codes
  SET uses_count = uses_count + 1
  WHERE id = p_promo_id AND active = true;
END;
$$;
