-- UNREGISTERED SOURCE. Restore is operator maintenance, never a tenant-owner/native-session grant.
-- 0515's material generation helper must exist before begin is called; its body is deferred here.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR pg_has_role(current_user,'ensemus_auth','member') THEN
  RAISE EXCEPTION 'AUTH_RESTORE_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
END $$;

--> statement-breakpoint
-- Only the actual offline migrator can inspect/reconcile these metadata projections. The scope
-- never grants a runtime SECURITY DEFINER caller or a tenant administrator cross-tenant access.
DO $$ DECLARE target regclass;BEGIN
 FOREACH target IN ARRAY ARRAY['org.organizations'::regclass,'org.memberships'::regclass,
  'org.security_policies'::regclass,'org.sso_connections'::regclass,'org.sso_member_links'::regclass,
  'org.scim_tokens'::regclass,'org.teams'::regclass,'org.team_memberships'::regclass,
  'org.invitations'::regclass,'identity.users'::regclass,'identity.accounts'::regclass,
  'identity.sso_providers'::regclass] LOOP
  EXECUTE format('CREATE POLICY auth_restore_operator_metadata ON %s FOR SELECT TO ensemus_migrator
   USING(session_user=''ensemus_migrator''
    AND current_setting(''identity.auth_restore_review_scope'',true)=''v1'')',target);
 END LOOP;
 FOREACH target IN ARRAY ARRAY['org.memberships'::regclass,'org.sso_connections'::regclass,
  'org.sso_member_links'::regclass,'org.scim_tokens'::regclass,'org.team_memberships'::regclass,
  'org.invitations'::regclass,'identity.sso_providers'::regclass,'identity.accounts'::regclass] LOOP
  EXECUTE format('CREATE POLICY auth_restore_operator_revoke ON %s TO ensemus_migrator
   USING(session_user=''ensemus_migrator'' AND current_setting(''identity.auth_restore_operation'',true)=''reconcile'')
   WITH CHECK(session_user=''ensemus_migrator'' AND current_setting(''identity.auth_restore_operation'',true)=''reconcile'')',target);
 END LOOP;
END $$;
--> statement-breakpoint

CREATE FUNCTION identity.lock_auth_restore_authority() RETURNS void LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' THEN
  RAISE EXCEPTION 'AUTH_RESTORE_OPERATOR_REQUIRED' USING ERRCODE='42501';END IF;
 -- All callers lock the singleton first. NOWAIT refuses active writers instead of introducing
 -- an inverted row-lock order; no network, file or cryptographic operation runs under these locks.
 LOCK TABLE org.organizations,org.memberships,org.security_policies,org.sso_connections,
  org.sso_member_links,org.scim_tokens,org.teams,org.team_memberships,org.invitations,
  identity.users,identity.accounts,identity.sso_providers IN SHARE ROW EXCLUSIVE MODE NOWAIT;
END $$;
REVOKE ALL ON FUNCTION identity.lock_auth_restore_authority() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION identity.auth_restore_security_snapshot() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE saved text;answer jsonb;target regclass;amount bigint;total bigint:=0;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' THEN
  RAISE EXCEPTION 'AUTH_RESTORE_OPERATOR_REQUIRED' USING ERRCODE='42501';END IF;
 saved:=current_setting('identity.auth_restore_review_scope',true);
 BEGIN
  PERFORM set_config('identity.auth_restore_review_scope','v1',true);
  FOREACH target IN ARRAY ARRAY['org.organizations'::regclass,'org.memberships'::regclass,
   'org.security_policies'::regclass,'org.sso_connections'::regclass,'org.sso_member_links'::regclass,
   'org.scim_tokens'::regclass,'org.teams'::regclass,'org.team_memberships'::regclass,
   'org.invitations'::regclass,'identity.users'::regclass,'identity.accounts'::regclass,
   'identity.sso_providers'::regclass] LOOP
   -- A complete inventory or a refusal, never a truncated review that appears complete.
   EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM %s LIMIT 10001) bounded',target) INTO amount;
   total:=total+amount;
   IF amount>10000 OR total>100000 THEN RAISE EXCEPTION 'AUTH_RESTORE_REVIEW_TOO_LARGE' USING ERRCODE='EN422';END IF;
  END LOOP;
  SELECT jsonb_build_object('version',1,
   'organizations',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'lifecycle',lifecycle) ORDER BY id)
    FROM org.organizations),'[]'::jsonb),
   'memberships',coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId',organization_id,'id',id,
    'userId',user_id,'role',role,'status',status) ORDER BY organization_id,id) FROM org.memberships),'[]'::jsonb),
   'securityPolicies',coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId',organization_id,
    'mfaForAdministration',mfa_for_administration,'mfaMaxAgeSeconds',mfa_max_age_seconds,
    'ssoEnforcement',sso_enforcement,'version',version) ORDER BY organization_id) FROM org.security_policies),'[]'::jsonb),
   'connections',coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId',organization_id,'id',id,
    'providerId',provider_id,'domain',domain,'domainState',domain_state,'domainVerifiedAt',domain_verified_at,
    'state',state,'autoJoin',auto_join,'version',version) ORDER BY organization_id,id) FROM org.sso_connections),'[]'::jsonb),
   'providers',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'providerId',provider_id,'domain',domain,
    'domainVerified',domain_verified,'ownerUserId',user_id,'organizationRef',organization_id,
    'issuerSha256',encode(sha256(convert_to(issuer,'UTF8')),'hex'),
    'configurationSha256',encode(sha256(convert_to(jsonb_build_object('saml',saml_config,'oidc',oidc_config)::text,'UTF8')),'hex'))
    ORDER BY id) FROM identity.sso_providers),'[]'::jsonb),
   'ssoLinks',coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId',organization_id,
    'membershipId',membership_id,'connectionId',connection_id,'state',state,'deprovisionedAt',deprovisioned_at,
    'subjectSha256',encode(sha256(convert_to(external_subject,'UTF8')),'hex')) ORDER BY organization_id,membership_id)
    FROM org.sso_member_links),'[]'::jsonb),
   'scimTokens',coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId',organization_id,'id',id,
    'connectionId',connection_id,'state',state,'revokedAt',revoked_at,
    'tokenSha256',encode(sha256(convert_to(token_hash,'UTF8')),'hex')) ORDER BY organization_id,id) FROM org.scim_tokens),'[]'::jsonb),
   'teams',coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId',organization_id,'id',id,
    'parentId',parent_id) ORDER BY organization_id,id) FROM org.teams),'[]'::jsonb),
   'teamMemberships',coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId',organization_id,
    'teamId',team_id,'membershipId',membership_id) ORDER BY organization_id,team_id,membership_id)
    FROM org.team_memberships),'[]'::jsonb),
   'invitations',coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId',organization_id,'id',id,
    'emailSha256',encode(sha256(convert_to(email,'UTF8')),'hex'),'role',role,'expiresAt',expires_at,
    'acceptedAt',accepted_at,'revokedAt',revoked_at,'claimedByUserId',claimed_by_user_id,
    'tokenSha256',encode(sha256(convert_to(token_hash,'UTF8')),'hex'))
    ORDER BY organization_id,id) FROM org.invitations),'[]'::jsonb),
   'users',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,
    'emailSha256',encode(sha256(convert_to(lower(email),'UTF8')),'hex'),'emailVerified',email_verified,
    'twoFactorEnabled',two_factor_enabled) ORDER BY id) FROM identity.users),'[]'::jsonb),
   'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'userId',user_id,'providerId',provider_id,
    'accountSha256',encode(sha256(convert_to(account_id,'UTF8')),'hex'),
    'credentialSha256',encode(sha256(convert_to(coalesce(password,''),'UTF8')),'hex'),
    'tokenMaterialSha256',encode(sha256(convert_to(jsonb_build_object('access',access_token,
     'refresh',refresh_token,'id',id_token,'accessExpires',access_token_expires_at,
     'refreshExpires',refresh_token_expires_at,'scope',scope)::text,'UTF8')),'hex')) ORDER BY id)
    FROM identity.accounts),'[]'::jsonb)) INTO answer;
  IF octet_length(answer::text)>16777216 THEN
   RAISE EXCEPTION 'AUTH_RESTORE_REVIEW_TOO_LARGE' USING ERRCODE='EN422';END IF;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('identity.auth_restore_review_scope',coalesce(saved,''),true);RAISE;END;
 PERFORM set_config('identity.auth_restore_review_scope',coalesce(saved,''),true);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION identity.auth_restore_security_snapshot() FROM PUBLIC;
