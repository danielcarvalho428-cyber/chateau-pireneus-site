-- FNRH (Ficha Nacional de Registro de Hóspedes) fields on guest profiles
-- Required by Lei 11.771/2008 and Portaria MTur 41/2025
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS date_of_birth    DATE,
  ADD COLUMN IF NOT EXISTS nationality      TEXT DEFAULT 'Brasileira',
  ADD COLUMN IF NOT EXISTS address_street   TEXT,
  ADD COLUMN IF NOT EXISTS address_city     TEXT,
  ADD COLUMN IF NOT EXISTS address_state    TEXT,
  ADD COLUMN IF NOT EXISTS address_zip      TEXT,
  ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN NOT NULL DEFAULT FALSE;

-- Purpose of visit per booking (required by FNRH)
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS purpose_of_visit TEXT;

COMMENT ON COLUMN profiles.date_of_birth     IS 'FNRH: data de nascimento do hóspede';
COMMENT ON COLUMN profiles.nationality       IS 'FNRH: nacionalidade do hóspede';
COMMENT ON COLUMN profiles.address_street    IS 'FNRH: logradouro de origem do hóspede';
COMMENT ON COLUMN profiles.address_city      IS 'FNRH: cidade de origem do hóspede';
COMMENT ON COLUMN profiles.address_state     IS 'FNRH: estado de origem do hóspede (sigla)';
COMMENT ON COLUMN profiles.address_zip       IS 'FNRH: CEP de origem do hóspede';
COMMENT ON COLUMN profiles.marketing_consent IS 'LGPD: consentimento explícito para envio de comunicações de marketing';
COMMENT ON COLUMN reservations.purpose_of_visit IS 'FNRH: motivo da viagem (Turismo, Negócios, Eventos, Outros)';
