-- Native session identity is an in-process auth handoff, then one transaction-local UUID. It is
-- never an HTTP input or an agent/delegated authority. Unknown/legacy contexts have no session.
-- Prerequisites include 0216 Knowledge model-job authority and 0400-0403 product identity source.
-- The joined migration journal must place 0216 before this migration; no optional-table bypass.
-- Installing under a different owner must not accidentally turn this metadata guard into a
-- superuser/BYPASSRLS function. The normal migration runner connects as the owning migrator.
DO $$ BEGIN
  IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
    OR pg_catalog.pg_has_role(current_user,'ensemus_auth','member') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;
END $$;
--> statement-breakpoint

CREATE FUNCTION app.current_interactive_session_id() RETURNS uuid LANGUAGE plpgsql STABLE
SET search_path=pg_catalog AS $$
DECLARE value text:=current_setting('app.interactive_session_id',true);
BEGIN
  IF value IS NULL OR value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  RETURN value::uuid;
END $$;
REVOKE ALL ON FUNCTION app.current_interactive_session_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_interactive_session_id() TO ensemus_app,ensemus_migrator;
--> statement-breakpoint

-- The migrator already owns these tables but obeys FORCE RLS. Lock-only visibility is the same
-- narrow owner/policy pattern used by Knowledge metadata guards. No auth-role membership, SET ROLE,
-- secret/account read grant or mutable session/user grant is added to the application role.
CREATE POLICY sessions_interactive_guard_read ON identity.sessions FOR SELECT TO ensemus_migrator
  USING (current_setting('identity.mfa_guard_active',true)='v1'
    AND id=nullif(current_setting('identity.mfa_guard_session',true),'')::uuid
    AND user_id=nullif(current_setting('identity.mfa_guard_user',true),'')::uuid
    AND id=app.current_interactive_session_id() AND user_id=app.current_user_id());
CREATE POLICY sessions_interactive_guard_lock ON identity.sessions FOR UPDATE TO ensemus_migrator
  USING (current_setting('identity.mfa_guard_active',true)='v1'
    AND id=nullif(current_setting('identity.mfa_guard_session',true),'')::uuid
    AND user_id=nullif(current_setting('identity.mfa_guard_user',true),'')::uuid
    AND id=app.current_interactive_session_id() AND user_id=app.current_user_id())
  WITH CHECK(false);
CREATE POLICY assurances_interactive_guard_lock ON identity.session_assurances FOR UPDATE TO ensemus_migrator
  USING (current_setting('identity.mfa_guard_active',true)='v1'
    AND session_id=nullif(current_setting('identity.mfa_guard_session',true),'')::uuid
    AND user_id=nullif(current_setting('identity.mfa_guard_user',true),'')::uuid
    AND session_id=app.current_interactive_session_id() AND user_id=app.current_user_id()
    AND kind IN ('mfa_totp','mfa_backup_code')) WITH CHECK(false);
--> statement-breakpoint

