-- Additive to0404. Requires0401-0404; the joined journal installs the M6/M7 prerequisites first.
-- Metadata only: no account body, external account identifier, assertion or provider config is read.
DO $$ BEGIN
  IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
    OR pg_catalog.pg_has_role(current_user,'ensemus_auth','member') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE identity.session_assurances ADD COLUMN primary_account_id uuid,
  ADD CONSTRAINT session_assurances_primary_account_id_accounts_id_fk
    FOREIGN KEY(primary_account_id) REFERENCES identity.accounts(id) ON DELETE CASCADE,
  ADD CONSTRAINT session_assurances_primary_account CHECK(kind='sso_saml' OR primary_account_id IS NULL);
-- Existing auth-only INSERT/UPDATE grants cover this control field. App keeps only its prior columns.
REVOKE SELECT ON identity.session_assurances FROM ensemus_app;
GRANT SELECT(session_id,kind,user_id,sso_provider_id,verified_at) ON identity.session_assurances TO ensemus_app;
--> statement-breakpoint

-- The existing request/read boundary uses this same proof projection. Unknown legacy SSO receipts
-- must not pass there while waiting for a privileged effect to reject them. RLS can test the private
-- control column without granting the application SELECT on that column.
ALTER POLICY session_assurances_self ON identity.session_assurances USING(user_id=app.current_user_id() AND
  (kind<>'sso_saml' OR (primary_account_id IS NOT NULL AND verified_at<=clock_timestamp() AND EXISTS(
    SELECT 1 FROM org.memberships m
    JOIN org.sso_member_links l ON l.organization_id=m.organization_id AND l.membership_id=m.id
    JOIN org.sso_connections c ON c.organization_id=l.organization_id AND c.id=l.connection_id
    JOIN identity.sso_providers p ON p.provider_id=c.provider_id AND p.domain_verified
    JOIN identity.sessions s ON s.id=identity.session_assurances.session_id AND s.user_id=m.user_id
      AND s.expires_at>clock_timestamp()
    WHERE m.organization_id=app.current_organization_id() AND m.user_id=app.current_user_id()
      AND m.status='active' AND l.state='active' AND c.provider_id=identity.session_assurances.sso_provider_id
      AND c.state='active' AND c.domain_state='verified'
  ))));
--> statement-breakpoint

CREATE FUNCTION identity.guard_sso_account_receipt() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'identity.session_assurances'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'SSO_RECEIPT_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF NEW.primary_account_id IS NULL THEN RETURN NEW;END IF;
  IF NEW.kind<>'sso_saml' THEN RAISE EXCEPTION 'SSO_RECEIPT_ACCOUNT_INVALID' USING ERRCODE='42501';END IF;
  PERFORM a.id FROM identity.accounts a WHERE a.id=NEW.primary_account_id
    AND a.user_id=NEW.user_id AND a.provider_id=NEW.sso_provider_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SSO_RECEIPT_ACCOUNT_INVALID' USING ERRCODE='42501';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_assurances_account_guard BEFORE INSERT OR UPDATE ON identity.session_assurances
  FOR EACH ROW EXECUTE FUNCTION identity.guard_sso_account_receipt();
REVOKE ALL ON FUNCTION identity.guard_sso_account_receipt() FROM PUBLIC;
--> statement-breakpoint

-- Deletion is FK-cascaded. Trust-changing updates invalidate only this account's SSO proof, not MFA.
CREATE FUNCTION identity.invalidate_changed_sso_account() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'identity.accounts'::regclass OR TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'SSO_RECEIPT_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    DELETE FROM identity.session_assurances a WHERE a.kind='sso_saml' AND a.primary_account_id=OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_invalidate_sso_receipt BEFORE UPDATE OF user_id,provider_id,account_id ON identity.accounts
  FOR EACH ROW EXECUTE FUNCTION identity.invalidate_changed_sso_account();
REVOKE ALL ON FUNCTION identity.invalidate_changed_sso_account() FROM PUBLIC;
--> statement-breakpoint