CREATE FUNCTION identity.auth_restore_security_fingerprint() RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' THEN
  RAISE EXCEPTION 'AUTH_RESTORE_OPERATOR_REQUIRED' USING ERRCODE='42501';END IF;
 RETURN encode(sha256(convert_to(identity.auth_restore_security_snapshot()::text,'UTF8')),'hex');
END $$;
REVOKE ALL ON FUNCTION identity.auth_restore_security_fingerprint() FROM PUBLIC;
CREATE FUNCTION identity.auth_restore_owners_reviewable() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE snapshot jsonb;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' THEN
  RAISE EXCEPTION 'AUTH_RESTORE_OPERATOR_REQUIRED' USING ERRCODE='42501';END IF;
 snapshot:=identity.auth_restore_security_snapshot();
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'organizations') o
  WHERE o->>'lifecycle'<>'deleted' AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(snapshot->'memberships') m WHERE m->>'organizationId'=o->>'id'
    AND m->>'role'='owner' AND m->>'status'='active'));
END $$;
REVOKE ALL ON FUNCTION identity.auth_restore_owners_reviewable() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION identity.inspect_auth_restore(p_generation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE body jsonb;snapshot jsonb;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' OR p_generation IS NULL THEN
  RAISE EXCEPTION 'AUTH_RESTORE_OPERATOR_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM id FROM identity.verifications WHERE id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b' FOR SHARE NOWAIT;
 body:=identity.auth_restore_control();
 IF body->>'generation'<>p_generation::text OR body->>'phase' NOT IN('pending','invalidated') THEN
  RAISE EXCEPTION 'AUTH_RESTORE_GENERATION_CHANGED' USING ERRCODE='EN422';END IF;
 PERFORM identity.lock_auth_restore_authority();
 snapshot:=identity.auth_restore_security_snapshot();
 RETURN jsonb_build_object('version',1,'generation',p_generation,'backupId',body->'backupId',
  'manifestSha256',body->'manifestSha256','phase',body->'phase','cutoff',body->'cutoff',
  'notBefore',body->'notBefore','invalidation',body->'invalidation','security',snapshot,
  'securitySha256',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION identity.inspect_auth_restore(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.inspect_auth_restore(uuid) TO ensemus_migrator;
--> statement-breakpoint

CREATE FUNCTION identity.guard_restore_authority_change() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE body jsonb;allowed boolean:=false;
BEGIN
 IF TG_RELID NOT IN('org.memberships'::regclass,'org.security_policies'::regclass,
  'org.sso_connections'::regclass,'org.sso_member_links'::regclass,'org.scim_tokens'::regclass,
  'org.team_memberships'::regclass,'org.invitations'::regclass,'identity.sso_providers'::regclass,
  'identity.accounts'::regclass) THEN
  RAISE EXCEPTION 'AUTH_RESTORE_RECONCILE_REFUSED' USING ERRCODE='EN422';END IF;
 body:=identity.auth_restore_control();
 IF body->>'phase'='admitted' THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 IF current_user='ensemus_migrator' AND session_user='ensemus_migrator'
  AND current_setting('identity.auth_restore_operation',true)='reconcile'
  AND current_setting('identity.auth_restore_generation',true)=body->>'generation' THEN
  IF TG_OP='DELETE' AND TG_RELID='org.team_memberships'::regclass THEN RETURN OLD;END IF;
  IF TG_OP='UPDATE' THEN
   IF TG_RELID='org.memberships'::regclass THEN
    allowed:=to_jsonb(NEW)-ARRAY['role','status'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['role','status']
     AND (NEW.status=OLD.status OR NEW.status='disabled')
     AND array_position(ARRAY['member','admin','owner'],NEW.role)<=array_position(ARRAY['member','admin','owner'],OLD.role);
   ELSIF TG_RELID='org.sso_connections'::regclass THEN
    allowed:=to_jsonb(NEW)-ARRAY['state','auto_join','version','updated_at']
      IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['state','auto_join','version','updated_at']
     AND (NEW.state=OLD.state OR NEW.state='disabled') AND (NEW.auto_join=OLD.auto_join OR NOT NEW.auto_join)
     AND NEW.version=OLD.version+1;
   ELSIF TG_RELID='org.sso_member_links'::regclass THEN
    allowed:=to_jsonb(NEW)-ARRAY['state','deprovisioned_at','updated_at']
      IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['state','deprovisioned_at','updated_at']
     AND NEW.state='deprovisioned' AND NEW.deprovisioned_at IS NOT NULL
     AND (OLD.deprovisioned_at IS NULL OR NEW.deprovisioned_at=OLD.deprovisioned_at);
   ELSIF TG_RELID='org.scim_tokens'::regclass THEN
    allowed:=to_jsonb(NEW)-ARRAY['state','revoked_at'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['state','revoked_at']
     AND NEW.state='revoked' AND NEW.revoked_at IS NOT NULL
     AND (OLD.revoked_at IS NULL OR NEW.revoked_at=OLD.revoked_at);
   ELSIF TG_RELID='org.invitations'::regclass THEN
    allowed:=to_jsonb(NEW)-'revoked_at' IS NOT DISTINCT FROM to_jsonb(OLD)-'revoked_at'
     AND NEW.revoked_at IS NOT NULL AND (OLD.revoked_at IS NULL OR NEW.revoked_at=OLD.revoked_at);
   ELSIF TG_RELID='identity.sso_providers'::regclass THEN
    allowed:=to_jsonb(NEW)-ARRAY['domain_verified','updated_at']
      IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['domain_verified','updated_at']
     AND NOT NEW.domain_verified;
   ELSIF TG_RELID='identity.accounts'::regclass THEN
    allowed:=(OLD.provider_id='credential' AND NEW.password IS NULL
      AND to_jsonb(NEW)-ARRAY['password','updated_at'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['password','updated_at'])
     OR (OLD.provider_id<>'credential' AND NEW.access_token IS NULL AND NEW.refresh_token IS NULL
      AND NEW.id_token IS NULL AND NEW.access_token_expires_at IS NULL AND NEW.refresh_token_expires_at IS NULL
      AND to_jsonb(NEW)-ARRAY['access_token','refresh_token','id_token','access_token_expires_at','refresh_token_expires_at','updated_at']
       IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['access_token','refresh_token','id_token','access_token_expires_at','refresh_token_expires_at','updated_at']);
   END IF;
  END IF;
 END IF;
 IF NOT coalesce(allowed,false) THEN RAISE EXCEPTION 'AUTH_RESTORE_RECONCILE_REFUSED' USING ERRCODE='EN422';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION identity.guard_restore_authority_change() FROM PUBLIC;
DO $$ DECLARE target regclass;BEGIN
 FOREACH target IN ARRAY ARRAY['org.memberships'::regclass,'org.security_policies'::regclass,
  'org.sso_connections'::regclass,'org.sso_member_links'::regclass,'org.scim_tokens'::regclass,
  'org.team_memberships'::regclass,'org.invitations'::regclass,'identity.sso_providers'::regclass,
  'identity.accounts'::regclass] LOOP
  EXECUTE format('CREATE TRIGGER authority_restore_0422_write BEFORE INSERT OR UPDATE OR DELETE ON %s
   FOR EACH ROW EXECUTE FUNCTION identity.guard_restore_authority_change()',target);
 END LOOP;
END $$;
--> statement-breakpoint

CREATE FUNCTION identity.reconcile_auth_restore(p_generation uuid,p_security_sha256 text,p_actions jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE body jsonb;saved text;saved_gen text;action jsonb;kind text;changed integer;total integer:=0;org_id uuid;row_id uuid;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' OR p_generation IS NULL THEN
  RAISE EXCEPTION 'AUTH_RESTORE_OPERATOR_REQUIRED' USING ERRCODE='42501';END IF;
 IF p_security_sha256 IS NULL OR p_security_sha256!~'^[0-9a-f]{64}$'
  OR jsonb_typeof(p_actions) IS DISTINCT FROM 'array' OR octet_length(p_actions::text)>131072
  OR jsonb_array_length(p_actions) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'AUTH_RESTORE_RECONCILE_REFUSED' USING ERRCODE='EN422';END IF;
 PERFORM id FROM identity.verifications WHERE id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b' FOR UPDATE NOWAIT;
 body:=identity.auth_restore_control();
 IF body->>'generation'<>p_generation::text OR body->>'phase' NOT IN('pending','invalidated') THEN
  RAISE EXCEPTION 'AUTH_RESTORE_GENERATION_CHANGED' USING ERRCODE='EN422';END IF;
 PERFORM identity.lock_auth_restore_authority();
 IF identity.auth_restore_security_fingerprint() IS DISTINCT FROM p_security_sha256 THEN
  RAISE EXCEPTION 'AUTH_RESTORE_REVIEW_CHANGED' USING ERRCODE='EN422';END IF;
 saved:=current_setting('identity.auth_restore_operation',true);saved_gen:=current_setting('identity.auth_restore_generation',true);
 BEGIN
  PERFORM set_config('identity.auth_restore_operation','reconcile',true),set_config('identity.auth_restore_generation',p_generation::text,true);
  FOR action IN SELECT value FROM jsonb_array_elements(p_actions) LOOP
   IF jsonb_typeof(action)<>'object' OR NOT action ?& ARRAY['kind','organizationId','id']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(action) k WHERE k<>ALL(ARRAY['kind','organizationId','id','role']))
    OR jsonb_typeof(action->'kind')<>'string' OR jsonb_typeof(action->'organizationId')<>'string'
    OR jsonb_typeof(action->'id')<>'string' THEN RAISE EXCEPTION 'AUTH_RESTORE_RECONCILE_REFUSED' USING ERRCODE='EN422';END IF;
   kind:=action->>'kind';org_id:=(action->>'organizationId')::uuid;row_id:=(action->>'id')::uuid;
   IF action ? 'role' AND kind<>'downgrade_member' THEN
    RAISE EXCEPTION 'AUTH_RESTORE_RECONCILE_REFUSED' USING ERRCODE='EN422';END IF;
   IF kind='disable_member' THEN
    UPDATE org.memberships SET status='disabled' WHERE organization_id=org_id AND id=row_id;
   ELSIF kind='downgrade_member' AND action->>'role' IN('member','admin') THEN
    UPDATE org.memberships SET role=action->>'role' WHERE organization_id=org_id AND id=row_id;
   ELSIF kind='disable_provider' THEN
    UPDATE org.sso_connections SET state='disabled',auto_join=false,version=version+1,updated_at=clock_timestamp()
     WHERE organization_id=org_id AND id=row_id;
   ELSIF kind='deprovision_member' THEN
    UPDATE org.sso_member_links SET state='deprovisioned',deprovisioned_at=coalesce(deprovisioned_at,clock_timestamp()),
     updated_at=clock_timestamp() WHERE organization_id=org_id AND membership_id=row_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_RESTORE_TARGET_MISSING' USING ERRCODE='EN422';END IF;
    UPDATE org.memberships SET status='disabled' WHERE organization_id=org_id AND id=row_id;
   ELSIF kind='revoke_scim' THEN
    UPDATE org.scim_tokens SET state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp())
     WHERE organization_id=org_id AND id=row_id;
   ELSIF kind='revoke_invitation' THEN
    UPDATE org.invitations SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE organization_id=org_id AND id=row_id;
   ELSIF kind='revoke_password' THEN
    UPDATE identity.accounts a SET password=NULL,updated_at=clock_timestamp()
     WHERE a.id=row_id AND a.provider_id='credential' AND EXISTS(
      SELECT 1 FROM org.memberships m WHERE m.organization_id=org_id AND m.user_id=a.user_id);
   ELSIF kind='revoke_oauth_tokens' THEN
    -- Token material only. This DOES NOT disable the retained provider-account login binding.
    UPDATE identity.accounts a SET access_token=NULL,refresh_token=NULL,id_token=NULL,
     access_token_expires_at=NULL,refresh_token_expires_at=NULL,updated_at=clock_timestamp()
     WHERE a.id=row_id AND a.provider_id<>'credential' AND EXISTS(
      SELECT 1 FROM org.memberships m WHERE m.organization_id=org_id AND m.user_id=a.user_id);
   ELSIF kind='remove_team_access' AND NOT (action ? 'role') THEN
    -- id selects the membership; all of its tenant team access is removed, never broadened.
    DELETE FROM org.team_memberships WHERE organization_id=org_id AND membership_id=row_id;
   ELSE RAISE EXCEPTION 'AUTH_RESTORE_RECONCILE_REFUSED' USING ERRCODE='EN422';END IF;
   GET DIAGNOSTICS changed=ROW_COUNT;
   IF changed=0 THEN RAISE EXCEPTION 'AUTH_RESTORE_TARGET_MISSING' USING ERRCODE='EN422';END IF;
   total:=total+changed;
  END LOOP;
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('identity.auth_restore_operation',coalesce(saved,''),true),set_config('identity.auth_restore_generation',coalesce(saved_gen,''),true);RAISE;
 END;
 PERFORM set_config('identity.auth_restore_operation',coalesce(saved,''),true),set_config('identity.auth_restore_generation',coalesce(saved_gen,''),true);
 RETURN jsonb_build_object('generation',p_generation,'changed',total,'securitySha256',identity.auth_restore_security_fingerprint());
EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'AUTH_RESTORE_RECONCILE_REFUSED' USING ERRCODE='EN422';
END $$;
REVOKE ALL ON FUNCTION identity.reconcile_auth_restore(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.reconcile_auth_restore(uuid,text,jsonb) TO ensemus_migrator;
--> statement-breakpoint

CREATE FUNCTION identity.acknowledge_auth_restore(p_generation uuid,p_backup uuid,p_manifest_sha256 text,
 p_security_sha256 text,p_review_sha256 text,p_review_bytes integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE body jsonb;saved text;saved_scope text;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' OR p_generation IS NULL OR p_backup IS NULL THEN
  RAISE EXCEPTION 'AUTH_RESTORE_OPERATOR_REQUIRED' USING ERRCODE='42501';END IF;
 IF NOT coalesce(p_manifest_sha256~'^[0-9a-f]{64}$' AND p_security_sha256~'^[0-9a-f]{64}$'
   AND p_review_sha256~'^[0-9a-f]{64}$' AND p_review_bytes BETWEEN 1 AND 16777216,false) THEN
  RAISE EXCEPTION 'AUTH_RESTORE_REVIEW_REQUIRED' USING ERRCODE='EN422';END IF;
 PERFORM id FROM identity.verifications WHERE id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b' FOR UPDATE NOWAIT;
 body:=identity.auth_restore_control();
 IF body->>'generation'<>p_generation::text OR body->>'backupId' IS DISTINCT FROM p_backup::text
  OR body->>'manifestSha256' IS DISTINCT FROM p_manifest_sha256
  OR body->>'phase'<>'invalidated' THEN RAISE EXCEPTION 'AUTH_RESTORE_GENERATION_CHANGED' USING ERRCODE='EN422';END IF;
 PERFORM identity.lock_auth_restore_authority();
 LOCK TABLE identity.sessions,identity.session_assurances,identity.verifications,
  identity.setup_tokens,identity.two_factors IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 IF identity.auth_restore_security_fingerprint() IS DISTINCT FROM p_security_sha256 THEN
  RAISE EXCEPTION 'AUTH_RESTORE_REVIEW_CHANGED' USING ERRCODE='EN422';END IF;
 IF NOT identity.auth_restore_owners_reviewable() THEN
  RAISE EXCEPTION 'AUTH_RESTORE_OWNER_REPAIR_REQUIRED' USING ERRCODE='EN422';END IF;
 IF (body->>'notBefore')::timestamptz>clock_timestamp() THEN
  RAISE EXCEPTION 'AUTH_RESTORE_COOLDOWN_REQUIRED' USING ERRCODE='EN422';END IF;
 saved:=current_setting('identity.auth_restore_operation',true);saved_scope:=current_setting('identity.auth_restore_review_scope',true);
 BEGIN
  PERFORM set_config('identity.auth_restore_review_scope','v1',true);
  IF EXISTS(SELECT 1 FROM org.organizations o WHERE o.lifecycle<>'deleted' AND NOT EXISTS(
   SELECT 1 FROM org.memberships m WHERE m.organization_id=o.id AND m.role='owner' AND m.status='active')) THEN
   RAISE EXCEPTION 'AUTH_RESTORE_OWNER_REPAIR_REQUIRED' USING ERRCODE='EN422';END IF;
  PERFORM set_config('identity.auth_restore_operation','acknowledge',true);
  UPDATE identity.verifications SET value=(body||jsonb_build_object('phase','admitted',
   'securitySha256',p_security_sha256,'externalReviewSha256',p_review_sha256,
   'externalReviewBytes',p_review_bytes,'admittedAt',clock_timestamp()))::text
   WHERE id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b';
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('identity.auth_restore_operation',coalesce(saved,''),true),set_config('identity.auth_restore_review_scope',coalesce(saved_scope,''),true);RAISE;
 END;
 PERFORM set_config('identity.auth_restore_operation',coalesce(saved,''),true),set_config('identity.auth_restore_review_scope',coalesce(saved_scope,''),true);
 RETURN p_generation;
END $$;
REVOKE ALL ON FUNCTION identity.acknowledge_auth_restore(uuid,uuid,text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.acknowledge_auth_restore(uuid,uuid,text,text,text,integer) TO ensemus_migrator;
--> statement-breakpoint

-- A stopped or stale auth image must not serve a backed-up session even before deletion finishes.
-- The auth-only invalidation transaction can inspect the actual rows it must remove; an ordinary
-- native request cannot turn a hidden/RLS-filtered zero into a cleanup certificate.
CREATE FUNCTION identity.auth_restore_read_allowed() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE body jsonb;
BEGIN
 IF session_user='ensemus_migrator' THEN RETURN true;END IF;
 body:=identity.auth_restore_control();
 IF body->>'phase'='admitted' OR (session_user='ensemus_auth'
  AND body->>'phase' IN('pending','invalidated') AND current_setting('identity.auth_restore_operation',true)='invalidate'
  AND current_setting('identity.auth_restore_generation',true)=body->>'generation') THEN RETURN true;END IF;
 RAISE EXCEPTION 'RESTORE_PENDING' USING ERRCODE='EN422';
END $$;
REVOKE ALL ON FUNCTION identity.auth_restore_read_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.auth_restore_read_allowed() TO ensemus_auth;
DO $$ DECLARE target regclass;BEGIN
 FOREACH target IN ARRAY ARRAY['identity.users'::regclass,'identity.accounts'::regclass,'identity.sessions'::regclass,
  'identity.session_assurances'::regclass,'identity.two_factors'::regclass,'identity.setup_tokens'::regclass,
  'identity.sso_providers'::regclass] LOOP
  EXECUTE format('CREATE POLICY auth_restore_read ON %s AS RESTRICTIVE FOR SELECT TO ensemus_auth
   USING(identity.auth_restore_read_allowed())',target);
 END LOOP;
END $$;
CREATE POLICY auth_restore_read ON identity.verifications AS RESTRICTIVE FOR SELECT TO ensemus_auth
 USING(CASE WHEN id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b' THEN true ELSE identity.auth_restore_read_allowed() END);
--> statement-breakpoint

-- Fixed owner metadata functions also retain the caller's actual session_user. Closing their
-- source rows prevents a stale MFA/SSO/member guard from bypassing pending admission through its
-- SECURITY DEFINER current_user. Only the one control row avoids recursive admission lookup.
DO $$ DECLARE target regclass;BEGIN
 FOREACH target IN ARRAY ARRAY['identity.users'::regclass,'identity.accounts'::regclass,'identity.sessions'::regclass,
  'identity.session_assurances'::regclass,'identity.two_factors'::regclass,'identity.setup_tokens'::regclass,
  'org.organizations'::regclass,'org.memberships'::regclass,'org.security_policies'::regclass,
  'org.sso_connections'::regclass,'org.sso_member_links'::regclass,'org.scim_tokens'::regclass,
  'platform.domain_events'::regclass,'platform.outbox_events'::regclass,'studio.process_run_intents'::regclass,
  'identity.sso_providers'::regclass] LOOP
  EXECUTE format('CREATE POLICY auth_restore_owner_read ON %s AS RESTRICTIVE FOR SELECT TO ensemus_migrator
   USING(identity.auth_restore_read_allowed())',target);
 END LOOP;
END $$;
CREATE POLICY auth_restore_owner_read ON identity.verifications AS RESTRICTIVE FOR SELECT TO ensemus_migrator
 USING(CASE WHEN current_setting('identity.auth_restore_control_scope',true)='v1' THEN
  id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b' AND identifier='ensemus-auth-restore:v1'
  ELSE CASE WHEN id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b' THEN true
   ELSE identity.auth_restore_read_allowed() END END);
--> statement-breakpoint

-- This existing private table holds one bounded control document, not an auth proof or user input.
CREATE POLICY verifications_restore_control_owner ON identity.verifications TO ensemus_migrator
 USING(id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b'::uuid AND identifier='ensemus-auth-restore:v1')
 WITH CHECK(id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b'::uuid AND identifier='ensemus-auth-restore:v1');
CREATE UNIQUE INDEX verifications_restore_control_identifier ON identity.verifications(identifier)
 WHERE identifier='ensemus-auth-restore:v1';
--> statement-breakpoint

DO $$ DECLARE target regclass;BEGIN
 FOREACH target IN ARRAY ARRAY['identity.sessions'::regclass,'identity.session_assurances'::regclass,
  'identity.verifications'::regclass,'identity.two_factors'::regclass,'identity.setup_tokens'::regclass] LOOP
  EXECUTE format('CREATE POLICY auth_restore_fixed_count ON %s FOR SELECT TO ensemus_migrator
   USING(session_user IN(''ensemus_auth'',''ensemus_migrator'')
    AND current_setting(''identity.auth_restore_count_scope'',true)=''v1'')',target);
 END LOOP;
END $$;
CREATE FUNCTION identity.auth_restore_transient_counts() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE saved text;saved_control text;answer jsonb;
BEGIN
 IF session_user NOT IN('ensemus_auth','ensemus_migrator') THEN
  RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='42501';END IF;
 saved:=current_setting('identity.auth_restore_count_scope',true);
 saved_control:=current_setting('identity.auth_restore_control_scope',true);
 BEGIN
  -- A caller-supplied narrowing scope must never turn existing proof rows into a false zero.
  PERFORM set_config('identity.auth_restore_count_scope','v1',true),
   set_config('identity.auth_restore_control_scope','',true);
  SELECT jsonb_build_object('sessions',(SELECT count(*) FROM identity.sessions),
   'assurances',(SELECT count(*) FROM identity.session_assurances),
   'verifications',(SELECT count(*) FROM identity.verifications WHERE id<>'68766d8e-9f7d-4b87-b881-bb4c3ff1654b'),
   'setupTokens',(SELECT count(*) FROM identity.setup_tokens WHERE used_at IS NULL),
   'backupSets',(SELECT count(*) FROM identity.two_factors)) INTO answer;
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('identity.auth_restore_count_scope',coalesce(saved,''),true),
   set_config('identity.auth_restore_control_scope',coalesce(saved_control,''),true);RAISE;END;
 PERFORM set_config('identity.auth_restore_count_scope',coalesce(saved,''),true),
  set_config('identity.auth_restore_control_scope',coalesce(saved_control,''),true);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION identity.auth_restore_transient_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.auth_restore_transient_counts() TO ensemus_auth,ensemus_migrator;
--> statement-breakpoint

CREATE FUNCTION identity.auth_restore_control() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE body jsonb;saved text;
BEGIN
 saved:=current_setting('identity.auth_restore_control_scope',true);
 BEGIN
  PERFORM set_config('identity.auth_restore_control_scope','v1',true);
  SELECT v.value::jsonb INTO body FROM identity.verifications v
   WHERE v.id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b' AND v.identifier='ensemus-auth-restore:v1';
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('identity.auth_restore_control_scope',coalesce(saved,''),true);RAISE;END;
 PERFORM set_config('identity.auth_restore_control_scope',coalesce(saved,''),true);
 IF NOT coalesce(body->'version'='1'::jsonb AND body->>'generation'~'^[0-9a-f-]{36}$'
  AND body->>'phase' IN('pending','invalidated','admitted')
  AND body ?& ARRAY['version','generation','phase','backupId','manifestSha256','cutoff','notBefore',
   'invalidation','securitySha256','externalReviewSha256','externalReviewBytes','admittedAt'],false) THEN
  RAISE EXCEPTION 'RESTORE_PENDING' USING ERRCODE='EN422';END IF;
 PERFORM (body->>'generation')::uuid;
 RETURN body;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN
 RAISE EXCEPTION 'RESTORE_PENDING' USING ERRCODE='EN422';
END $$;
REVOKE ALL ON FUNCTION identity.auth_restore_control() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION app.assert_restore_admitted() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE body jsonb;
BEGIN
 -- session_user remains the real login through every fixed SECURITY DEFINER metadata function.
 IF session_user='ensemus_migrator' THEN RETURN;END IF;
 body:=identity.auth_restore_control();
 IF body->>'phase'<>'admitted' THEN RAISE EXCEPTION 'RESTORE_PENDING' USING ERRCODE='EN422';END IF;
END $$;
REVOKE ALL ON FUNCTION app.assert_restore_admitted() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_restore_admitted() TO ensemus_app,ensemus_agent,ensemus_auth,
 ensemus_dispatcher,ensemus_secrets,ensemus_operator,ensemus_support,ensemus_eraser,ensemus_migrator;
--> statement-breakpoint

-- Keep the public function OID: already-parsed RLS/view expressions must receive this guard too.
-- Raising instead of NULL prevents a closed tenant from becoming an "unbound discovery" context.
CREATE OR REPLACE FUNCTION app.current_organization_id() RETURNS uuid LANGUAGE plpgsql STABLE
SET search_path=pg_catalog AS $$
BEGIN
 PERFORM app.assert_restore_admitted();
 RETURN nullif(current_setting('app.organization_id',true),'')::uuid;
END $$;
--> statement-breakpoint

CREATE FUNCTION app.current_auth_restore_generation() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE body jsonb;
BEGIN
 body:=identity.auth_restore_control();
 -- No migrator bypass here: a generation that admits prepaid/native outcomes must be ready.
 IF body->>'phase'<>'admitted' THEN RAISE EXCEPTION 'RESTORE_PENDING' USING ERRCODE='EN422';END IF;
 RETURN (body->>'generation')::uuid;
END $$;
REVOKE ALL ON FUNCTION app.current_auth_restore_generation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_auth_restore_generation() TO ensemus_app,ensemus_agent,ensemus_secrets,
 ensemus_dispatcher,ensemus_operator,ensemus_support,ensemus_eraser,ensemus_migrator;
CREATE POLICY auth_restore_dispatch_admission ON platform.domain_events AS RESTRICTIVE FOR SELECT TO ensemus_dispatcher
 USING(app.current_auth_restore_generation() IS NOT NULL);
CREATE POLICY auth_restore_dispatch_admission ON platform.outbox_events AS RESTRICTIVE TO ensemus_dispatcher
 USING(app.current_auth_restore_generation() IS NOT NULL) WITH CHECK(app.current_auth_restore_generation() IS NOT NULL);
--> statement-breakpoint

CREATE FUNCTION identity.auth_restore_admission() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE body jsonb;
BEGIN
 body:=identity.auth_restore_control();
 RETURN jsonb_build_object('version',1,'phase',body->'phase','generation',body->'generation',
  'cutoff',body->'cutoff','notBefore',body->'notBefore');
END $$;

--> statement-breakpoint
-- FINAL COMPOSITION OBLIGATION: 0999 must call this after later SaaS tables AND eraser grants.
-- No role gets a new table/column privilege. Existing RLS remains the body/tenant authority; this
-- restrictive layer only closes raw offline-role DML during pending restore. No event trigger.
CREATE FUNCTION identity.extend_auth_restore_admission() RETURNS integer LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE role_name text;role_oid oid;target record;policy_name text;existing record;changed integer:=0;required_table text;
 schemas constant text[]:=ARRAY['identity','org','platform','governance','secrets','work','integrations',
  'ai','knowledge','sovereign','studio','objects','packs','experience','billing','support','lifecycle','operations'];
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator'
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'AUTH_RESTORE_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 FOREACH required_table IN ARRAY ARRAY['billing.plan_versions','support.tickets','lifecycle.offboardings',
  'operations.incidents','work.work_units'] LOOP
  IF to_regclass(required_table) IS NULL THEN
   RAISE EXCEPTION 'AUTH_RESTORE_ROLE_INVENTORY_MISSING' USING ERRCODE='EN422';END IF;
 END LOOP;
 IF NOT has_any_column_privilege('ensemus_operator','billing.plan_versions','SELECT')
  OR NOT has_any_column_privilege('ensemus_support','support.tickets','SELECT')
  OR NOT has_table_privilege('ensemus_eraser','work.work_units','DELETE') THEN
  RAISE EXCEPTION 'AUTH_RESTORE_ROLE_INVENTORY_MISSING' USING ERRCODE='EN422';END IF;
 FOREACH role_name IN ARRAY ARRAY['ensemus_operator','ensemus_support','ensemus_eraser'] LOOP
  SELECT oid INTO role_oid FROM pg_roles WHERE rolname=role_name;
  IF role_oid IS NULL THEN RAISE EXCEPTION 'AUTH_RESTORE_ROLE_INVENTORY_MISSING' USING ERRCODE='EN422';END IF;
  FOR target IN SELECT c.oid,n.nspname AS schema_name,c.relname AS table_name,c.relrowsecurity,c.relforcerowsecurity
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind IN('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
    AND (has_table_privilege(role_name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      OR has_any_column_privilege(role_name,c.oid,'SELECT,INSERT,UPDATE'))
   ORDER BY n.nspname,c.relname LOOP
   IF NOT target.schema_name=ANY(schemas) OR NOT target.relrowsecurity OR NOT target.relforcerowsecurity
    OR has_table_privilege(role_name,target.oid,'TRUNCATE') THEN
    RAISE EXCEPTION 'AUTH_RESTORE_ROLE_TABLE_UNCOVERED' USING ERRCODE='EN422';END IF;
   policy_name:='auth_restore_0422_'||substr(role_name,9);
   SELECT * INTO existing FROM pg_policy WHERE polrelid=target.oid AND polname=policy_name;
   IF FOUND THEN
    IF existing.polpermissive OR existing.polcmd<>'*' OR existing.polroles<>ARRAY[role_oid]
     OR regexp_replace(pg_get_expr(existing.polqual,existing.polrelid),'[[:space:]()]','','g')
       IS DISTINCT FROM 'app.current_auth_restore_generationISNOTNULL'
     OR regexp_replace(pg_get_expr(existing.polwithcheck,existing.polrelid),'[[:space:]()]','','g')
       IS DISTINCT FROM 'app.current_auth_restore_generationISNOTNULL' THEN
     RAISE EXCEPTION 'AUTH_RESTORE_ROLE_POLICY_CHANGED' USING ERRCODE='EN422';END IF;
   ELSE
    EXECUTE format('CREATE POLICY %I ON %I.%I AS RESTRICTIVE TO %I
     USING(app.current_auth_restore_generation() IS NOT NULL)
     WITH CHECK(app.current_auth_restore_generation() IS NOT NULL)',policy_name,target.schema_name,target.table_name,role_name);
    changed:=changed+1;
   END IF;
  END LOOP;
 END LOOP;
 RETURN changed;
END $$;
REVOKE ALL ON FUNCTION identity.extend_auth_restore_admission() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.extend_auth_restore_admission() TO ensemus_migrator;
REVOKE ALL ON FUNCTION identity.auth_restore_admission() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.auth_restore_admission() TO ensemus_auth;
--> statement-breakpoint

CREATE FUNCTION identity.guard_auth_restore_control() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE body jsonb;prior jsonb;counts jsonb;operation text:=current_setting('identity.auth_restore_operation',true);
 control_id constant uuid:='68766d8e-9f7d-4b87-b881-bb4c3ff1654b';observed timestamptz:=clock_timestamp();
BEGIN
 IF TG_RELID<>'identity.verifications'::regclass OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN
  RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.id=control_id OR OLD.identifier='ensemus-auth-restore:v1' THEN
   RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
  RETURN OLD;
 END IF;
 IF NEW.id<>control_id AND NEW.identifier<>'ensemus-auth-restore:v1'
  AND (TG_OP='INSERT' OR (OLD.id<>control_id AND OLD.identifier<>'ensemus-auth-restore:v1')) THEN RETURN NEW;END IF;
 IF NEW.id<>control_id OR NEW.identifier<>'ensemus-auth-restore:v1' OR octet_length(NEW.value)>16384
  OR NEW.expires_at IS DISTINCT FROM '9999-01-01T00:00:00Z'::timestamptz
  OR (TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.identifier IS DISTINCT FROM OLD.identifier
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at)) THEN
  RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
 body:=NEW.value::jsonb;
 IF jsonb_typeof(body)<>'object' OR body->'version' IS DISTINCT FROM '1'::jsonb
  OR NOT body ?& ARRAY['version','generation','phase','backupId','manifestSha256','cutoff','notBefore',
   'invalidation','securitySha256','externalReviewSha256','externalReviewBytes','admittedAt']
  OR NOT coalesce(body->>'generation'~'^[0-9a-f-]{36}$' AND body->>'phase' IN('pending','invalidated','admitted'),false)
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(body) k WHERE k<>ALL(ARRAY[
   'version','generation','phase','backupId','manifestSha256','cutoff','notBefore','invalidation',
   'securitySha256','externalReviewSha256','externalReviewBytes','admittedAt'])) THEN
  RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
 PERFORM (body->>'generation')::uuid;
 IF body->'backupId'<>'null'::jsonb AND NOT coalesce(jsonb_typeof(body->'backupId')='string'
  AND body->>'manifestSha256'~'^[0-9a-f]{64}$' AND jsonb_typeof(body->'cutoff')='string'
  AND jsonb_typeof(body->'notBefore')='string',false) THEN
  RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
 IF TG_OP='INSERT' THEN
  IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' OR operation<>'initial-install'
   OR body->>'phase'<>'admitted' OR body->'backupId'<>'null'::jsonb OR body->'manifestSha256'<>'null'::jsonb
   OR body->'cutoff'<>'null'::jsonb OR body->'notBefore'<>'null'::jsonb OR body->'invalidation'<>'null'::jsonb
   OR body->'securitySha256'<>'null'::jsonb OR body->'externalReviewSha256'<>'null'::jsonb
   OR body->'externalReviewBytes'<>'null'::jsonb THEN
   RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
 ELSE
  prior:=OLD.value::jsonb;
  IF current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND operation='begin' THEN
   IF body->>'phase'<>'pending' OR body->>'generation'=prior->>'generation'
    OR NOT coalesce(body->>'backupId'~'^[0-9a-f-]{36}$' AND body->>'manifestSha256'~'^[0-9a-f]{64}$',false)
    OR (body->>'cutoff')::timestamptz>observed OR (body->>'cutoff')::timestamptz<observed-interval '1 minute'
    OR (body->>'notBefore')::timestamptz<(body->>'cutoff')::timestamptz+interval '15 minutes'
    OR body->'invalidation'<>'null'::jsonb OR body->'securitySha256'<>'null'::jsonb
    OR body->'externalReviewSha256'<>'null'::jsonb OR body->'externalReviewBytes'<>'null'::jsonb
    OR body->'admittedAt'<>'null'::jsonb THEN
    RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
   ELSIF current_user='ensemus_auth' AND session_user='ensemus_auth' AND operation='invalidate' THEN
    IF prior->>'phase'<>'pending' OR body->>'phase'<>'invalidated'
     OR body-'invalidation'-'phase' IS DISTINCT FROM prior-'invalidation'-'phase'
     OR current_setting('identity.auth_restore_generation',true) IS DISTINCT FROM body->>'generation'
     OR jsonb_typeof(body->'invalidation') IS DISTINCT FROM 'object'
     OR NOT (body->'invalidation') ?& ARRAY['version','completedAt','emptyBackupCipherSha256',
      'sessionsRemoved','assurancesRemoved','verificationsRemoved','setupTokensRevoked','backupCodeSetsRevoked']
     OR body#>'{invalidation,version}' IS DISTINCT FROM '1'::jsonb
     OR NOT coalesce(body#>>'{invalidation,emptyBackupCipherSha256}'~'^[0-9a-f]{64}$',false)
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(body->'invalidation') k WHERE k<>ALL(ARRAY[
      'version','completedAt','emptyBackupCipherSha256','sessionsRemoved','assurancesRemoved',
      'verificationsRemoved','setupTokensRevoked','backupCodeSetsRevoked']))
     OR EXISTS(SELECT 1 FROM unnest(ARRAY['sessionsRemoved','assurancesRemoved','verificationsRemoved',
      'setupTokensRevoked','backupCodeSetsRevoked']) k WHERE
       jsonb_typeof(body->'invalidation'->k) IS DISTINCT FROM 'number'
       OR NOT coalesce(body->'invalidation'->>k~'^(0|[1-9][0-9]{0,14})$',false))
     OR jsonb_typeof(body#>'{invalidation,completedAt}') IS DISTINCT FROM 'string'
     OR (body#>>'{invalidation,completedAt}')::timestamptz<(body->>'cutoff')::timestamptz
     OR (body#>>'{invalidation,completedAt}')::timestamptz>observed
     OR (body#>>'{invalidation,backupCodeSetsRevoked}')::bigint<>(SELECT count(*) FROM identity.two_factors)
     OR EXISTS(SELECT 1 FROM identity.sessions) OR EXISTS(SELECT 1 FROM identity.session_assurances)
     OR EXISTS(SELECT 1 FROM identity.verifications v WHERE v.id<>control_id)
     OR EXISTS(SELECT 1 FROM identity.setup_tokens t WHERE t.used_at IS NULL)
     OR EXISTS(SELECT 1 FROM identity.two_factors f WHERE
       encode(sha256(convert_to(f.backup_codes,'UTF8')),'hex') IS DISTINCT FROM body#>>'{invalidation,emptyBackupCipherSha256}'
       OR f.locked_until IS NULL OR f.locked_until<(body->>'notBefore')::timestamptz) THEN
     RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
   ELSIF current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND operation='acknowledge' THEN
    PERFORM identity.lock_auth_restore_authority();
    IF NOT identity.auth_restore_owners_reviewable() THEN
     RAISE EXCEPTION 'AUTH_RESTORE_OWNER_REPAIR_REQUIRED' USING ERRCODE='EN422';END IF;
    counts:=identity.auth_restore_transient_counts();
    IF prior->>'phase'<>'invalidated' OR body->>'phase'<>'admitted'
     OR body-ARRAY['phase','securitySha256','externalReviewSha256','externalReviewBytes','admittedAt']
       IS DISTINCT FROM prior-ARRAY['phase','securitySha256','externalReviewSha256','externalReviewBytes','admittedAt']
     OR NOT coalesce(body->>'securitySha256'~'^[0-9a-f]{64}$' AND body->>'externalReviewSha256'~'^[0-9a-f]{64}$',false)
     OR jsonb_typeof(body->'externalReviewBytes')<>'number'
     OR NOT coalesce(body->>'externalReviewBytes'~'^[1-9][0-9]{0,7}$',false)
     OR (body->>'externalReviewBytes')::bigint>16777216
     OR body->>'securitySha256' IS DISTINCT FROM identity.auth_restore_security_fingerprint()
     OR counts->>'sessions'<>'0' OR counts->>'assurances'<>'0'
     OR counts->>'verifications'<>'0' OR counts->>'setupTokens'<>'0'
     OR (counts->>'backupSets')::bigint IS DISTINCT FROM (body#>>'{invalidation,backupCodeSetsRevoked}')::bigint
     OR EXISTS(SELECT 1 FROM identity.two_factors f WHERE
       encode(sha256(convert_to(f.backup_codes,'UTF8')),'hex') IS DISTINCT FROM body#>>'{invalidation,emptyBackupCipherSha256}'
       OR f.locked_until IS NULL OR f.locked_until<(body->>'notBefore')::timestamptz)
     OR (body->>'notBefore')::timestamptz>observed OR (body->>'admittedAt')::timestamptz>observed
     OR (body->>'admittedAt')::timestamptz<observed-interval '1 minute' THEN
     RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
   ELSE RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';
  END IF;
 END IF;
 NEW.updated_at:=observed;RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR datetime_field_overflow THEN
 RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';
END $$;
REVOKE ALL ON FUNCTION identity.guard_auth_restore_control() FROM PUBLIC;
CREATE TRIGGER verifications_0422a_control BEFORE INSERT OR UPDATE OR DELETE ON identity.verifications
 FOR EACH ROW EXECUTE FUNCTION identity.guard_auth_restore_control();
--> statement-breakpoint

-- Initial deployment is explicit, not a missing-row-as-ready fallback. A restored deployment must
-- invoke begin after schema readiness; the protected seed is not evidence that a restore was reviewed.
DO $$ BEGIN
 PERFORM set_config('identity.auth_restore_operation','initial-install',true);
 INSERT INTO identity.verifications(id,identifier,value,expires_at) VALUES(
  '68766d8e-9f7d-4b87-b881-bb4c3ff1654b','ensemus-auth-restore:v1',
  jsonb_build_object('version',1,'generation',gen_random_uuid(),'phase','admitted','backupId',NULL,
   'manifestSha256',NULL,'cutoff',NULL,'notBefore',NULL,'invalidation',NULL,'securitySha256',NULL,
   'externalReviewSha256',NULL,'externalReviewBytes',NULL,'admittedAt',clock_timestamp())::text,'9999-01-01T00:00:00Z');
 PERFORM set_config('identity.auth_restore_operation','',true);
END $$;
--> statement-breakpoint

CREATE FUNCTION identity.begin_auth_restore(p_backup uuid,p_manifest_sha256 text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE generation uuid:=gen_random_uuid();observed timestamptz:=clock_timestamp();previous text;previous_gen text;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' OR p_backup IS NULL
  OR p_manifest_sha256 IS NULL OR p_manifest_sha256!~'^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'AUTH_RESTORE_OPERATOR_REQUIRED' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename IN(
  'ensemus_app','ensemus_agent','ensemus_auth','ensemus_dispatcher','ensemus_secrets',
  'ensemus_operator','ensemus_support','ensemus_eraser')) THEN
  RAISE EXCEPTION 'AUTH_RESTORE_READERS_STILL_CONNECTED' USING ERRCODE='EN422';END IF;
 PERFORM v.id FROM identity.verifications v WHERE v.id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b'
  AND v.identifier='ensemus-auth-restore:v1' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESTORE_PENDING' USING ERRCODE='EN422';END IF;
 PERFORM identity.lock_auth_restore_authority();
 -- The same transaction fences all backed-up material proofs. Missing 0515 refuses the begin.
 PERFORM sovereign.rotate_material_restore_generation();
 observed:=clock_timestamp();
 previous:=current_setting('identity.auth_restore_operation',true);
 previous_gen:=current_setting('identity.auth_restore_generation',true);
 BEGIN
  PERFORM set_config('identity.auth_restore_operation','begin',true);
  UPDATE identity.verifications SET value=jsonb_build_object('version',1,'generation',generation,
   'phase','pending','backupId',p_backup,'manifestSha256',p_manifest_sha256,'cutoff',observed,
   'notBefore',observed+interval '15 minutes','invalidation',NULL,'securitySha256',NULL,
   'externalReviewSha256',NULL,'externalReviewBytes',NULL,'admittedAt',NULL)::text WHERE id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b';
  -- A dump can resurrect a consumed invitation or a revoked SCIM bearer. Keep their history,
  -- but make every outstanding grant inert; a later owner must issue genuinely new credentials.
  PERFORM set_config('identity.auth_restore_operation','reconcile',true),
   set_config('identity.auth_restore_generation',generation::text,true);
  UPDATE org.invitations SET revoked_at=clock_timestamp() WHERE accepted_at IS NULL AND revoked_at IS NULL;
  UPDATE org.scim_tokens SET state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp())
   WHERE state<>'revoked' OR revoked_at IS NULL;
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('identity.auth_restore_operation',coalesce(previous,''),true),
   set_config('identity.auth_restore_generation',coalesce(previous_gen,''),true);RAISE;END;
 PERFORM set_config('identity.auth_restore_operation',coalesce(previous,''),true),
  set_config('identity.auth_restore_generation',coalesce(previous_gen,''),true);
 RETURN generation;
END $$;
REVOKE ALL ON FUNCTION identity.begin_auth_restore(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.begin_auth_restore(uuid,text) TO ensemus_migrator;
--> statement-breakpoint

-- Old or accidentally restarted auth binaries cannot mint sessions/proofs while reconciliation is
-- pending. Auth cleanup is allowed, but the protected control row has its own nondeletable guard.
CREATE FUNCTION identity.guard_auth_restore_native_write() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE body jsonb;allowed boolean:=false;cipher_hash text;
BEGIN
 IF TG_RELID NOT IN('identity.users'::regclass,'identity.accounts'::regclass,'identity.sessions'::regclass,
  'identity.session_assurances'::regclass,'identity.verifications'::regclass,'identity.two_factors'::regclass,
  'identity.setup_tokens'::regclass,'identity.sso_providers'::regclass) OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN
  RAISE EXCEPTION 'AUTH_RESTORE_WRITE_REFUSED' USING ERRCODE='EN422';END IF;
 IF TG_RELID='identity.verifications'::regclass THEN
  IF (TG_OP='DELETE' AND OLD.identifier='ensemus-auth-restore:v1')
   OR (TG_OP<>'DELETE' AND NEW.identifier='ensemus-auth-restore:v1') THEN
   IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
  END IF;
 END IF;
 IF session_user='ensemus_migrator' AND current_user='ensemus_migrator' THEN
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END IF;
 body:=identity.auth_restore_admission();
 IF body->>'phase'='admitted' THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 IF current_user='ensemus_auth' AND session_user='ensemus_auth' THEN
  IF TG_OP='DELETE' AND TG_RELID IN('identity.sessions'::regclass,'identity.session_assurances'::regclass,
   'identity.verifications'::regclass) THEN RETURN OLD;END IF;
  IF body->>'phase'='pending' AND current_setting('identity.auth_restore_operation',true)='invalidate'
   AND current_setting('identity.auth_restore_generation',true)=body->>'generation' THEN
   IF TG_OP='UPDATE' AND TG_RELID='identity.setup_tokens'::regclass THEN
    allowed:=OLD.used_at IS NULL AND NEW.used_at IS NOT NULL
     AND to_jsonb(NEW)-'used_at' IS NOT DISTINCT FROM to_jsonb(OLD)-'used_at';
   ELSIF TG_OP='UPDATE' AND TG_RELID='identity.two_factors'::regclass THEN
    cipher_hash:=current_setting('identity.auth_restore_empty_cipher_sha256',true);
    allowed:=cipher_hash~'^[0-9a-f]{64}$'
     AND encode(sha256(convert_to(NEW.backup_codes,'UTF8')),'hex')=cipher_hash
     AND NEW.locked_until>=(body->>'notBefore')::timestamptz
     AND (OLD.locked_until IS NULL OR NEW.locked_until>=OLD.locked_until)
     AND to_jsonb(NEW)-ARRAY['backup_codes','locked_until']
       IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['backup_codes','locked_until'];
   END IF;
  END IF;
 END IF;
 IF NOT coalesce(allowed,false) THEN RAISE EXCEPTION 'RESTORE_PENDING' USING ERRCODE='EN422';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION identity.guard_auth_restore_native_write() FROM PUBLIC;
DO $$ DECLARE target regclass;BEGIN
 FOREACH target IN ARRAY ARRAY['identity.users'::regclass,'identity.accounts'::regclass,'identity.sessions'::regclass,
  'identity.session_assurances'::regclass,'identity.verifications'::regclass,'identity.two_factors'::regclass,
  'identity.setup_tokens'::regclass,'identity.sso_providers'::regclass] LOOP
  EXECUTE format('CREATE TRIGGER auth_restore_0422_write BEFORE INSERT OR UPDATE OR DELETE ON %s
   FOR EACH ROW EXECUTE FUNCTION identity.guard_auth_restore_native_write()',target);
 END LOOP;
END $$;