CREATE FUNCTION identity.lock_recent_interactive_mfa(p_user uuid,p_session uuid,p_max_age integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_active text;previous_user text;previous_session text;
        enabled boolean;expires timestamptz;proved timestamptz;allowed boolean:=false;observed timestamptz;
BEGIN
  -- session_user also denies an agent connection that SET ROLEs to its inherited app role.
  IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'user'
    OR p_user IS NULL OR p_session IS NULL OR p_max_age NOT BETWEEN 60 AND 3600
    OR p_user IS DISTINCT FROM app.current_user_id()
    OR p_session IS DISTINCT FROM app.current_interactive_session_id() THEN RETURN false; END IF;
  previous_active:=current_setting('identity.mfa_guard_active',true);
  previous_user:=current_setting('identity.mfa_guard_user',true);
  previous_session:=current_setting('identity.mfa_guard_session',true);
  PERFORM set_config('identity.mfa_guard_active','v1',true),
    set_config('identity.mfa_guard_user',p_user::text,true),set_config('identity.mfa_guard_session',p_session::text,true);
  BEGIN
    -- Match native proof/disable lock order. A concurrent logout, factor removal or proof deletion
    -- commits either before this check or after the protected effect; it cannot land between them.
    SELECT u.two_factor_enabled INTO enabled FROM identity.users u WHERE u.id=p_user FOR SHARE;
    SELECT s.expires_at INTO expires FROM identity.sessions s
      WHERE s.id=p_session AND s.user_id=p_user FOR SHARE;
    SELECT a.verified_at INTO proved FROM identity.session_assurances a
      WHERE a.session_id=p_session AND a.user_id=p_user AND a.kind IN ('mfa_totp','mfa_backup_code')
      ORDER BY a.verified_at DESC LIMIT 1 FOR SHARE;
    observed:=clock_timestamp();
    allowed:=coalesce(enabled AND expires>observed AND proved<=observed
      AND proved>=observed-make_interval(secs=>p_max_age),false);
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
REVOKE ALL ON FUNCTION identity.lock_recent_interactive_mfa(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.lock_recent_interactive_mfa(uuid,uuid,integer) TO ensemus_app;
--> statement-breakpoint

-- All production effect callers and the trigger backstops use this one literal action map.
-- The advisory lock covers a missing default policy too; a first policy INSERT takes it as well.
CREATE FUNCTION app.interactive_privilege_allowed(p_action text,
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
  IF tier='administration' AND NOT coalesce(policy.mfa_for_administration,false) THEN RETURN true;END IF;
  IF p_session IS NULL OR p_session IS DISTINCT FROM app.current_interactive_session_id() THEN RETURN false;END IF;
  RETURN identity.lock_recent_interactive_mfa(person.user_id,p_session,coalesce(policy.mfa_max_age_seconds,900));
END $$;
REVOKE ALL ON FUNCTION app.interactive_privilege_allowed(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.interactive_privilege_allowed(text,uuid) TO ensemus_app;
--> statement-breakpoint

-- No FK to a continuing live session. An admitted exact-version probe survives later logout.
ALTER TABLE ai.model_profiles ADD COLUMN probe_authorized_profile_version integer,
  ADD COLUMN probe_authorized_membership_id uuid,ADD COLUMN probe_authorized_session_id uuid,
  ADD COLUMN probe_authorized_at timestamptz,
  ADD CONSTRAINT model_probe_authorization_complete CHECK (
    (probe_authorized_profile_version IS NULL AND probe_authorized_membership_id IS NULL
      AND probe_authorized_session_id IS NULL AND probe_authorized_at IS NULL)
    OR (probe_authorized_profile_version IS NOT NULL AND probe_authorized_profile_version>0 AND probe_authorized_membership_id IS NOT NULL
      AND probe_authorized_session_id IS NOT NULL AND probe_authorized_at IS NOT NULL)),
  ADD CONSTRAINT model_probe_authorization_member FOREIGN KEY(organization_id,probe_authorized_membership_id)
    REFERENCES org.memberships(organization_id,id);
--> statement-breakpoint

-- The existing table-level INSERT grant lets the ORM send DEFAULT for omitted columns. It never
-- permits a caller-supplied non-null admission, and there is no app/agent UPDATE stamp grant.
CREATE FUNCTION ai.check_new_probe_authorization() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'ai.model_profiles'::regclass OR TG_OP<>'INSERT'
    OR NEW.probe_authorized_profile_version IS NOT NULL OR NEW.probe_authorized_membership_id IS NOT NULL
    OR NEW.probe_authorized_session_id IS NOT NULL OR NEW.probe_authorized_at IS NOT NULL THEN
    RAISE EXCEPTION 'MODEL_PROBE_ADMISSION_CALLER_STAMP_DENIED' USING ERRCODE='42501';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_profiles_z_mfa_new BEFORE INSERT ON ai.model_profiles
  FOR EACH ROW EXECUTE FUNCTION ai.check_new_probe_authorization();
--> statement-breakpoint

CREATE FUNCTION ai.invalidate_probe_authorization() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'ai.model_profiles'::regclass OR TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF NEW.version IS DISTINCT FROM OLD.version OR NEW.status IN ('draft','disabled') THEN
    NEW.probe_authorized_profile_version:=NULL;NEW.probe_authorized_membership_id:=NULL;
    NEW.probe_authorized_session_id:=NULL;NEW.probe_authorized_at:=NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_profiles_z_mfa_invalidate BEFORE UPDATE ON ai.model_profiles
  FOR EACH ROW EXECUTE FUNCTION ai.invalidate_probe_authorization();
--> statement-breakpoint

CREATE FUNCTION ai.guard_probe_authorization() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'ai.model_profiles'::regclass OR TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF NEW.status='probing' THEN
    IF NOT app.interactive_privilege_allowed('model_profile.activate')
      OR NEW.probe_requested_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
      RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
    NEW.probe_authorized_profile_version:=NEW.version;
    NEW.probe_authorized_membership_id:=app.current_membership_id();
    NEW.probe_authorized_session_id:=app.current_interactive_session_id();
    NEW.probe_authorized_at:=clock_timestamp();
  ELSIF NEW.status='active' AND OLD.status IS DISTINCT FROM 'active' THEN
    -- Qualification-specific proof remains independently required. This receipt is not a pass.
    IF current_user<>'ensemus_agent' OR session_user<>'ensemus_agent' OR OLD.status<>'probing'
      OR OLD.probe_authorized_profile_version IS DISTINCT FROM OLD.version
      OR OLD.probe_authorized_membership_id IS DISTINCT FROM OLD.probe_requested_by_membership_id
      OR OLD.probe_authorized_session_id IS NULL OR OLD.probe_authorized_at IS NULL
      OR NEW.version IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION 'MODEL_PROBE_INTERACTIVE_ADMISSION_REQUIRED' USING ERRCODE='EN405';END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_profiles_zz_mfa_status BEFORE UPDATE OF status ON ai.model_profiles
  FOR EACH ROW EXECUTE FUNCTION ai.guard_probe_authorization();
REVOKE ALL ON FUNCTION ai.check_new_probe_authorization(),ai.invalidate_probe_authorization(),ai.guard_probe_authorization() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION app.guard_security_policy() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'org.security_policies'::regclass OR TG_OP NOT IN ('INSERT','UPDATE')
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user IN ('ensemus_app','ensemus_agent') AND
    (NOT app.interactive_privilege_allowed('security_policy.change')
      OR NEW.updated_by_membership_id IS DISTINCT FROM app.current_membership_id()) THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER security_policies_interactive BEFORE INSERT OR UPDATE ON org.security_policies
  FOR EACH ROW EXECUTE FUNCTION app.guard_security_policy();
REVOKE ALL ON FUNCTION app.guard_security_policy() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION ai.guard_agent_publication() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID NOT IN ('ai.agent_versions'::regclass,'ai.agent_publications'::regclass)
    OR TG_OP NOT IN ('INSERT','UPDATE') OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user IN ('ensemus_app','ensemus_agent') AND NOT app.interactive_privilege_allowed('agent.publish') THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_versions_interactive BEFORE INSERT ON ai.agent_versions
  FOR EACH ROW EXECUTE FUNCTION ai.guard_agent_publication();
CREATE TRIGGER agent_publications_interactive BEFORE INSERT OR UPDATE ON ai.agent_publications
  FOR EACH ROW EXECUTE FUNCTION ai.guard_agent_publication();
REVOKE ALL ON FUNCTION ai.guard_agent_publication() FROM PUBLIC;
--> statement-breakpoint

-- 0216's immutable bounded approval is a new spend/egress authority, separate from qualification.
-- Its existing capability/bounds guard remains independent. One-way revocation adds no MFA obstacle.
CREATE FUNCTION ai.guard_model_workload_approval() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'ai.model_workload_approvals'::regclass OR TG_OP<>'INSERT'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user IN ('ensemus_app','ensemus_agent') AND
    (NOT app.interactive_privilege_allowed('model_workload.approve')
      OR NEW.approved_by_membership_id IS DISTINCT FROM app.current_membership_id()) THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_workload_approvals_interactive BEFORE INSERT ON ai.model_workload_approvals
  FOR EACH ROW EXECUTE FUNCTION ai.guard_model_workload_approval();
REVOKE ALL ON FUNCTION ai.guard_model_workload_approval() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION org.guard_sso_management() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE action text;
BEGIN
  IF TG_RELID NOT IN ('org.sso_connections'::regclass,'org.scim_tokens'::regclass)
    OR TG_OP NOT IN ('INSERT','UPDATE') OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  action:=CASE WHEN TG_RELID='org.scim_tokens'::regclass AND TG_OP='INSERT' THEN 'scim_token.issue' ELSE 'sso.manage' END;
  IF current_user IN ('ensemus_app','ensemus_agent') AND NOT app.interactive_privilege_allowed(action) THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sso_connections_interactive BEFORE INSERT OR UPDATE OF display_name,state,auto_join ON org.sso_connections
  FOR EACH ROW EXECUTE FUNCTION org.guard_sso_management();
CREATE TRIGGER scim_tokens_interactive BEFORE INSERT OR UPDATE OF state ON org.scim_tokens
  FOR EACH ROW EXECUTE FUNCTION org.guard_sso_management();
REVOKE ALL ON FUNCTION org.guard_sso_management() FROM PUBLIC;
--> statement-breakpoint

-- Exact durable invitation acceptance needs only this existing account-status metadata, not a
-- password, session token or provider body. Existing users_self/tenant RLS still applies.
GRANT SELECT(email_verified) ON identity.users TO ensemus_app;
--> statement-breakpoint

CREATE FUNCTION org.guard_invitation_management() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE recipient identity.users%ROWTYPE;inviter org.memberships%ROWTYPE;
BEGIN
  IF TG_RELID<>'org.invitations'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user NOT IN ('ensemus_app','ensemus_agent') THEN RETURN NEW;END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' THEN
    -- An accepted row cannot be touched to refresh xmin and spend its admission a second time.
    IF OLD.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'INVITATION_ALREADY_CONSUMED' USING ERRCODE='42501';END IF;
    IF (to_jsonb(NEW)-ARRAY['accepted_at','claimed_by_user_id','claimed_at'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['accepted_at','claimed_by_user_id','claimed_at'])
      AND OLD.token_hash=app.current_invitation_hash() AND OLD.revoked_at IS NULL
      AND OLD.expires_at>clock_timestamp() AND current_user='ensemus_app' AND session_user='ensemus_app' THEN
      SELECT u.id,u.email,u.email_verified INTO recipient.id,recipient.email,recipient.email_verified
        FROM identity.users u WHERE u.id=app.current_user_id();
      SELECT m.* INTO inviter FROM org.memberships m WHERE m.organization_id=OLD.organization_id
        AND m.id=OLD.invited_by_membership_id AND m.status='active' AND m.role IN ('owner','admin') FOR SHARE;
      IF recipient.id IS NOT NULL AND lower(recipient.email)=OLD.email AND inviter.id IS NOT NULL THEN
        IF NEW.accepted_at IS NOT NULL AND recipient.email_verified
          AND NEW.claimed_by_user_id IS NOT DISTINCT FROM OLD.claimed_by_user_id
          AND NEW.claimed_at IS NOT DISTINCT FROM OLD.claimed_at THEN
          NEW.accepted_at:=clock_timestamp();RETURN NEW;
        ELSIF NEW.accepted_at IS NULL AND NEW.claimed_by_user_id=recipient.id THEN
          NEW.claimed_at:=clock_timestamp();RETURN NEW;
        END IF;
      END IF;
    END IF;
    -- Automatic cleanup only removes an unused invitation whose inviter has actually lost access.
    IF app.current_actor_type()='service' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
      AND (to_jsonb(NEW)-'revoked_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
      AND NOT EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=OLD.organization_id
        AND m.id=OLD.invited_by_membership_id AND m.status='active' AND m.role IN ('owner','admin')) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT app.interactive_privilege_allowed('member.manage') THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.invited_by_membership_id IS DISTINCT FROM app.current_membership_id()
      OR NEW.accepted_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.claimed_by_user_id IS NOT NULL
      OR NEW.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'INVITATION_INVALID_START' USING ERRCODE='42501';END IF;
  ELSIF NEW.accepted_at IS NOT NULL THEN
    -- A manager confirms the previously recorded claimant, with the normal interactive policy.
    IF OLD.claimed_by_user_id IS NULL OR OLD.revoked_at IS NOT NULL OR OLD.expires_at<=clock_timestamp()
      OR (to_jsonb(NEW)-'accepted_at') IS DISTINCT FROM (to_jsonb(OLD)-'accepted_at') THEN
      RAISE EXCEPTION 'INVITATION_CONFIRMATION_INVALID' USING ERRCODE='42501';END IF;
    NEW.accepted_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitations_interactive BEFORE INSERT OR UPDATE ON org.invitations
  FOR EACH ROW EXECUTE FUNCTION org.guard_invitation_management();
REVOKE ALL ON FUNCTION org.guard_invitation_management() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION org.guard_membership_management() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE action_allowed boolean:=false;other_owner uuid;
BEGIN
  IF TG_RELID<>'org.memberships'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user NOT IN ('ensemus_app','ensemus_agent') THEN RETURN NEW;END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('member_changes:'||NEW.organization_id::text,0));
  IF TG_OP='INSERT' THEN
    -- The sole initial owner, while this transaction is creating the actual empty organization.
    IF current_user='ensemus_app' AND session_user='ensemus_app'
      AND NEW.role='owner' AND NEW.status='active' AND NEW.user_id=app.current_user_id()
      AND EXISTS(SELECT 1 FROM org.organizations o WHERE o.id=NEW.organization_id AND o.lifecycle='active'
        AND o.xmin::text=(txid_current()%4294967296)::text)
      AND NOT EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=NEW.organization_id) THEN RETURN NEW;END IF;
    -- A token, or a manager's claimant confirmation, was consumed in THIS transaction. xmin is
    -- server-assigned and makes an old accepted invitation unusable even after a membership deletion.
    IF current_user='ensemus_app' AND session_user='ensemus_app'
      AND NEW.status='active' AND NEW.role IN ('member','admin') AND EXISTS(
      SELECT 1 FROM org.invitations i JOIN identity.users u ON u.id=NEW.user_id AND lower(u.email)=i.email
      JOIN org.memberships inviter ON inviter.organization_id=i.organization_id AND inviter.id=i.invited_by_membership_id
      WHERE i.organization_id=NEW.organization_id AND i.role=NEW.role AND i.accepted_at IS NOT NULL
        AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp()
        AND i.xmin::text=(txid_current()%4294967296)::text AND inviter.status='active' AND inviter.role IN ('owner','admin')
        AND ((i.token_hash=app.current_invitation_hash() AND NEW.user_id=app.current_user_id() AND u.email_verified)
          OR (i.claimed_by_user_id=NEW.user_id AND app.interactive_privilege_allowed('member.manage')))
    ) THEN RETURN NEW;END IF;
    -- This is only the existing member-only, explicitly enabled and currently verified SAML path.
    IF current_user='ensemus_app' AND session_user='ensemus_app'
      AND NEW.role='member' AND NEW.status='active' AND app.current_actor_type()='service'
      AND NEW.user_id=nullif(current_setting('app.sso_subject_user_id',true),'')::uuid
      AND current_setting('app.sso_subject_key',true) ~ '^[0-9a-f]{64}$'
      AND EXISTS(SELECT 1 FROM org.sso_connections c JOIN identity.sso_providers p
        ON p.provider_id=c.provider_id AND p.domain_verified
        WHERE c.organization_id=NEW.organization_id AND c.provider_id=app.current_sso_provider_id()
          AND c.state='active' AND c.domain_state='verified' AND c.auto_join) THEN RETURN NEW;END IF;
  ELSE
    -- A live scoped SCIM token can only perform the already implemented status transitions on its
    -- own link; it cannot change a role or restore a human-invalidated reactivation receipt.
    IF current_user='ensemus_app' AND session_user='ensemus_app'
      AND NEW.role=OLD.role AND app.current_actor_type()='service' AND EXISTS(
      SELECT 1 FROM org.scim_tokens t JOIN org.sso_connections c ON c.organization_id=t.organization_id AND c.id=t.connection_id
      JOIN org.sso_member_links l ON l.organization_id=c.organization_id AND l.connection_id=c.id
      WHERE t.organization_id=NEW.organization_id AND t.token_hash=app.current_scim_token_hash() AND t.state='active'
        AND c.state='active' AND c.domain_state='verified' AND l.membership_id=NEW.id
        AND ((OLD.status='active' AND NEW.status='disabled' AND l.state='active')
          OR (OLD.status='disabled' AND NEW.status='active' AND l.state='deprovisioned' AND l.deprovisioned_at IS NOT NULL))
      FOR SHARE OF t,c,l
    ) THEN action_allowed:=true;END IF;
  END IF;
  IF NOT action_allowed AND NOT app.interactive_privilege_allowed('member.manage') THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  IF (NEW.role='owner' OR (TG_OP='UPDATE' AND OLD.role='owner')) AND NOT action_allowed
    AND NOT EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=NEW.organization_id
      AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.role='owner' AND m.status='active') THEN
    RAISE EXCEPTION 'MEMBER_OWNER_AUTHORITY_REQUIRED' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' AND OLD.role='owner' AND OLD.status='active' AND (NEW.role<>'owner' OR NEW.status<>'active') THEN
    SELECT m.id INTO other_owner FROM org.memberships m WHERE m.organization_id=NEW.organization_id
      AND m.id<>NEW.id AND m.role='owner' AND m.status='active' ORDER BY m.id LIMIT 1 FOR SHARE;
    IF other_owner IS NULL THEN RAISE EXCEPTION 'LAST_OWNER' USING ERRCODE='EN001';END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_interactive BEFORE INSERT OR UPDATE OF role,status ON org.memberships
  FOR EACH ROW EXECUTE FUNCTION org.guard_membership_management();
REVOKE ALL ON FUNCTION org.guard_membership_management() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION org.guard_membership_removal() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE other_owner uuid;
BEGIN
  IF TG_RELID<>'org.memberships'::regclass OR TG_OP<>'DELETE' THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user NOT IN ('ensemus_app','ensemus_agent') THEN RETURN OLD;END IF;
  IF OLD.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('member_changes:'||OLD.organization_id::text,0));
  IF NOT app.interactive_privilege_allowed('member.manage') THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  IF OLD.role='owner' THEN
    IF NOT EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=OLD.organization_id
      AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.role='owner' AND m.status='active') THEN
      RAISE EXCEPTION 'MEMBER_OWNER_AUTHORITY_REQUIRED' USING ERRCODE='42501';END IF;
    SELECT m.id INTO other_owner FROM org.memberships m WHERE m.organization_id=OLD.organization_id
      AND m.id<>OLD.id AND m.role='owner' AND m.status='active' ORDER BY m.id LIMIT 1 FOR SHARE;
    IF other_owner IS NULL THEN RAISE EXCEPTION 'LAST_OWNER' USING ERRCODE='EN001';END IF;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER memberships_interactive_delete BEFORE DELETE ON org.memberships
  FOR EACH ROW EXECUTE FUNCTION org.guard_membership_removal();
