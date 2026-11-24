-- FLAGGED FOR HUMAN SECURITY REVIEW
-- A receipt is bound to the native interactive actor, including when SQL is
-- called directly. The existing state machine and trust lock still apply.
CREATE FUNCTION skills.guard_interactive_release() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE
  publishing boolean;
  yanking boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM skills.packages p WHERE p.organization_id=NEW.organization_id
      AND p.id=NEW.package_id AND p.origin='tenant') THEN
      RETURN NEW;
    END IF;
    IF NEW.uploaded_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
      RAISE EXCEPTION 'SKILL_UPLOADER_REQUIRED' USING ERRCODE='42501';
    END IF;
  ELSE
    publishing := OLD.state<>'published' AND NEW.state='published';
    yanking := OLD.state<>'yanked' AND NEW.state='yanked';
    IF (NOT publishing AND ROW(NEW.published_by_membership_id,NEW.published_at)
        IS DISTINCT FROM ROW(OLD.published_by_membership_id,OLD.published_at))
      OR (NOT yanking AND ROW(NEW.yanked_by_membership_id,NEW.yanked_at,NEW.yank_code)
        IS DISTINCT FROM ROW(OLD.yanked_by_membership_id,OLD.yanked_at,OLD.yank_code)) THEN
      RAISE EXCEPTION 'SKILL_RELEASE_RECEIPT_IMMUTABLE' USING ERRCODE='ES002';
    END IF;
    IF NOT publishing AND NOT yanking THEN RETURN NEW; END IF;
  END IF;

  IF session_user<>'ensemus_app' OR current_user<>session_user
    OR app.current_actor_type() IS DISTINCT FROM 'user'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'SKILL_RELEASE_PERSON_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF app.interactive_privilege_allowed('skill.manage') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';
  END IF;

  IF publishing THEN
    IF NEW.published_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
      RAISE EXCEPTION 'SKILL_PUBLISHER_REQUIRED' USING ERRCODE='42501';
    END IF;
    NEW.published_at := statement_timestamp();
  ELSIF yanking THEN
    IF NEW.yanked_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
      RAISE EXCEPTION 'SKILL_YANK_ACTOR_REQUIRED' USING ERRCODE='42501';
    END IF;
    IF NOT COALESCE(NEW.yank_code IN ('WITHDRAWN_BY_OWNER','SECURITY_ISSUE')
      OR (NEW.yank_code='SIGNER_REVOKED' AND EXISTS (
        SELECT 1 FROM skills.packages p JOIN skills.trusted_signers s
          ON s.organization_id=p.organization_id
        WHERE p.organization_id=NEW.organization_id AND p.id=NEW.package_id AND p.origin='tenant'
          AND s.key_id=NEW.signer_key_id AND s.state='revoked'
      )),false) THEN
      RAISE EXCEPTION 'SKILL_YANK_REASON_INVALID' USING ERRCODE='ES001';
    END IF;
    NEW.yanked_at := statement_timestamp();
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION skills.guard_interactive_release() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER skill_versions_guard_release BEFORE INSERT OR UPDATE ON skills.package_versions
FOR EACH ROW EXECUTE FUNCTION skills.guard_interactive_release();
