-- Unregistered source. Explicit native self-link only; no new table, role assumption or body grant.
-- The existing ordinary SAML browser-correlation prefix is deliberately outside this trigger.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR pg_catalog.pg_has_role(current_user,'ensemus_auth','member') THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
END $$;
--> statement-breakpoint
CREATE POLICY sso_connections_self_link_read ON org.sso_connections FOR SELECT TO ensemus_migrator
 USING(current_setting('identity.saml_link_guard_active',true)='v1'
  AND provider_id=current_setting('identity.saml_link_guard_provider',true));
CREATE POLICY sso_connections_self_link_lock ON org.sso_connections FOR UPDATE TO ensemus_migrator
 USING(current_setting('identity.saml_link_guard_active',true)='v1'
  AND provider_id=current_setting('identity.saml_link_guard_provider',true)) WITH CHECK(false);
CREATE POLICY organizations_self_link_read ON org.organizations FOR SELECT TO ensemus_migrator
 USING(current_setting('identity.saml_link_guard_active',true)='v1'
  AND id=nullif(current_setting('identity.saml_link_guard_org',true),'')::uuid);
CREATE POLICY organizations_self_link_lock ON org.organizations FOR UPDATE TO ensemus_migrator
 USING(current_setting('identity.saml_link_guard_active',true)='v1'
  AND id=nullif(current_setting('identity.saml_link_guard_org',true),'')::uuid) WITH CHECK(false);
CREATE POLICY memberships_self_link_read ON org.memberships FOR SELECT TO ensemus_migrator
 USING(current_setting('identity.saml_link_guard_active',true)='v1'
  AND organization_id=nullif(current_setting('identity.saml_link_guard_org',true),'')::uuid
  AND user_id=nullif(current_setting('identity.saml_link_guard_user',true),'')::uuid);
CREATE POLICY memberships_self_link_lock ON org.memberships FOR UPDATE TO ensemus_migrator
 USING(current_setting('identity.saml_link_guard_active',true)='v1'
  AND organization_id=nullif(current_setting('identity.saml_link_guard_org',true),'')::uuid
  AND user_id=nullif(current_setting('identity.saml_link_guard_user',true),'')::uuid) WITH CHECK(false);
CREATE POLICY sso_links_self_link_read ON org.sso_member_links FOR SELECT TO ensemus_migrator
 USING(current_setting('identity.saml_link_guard_active',true)='v1'
  AND organization_id=nullif(current_setting('identity.saml_link_guard_org',true),'')::uuid
  AND (membership_id=nullif(current_setting('identity.saml_link_guard_member',true),'')::uuid
   OR (connection_id=nullif(current_setting('identity.saml_link_guard_connection',true),'')::uuid
    AND external_subject=current_setting('identity.saml_link_guard_subject',true))));
CREATE POLICY sso_links_self_link_lock ON org.sso_member_links FOR UPDATE TO ensemus_migrator
 USING(current_setting('identity.saml_link_guard_active',true)='v1'
  AND organization_id=nullif(current_setting('identity.saml_link_guard_org',true),'')::uuid
  AND (membership_id=nullif(current_setting('identity.saml_link_guard_member',true),'')::uuid
   OR (connection_id=nullif(current_setting('identity.saml_link_guard_connection',true),'')::uuid
    AND external_subject=current_setting('identity.saml_link_guard_subject',true)))) WITH CHECK(false);
--> statement-breakpoint