REVOKE ALL ON FUNCTION org.guard_membership_removal() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION org.guard_team_management() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE row_org uuid;
BEGIN
  IF TG_RELID NOT IN ('org.teams'::regclass,'org.team_memberships'::regclass) OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user IN ('ensemus_app','ensemus_agent') THEN
    row_org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
    IF row_org IS DISTINCT FROM app.current_organization_id() THEN
      RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
    IF NOT app.interactive_privilege_allowed('member.manage') THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER teams_interactive BEFORE INSERT OR UPDATE OR DELETE ON org.teams
  FOR EACH ROW EXECUTE FUNCTION org.guard_team_management();
CREATE TRIGGER team_memberships_interactive BEFORE INSERT OR DELETE ON org.team_memberships
  FOR EACH ROW EXECUTE FUNCTION org.guard_team_management();
REVOKE ALL ON FUNCTION org.guard_team_management() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION org.guard_organization_management() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'org.organizations'::regclass OR TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user IN ('ensemus_app','ensemus_agent') AND
    (NEW.id IS DISTINCT FROM app.current_organization_id() OR NOT app.interactive_privilege_allowed('organization.manage')) THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_interactive BEFORE UPDATE OF name,lifecycle ON org.organizations
  FOR EACH ROW EXECUTE FUNCTION org.guard_organization_management();
