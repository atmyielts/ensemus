-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (EXP-09, ADR-035 D6). Human security review remains pending.
-- Take the existing interactive policy lock before rows, and keep the fenced eraser path.
CREATE FUNCTION tenancy.authorize_residency_requirement_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' AND session_user='ensemus_eraser' AND current_user=session_user THEN
    RETURN NULL;
  END IF;
  IF app.is_web_login() IS DISTINCT FROM true
    OR app.current_actor_type() IS DISTINCT FROM 'user'
    OR app.current_interactive_session_id() IS NULL THEN
    RAISE EXCEPTION 'RESIDENCY_OWNER_SESSION_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM org.memberships m
    WHERE m.organization_id=app.current_organization_id()
      AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id()
      AND m.status='active' AND m.role='owner'
  ) THEN
    RAISE EXCEPTION 'RESIDENCY_NOT_AN_OWNER' USING ERRCODE='EN704';
  END IF;
  IF app.interactive_privilege_allowed('organization.manage') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RESIDENCY_OWNER_PROOF_REQUIRED' USING ERRCODE='EN405';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tenancy.authorize_residency_requirement_write() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER residency_requirements_authorize_write
  BEFORE INSERT OR UPDATE OR DELETE ON tenancy.residency_requirements
  FOR EACH STATEMENT EXECUTE FUNCTION tenancy.authorize_residency_requirement_write();
--> statement-breakpoint
CREATE FUNCTION tenancy.check_residency_requirement_author() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.set_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'RESIDENCY_AUTHOR_MISMATCH' USING ERRCODE='EN704';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tenancy.check_residency_requirement_author() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER residency_requirements_check_author
  BEFORE INSERT OR UPDATE ON tenancy.residency_requirements
  FOR EACH ROW EXECUTE FUNCTION tenancy.check_residency_requirement_author();
