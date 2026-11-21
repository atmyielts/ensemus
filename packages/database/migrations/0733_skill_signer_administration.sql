-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (EXP-04, ADR-034 D2/D4). Human security approval is still pending.
-- Add signer administration to the existing policy map without replacing the newer native-session,
-- SSO or restore admission checks installed by previous migrations.
DO $$
DECLARE body text; changed text;
BEGIN
  body := pg_get_functiondef('app.interactive_privilege_allowed(text,uuid)'::regprocedure);
  changed := replace(body,
    '''member.manage'',''organization.manage'',''connection.manage''',
    '''member.manage'',''organization.manage'',''connection.manage'',''skill.manage''');
  IF changed=body OR position('''skill.manage''' in changed)=0 THEN
    RAISE EXCEPTION 'INTERACTIVE_PRIVILEGE_MAP_UNEXPECTED' USING ERRCODE='55000';
  END IF;
  EXECUTE changed;
END $$;
--> statement-breakpoint

CREATE FUNCTION skills.guard_signer_administration() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE person org.memberships%ROWTYPE;
BEGIN
  IF TG_RELID<>'skills.trusted_signers'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'SKILL_SIGNER_GUARD_TARGET_INVALID' USING ERRCODE='42501';
  END IF;
  -- An intentional native-login boundary, not a legacy application-tier comparison. Neither
  -- workers nor agents administer trust even when they forge a user-shaped transaction binding.
  IF session_user<>'ensemus_app' OR current_user<>'ensemus_app'
    OR app.current_actor_type() IS DISTINCT FROM 'user'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'SKILL_SIGNER_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('interactive_policy:'||NEW.organization_id::text,0));
  SELECT m.* INTO person FROM org.memberships m WHERE m.organization_id=NEW.organization_id
    AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active' FOR SHARE;
  IF NOT FOUND OR person.role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'SKILL_SIGNER_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF NOT app.interactive_privilege_allowed('skill.manage') THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'active' OR NEW.version<>1 OR NEW.revoked_at IS NOT NULL
      OR NEW.revoked_by_membership_id IS NOT NULL OR NEW.added_by_membership_id<>person.id THEN
      RAISE EXCEPTION 'SKILL_SIGNER_INVALID_START' USING ERRCODE='ES002';
    END IF;
    IF octet_length(NEW.public_key)<>32 OR NEW.key_id IS DISTINCT FROM encode(sha256(NEW.public_key),'hex') THEN
      RAISE EXCEPTION 'SKILL_SIGNER_KEY_MISMATCH' USING ERRCODE='ES002';
    END IF;
    NEW.created_at:=now();
  ELSE
    IF ROW(NEW.organization_id,NEW.id,NEW.display_name,NEW.key_id,NEW.public_key,NEW.added_by_membership_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.display_name,OLD.key_id,OLD.public_key,OLD.added_by_membership_id,OLD.created_at)
      OR OLD.state<>'active' OR NEW.state<>'revoked' OR NEW.version<>OLD.version+1
      OR NEW.revoked_by_membership_id IS DISTINCT FROM person.id OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'SKILL_SIGNER_IMMUTABLE' USING ERRCODE='ES002';
    END IF;
    NEW.revoked_at:=now();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION skills.guard_signer_administration() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trusted_signers_guard_administration BEFORE INSERT OR UPDATE ON skills.trusted_signers
FOR EACH ROW EXECUTE FUNCTION skills.guard_signer_administration();