REVOKE ALL ON FUNCTION org.guard_organization_management() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION integrations.guard_connection_management() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'integrations.connections'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user NOT IN ('ensemus_app','ensemus_agent') THEN RETURN NEW;END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  -- Sync/error projections only change these fixed bookkeeping fields and add no access.
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['last_error_code','last_error_at','updated_at','version'])
    IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['last_error_code','last_error_at','updated_at','version']) THEN RETURN NEW;END IF;
  IF NOT app.interactive_privilege_allowed('connection.manage') THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connections_interactive BEFORE INSERT OR UPDATE ON integrations.connections
  FOR EACH ROW EXECUTE FUNCTION integrations.guard_connection_management();
REVOKE ALL ON FUNCTION integrations.guard_connection_management() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION integrations.guard_webhook_management() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'integrations.webhook_endpoints'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user NOT IN ('ensemus_app','ensemus_agent') THEN RETURN NEW;END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  -- Public callback admission and worker settlement update counters only. They never gain a new
  -- secret, target, scheme, state or resource limit through this bookkeeping exception.
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['window_started_at','window_deliveries','window_bytes','pending_bytes','updated_at'])
    IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['window_started_at','window_deliveries','window_bytes','pending_bytes','updated_at']) THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' AND NEW.state='revoked' AND
    (to_jsonb(NEW)-ARRAY['state','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','updated_at'])
    AND EXISTS(SELECT 1 FROM integrations.connections c WHERE c.organization_id=NEW.organization_id
      AND c.id=NEW.connection_id AND c.state='revoked') THEN RETURN NEW;END IF;
  IF NOT app.interactive_privilege_allowed('connection.manage') THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER webhook_endpoints_interactive BEFORE INSERT OR UPDATE ON integrations.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION integrations.guard_webhook_management();