-- Called only from the auth-role verification trigger. Returns identity metadata, never a body,
-- role grant, email or credential. NOWAIT/try locks avoid inversion with the native provider lock.
CREATE FUNCTION identity.lock_saml_self_link_member(p_provider text,p_user uuid,p_email text,p_subject text)
RETURNS TABLE(organization_id uuid,membership_id uuid) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE saved jsonb;tenant uuid;person uuid;connection uuid;domain text;subject_key text;existing record;
 key text;val text;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_auth' OR pg_trigger_depth()<>1 OR p_user IS NULL OR p_provider IS NULL THEN RETURN;END IF;
 saved:=jsonb_build_object(
  'identity.saml_link_guard_active',current_setting('identity.saml_link_guard_active',true),
  'identity.saml_link_guard_provider',current_setting('identity.saml_link_guard_provider',true),
  'identity.saml_link_guard_user',current_setting('identity.saml_link_guard_user',true),
  'identity.saml_link_guard_org',current_setting('identity.saml_link_guard_org',true),
  'identity.saml_link_guard_member',current_setting('identity.saml_link_guard_member',true),
  'identity.saml_link_guard_connection',current_setting('identity.saml_link_guard_connection',true),
  'identity.saml_link_guard_subject',current_setting('identity.saml_link_guard_subject',true));
 PERFORM set_config('identity.saml_link_guard_active','v1',true),
  set_config('identity.saml_link_guard_provider',p_provider,true),set_config('identity.saml_link_guard_user',p_user::text,true),
  set_config('identity.saml_link_guard_org','',true),set_config('identity.saml_link_guard_member','',true),
  set_config('identity.saml_link_guard_connection','',true),set_config('identity.saml_link_guard_subject','',true);
 BEGIN
  SELECT c.organization_id INTO tenant FROM org.sso_connections c WHERE c.provider_id=p_provider;
  IF tenant IS NULL THEN RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('interactive_policy:'||tenant::text,0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('member_changes:'||tenant::text,0)) THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_BUSY' USING ERRCODE='55P03';END IF;
  PERFORM set_config('identity.saml_link_guard_org',tenant::text,true);
  PERFORM o.id FROM org.organizations o WHERE o.id=tenant AND o.lifecycle<>'deleted' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  SELECT c.id,c.domain INTO connection,domain FROM org.sso_connections c WHERE c.organization_id=tenant
   AND c.provider_id=p_provider AND c.state='active' AND c.domain_state='verified' FOR SHARE NOWAIT;
  IF connection IS NULL OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
   OR lower(split_part(p_email,'@',2)) IS DISTINCT FROM domain THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  SELECT m.id INTO person FROM org.memberships m WHERE m.organization_id=tenant AND m.user_id=p_user
   AND m.status='active' FOR SHARE NOWAIT;
  IF person IS NULL THEN RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  PERFORM set_config('identity.saml_link_guard_member',person::text,true),
   set_config('identity.saml_link_guard_connection',connection::text,true),
   set_config('identity.saml_link_guard_subject',coalesce(p_subject,''),true);
  FOR existing IN SELECT l.* FROM org.sso_member_links l WHERE l.organization_id=tenant
   AND (l.membership_id=person OR (l.connection_id=connection AND l.external_subject=p_subject)) FOR SHARE NOWAIT LOOP
   IF existing.membership_id<>person OR existing.connection_id<>connection OR existing.state<>'active'
    OR (p_subject IS NOT NULL AND existing.external_subject<>p_subject) THEN
    RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  END LOOP;
 EXCEPTION WHEN OTHERS THEN
  FOR key,val IN SELECT * FROM jsonb_each_text(saved) LOOP PERFORM set_config(key,coalesce(val,''),true);END LOOP;
  RAISE;
 END;
 FOR key,val IN SELECT * FROM jsonb_each_text(saved) LOOP PERFORM set_config(key,coalesce(val,''),true);END LOOP;
 RETURN QUERY SELECT tenant,person;
END $$;
REVOKE ALL ON FUNCTION identity.lock_saml_self_link_member(text,uuid,text,text) FROM PUBLIC;
-- No runtime role can call or attach this metadata authority, even from its own trigger.
REVOKE ALL ON FUNCTION identity.lock_saml_self_link_member(text,uuid,text,text) FROM ensemus_auth;
--> statement-breakpoint

CREATE FUNCTION identity.guard_saml_self_link_verification() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE b jsonb;old_b jsonb;source jsonb;primary_proof jsonb;preparation jsonb;person record;native_session record;
 account record;provider record;source_provider record;receipt record;receipt_body jsonb;
 observed timestamptz;mutable text[]:=ARRAY['phase','subject','signedEmail','finalizationAdmission','finalizationTransaction'];
