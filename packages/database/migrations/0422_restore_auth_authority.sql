-- UNREGISTERED SOURCE. Restore is operator maintenance, never a tenant-owner/native-session grant.
-- 0515's material generation helper must exist before begin is called; its body is deferred here.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR pg_has_role(current_user,'ensemus_auth','member') THEN
  RAISE EXCEPTION 'AUTH_RESTORE_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
END $$;
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
  'identity.session_assurances'::regclass,'identity.two_factors'::regclass,'identity.setup_tokens'::regclass] LOOP
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
  'platform.domain_events'::regclass,'platform.outbox_events'::regclass,'studio.process_run_intents'::regclass] LOOP
  EXECUTE format('CREATE POLICY auth_restore_owner_read ON %s AS RESTRICTIVE FOR SELECT TO ensemus_migrator
   USING(identity.auth_restore_read_allowed())',target);
 END LOOP;
END $$;
CREATE POLICY auth_restore_owner_read ON identity.verifications AS RESTRICTIVE FOR SELECT TO ensemus_migrator
 USING(CASE WHEN id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b' THEN true ELSE identity.auth_restore_read_allowed() END);
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
DECLARE saved text;answer jsonb;
BEGIN
 IF session_user NOT IN('ensemus_auth','ensemus_migrator') THEN
  RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='42501';END IF;
 saved:=current_setting('identity.auth_restore_count_scope',true);
 BEGIN
  PERFORM set_config('identity.auth_restore_count_scope','v1',true);
  SELECT jsonb_build_object('sessions',(SELECT count(*) FROM identity.sessions),
   'assurances',(SELECT count(*) FROM identity.session_assurances),
   'verifications',(SELECT count(*) FROM identity.verifications WHERE id<>'68766d8e-9f7d-4b87-b881-bb4c3ff1654b'),
   'setupTokens',(SELECT count(*) FROM identity.setup_tokens WHERE used_at IS NULL),
   'backupSets',(SELECT count(*) FROM identity.two_factors)) INTO answer;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('identity.auth_restore_count_scope',coalesce(saved,''),true);RAISE;END;
 PERFORM set_config('identity.auth_restore_count_scope',coalesce(saved,''),true);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION identity.auth_restore_transient_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.auth_restore_transient_counts() TO ensemus_auth,ensemus_migrator;
--> statement-breakpoint

CREATE FUNCTION identity.auth_restore_control() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE body jsonb;
BEGIN
 SELECT v.value::jsonb INTO body FROM identity.verifications v
  WHERE v.id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b' AND v.identifier='ensemus-auth-restore:v1';
 IF NOT coalesce(body->'version'='1'::jsonb AND body->>'generation'~'^[0-9a-f-]{36}$'
  AND body->>'phase' IN('pending','invalidated','admitted')
  AND body ?& ARRAY['version','generation','phase','backupId','manifestSha256','cutoff','notBefore',
   'invalidation','securitySha256','externalReviewSha256','admittedAt'],false) THEN
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
GRANT EXECUTE ON FUNCTION app.current_auth_restore_generation() TO ensemus_app,ensemus_agent,ensemus_secrets,ensemus_dispatcher,ensemus_migrator;
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
  OR (TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.identifier IS DISTINCT FROM OLD.identifier
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at)) THEN
  RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
 body:=NEW.value::jsonb;
 IF jsonb_typeof(body)<>'object' OR body->'version' IS DISTINCT FROM '1'::jsonb
  OR NOT body ?& ARRAY['version','generation','phase','backupId','manifestSha256','cutoff','notBefore',
   'invalidation','securitySha256','externalReviewSha256','admittedAt']
  OR NOT coalesce(body->>'generation'~'^[0-9a-f-]{36}$' AND body->>'phase' IN('pending','invalidated','admitted'),false)
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(body) k WHERE k<>ALL(ARRAY[
   'version','generation','phase','backupId','manifestSha256','cutoff','notBefore','invalidation',
   'securitySha256','externalReviewSha256','admittedAt'])) THEN
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
   OR body->'securitySha256'<>'null'::jsonb OR body->'externalReviewSha256'<>'null'::jsonb THEN
   RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
 ELSE
  prior:=OLD.value::jsonb;
  IF current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND operation='begin' THEN
   IF body->>'phase'<>'pending' OR body->>'generation'=prior->>'generation'
    OR NOT coalesce(body->>'backupId'~'^[0-9a-f-]{36}$' AND body->>'manifestSha256'~'^[0-9a-f]{64}$',false)
    OR (body->>'cutoff')::timestamptz>observed OR (body->>'cutoff')::timestamptz<observed-interval '1 minute'
    OR (body->>'notBefore')::timestamptz<(body->>'cutoff')::timestamptz+interval '15 minutes'
    OR body->'invalidation'<>'null'::jsonb OR body->'securitySha256'<>'null'::jsonb
    OR body->'externalReviewSha256'<>'null'::jsonb OR body->'admittedAt'<>'null'::jsonb THEN
    RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
   ELSIF current_user='ensemus_auth' AND session_user='ensemus_auth' AND operation='invalidate' THEN
    IF prior->>'phase'<>'pending' OR body->>'phase'<>'invalidated'
     OR body-'invalidation'-'phase' IS DISTINCT FROM prior-'invalidation'-'phase'
     OR current_setting('identity.auth_restore_generation',true) IS DISTINCT FROM body->>'generation'
     OR NOT coalesce(body#>>'{invalidation,emptyBackupCipherSha256}'~'^[0-9a-f]{64}$',false)
     OR EXISTS(SELECT 1 FROM identity.sessions) OR EXISTS(SELECT 1 FROM identity.session_assurances)
     OR EXISTS(SELECT 1 FROM identity.verifications v WHERE v.id<>control_id)
     OR EXISTS(SELECT 1 FROM identity.setup_tokens t WHERE t.used_at IS NULL)
     OR EXISTS(SELECT 1 FROM identity.two_factors f WHERE
       encode(sha256(convert_to(f.backup_codes,'UTF8')),'hex') IS DISTINCT FROM body#>>'{invalidation,emptyBackupCipherSha256}'
       OR f.locked_until IS NULL OR f.locked_until<(body->>'notBefore')::timestamptz) THEN
     RAISE EXCEPTION 'AUTH_RESTORE_CONTROL_REFUSED' USING ERRCODE='EN422';END IF;
   ELSIF current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND operation='acknowledge' THEN
    counts:=identity.auth_restore_transient_counts();
    IF prior->>'phase'<>'invalidated' OR body->>'phase'<>'admitted'
     OR body-ARRAY['phase','securitySha256','externalReviewSha256','admittedAt']
       IS DISTINCT FROM prior-ARRAY['phase','securitySha256','externalReviewSha256','admittedAt']
     OR NOT coalesce(body->>'securitySha256'~'^[0-9a-f]{64}$' AND body->>'externalReviewSha256'~'^[0-9a-f]{64}$',false)
     OR body->>'securitySha256' IS DISTINCT FROM identity.auth_restore_security_fingerprint()
     OR counts->>'sessions'<>'0' OR counts->>'assurances'<>'0'
     OR counts->>'verifications'<>'0' OR counts->>'setupTokens'<>'0'
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
   'externalReviewSha256',NULL,'admittedAt',clock_timestamp())::text,'9999-01-01T00:00:00Z');
 PERFORM set_config('identity.auth_restore_operation','',true);
