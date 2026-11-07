-- Source only. Requires 0300-0303, 0404, 0410 and 0412 before installation. SQL verifies fixed
-- manifest/part byte hashes and exact metadata effects; customer-key decryption and full transport
-- validation remain the trusted operator parser's boundary, never a claim of SQL key verification.
DO $$ BEGIN
  IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
    OR pg_catalog.pg_has_role(current_user,'ensemus_auth','member') THEN
    RAISE EXCEPTION 'PORTABILITY_GUARD_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE sovereign.organization_imports ADD COLUMN intent_authorized_at timestamptz,
  ADD COLUMN intent_authorized_membership_id uuid,ADD COLUMN intent_authorized_session_id uuid,
  ADD CONSTRAINT import_intent_authorization_complete CHECK(
    (intent_authorized_at IS NULL AND intent_authorized_membership_id IS NULL AND intent_authorized_session_id IS NULL)
    OR (intent_authorized_at IS NOT NULL AND intent_authorized_membership_id=requested_by_membership_id AND intent_authorized_session_id IS NOT NULL)),
  ADD CONSTRAINT import_intent_authorized_member FOREIGN KEY(organization_id,intent_authorized_membership_id)
    REFERENCES org.memberships(organization_id,id);
-- Deliberately no FK to a live session: logout does not revoke a previously admitted immutable import.
CREATE FUNCTION sovereign.guard_import_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'sovereign.organization_imports'::regclass THEN RAISE EXCEPTION 'IMPORT_ADMISSION_REQUIRED' USING ERRCODE='EN409'; END IF;
  IF TG_OP='INSERT' THEN
    IF current_user<>'ensemus_app' OR session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'user'
      OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id()
      OR NEW.fallback_membership_id IS DISTINCT FROM app.current_membership_id() OR NEW.status<>'requested'
      OR NEW.intent_authorized_at IS NOT NULL OR NEW.intent_authorized_membership_id IS NOT NULL OR NEW.intent_authorized_session_id IS NOT NULL
      OR NEW.archive_sha256 IS NOT NULL OR NEW.source_organization_id IS NOT NULL OR NEW.source_export_id IS NOT NULL
      OR NEW.source_release IS NOT NULL OR NEW.exported_at IS NOT NULL
      OR NOT identity.lock_studio_session(app.current_user_id(),app.current_interactive_session_id())
      OR NOT app.interactive_privilege_allowed('organization.manage') THEN
      RAISE EXCEPTION 'IMPORT_ADMISSION_REQUIRED' USING ERRCODE='EN409';
    END IF;
    NEW.intent_authorized_at:=clock_timestamp();NEW.intent_authorized_membership_id:=app.current_membership_id();
    NEW.intent_authorized_session_id:=app.current_interactive_session_id();
  ELSE
    IF ROW(NEW.organization_id,NEW.id,NEW.requested_by_membership_id,NEW.fallback_membership_id,
      NEW.intent_authorized_at,NEW.intent_authorized_membership_id,NEW.intent_authorized_session_id)
      IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.requested_by_membership_id,OLD.fallback_membership_id,
      OLD.intent_authorized_at,OLD.intent_authorized_membership_id,OLD.intent_authorized_session_id) THEN
      RAISE EXCEPTION 'IMPORT_ADMISSION_IMMUTABLE' USING ERRCODE='EN409';
    END IF;
    IF OLD.archive_sha256 IS NOT NULL AND ROW(NEW.archive_sha256,NEW.source_organization_id,NEW.source_export_id,NEW.source_release,NEW.exported_at)
      IS DISTINCT FROM ROW(OLD.archive_sha256,OLD.source_organization_id,OLD.source_export_id,OLD.source_release,OLD.exported_at) THEN
      RAISE EXCEPTION 'IMPORT_ARCHIVE_IMMUTABLE' USING ERRCODE='EN409';
    END IF;
    IF OLD.archive_sha256 IS NULL AND NEW.archive_sha256 IS NOT NULL AND current_user<>'ensemus_migrator' THEN
      RAISE EXCEPTION 'IMPORT_VERIFIED_MANIFEST_REQUIRED' USING ERRCODE='EN409';
    END IF;
    IF NEW.status='running' AND OLD.status<>'running' AND OLD.intent_authorized_at IS NULL THEN
      RAISE EXCEPTION 'IMPORT_ADMISSION_REQUIRED' USING ERRCODE='EN409';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sovereign.guard_import_admission() FROM PUBLIC;