REVOKE ALL ON FUNCTION integrations.guard_webhook_management() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION org.guard_sso_link_management() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE native_origin boolean;
BEGIN
  IF TG_RELID<>'org.sso_member_links'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user NOT IN ('ensemus_app','ensemus_agent') THEN RETURN NEW;END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR current_user<>'ensemus_app'
    OR session_user<>'ensemus_app' THEN RAISE EXCEPTION 'SSO_LINK_AUTHORITY_REQUIRED' USING ERRCODE='42501';END IF;
  native_origin:=app.current_actor_type()='service'
    AND NEW.external_subject=current_setting('app.sso_subject_key',true)
    AND EXISTS(SELECT 1 FROM org.sso_connections c JOIN identity.sso_providers p
      ON p.provider_id=c.provider_id AND p.domain_verified
      JOIN org.memberships m ON m.organization_id=c.organization_id AND m.id=NEW.membership_id
      WHERE c.organization_id=NEW.organization_id AND c.id=NEW.connection_id
        AND c.provider_id=app.current_sso_provider_id() AND c.state='active' AND c.domain_state='verified'
        AND m.status='active' AND m.user_id=nullif(current_setting('app.sso_subject_user_id',true),'')::uuid);
  IF TG_OP='INSERT' THEN
    IF NOT coalesce(native_origin,false) OR NEW.state<>'active' OR NEW.deprovisioned_at IS NOT NULL THEN
      RAISE EXCEPTION 'SSO_LINK_AUTHORITY_REQUIRED' USING ERRCODE='42501';END IF;
    NEW.last_login_at:=clock_timestamp();NEW.updated_at:=clock_timestamp();RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['last_login_at','updated_at']) IS NOT DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['last_login_at','updated_at']) AND coalesce(native_origin,false) AND OLD.state='active' THEN
    NEW.last_login_at:=clock_timestamp();NEW.updated_at:=clock_timestamp();RETURN NEW;
  END IF;
  -- Only the fixed nested human-disable trigger can invalidate SCIM's earlier receipt. It remains
  -- an opt-in administration action, not a new always-MFA SSO setting change.
  IF pg_trigger_depth()>1 AND app.current_actor_type()='user' AND OLD.state='deprovisioned'
    AND OLD.deprovisioned_at IS NOT NULL AND NEW.deprovisioned_at IS NULL
    AND (to_jsonb(NEW)-ARRAY['deprovisioned_at','updated_at']) IS NOT DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['deprovisioned_at','updated_at'])
    AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=NEW.organization_id
      AND m.id=NEW.membership_id AND m.status='disabled')
    AND app.interactive_privilege_allowed('member.manage') THEN RETURN NEW;END IF;
  IF app.current_actor_type()='service' AND
    (to_jsonb(NEW)-ARRAY['state','deprovisioned_at','updated_at']) IS NOT DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','deprovisioned_at','updated_at']) AND EXISTS(
      SELECT 1 FROM org.scim_tokens t JOIN org.sso_connections c ON c.organization_id=t.organization_id AND c.id=t.connection_id
      JOIN org.memberships m ON m.organization_id=c.organization_id AND m.id=NEW.membership_id
      WHERE t.organization_id=NEW.organization_id AND t.token_hash=app.current_scim_token_hash() AND t.state='active'
        AND c.id=NEW.connection_id AND c.state='active' AND c.domain_state='verified'
        AND ((OLD.state='active' AND NEW.state='deprovisioned' AND m.status='disabled' AND NEW.deprovisioned_at IS NOT NULL)
          OR (OLD.state='deprovisioned' AND OLD.deprovisioned_at IS NOT NULL AND NEW.state='active'
            AND m.status='active' AND NEW.deprovisioned_at IS NULL)) FOR SHARE OF t,c,m
    ) THEN
    IF NEW.state='deprovisioned' THEN NEW.deprovisioned_at:=clock_timestamp();END IF;
    NEW.updated_at:=clock_timestamp();RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SSO_LINK_AUTHORITY_REQUIRED' USING ERRCODE='42501';
END $$;
CREATE TRIGGER sso_member_links_authority BEFORE INSERT OR UPDATE ON org.sso_member_links
  FOR EACH ROW EXECUTE FUNCTION org.guard_sso_link_management();
REVOKE ALL ON FUNCTION org.guard_sso_link_management() FROM PUBLIC;
