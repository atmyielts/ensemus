-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-029). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW: written by an agent in CI repair round 6 (g2) and not yet
-- reviewed by a person. It lets 0422's offline restore revocation through two older SSO guards.
--
-- 0546 (r6 restore): 0422's offline operator restore revokes authority that a restored dump may hold.
-- identity.begin_auth_restore revokes every outstanding SCIM bearer in the transaction that closes
-- admission, and identity.reconcile_auth_restore's 'revoke_scim' and 'disable_provider' actions do
-- the same for one token or connection. Both run as the actual ensemus_migrator login with no tenant
-- bound (there is no tenant: the operator acts on the whole restored database), under 0422's own
-- authority_restore_0422_write trigger, which admits only the one-way shapes.
--
-- Two older guards compared the row's tenant to app.current_organization_id() for EVERY role:
--   * 0404 org.guard_sso_management (org.scim_tokens UPDATE OF state, org.sso_connections
--     UPDATE OF display_name,state,auto_join) raised INTERACTIVE_GUARD_TARGET_INVALID;
--   * 0410 org.serialize_sso_effect_policy (org.sso_connections UPDATE OF state) raised
--     SSO_POLICY_SCOPE_INVALID.
-- So a restore of any database holding one active SCIM token could not begin (stack CI run
-- 42634553288, restore drill: "ERROR: INTERACTIVE_GUARD_TARGET_INVALID ... org.guard_sso_management()
-- ... identity.begin_auth_restore(uuid,text) line 31"), and no provider could be disabled in review.
-- Their sibling 0404 guards (invitations, memberships, teams, SSO links) already return before the
-- tenant comparison for any role other than ensemus_app/ensemus_agent; these two did not.
--
-- This keeps both guards for every caller and adds one narrow exit, decided by
-- identity.auth_restore_sso_revocation, which is true only when ALL of these hold:
--   * current_user and session_user are both ensemus_migrator (the begin/reconcile helpers are
--     SECURITY DEFINER owned by it, and auth-restore.js logs in as it);
--   * the row is UPDATEd, not inserted or deleted, and its tenant does not change;
--   * identity.auth_restore_operation is 'reconcile' and identity.auth_restore_generation names the
--     current 0422 control generation, whose phase is 'pending' or 'invalidated' (never 'admitted');
--   * the change only revokes: a SCIM token becomes 'revoked' with revoked_at set, or a connection
--     becomes 'disabled' with auto_join false, with no other column changed beyond 0422's own list.
-- 0422's trigger still runs first (triggers fire by name) and still refuses any other shape. The
-- 0410 exit still takes the tenant's interactive_policy advisory lock. Nothing else changes: no
-- table, column, grant, policy or trigger, and the helper has no runtime EXECUTE.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'AUTH_RESTORE_SSO_REVOCATION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('org.guard_sso_management()') IS NULL
  OR to_regprocedure('org.serialize_sso_effect_policy()') IS NULL
  OR to_regprocedure('identity.auth_restore_control()') IS NULL
  OR to_regprocedure('identity.begin_auth_restore(uuid,text)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='org.scim_tokens'::regclass AND t.tgname='scim_tokens_interactive')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='org.sso_connections'::regclass AND t.tgname='sso_connections_interactive')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='org.sso_connections'::regclass AND t.tgname='sso_connections_effect_policy')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='org.scim_tokens'::regclass AND t.tgname='authority_restore_0422_write')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='org.sso_connections'::regclass AND t.tgname='authority_restore_0422_write') THEN
  RAISE EXCEPTION 'AUTH_RESTORE_SSO_REVOCATION_PREREQUISITE_REQUIRED' USING ERRCODE='EN422';END IF;
END $$;
--> statement-breakpoint
-- INVOKER, and only ever reached by the migrator: both guards call it only after checking that
-- current_user and session_user are ensemus_migrator, so runtime roles never need EXECUTE on it.
CREATE FUNCTION identity.auth_restore_sso_revocation(p_table regclass,p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE body jsonb;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' OR p_old IS NULL OR p_new IS NULL
  OR p_new->'organization_id' IS DISTINCT FROM p_old->'organization_id'
  OR current_setting('identity.auth_restore_operation',true) IS DISTINCT FROM 'reconcile' THEN RETURN false;END IF;
 body:=identity.auth_restore_control();
 IF NOT coalesce(body->>'phase' IN('pending','invalidated')
  AND current_setting('identity.auth_restore_generation',true)=body->>'generation',false) THEN RETURN false;END IF;
 IF p_table='org.scim_tokens'::regclass THEN
  RETURN coalesce(p_new-ARRAY['state','revoked_at']=p_old-ARRAY['state','revoked_at']
   AND p_new->>'state'='revoked' AND jsonb_typeof(p_new->'revoked_at')='string',false);
 ELSIF p_table='org.sso_connections'::regclass THEN
  RETURN coalesce(p_new-ARRAY['state','auto_join','version','updated_at']=p_old-ARRAY['state','auto_join','version','updated_at']
   AND p_new->>'state'='disabled' AND p_new->'auto_join'='false'::jsonb,false);
 END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION identity.auth_restore_sso_revocation(regclass,jsonb,jsonb) FROM PUBLIC;
--> statement-breakpoint
-- 0404's body, with the 0546 exit before its tenant comparison. Same signature, owner, ACL and triggers.
CREATE OR REPLACE FUNCTION org.guard_sso_management() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE action text;
BEGIN
  IF TG_RELID NOT IN ('org.sso_connections'::regclass,'org.scim_tokens'::regclass)
    OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  -- 0546: the offline restore operator's one-way revocation (see the header). Nested, so a runtime
  -- role never reaches the helper it has no EXECUTE on.
  IF TG_OP='UPDATE' AND current_user='ensemus_migrator' AND session_user='ensemus_migrator' THEN
    IF identity.auth_restore_sso_revocation(TG_RELID,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  action:=CASE WHEN TG_RELID='org.scim_tokens'::regclass AND TG_OP='INSERT' THEN 'scim_token.issue' ELSE 'sso.manage' END;
  IF current_user IN ('ensemus_app','ensemus_agent') AND NOT app.interactive_privilege_allowed(action) THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 0410's body, with the same exit. It still serializes with the tenant's policy check.
CREATE OR REPLACE FUNCTION org.serialize_sso_effect_policy() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE tenant uuid;
BEGIN
  IF TG_RELID<>'org.sso_connections'::regclass OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'SSO_POLICY_TARGET_INVALID' USING ERRCODE='42501';END IF;
  tenant:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF TG_OP='UPDATE' AND current_user='ensemus_migrator' AND session_user='ensemus_migrator' THEN
    IF identity.auth_restore_sso_revocation(TG_RELID,to_jsonb(OLD),to_jsonb(NEW)) THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('interactive_policy:'||tenant::text,0));
      RETURN NEW;
    END IF;
  END IF;
  IF tenant IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'SSO_POLICY_SCOPE_INVALID' USING ERRCODE='42501';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('interactive_policy:'||tenant::text,0));
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
--> statement-breakpoint
-- Postconditions: no runtime role can call the helper, and the guards keep their PUBLIC revocation.
DO $$ DECLARE role text;BEGIN
 FOREACH role IN ARRAY ARRAY['ensemus_app','ensemus_agent','ensemus_auth','ensemus_dispatcher',
  'ensemus_secrets','ensemus_operator','ensemus_support','ensemus_eraser'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role) THEN
   IF has_function_privilege(role,'identity.auth_restore_sso_revocation(regclass,jsonb,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'AUTH_RESTORE_SSO_REVOCATION_POSTCONDITION' USING ERRCODE='EN422';END IF;
  END IF;
 END LOOP;
END $$;
