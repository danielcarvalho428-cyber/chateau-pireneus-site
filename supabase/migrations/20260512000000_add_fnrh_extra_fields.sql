-- Remaining FNRH fields missing from the initial migration
-- Required by Lei 11.771/2008 and Portaria MTur 41/2025
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS sex             TEXT,
  ADD COLUMN IF NOT EXISTS profession      TEXT,
  ADD COLUMN IF NOT EXISTS address_number  TEXT,
  ADD COLUMN IF NOT EXISTS address_country TEXT DEFAULT 'Brasil';

COMMENT ON COLUMN profiles.sex             IS 'FNRH: sexo do hóspede (Masculino/Feminino/Prefiro não informar)';
COMMENT ON COLUMN profiles.profession      IS 'FNRH: profissão do hóspede';
COMMENT ON COLUMN profiles.address_number  IS 'FNRH: número do logradouro de origem';
COMMENT ON COLUMN profiles.address_country IS 'FNRH: país de origem do hóspede';