END $$;
--> statement-breakpoint

CREATE FUNCTION identity.begin_auth_restore(p_backup uuid,p_manifest_sha256 text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE generation uuid:=gen_random_uuid();observed timestamptz:=clock_timestamp();previous text;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' OR p_backup IS NULL
  OR p_manifest_sha256 IS NULL OR p_manifest_sha256!~'^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'AUTH_RESTORE_OPERATOR_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM v.id FROM identity.verifications v WHERE v.id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b'
  AND v.identifier='ensemus-auth-restore:v1' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESTORE_PENDING' USING ERRCODE='EN422';END IF;
 -- The same transaction fences all backed-up material proofs. Missing 0515 refuses the begin.
 PERFORM sovereign.rotate_material_restore_generation();
 observed:=clock_timestamp();
 previous:=current_setting('identity.auth_restore_operation',true);
 BEGIN
  PERFORM set_config('identity.auth_restore_operation','begin',true);
  UPDATE identity.verifications SET value=jsonb_build_object('version',1,'generation',generation,
   'phase','pending','backupId',p_backup,'manifestSha256',p_manifest_sha256,'cutoff',observed,
   'notBefore',observed+interval '15 minutes','invalidation',NULL,'securitySha256',NULL,
   'externalReviewSha256',NULL,'admittedAt',NULL)::text WHERE id='68766d8e-9f7d-4b87-b881-bb4c3ff1654b';
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('identity.auth_restore_operation',coalesce(previous,''),true);RAISE;END;
 PERFORM set_config('identity.auth_restore_operation',coalesce(previous,''),true);
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
  'identity.setup_tokens'::regclass) OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN
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
  'identity.setup_tokens'::regclass] LOOP
  EXECUTE format('CREATE TRIGGER auth_restore_0422_write BEFORE INSERT OR UPDATE OR DELETE ON %s
   FOR EACH ROW EXECUTE FUNCTION identity.guard_auth_restore_native_write()',target);
 END LOOP;
END $$;
