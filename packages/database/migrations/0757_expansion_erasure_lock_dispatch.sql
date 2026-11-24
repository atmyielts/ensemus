-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Preserve the tenant erasure lock for the eraser. Ordinary participants use the existing
-- tenant policy and consent triggers. SQL may reorder predicates in a single IF expression,
-- so branch before resolving the eraser-only operation.
CREATE OR REPLACE FUNCTION lifecycle.lock_expansion_erase() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF current_user <> 'ensemus_eraser' THEN
    RETURN NULL;
  END IF;
  IF lifecycle.lock_erasure_tenant() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ERASURE_NOT_OPEN' USING ERRCODE='42501';
  END IF;
  RETURN NULL;
END $$;