CREATE POLICY assurances_interactive_sso_lock ON identity.session_assurances FOR UPDATE TO ensemus_migrator
  USING(current_setting('identity.mfa_guard_active',true)='v1' AND kind='sso_saml'
    AND primary_account_id IS NOT NULL AND user_id=app.current_user_id()
    AND session_id=app.current_interactive_session_id()
    AND user_id=nullif(current_setting('identity.mfa_guard_user',true),'')::uuid
    AND session_id=nullif(current_setting('identity.mfa_guard_session',true),'')::uuid) WITH CHECK(false);
CREATE POLICY sso_links_interactive_metadata ON org.sso_member_links FOR SELECT TO ensemus_migrator
  USING(current_setting('identity.mfa_guard_active',true)='v1'
    AND organization_id=app.current_organization_id() AND membership_id=app.current_membership_id()
    AND app.current_user_id()=nullif(current_setting('identity.mfa_guard_user',true),'')::uuid
    AND app.current_interactive_session_id()=nullif(current_setting('identity.mfa_guard_session',true),'')::uuid);
CREATE POLICY sso_links_interactive_lock ON org.sso_member_links FOR UPDATE TO ensemus_migrator
  USING(current_setting('identity.mfa_guard_active',true)='v1'
    AND organization_id=app.current_organization_id() AND membership_id=app.current_membership_id()
    AND app.current_user_id()=nullif(current_setting('identity.mfa_guard_user',true),'')::uuid
    AND app.current_interactive_session_id()=nullif(current_setting('identity.mfa_guard_session',true),'')::uuid) WITH CHECK(false);
--> statement-breakpoint

-- State-presence changes serialize with the missing-policy/no-active-provider recovery check too.
-- Normal SSO DAL mutations already take this lock before touching their row. Direct role mutations
-- may be aborted by PostgreSQL's deadlock detection; they never authorize against a stale absence.
CREATE FUNCTION org.serialize_sso_effect_policy() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE tenant uuid;
BEGIN
  IF TG_RELID<>'org.sso_connections'::regclass OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'SSO_POLICY_TARGET_INVALID' USING ERRCODE='42501';END IF;
  tenant:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF tenant IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'SSO_POLICY_SCOPE_INVALID' USING ERRCODE='42501';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('interactive_policy:'||tenant::text,0));
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER sso_connections_effect_policy BEFORE INSERT OR UPDATE OF state OR DELETE ON org.sso_connections
  FOR EACH ROW EXECUTE FUNCTION org.serialize_sso_effect_policy();
