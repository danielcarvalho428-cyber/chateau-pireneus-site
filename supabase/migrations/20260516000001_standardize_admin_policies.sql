-- Shared admin check for RLS policies and browser-side routing.
CREATE OR REPLACE FUNCTION is_current_user_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM admins a
    WHERE a.id = auth.uid()
       OR to_jsonb(a)->>'user_id' = auth.uid()::text
  );
$$;

DROP POLICY IF EXISTS "Admins full access to notas_fiscais" ON notas_fiscais;
CREATE POLICY "Admins full access to notas_fiscais" ON notas_fiscais
  FOR ALL
  TO authenticated
  USING (is_current_user_admin())
  WITH CHECK (is_current_user_admin());

DROP POLICY IF EXISTS "admins_all_promo_codes" ON promo_codes;
CREATE POLICY "admins_all_promo_codes" ON promo_codes
  FOR ALL
  TO authenticated
  USING (is_current_user_admin())
  WITH CHECK (is_current_user_admin());
