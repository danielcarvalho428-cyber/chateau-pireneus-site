-- Add CPF/CNPJ to guest profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cpf_cnpj TEXT;

-- Nota fiscal emission records
CREATE TABLE IF NOT EXISTS notas_fiscais (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  UUID        NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  user_id         UUID        REFERENCES auth.users(id),
  cpf_cnpj        TEXT,
  guest_name      TEXT,
  guest_email     TEXT,
  amount_brl      NUMERIC(10,2),
  status          TEXT        NOT NULL DEFAULT 'pending',
  provider        TEXT        NOT NULL DEFAULT 'nfeio',
  provider_id     TEXT,
  pdf_url         TEXT,
  xml_url         TEXT,
  error_msg       TEXT,
  emitted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notas_fiscais_reservation_unique UNIQUE (reservation_id),
  CONSTRAINT notas_fiscais_status_check CHECK (status IN ('pending','processing','emitted','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS notas_fiscais_reservation_idx ON notas_fiscais (reservation_id);
CREATE INDEX IF NOT EXISTS notas_fiscais_status_idx       ON notas_fiscais (status);
CREATE INDEX IF NOT EXISTS notas_fiscais_user_idx         ON notas_fiscais (user_id);

ALTER TABLE notas_fiscais ENABLE ROW LEVEL SECURITY;

-- Admins can read and write all records
CREATE POLICY "Admins full access to notas_fiscais" ON notas_fiscais
  FOR ALL
  USING (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

-- Guests can read their own NF (for future dashboard display)
CREATE POLICY "Guests can view own notas_fiscais" ON notas_fiscais
  FOR SELECT
  USING (auth.uid() = user_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notas_fiscais_updated_at ON notas_fiscais;
CREATE TRIGGER notas_fiscais_updated_at
  BEFORE UPDATE ON notas_fiscais
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
