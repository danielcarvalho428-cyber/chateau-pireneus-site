-- Add NFS-e Nacional specific fields to notas_fiscais
ALTER TABLE notas_fiscais
  ADD COLUMN IF NOT EXISTS dps_number  INTEGER,
  ADD COLUMN IF NOT EXISTS dps_serie   TEXT    DEFAULT 'E',
  ADD COLUMN IF NOT EXISTS competencia TEXT;

-- Allow 'nacional' as a provider value (existing constraint only needs nfeio)
-- We keep both providers valid for backwards compatibility
COMMENT ON COLUMN notas_fiscais.provider    IS 'nfeio | nacional';
COMMENT ON COLUMN notas_fiscais.provider_id IS 'NFE.io invoice ID or SEFIN access key (chave de acesso)';
COMMENT ON COLUMN notas_fiscais.dps_number  IS 'Sequential DPS number used in NFS-e Nacional emission';
COMMENT ON COLUMN notas_fiscais.competencia IS 'YYYY-MM — month/year the service was rendered (check-in month)';