CREATE TRIGGER imports_01_admission BEFORE INSERT OR UPDATE ON sovereign.organization_imports
  FOR EACH ROW EXECUTE FUNCTION sovereign.guard_import_admission();
REVOKE UPDATE(source_organization_id,source_export_id,source_release,archive_sha256,exported_at) ON sovereign.organization_imports FROM ensemus_app;
--> statement-breakpoint
CREATE TABLE sovereign.organization_import_manifests(
  organization_id uuid NOT NULL,import_id uuid NOT NULL,path text NOT NULL,
  archive_sha256 text NOT NULL CHECK(archive_sha256~'^[0-9a-f]{64}$'),
  plaintext_sha256 text NOT NULL CHECK(plaintext_sha256~'^[0-9a-f]{64}$'),
  section text NOT NULL,record_count integer NOT NULL CHECK(record_count>=0),
  record_digests jsonb NOT NULL CHECK(jsonb_typeof(record_digests)='array'),
  manifest jsonb,verified_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,import_id,path),
  CONSTRAINT import_manifest_import_fk FOREIGN KEY(organization_id,import_id) REFERENCES sovereign.organization_imports(organization_id,id),
  CONSTRAINT import_manifest_kind_check CHECK((path='manifest.json.sealed')=(manifest IS NOT NULL)),
  CONSTRAINT import_manifest_verified_kind CHECK(verified_at IS NULL OR path='manifest.json.sealed')
);
CREATE TABLE sovereign.organization_import_effects(
  organization_id uuid NOT NULL,import_id uuid NOT NULL,part_path text NOT NULL,operation text NOT NULL,
  target_key text NOT NULL,expected_sha256 text NOT NULL CHECK(expected_sha256~'^[0-9a-f]{64}$'),
  source_sha256 text NOT NULL CHECK(source_sha256~'^[0-9a-f]{64}$'),
  consumed_at timestamptz,created_target boolean NOT NULL DEFAULT false,
  PRIMARY KEY(organization_id,import_id,part_path,operation,target_key),
  CONSTRAINT import_effect_part_fk FOREIGN KEY(organization_id,import_id,part_path) REFERENCES sovereign.organization_import_manifests(organization_id,import_id,path),
  CHECK(operation IN('team_insert','team_parent','team_member','connection_insert'))
);
ALTER TABLE sovereign.organization_import_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE sovereign.organization_import_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE sovereign.organization_import_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sovereign.organization_import_effects FORCE ROW LEVEL SECURITY;
CREATE POLICY import_manifest_metadata_read ON sovereign.organization_import_manifests FOR SELECT TO ensemus_app
  USING(organization_id=app.current_organization_id() AND ((knowledge.is_service_actor() AND import_id=nullif(current_setting('app.portability_import_id',true),'')::uuid)
    OR (app.current_actor_type()='user' AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=app.current_organization_id() AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active' AND m.role IN('owner','admin')))));
CREATE POLICY import_effect_metadata_read ON sovereign.organization_import_effects FOR SELECT TO ensemus_app
  USING(organization_id=app.current_organization_id() AND ((knowledge.is_service_actor() AND import_id=nullif(current_setting('app.portability_import_id',true),'')::uuid)
    OR (app.current_actor_type()='user' AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=app.current_organization_id() AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active' AND m.role IN('owner','admin')))));
GRANT SELECT ON sovereign.organization_import_manifests,sovereign.organization_import_effects TO ensemus_app;
CREATE POLICY import_manifest_fixed_writer ON sovereign.organization_import_manifests TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor() AND import_id=nullif(current_setting('app.portability_import_id',true),'')::uuid)
  WITH CHECK(organization_id=app.current_organization_id() AND knowledge.is_service_actor() AND import_id=nullif(current_setting('app.portability_import_id',true),'')::uuid);
CREATE POLICY import_effect_fixed_writer ON sovereign.organization_import_effects TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor() AND import_id=nullif(current_setting('app.portability_import_id',true),'')::uuid)
  WITH CHECK(organization_id=app.current_organization_id() AND knowledge.is_service_actor() AND import_id=nullif(current_setting('app.portability_import_id',true),'')::uuid);
CREATE POLICY import_intent_fixed_writer ON sovereign.organization_imports TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor() AND id=nullif(current_setting('app.portability_import_id',true),'')::uuid)
  WITH CHECK(organization_id=app.current_organization_id() AND knowledge.is_service_actor() AND id=nullif(current_setting('app.portability_import_id',true),'')::uuid);
CREATE POLICY import_intent_member_read ON org.memberships FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor() AND EXISTS(
    SELECT 1 FROM sovereign.organization_imports i WHERE i.organization_id=app.current_organization_id()
      AND i.id=nullif(current_setting('app.portability_import_id',true),'')::uuid AND org.memberships.id IN(i.requested_by_membership_id,i.fallback_membership_id)));
CREATE POLICY import_intent_member_lock ON org.memberships FOR UPDATE TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor() AND EXISTS(
    SELECT 1 FROM sovereign.organization_imports i WHERE i.organization_id=app.current_organization_id()
      AND i.id=nullif(current_setting('app.portability_import_id',true),'')::uuid AND org.memberships.id IN(i.requested_by_membership_id,i.fallback_membership_id))) WITH CHECK(false);
--> statement-breakpoint
CREATE FUNCTION sovereign.lock_running_import(p_import uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i sovereign.organization_imports%ROWTYPE;n integer;
BEGIN
  IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor()
    OR p_import IS DISTINCT FROM nullif(current_setting('app.portability_import_id',true),'')::uuid THEN RETURN false;END IF;
  SELECT * INTO i FROM sovereign.organization_imports WHERE organization_id=app.current_organization_id() AND id=p_import AND status='running' FOR SHARE;
  IF i.id IS NULL OR i.intent_authorized_at IS NULL OR i.intent_authorized_membership_id IS DISTINCT FROM i.requested_by_membership_id THEN RETURN false;END IF;
  PERFORM m.id FROM org.memberships m WHERE m.organization_id=i.organization_id
    AND m.id IN(i.requested_by_membership_id,i.fallback_membership_id) ORDER BY m.id FOR SHARE;
  SELECT count(*) INTO n FROM org.memberships m WHERE m.organization_id=i.organization_id
    AND m.id IN(i.requested_by_membership_id,i.fallback_membership_id) AND m.status='active' AND m.role='owner';
  RETURN n=CASE WHEN i.requested_by_membership_id=i.fallback_membership_id THEN 1 ELSE 2 END;
END $$;
REVOKE ALL ON FUNCTION sovereign.lock_running_import(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.lock_running_import(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.register_import_manifest(p_import uuid,p_archive_sha text,p_plain bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE body jsonb;hash text;prior sovereign.organization_import_manifests%ROWTYPE;
BEGIN
  IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR p_import IS DISTINCT FROM nullif(current_setting('app.portability_import_id',true),'')::uuid THEN
    RAISE EXCEPTION 'IMPORT_VERIFIED_MANIFEST_REQUIRED' USING ERRCODE='EN409';END IF;
  PERFORM 1 FROM sovereign.organization_imports WHERE organization_id=app.current_organization_id() AND id=p_import AND status='running' FOR UPDATE;
  IF NOT sovereign.lock_running_import(p_import) OR p_archive_sha!~'^[0-9a-f]{64}$' OR octet_length(p_plain)>512008192 THEN
    RAISE EXCEPTION 'IMPORT_VERIFIED_MANIFEST_REQUIRED' USING ERRCODE='EN409';END IF;
  body:=convert_from(p_plain,'UTF8')::jsonb;hash:=encode(pg_catalog.sha256(p_plain),'hex');
  IF body->>'format'<>'ensemus.organization_export' OR body->>'schema_version' NOT IN('1','2')
    OR jsonb_typeof(body->'parts')<>'array' OR jsonb_array_length(body->'parts')>1000000 THEN
    RAISE EXCEPTION 'IMPORT_VERIFIED_MANIFEST_REQUIRED' USING ERRCODE='EN409';END IF;
  SELECT * INTO prior FROM sovereign.organization_import_manifests WHERE organization_id=app.current_organization_id() AND import_id=p_import AND path='manifest.json.sealed';
  IF FOUND THEN
    IF prior.archive_sha256<>p_archive_sha OR prior.plaintext_sha256<>hash OR prior.manifest<>body THEN
      RAISE EXCEPTION 'IMPORT_ARCHIVE_IMMUTABLE' USING ERRCODE='EN409';END IF;RETURN;
  END IF;
  -- Locking the intent serializes concurrent first registrations; no different source may be pinned.
  PERFORM 1 FROM sovereign.organization_imports WHERE organization_id=app.current_organization_id() AND id=p_import FOR UPDATE;
  IF EXISTS(SELECT 1 FROM sovereign.organization_imports WHERE organization_id=app.current_organization_id() AND id=p_import AND archive_sha256 IS NOT NULL AND archive_sha256<>p_archive_sha) THEN
    RAISE EXCEPTION 'IMPORT_ARCHIVE_IMMUTABLE' USING ERRCODE='EN409';END IF;
  UPDATE sovereign.organization_imports SET archive_sha256=p_archive_sha,source_organization_id=(body->>'organization_id')::uuid,
    source_export_id=(body->>'export_id')::uuid,source_release=body->>'source_release',exported_at=(body->>'exported_at')::timestamptz
    WHERE organization_id=app.current_organization_id() AND id=p_import;
  INSERT INTO sovereign.organization_import_manifests(organization_id,import_id,path,archive_sha256,plaintext_sha256,section,record_count,record_digests,manifest)
    VALUES(app.current_organization_id(),p_import,'manifest.json.sealed',p_archive_sha,hash,'manifest',0,'[]',body);
END $$;
REVOKE ALL ON FUNCTION sovereign.register_import_manifest(uuid,text,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.register_import_manifest(uuid,text,bytea) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.register_import_part(p_import uuid,p_path text,p_plain bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE header sovereign.organization_import_manifests%ROWTYPE;part jsonb;row_text text;record jsonb;digests jsonb:='[]';actual_hash text;n integer:=0;
BEGIN
  IF NOT sovereign.lock_running_import(p_import) OR octet_length(p_plain)>33554432 THEN
    RAISE EXCEPTION 'IMPORT_PART_PROOF_REQUIRED' USING ERRCODE='EN409';END IF;
  SELECT * INTO header FROM sovereign.organization_import_manifests WHERE organization_id=app.current_organization_id() AND import_id=p_import AND path='manifest.json.sealed';
  SELECT entry INTO part FROM jsonb_array_elements(header.manifest->'parts') entry WHERE entry->>'path'=p_path;
  actual_hash:=encode(pg_catalog.sha256(p_plain),'hex');
  IF part IS NULL OR part->>'plaintext_sha256' IS DISTINCT FROM actual_hash THEN RAISE EXCEPTION 'IMPORT_PART_CHANGED' USING ERRCODE='EN409';END IF;
  IF p_path NOT LIKE '%.bin.sealed' AND (part->>'records')::integer>0 THEN
    FOREACH row_text IN ARRAY string_to_array(convert_from(p_plain,'UTF8'),E'\n') LOOP
      IF row_text='' THEN CONTINUE;END IF;record:=row_text::jsonb;n:=n+1;
      digests:=digests||jsonb_build_array(jsonb_build_object('kind',record->>'kind','sha256',encode(pg_catalog.sha256(convert_to(record::text,'UTF8')),'hex')));
    END LOOP;
    IF n<>(part->>'records')::integer OR n>5000 THEN RAISE EXCEPTION 'IMPORT_PART_COUNT_CHANGED' USING ERRCODE='EN409';END IF;
  ELSIF p_path LIKE '%.bin.sealed' AND NOT ((part->>'section'='artifacts' AND (part->>'records')::integer IN(0,1))
    OR (part->>'section'='knowledge' AND (part->>'records')::integer=0)) THEN
    RAISE EXCEPTION 'IMPORT_PART_COUNT_CHANGED' USING ERRCODE='EN409';
  END IF;
  INSERT INTO sovereign.organization_import_manifests(organization_id,import_id,path,archive_sha256,plaintext_sha256,section,record_count,record_digests)
    VALUES(app.current_organization_id(),p_import,p_path,header.archive_sha256,actual_hash,part->>'section',(part->>'records')::integer,digests)
    ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM sovereign.organization_import_manifests WHERE organization_id=app.current_organization_id()
    AND import_id=p_import AND path=p_path AND archive_sha256=header.archive_sha256 AND plaintext_sha256=actual_hash AND record_digests=digests) THEN
    RAISE EXCEPTION 'IMPORT_PART_CHANGED' USING ERRCODE='EN409';END IF;
END $$;
REVOKE ALL ON FUNCTION sovereign.register_import_part(uuid,text,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.register_import_part(uuid,text,bytea) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.verified_import_record(p_import uuid,p_record jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE part sovereign.organization_import_manifests%ROWTYPE;header sovereign.organization_import_manifests%ROWTYPE;
BEGIN
  IF NOT sovereign.lock_running_import(p_import) THEN RETURN false;END IF;
  SELECT * INTO header FROM sovereign.organization_import_manifests WHERE organization_id=app.current_organization_id() AND import_id=p_import AND path='manifest.json.sealed';
  IF header.path IS NULL OR header.verified_at IS NULL THEN RETURN false;END IF;
  SELECT * INTO part FROM sovereign.organization_import_manifests WHERE organization_id=app.current_organization_id() AND import_id=p_import
    AND path=current_setting('app.portability_part_path',true)
    AND plaintext_sha256=current_setting('app.portability_part_sha256',true) AND path<>'manifest.json.sealed';
  RETURN part.path IS NOT NULL AND part.record_digests @> jsonb_build_array(jsonb_build_object('kind',p_record->>'kind',
    'sha256',encode(pg_catalog.sha256(convert_to(p_record::text,'UTF8')),'hex')));
END $$;
REVOKE ALL ON FUNCTION sovereign.verified_import_record(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.verified_import_record(uuid,jsonb) TO ensemus_app;
--> statement-breakpoint
CREATE POLICY import_people_fixed_read ON sovereign.imported_people FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor()
    AND import_id=nullif(current_setting('app.portability_import_id',true),'')::uuid);
CREATE POLICY import_people_fixed_lock ON sovereign.imported_people FOR UPDATE TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor()
    AND import_id=nullif(current_setting('app.portability_import_id',true),'')::uuid) WITH CHECK(false);
CREATE POLICY import_linked_member_read ON org.memberships FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor() AND EXISTS(
    SELECT 1 FROM sovereign.imported_people p WHERE p.organization_id=app.current_organization_id()
      AND p.import_id=nullif(current_setting('app.portability_import_id',true),'')::uuid AND p.target_membership_id=org.memberships.id));
CREATE POLICY import_linked_member_lock ON org.memberships FOR UPDATE TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor() AND EXISTS(
    SELECT 1 FROM sovereign.imported_people p WHERE p.organization_id=app.current_organization_id()
      AND p.import_id=nullif(current_setting('app.portability_import_id',true),'')::uuid AND p.target_membership_id=org.memberships.id)) WITH CHECK(false);
CREATE TRIGGER import_manifest_append_only BEFORE DELETE OR TRUNCATE ON sovereign.organization_import_manifests
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE FUNCTION sovereign.guard_import_manifest_completion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'sovereign.organization_import_manifests'::regclass OR TG_OP<>'UPDATE'
    OR current_user<>'ensemus_migrator' OR NOT sovereign.lock_running_import(OLD.import_id)
    OR OLD.path<>'manifest.json.sealed' OR OLD.verified_at IS NOT NULL OR NEW.verified_at IS NULL
    OR (to_jsonb(OLD)-'verified_at') IS DISTINCT FROM (to_jsonb(NEW)-'verified_at')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.manifest->'parts') wanted WHERE NOT EXISTS(
      SELECT 1 FROM sovereign.organization_import_manifests proof WHERE proof.organization_id=OLD.organization_id
        AND proof.import_id=OLD.import_id AND proof.path=wanted->>'path' AND proof.archive_sha256=OLD.archive_sha256
        AND proof.plaintext_sha256=wanted->>'plaintext_sha256' AND proof.section=wanted->>'section'
        AND proof.record_count=(wanted->>'records')::integer)) THEN
    RAISE EXCEPTION 'IMPORT_ALL_PART_PROOFS_REQUIRED' USING ERRCODE='EN409';END IF;
  NEW.verified_at:=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sovereign.guard_import_manifest_completion() FROM PUBLIC;
CREATE TRIGGER import_manifest_completion BEFORE UPDATE ON sovereign.organization_import_manifests
  FOR EACH ROW EXECUTE FUNCTION sovereign.guard_import_manifest_completion();
CREATE FUNCTION sovereign.complete_import_verification(p_import uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT sovereign.lock_running_import(p_import) THEN RAISE EXCEPTION 'IMPORT_ALL_PART_PROOFS_REQUIRED' USING ERRCODE='EN409';END IF;
  UPDATE sovereign.organization_import_manifests SET verified_at=clock_timestamp()
    WHERE organization_id=app.current_organization_id() AND import_id=p_import AND path='manifest.json.sealed' AND verified_at IS NULL;
  IF NOT EXISTS(SELECT 1 FROM sovereign.organization_import_manifests WHERE organization_id=app.current_organization_id()
    AND import_id=p_import AND path='manifest.json.sealed' AND verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'IMPORT_ALL_PART_PROOFS_REQUIRED' USING ERRCODE='EN409';END IF;
END $$;
REVOKE ALL ON FUNCTION sovereign.complete_import_verification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.complete_import_verification(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.prepare_import_effect(p_import uuid,p_operation text,p_source jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expected jsonb;target text;linked uuid;custodian uuid;source_hash text;expected_hash text;part text;part_section text;
BEGIN
  IF NOT sovereign.verified_import_record(p_import,p_source) THEN RAISE EXCEPTION 'IMPORT_EFFECT_REFUSED' USING ERRCODE='EN409';END IF;
  part:=current_setting('app.portability_part_path',true);
  SELECT section INTO part_section FROM sovereign.organization_import_manifests WHERE organization_id=app.current_organization_id() AND import_id=p_import AND path=part;
  IF (p_operation IN('team_insert','team_parent','team_member') AND part_section NOT IN('people','relations'))
    OR (p_operation='connection_insert' AND part_section<>'connections') THEN RAISE EXCEPTION 'IMPORT_EFFECT_REFUSED' USING ERRCODE='EN409';END IF;
  SELECT fallback_membership_id INTO custodian FROM sovereign.organization_imports WHERE organization_id=app.current_organization_id() AND id=p_import;
  IF p_operation IN('team_insert','team_parent') AND p_source->>'kind'='team' THEN
    target:=(p_source->>'id')::uuid::text;
    IF p_operation='team_insert' THEN
      expected:=jsonb_build_object('id',target,'name',p_source->>'name','parent_id',NULL,'created_at',(p_source->>'created_at')::timestamptz);
    ELSE
      IF p_source->>'parent_id' IS NULL OR NOT EXISTS(SELECT 1 FROM sovereign.organization_import_effects e
        WHERE e.organization_id=app.current_organization_id() AND e.import_id=p_import AND e.operation='team_insert' AND e.target_key=target AND e.created_target)
        OR NOT EXISTS(SELECT 1 FROM sovereign.organization_import_effects e WHERE e.organization_id=app.current_organization_id()
          AND e.import_id=p_import AND e.operation='team_insert' AND e.target_key=p_source->>'parent_id' AND e.created_target) THEN
        RAISE EXCEPTION 'IMPORT_EFFECT_REFUSED' USING ERRCODE='EN409';END IF;
      expected:=jsonb_build_object('id',target,'parent_id',(p_source->>'parent_id')::uuid);
    END IF;
  ELSIF p_operation='team_member' AND p_source->>'kind'='team_membership' THEN
    SELECT m.id INTO linked FROM sovereign.imported_people p JOIN org.memberships m
      ON m.organization_id=p.organization_id AND m.id=p.target_membership_id AND m.status='active'
      WHERE p.organization_id=app.current_organization_id() AND p.import_id=p_import
        AND p.source_membership_id=(p_source->>'membership_id')::uuid FOR SHARE OF p,m;
    IF linked IS NULL OR NOT EXISTS(SELECT 1 FROM sovereign.organization_import_effects e WHERE e.organization_id=app.current_organization_id()
      AND e.import_id=p_import AND e.operation='team_insert' AND e.target_key=p_source->>'team_id' AND e.created_target) THEN
      RAISE EXCEPTION 'IMPORT_EFFECT_REFUSED' USING ERRCODE='EN409';END IF;
    target:=(p_source->>'team_id')::uuid::text||':'||linked::text;
    expected:=jsonb_build_object('team_id',(p_source->>'team_id')::uuid,'membership_id',linked);
  ELSIF p_operation='connection_insert' AND p_source->>'kind'='connection' THEN
    target:=(p_source->>'id')::uuid::text;
    expected:=jsonb_build_object('id',target,'connector_type',p_source->>'connector_type','display_name',p_source->>'display_name',
      'state','disabled','credential_secret_id',NULL,'config','{}'::jsonb,'granted_scopes','[]'::jsonb,
      'created_by_membership_id',custodian,'created_at',(p_source->>'created_at')::timestamptz);
  ELSE RAISE EXCEPTION 'IMPORT_EFFECT_REFUSED' USING ERRCODE='EN409';END IF;
  source_hash:=encode(pg_catalog.sha256(convert_to(p_source::text,'UTF8')),'hex');
  expected_hash:=encode(pg_catalog.sha256(convert_to(expected::text,'UTF8')),'hex');
  INSERT INTO sovereign.organization_import_effects(organization_id,import_id,part_path,operation,target_key,expected_sha256,source_sha256)
    VALUES(app.current_organization_id(),p_import,part,p_operation,target,expected_hash,source_hash) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM sovereign.organization_import_effects e WHERE e.organization_id=app.current_organization_id()
    AND e.import_id=p_import AND e.part_path=part AND e.operation=p_operation AND e.target_key=target
    AND e.expected_sha256=expected_hash AND e.source_sha256=source_hash AND e.consumed_at IS NULL) THEN
    RAISE EXCEPTION 'IMPORT_EFFECT_REFUSED' USING ERRCODE='EN409';END IF;
  RETURN target;
END $$;
REVOKE ALL ON FUNCTION sovereign.prepare_import_effect(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.prepare_import_effect(uuid,text,jsonb) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.consume_import_effect(p_operation text,p_target text,p_expected jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE import_id uuid;applied integer;
BEGIN
  import_id:=nullif(current_setting('app.portability_import_id',true),'')::uuid;
  IF NOT sovereign.lock_running_import(import_id) THEN RETURN false;END IF;
  UPDATE sovereign.organization_import_effects e SET consumed_at=clock_timestamp()
    WHERE e.organization_id=app.current_organization_id() AND e.import_id=import_id
      AND e.part_path=current_setting('app.portability_part_path',true) AND e.operation=p_operation AND e.target_key=p_target
      AND e.expected_sha256=encode(pg_catalog.sha256(convert_to(p_expected::text,'UTF8')),'hex') AND e.consumed_at IS NULL
      AND EXISTS(SELECT 1 FROM sovereign.organization_import_manifests p WHERE p.organization_id=e.organization_id
        AND p.import_id=e.import_id AND p.path=e.part_path AND p.plaintext_sha256=current_setting('app.portability_part_sha256',true));
  GET DIAGNOSTICS applied=ROW_COUNT;RETURN applied=1;
END $$;
REVOKE ALL ON FUNCTION sovereign.consume_import_effect(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.consume_import_effect(text,text,jsonb) TO ensemus_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION org.guard_team_management() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE row_org uuid;operation text;expected jsonb;target text;
BEGIN
  IF TG_RELID NOT IN('org.teams'::regclass,'org.team_memberships'::regclass) OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user IN('ensemus_app','ensemus_agent') THEN
    row_org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
    IF row_org IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
    IF TG_RELID='org.teams'::regclass THEN
      IF TG_OP='INSERT' AND NEW.parent_id IS NULL THEN
        operation:='team_insert';target:=NEW.id::text;
        expected:=jsonb_build_object('id',NEW.id,'name',NEW.name,'parent_id',NEW.parent_id,'created_at',NEW.created_at);
      ELSIF TG_OP='UPDATE' AND (to_jsonb(NEW)-'parent_id')=(to_jsonb(OLD)-'parent_id') THEN
        operation:='team_parent';target:=NEW.id::text;expected:=jsonb_build_object('id',NEW.id,'parent_id',NEW.parent_id);
      END IF;
    ELSIF TG_OP='INSERT' THEN
      operation:='team_member';target:=NEW.team_id::text||':'||NEW.membership_id::text;
      expected:=jsonb_build_object('team_id',NEW.team_id,'membership_id',NEW.membership_id);
    END IF;
    IF operation IS NOT NULL AND sovereign.consume_import_effect(operation,target,expected) THEN RETURN NEW;END IF;
    IF NOT app.interactive_privilege_allowed('member.manage') THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION sovereign.record_import_created_team() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'org.teams'::regclass OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMPORT_EFFECT_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF knowledge.is_service_actor() AND sovereign.lock_running_import(nullif(current_setting('app.portability_import_id',true),'')::uuid) THEN
    UPDATE sovereign.organization_import_effects e SET created_target=true WHERE e.organization_id=NEW.organization_id
      AND e.import_id=nullif(current_setting('app.portability_import_id',true),'')::uuid
      AND e.part_path=current_setting('app.portability_part_path',true) AND e.operation='team_insert' AND e.target_key=NEW.id::text
      AND e.consumed_at IS NOT NULL;
  END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sovereign.record_import_created_team() FROM PUBLIC;
CREATE TRIGGER team_import_created AFTER INSERT ON org.teams FOR EACH ROW EXECUTE FUNCTION sovereign.record_import_created_team();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION integrations.guard_connection_management() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE expected jsonb;
BEGIN
  IF TG_RELID<>'integrations.connections'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user NOT IN('ensemus_app','ensemus_agent') THEN RETURN NEW;END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF TG_OP='INSERT' AND NEW.state='disabled' AND NEW.credential_secret_id IS NULL AND NEW.config='{}'::jsonb
    AND cardinality(NEW.granted_scopes)=0 AND NEW.revoked_at IS NULL AND NEW.version=1 AND NEW.last_error_code IS NULL AND NEW.last_error_at IS NULL THEN
    expected:=jsonb_build_object('id',NEW.id,'connector_type',NEW.connector_type,'display_name',NEW.display_name,'state',NEW.state,
      'credential_secret_id',NEW.credential_secret_id,'config',NEW.config,'granted_scopes',to_jsonb(NEW.granted_scopes),
      'created_by_membership_id',NEW.created_by_membership_id,'created_at',NEW.created_at);
    IF sovereign.consume_import_effect('connection_insert',NEW.id::text,expected) THEN RETURN NEW;END IF;
  END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['last_error_code','last_error_at','updated_at','version'])
    IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['last_error_code','last_error_at','updated_at','version']) THEN RETURN NEW;END IF;
  IF NOT app.interactive_privilege_allowed('connection.manage') THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
