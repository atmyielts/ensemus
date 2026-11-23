-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (EXP-03, ADR-033 D6). Human security review remains pending.
-- Keep the policy-before-row lock order for provider grants and revocations.
CREATE FUNCTION meetings.authorize_provider_approval_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF app.is_web_login() IS DISTINCT FROM true
    OR app.current_interactive_session_id() IS NULL THEN
    RAISE EXCEPTION 'PROVIDER_ADMIN_SESSION_REQUIRED' USING ERRCODE='EN405';
  END IF;
  IF app.interactive_privilege_allowed('meeting.manage') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PROVIDER_ADMIN_SESSION_REQUIRED' USING ERRCODE='EN405';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION meetings.authorize_provider_approval_write() FROM PUBLIC;
CREATE TRIGGER provider_approvals_authorize_write
  BEFORE INSERT OR UPDATE ON meetings.provider_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION meetings.authorize_provider_approval_write();
--> statement-breakpoint
CREATE FUNCTION meetings.check_provider_approval_actor() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  author uuid := CASE WHEN TG_OP='INSERT' THEN NEW.approved_by_membership_id ELSE NEW.revoked_by_membership_id END;
BEGIN
  IF author IS DISTINCT FROM app.current_membership_id()
    OR NOT meetings.is_active_administrator(NEW.organization_id, author) THEN
    RAISE EXCEPTION 'PROVIDER_APPROVER_NOT_ADMIN' USING ERRCODE='EN111';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION meetings.check_provider_approval_actor() FROM PUBLIC;
CREATE TRIGGER provider_approvals_check_actor
  BEFORE INSERT OR UPDATE ON meetings.provider_approvals
  FOR EACH ROW EXECUTE FUNCTION meetings.check_provider_approval_actor();