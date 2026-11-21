-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Do not dereference an unassigned PL/pgSQL record on uploaded -> verifying/rejected transitions.
-- Publication still requires the package loaded by the verified/published block to be active.
CREATE OR REPLACE FUNCTION skills.check_version_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean;
  pkg record;
  signer_ok boolean;
  tested boolean;
BEGIN
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'SKILL_VERSION_STALE_WRITE' USING ERRCODE = 'ES001';
  END IF;

  -- What was learned from the bundle is written once, on the way to verified, and never again.
  IF (NEW.semver IS DISTINCT FROM OLD.semver
      OR NEW.digest IS DISTINCT FROM OLD.digest
      OR NEW.manifest IS DISTINCT FROM OLD.manifest
      OR NEW.execution_kind IS DISTINCT FROM OLD.execution_kind
      OR NEW.license IS DISTINCT FROM OLD.license
      OR NEW.max_classification IS DISTINCT FROM OLD.max_classification
      OR NEW.signer_key_id IS DISTINCT FROM OLD.signer_key_id
      OR NEW.signature IS DISTINCT FROM OLD.signature)
     AND NOT (OLD.state = 'verifying' AND NEW.state = 'verified') THEN
    RAISE EXCEPTION 'SKILL_VERSION_IMMUTABLE' USING ERRCODE = 'ES002';
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.state
    WHEN 'uploaded' THEN NEW.state IN ('verifying', 'rejected')
    WHEN 'verifying' THEN NEW.state IN ('verified', 'rejected')
    WHEN 'verified' THEN NEW.state IN ('published', 'yanked')
    WHEN 'published' THEN NEW.state IN ('yanked')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'SKILL_VERSION_INVALID_TRANSITION' USING ERRCODE = 'ES001';
  END IF;

  IF NEW.state IN ('verified', 'published') THEN
    SELECT p.state, p.origin, p.listing_id INTO pkg
      FROM skills.packages p
     WHERE p.organization_id = NEW.organization_id AND p.id = NEW.package_id;

    -- Signed by a key this tenant trusts, or attested through a listing it can still see.
    IF pkg.origin = 'tenant' THEN
      SELECT EXISTS (
        SELECT 1 FROM skills.trusted_signers s
         WHERE s.organization_id = NEW.organization_id
           AND s.key_id = NEW.signer_key_id
           AND s.state = 'active'
      ) INTO signer_ok;
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM marketplace.listings l
         WHERE l.id = pkg.listing_id
           AND l.digest = NEW.digest
           AND l.signer_key_id = NEW.signer_key_id
           AND l.signature = NEW.signature
           AND coalesce(l.delist_mode, 'none') <> 'revoke'
      ) INTO signer_ok;
    END IF;
    IF NOT signer_ok THEN
      RAISE EXCEPTION 'SKILL_VERSION_SIGNER_NOT_TRUSTED' USING ERRCODE = 'ES003';
    END IF;

    -- Tested, on exactly these bytes, in the way this kind of package has to be.
    SELECT EXISTS (
      SELECT 1 FROM skills.test_runs r
       WHERE r.organization_id = NEW.organization_id
         AND r.skill_version_id = NEW.id
         AND r.digest = NEW.digest
         AND r.outcome = 'passed'
         AND r.mode = CASE NEW.execution_kind WHEN 'sandbox' THEN 'sandbox' ELSE 'contract' END
    ) INTO tested;
    IF NOT tested THEN
      RAISE EXCEPTION 'SKILL_VERSION_NOT_TESTED' USING ERRCODE = 'ES003';
    END IF;
  END IF;

  IF NEW.state = 'published' THEN
    IF pkg.state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'SKILL_PACKAGE_NOT_ACTIVE' USING ERRCODE = 'ES003';
    END IF;
  END IF;

  RETURN NEW;
END $$;
