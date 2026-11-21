-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (EXP-04, ADR-034 D1/D4). Human review is pending.
-- Serialize trust changes and version transitions before their row writes. Otherwise a verifier can
-- see a still-active signer while a revoker misses that verifier's uncommitted version under MVCC.
-- Interactive policy precedes skill trust; callers taking explicit row locks use this same entry first.
CREATE FUNCTION skills.lock_trust() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE organization uuid := app.current_organization_id();
BEGIN
  IF organization IS NULL THEN
    RAISE EXCEPTION 'SKILL_TRUST_TENANT_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF app.current_actor_type()='user' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('interactive_policy:'||organization::text,0));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('skill_trust:'||organization::text,0));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION skills.lock_trust() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION skills.lock_trust() TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION skills.lock_trust_statement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID NOT IN ('skills.trusted_signers'::regclass,'skills.package_versions'::regclass)
    OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'SKILL_TRUST_GUARD_TARGET_INVALID' USING ERRCODE='42501';
  END IF;
  PERFORM skills.lock_trust();
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION skills.lock_trust_statement() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trusted_signers_lock_trust BEFORE INSERT OR UPDATE ON skills.trusted_signers
FOR EACH STATEMENT EXECUTE FUNCTION skills.lock_trust_statement();
--> statement-breakpoint
CREATE TRIGGER skill_versions_lock_trust BEFORE INSERT OR UPDATE ON skills.package_versions
FOR EACH STATEMENT EXECUTE FUNCTION skills.lock_trust_statement();