REVOKE ALL ON FUNCTION org.serialize_sso_effect_policy() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION identity.lock_required_sso_effect(p_org uuid,p_member uuid,p_user uuid,p_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_active text;previous_user text;previous_session text;provider text;trusted boolean;
        person uuid;connection uuid;linked uuid;expires timestamptz;proved timestamptz;
        observed timestamptz;allowed boolean:=false;
BEGIN
  IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'user'
    OR p_org IS DISTINCT FROM app.current_organization_id() OR p_member IS DISTINCT FROM app.current_membership_id()
    OR p_user IS NULL OR p_user IS DISTINCT FROM app.current_user_id()
    OR p_session IS NULL OR p_session IS DISTINCT FROM app.current_interactive_session_id() THEN RETURN false;END IF;
  previous_active:=current_setting('identity.mfa_guard_active',true);
  previous_user:=current_setting('identity.mfa_guard_user',true);
  previous_session:=current_setting('identity.mfa_guard_session',true);
  PERFORM set_config('identity.mfa_guard_active','v1',true),set_config('identity.mfa_guard_user',p_user::text,true),
    set_config('identity.mfa_guard_session',p_session::text,true);
  BEGIN
    -- The user first matches0404 MFA disable/proof ordering. Provider precedes session/proof as the
    -- auth writer and operator trust review do; no account body or external identity is consulted.
    SELECT u.id INTO person FROM identity.users u WHERE u.id=p_user FOR SHARE;
    SELECT a.sso_provider_id INTO provider FROM identity.session_assurances a
      WHERE a.session_id=p_session AND a.user_id=p_user AND a.kind='sso_saml' AND a.primary_account_id IS NOT NULL;
    SELECT p.domain_verified INTO trusted FROM identity.sso_providers p WHERE p.provider_id=provider FOR SHARE;
    SELECT c.id INTO connection FROM org.sso_connections c WHERE c.organization_id=p_org
      AND c.provider_id=provider AND c.state='active' AND c.domain_state='verified' FOR SHARE;
    SELECT s.expires_at INTO expires FROM identity.sessions s WHERE s.id=p_session AND s.user_id=p_user FOR SHARE;
    SELECT a.verified_at INTO proved FROM identity.session_assurances a WHERE a.session_id=p_session AND a.user_id=p_user
      AND a.kind='sso_saml' AND a.sso_provider_id=provider AND a.primary_account_id IS NOT NULL FOR SHARE;
    SELECT l.membership_id INTO linked FROM org.sso_member_links l WHERE l.organization_id=p_org
      AND l.connection_id=connection AND l.membership_id=p_member AND l.state='active' FOR SHARE;
    observed:=clock_timestamp();
    allowed:=coalesce(person IS NOT NULL AND trusted AND connection IS NOT NULL AND linked=p_member
      AND expires>observed AND proved<=observed,false);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('identity.mfa_guard_active',coalesce(previous_active,''),true),
      set_config('identity.mfa_guard_user',coalesce(previous_user,''),true),
      set_config('identity.mfa_guard_session',coalesce(previous_session,''),true);
    RAISE;
  END;
  PERFORM set_config('identity.mfa_guard_active',coalesce(previous_active,''),true),
    set_config('identity.mfa_guard_user',coalesce(previous_user,''),true),
    set_config('identity.mfa_guard_session',coalesce(previous_session,''),true);
  RETURN allowed;
END $$;
REVOKE ALL ON FUNCTION identity.lock_required_sso_effect(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.lock_required_sso_effect(uuid,uuid,uuid,uuid) TO ensemus_app;
--> statement-breakpoint

-- Preserve0404's action/default map. Add only the current required-SSO authority check before its
-- optional-administration return. Owners and tenants with no active connection retain documented recovery.
CREATE OR REPLACE FUNCTION app.interactive_privilege_allowed(p_action text,
  p_session uuid DEFAULT app.current_interactive_session_id()) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE person org.memberships%ROWTYPE;policy org.security_policies%ROWTYPE;tier text;
BEGIN
  IF current_user<>'ensemus_app' OR session_user<>'ensemus_app'
    OR app.current_actor_type() IS DISTINCT FROM 'user' OR app.current_organization_id() IS NULL THEN RETURN false; END IF;
  tier:=CASE
    WHEN p_action IN ('studio.publish','studio.review_decision','pack.activate','pack.rollback',
      'object_type.lower_scope','sso.manage','scim_token.issue','security_policy.change',
      'agent.publish','model_profile.activate','model_workload.approve') THEN 'always'
    WHEN p_action IN ('member.manage','organization.manage','connection.manage') THEN 'administration'
    ELSE NULL END;
  IF tier IS NULL THEN RETURN false;END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('interactive_policy:'||app.current_organization_id()::text,0));
  SELECT m.* INTO person FROM org.memberships m WHERE m.organization_id=app.current_organization_id()
    AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active' FOR SHARE;
  IF person.id IS NULL OR person.role NOT IN ('owner','admin')
    OR (p_action IN ('security_policy.change','organization.manage') AND person.role<>'owner') THEN RETURN false;END IF;
  SELECT p.* INTO policy FROM org.security_policies p WHERE p.organization_id=person.organization_id FOR SHARE;
  IF policy.sso_enforcement='required' AND person.role<>'owner'
    AND EXISTS(SELECT 1 FROM org.sso_connections c WHERE c.organization_id=person.organization_id AND c.state='active')
    AND NOT identity.lock_required_sso_effect(person.organization_id,person.id,person.user_id,app.current_interactive_session_id()) THEN
    RAISE EXCEPTION 'SSO_REQUIRED' USING ERRCODE='EN410';END IF;
  IF tier='administration' AND NOT coalesce(policy.mfa_for_administration,false) THEN RETURN true;END IF;
  IF p_session IS NULL OR p_session IS DISTINCT FROM app.current_interactive_session_id() THEN RETURN false;END IF;
  RETURN identity.lock_recent_interactive_mfa(person.user_id,p_session,coalesce(policy.mfa_max_age_seconds,900));
END $$;
REVOKE ALL ON FUNCTION app.interactive_privilege_allowed(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.interactive_privilege_allowed(text,uuid) TO ensemus_app;