BEGIN
 IF TG_RELID<>'identity.verifications'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 IF NEW.identifier NOT LIKE 'ensemus-saml-self-link:v1:%' AND (TG_OP='INSERT' OR OLD.identifier NOT LIKE 'ensemus-saml-self-link:v1:%') THEN RETURN NEW;END IF;
 IF current_user<>'ensemus_auth' OR session_user<>'ensemus_auth' OR octet_length(NEW.value)>16384 THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 BEGIN b:=NEW.value::jsonb;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END;
 IF jsonb_typeof(b)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(b) k WHERE k<>ALL(ARRAY[
  'version','mode','phase','requestId','relaySha256','providerId','issuer','domain','boundary','rawConfigSha256','browserProofSha256',
  'source','organizationId','membershipId','scopeAdmission','subject','signedEmail','finalizationAdmission','finalizationTransaction'])) THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 IF b->'version' IS DISTINCT FROM '1'::jsonb OR EXISTS(SELECT 1 FROM unnest(ARRAY[
  'mode','phase','requestId','relaySha256','providerId','issuer','domain','boundary','rawConfigSha256','browserProofSha256']) k
  WHERE jsonb_typeof(b->k) IS DISTINCT FROM 'string') THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 IF NOT coalesce(b->>'version'='1' AND b->>'mode'='self_link' AND b->>'phase' IN('prepared','consumed')
  AND b->>'requestId' ~ '^[A-Za-z_][A-Za-z0-9_.-]{0,199}$' AND length(b->>'providerId') BETWEEN 1 AND 200
  AND length(b->>'issuer') BETWEEN 1 AND 2048 AND length(b->>'domain') BETWEEN 1 AND 253
  AND b->>'relaySha256' ~ '^[0-9a-f]{64}$' AND b->>'boundary' ~ '^[0-9a-f]{64}$'
  AND b->>'rawConfigSha256' ~ '^[0-9a-f]{64}$' AND b->>'browserProofSha256' ~ '^[0-9a-f]{64}$'
  AND NEW.identifier='ensemus-saml-self-link:v1:'||(b->>'relaySha256'),false) THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 source:=b->'source';primary_proof:=source->'primary';
 IF jsonb_typeof(source)<>'object' OR jsonb_typeof(primary_proof)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k<>ALL(ARRAY['userId','sessionId','sessionTokenSha256','email','primary']))
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(primary_proof) k WHERE k<>ALL(ARRAY['kind','accountId','fingerprint','proofId','authenticatedAt','providerId','rawConfigSha256'])) THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 IF NOT coalesce(source->>'userId' ~ '^[0-9a-f-]{36}$' AND source->>'sessionId' ~ '^[0-9a-f-]{36}$'
  AND source->>'sessionTokenSha256' ~ '^[0-9a-f]{64}$' AND length(source->>'email') BETWEEN 3 AND 320
  AND primary_proof->>'accountId' ~ '^[0-9a-f-]{36}$' AND primary_proof->>'fingerprint' ~ '^[0-9a-f]{64}$'
  AND primary_proof->>'kind' IN('credential','provider'),false) THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['userId','sessionId','sessionTokenSha256','email']) k WHERE jsonb_typeof(source->k) IS DISTINCT FROM 'string')
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['kind','accountId','fingerprint']) k WHERE jsonb_typeof(primary_proof->k) IS DISTINCT FROM 'string') THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 IF TG_OP='INSERT' THEN
  preparation:=nullif(current_setting('identity.saml_link_preparation',true),'')::jsonb;
  IF preparation IS DISTINCT FROM source OR b->>'phase'<>'prepared' OR b ?| ARRAY['organizationId','membershipId','scopeAdmission','subject','signedEmail','finalizationAdmission','finalizationTransaction'] THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 ELSE
  old_b:=OLD.value::jsonb;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.identifier IS DISTINCT FROM OLD.identifier OR NEW.created_at IS DISTINCT FROM OLD.created_at
   OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR old_b->>'phase'<>'prepared' OR b->>'phase'<>'consumed'
   OR b-mutable IS DISTINCT FROM old_b-mutable OR b ?| ARRAY['finalizationAdmission','finalizationTransaction']
   OR old_b->>'scopeAdmission' IS DISTINCT FROM 'v1' THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  IF NOT coalesce(length(b->>'subject') BETWEEN 1 AND 2048 AND b->>'subject' !~ '[[:cntrl:]]'
   AND lower(b->>'signedEmail')=lower(source->>'email'),false) THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 END IF;
 SELECT p.* INTO provider FROM identity.sso_providers p WHERE p.provider_id=b->>'providerId' FOR SHARE NOWAIT;
 IF provider.id IS NULL OR NOT provider.domain_verified OR provider.issuer IS DISTINCT FROM (provider.saml_config::jsonb->>'issuer')
  OR provider.domain IS DISTINCT FROM b->>'domain' OR provider.saml_config IS NULL
  OR encode(sha256(convert_to(provider.saml_config,'UTF8')),'hex') IS DISTINCT FROM b->>'rawConfigSha256'
  OR provider.saml_config::jsonb#>>'{idpMetadata,entityID}' IS DISTINCT FROM b->>'issuer' THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 -- UPDATE-strength on the actual source parent also fences a new credential Account's FK
 -- KEY SHARE check. A passwordless absence cannot race a new local credential into existence.
 SELECT u.id,u.email INTO person FROM identity.users u WHERE u.id=(source->>'userId')::uuid FOR UPDATE NOWAIT;
 SELECT s.id,s.token,s.expires_at INTO native_session FROM identity.sessions s WHERE s.id=(source->>'sessionId')::uuid
  AND s.user_id=(source->>'userId')::uuid FOR SHARE NOWAIT;
 IF person.id IS NULL OR native_session.id IS NULL OR lower(person.email) IS DISTINCT FROM lower(source->>'email')
  OR encode(sha256(convert_to(native_session.token,'UTF8')),'hex') IS DISTINCT FROM source->>'sessionTokenSha256' THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 SELECT a.* INTO account FROM identity.accounts a WHERE a.id=(primary_proof->>'accountId')::uuid
  AND a.user_id=person.id FOR SHARE NOWAIT;
 IF account.id IS NULL THEN RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 IF TG_OP='UPDATE' THEN
  -- Do not create a second subject binding for this person at the same provider, including a
  -- native binding whose later tenant provisioning did not finish. The SDK separately rejects
  -- ownership collisions when this signed subject already belongs to somebody else.
  PERFORM a.id FROM identity.accounts a WHERE a.user_id=person.id AND a.provider_id=b->>'providerId'
   AND a.account_id IS DISTINCT FROM b->>'subject' FOR SHARE NOWAIT;
  IF FOUND THEN RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 END IF;
 IF primary_proof->>'kind'='credential' THEN
  IF account.provider_id<>'credential' OR account.password IS NULL
   OR encode(sha256(convert_to(account.password,'UTF8')),'hex') IS DISTINCT FROM primary_proof->>'fingerprint'
   OR primary_proof ?| ARRAY['proofId','authenticatedAt','providerId','rawConfigSha256'] THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 ELSE
  IF account.provider_id='credential' OR account.provider_id IS DISTINCT FROM primary_proof->>'providerId'
   OR EXISTS(SELECT 1 FROM identity.accounts a WHERE a.user_id=person.id AND a.provider_id='credential' AND a.password IS NOT NULL)
   OR NOT coalesce(primary_proof->>'proofId' ~ '^[0-9a-f-]{36}$',false) THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  IF jsonb_typeof(primary_proof->'authenticatedAt') IS DISTINCT FROM 'number'
   OR jsonb_typeof(primary_proof->'proofId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(primary_proof->'providerId') IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  SELECT v.* INTO receipt FROM identity.verifications v WHERE v.id=(primary_proof->>'proofId')::uuid
   AND v.identifier LIKE 'ensemus-primary:v1:%' FOR SHARE NOWAIT;
  IF receipt.id IS NULL OR encode(sha256(convert_to(receipt.value,'UTF8')),'hex') IS DISTINCT FROM primary_proof->>'fingerprint'
   OR left(receipt.value,5) NOT IN('saml:','oidc:') THEN RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  receipt_body:=substring(receipt.value FROM 6)::jsonb;
  IF receipt_body->>'accountId' IS DISTINCT FROM account.id::text OR receipt_body->>'providerId' IS DISTINCT FROM account.provider_id
   OR (receipt_body->>'authenticatedAt')::numeric IS DISTINCT FROM (primary_proof->>'authenticatedAt')::numeric THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  IF left(receipt.value,5)='saml:' THEN
   SELECT p.* INTO source_provider FROM identity.sso_providers p WHERE p.provider_id=account.provider_id FOR SHARE NOWAIT;
   IF source_provider.id IS NULL OR NOT source_provider.domain_verified OR source_provider.saml_config IS NULL
    OR encode(sha256(convert_to(source_provider.saml_config,'UTF8')),'hex') IS DISTINCT FROM primary_proof->>'rawConfigSha256' THEN
    RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  ELSIF primary_proof->'rawConfigSha256' IS DISTINCT FROM 'null'::jsonb THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 END IF;
 observed:=clock_timestamp();
 IF native_session.expires_at<=observed OR NEW.expires_at<=observed OR NEW.created_at>observed+interval '1 second'
  OR NEW.created_at<observed-interval '5 minutes' OR NEW.expires_at>NEW.created_at+interval '5 minutes' THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 IF primary_proof->>'kind'='provider' THEN
  IF receipt.expires_at<=observed
   OR to_timestamp((primary_proof->>'authenticatedAt')::numeric/1000)>observed
   OR to_timestamp((primary_proof->>'authenticatedAt')::numeric/1000)<observed-interval '5 minutes' THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 END IF;
 NEW.value:=b::text;NEW.updated_at:=observed;RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';
END $$;
REVOKE ALL ON FUNCTION identity.guard_saml_self_link_verification() FROM PUBLIC;
CREATE TRIGGER verifications_0421a_self_link_native BEFORE INSERT OR UPDATE ON identity.verifications
 FOR EACH ROW EXECUTE FUNCTION identity.guard_saml_self_link_verification();
--> statement-breakpoint

-- The preceding invoker trigger validates/locks native identity under the existing auth role.
-- This second fixed trigger reads only tenant identity metadata through its scoped helper. It has
-- no auth-role EXECUTE grant and rejects every other target/name, including an auth-owned table.
CREATE FUNCTION identity.guard_saml_self_link_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE b jsonb;scope record;subject_key text;
BEGIN
 IF TG_RELID<>'identity.verifications'::regclass OR TG_NAME<>'verifications_0421b_self_link_scope'
  OR TG_OP NOT IN('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 IF NEW.identifier NOT LIKE 'ensemus-saml-self-link:v1:%' AND (TG_OP='INSERT' OR OLD.identifier NOT LIKE 'ensemus-saml-self-link:v1:%') THEN RETURN NEW;END IF;
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_auth' THEN RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 b:=NEW.value::jsonb;
 IF NOT coalesce(b->>'mode'='self_link' AND b->>'phase'=CASE WHEN TG_OP='INSERT' THEN 'prepared' ELSE 'consumed' END,false) THEN
  RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 IF TG_OP='UPDATE' THEN
  subject_key:=encode(sha256(convert_to(array_to_json(ARRAY[b->>'providerId',b->>'issuer',b->>'subject'])::text,'UTF8')),'hex');
 END IF;
 SELECT * INTO scope FROM identity.lock_saml_self_link_member(b->>'providerId',(b#>>'{source,userId}')::uuid,b#>>'{source,email}',subject_key);
 IF scope.organization_id IS NULL OR scope.membership_id IS NULL THEN RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
 IF TG_OP='INSERT' THEN
  b:=b||jsonb_build_object('organizationId',scope.organization_id,'membershipId',scope.membership_id,'scopeAdmission','v1');
 ELSE
  IF b->>'organizationId' IS DISTINCT FROM scope.organization_id::text OR b->>'membershipId' IS DISTINCT FROM scope.membership_id::text THEN
   RAISE EXCEPTION 'SSO_SELF_LINK_REFUSED' USING ERRCODE='EN421';END IF;
  b:=b||jsonb_build_object('finalizationAdmission','v1','finalizationTransaction',pg_current_xact_id()::text);
 END IF;
 NEW.value:=b::text;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION identity.guard_saml_self_link_scope() FROM PUBLIC,ensemus_auth;
CREATE TRIGGER verifications_0421b_self_link_scope BEFORE INSERT OR UPDATE ON identity.verifications
 FOR EACH ROW EXECUTE FUNCTION identity.guard_saml_self_link_scope();
