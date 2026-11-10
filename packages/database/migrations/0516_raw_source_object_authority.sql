-- UNREGISTERED SOURCE. Static/SQL/runtime qualification is owed; never apply in isolation.
-- Actual0422 ready admission + protected material generation +0508/0515 are prerequisites.
-- Provider outcomes are supplied only by the trusted native storage executor. App-role SQL does
-- not independently attest the provider; a private metadata selector is not a physical proof.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR to_regprocedure('app.current_auth_restore_generation()') IS NULL OR to_regprocedure('ai.current_material_restore_generation()') IS NULL
  OR to_regprocedure('lifecycle.source_projection_hold_free(uuid,bigint,uuid)') IS NULL
  OR to_regprocedure('lifecycle.seal_delegated_erasure(uuid)') IS NULL OR to_regclass('lifecycle.delegated_erasure_receipts') IS NULL THEN
  RAISE EXCEPTION 'RAW_SOURCE_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE lifecycle.raw_source_inventories(
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),
 scope_kind text NOT NULL,source_id uuid,protocol_version integer NOT NULL,
 material_restore_generation uuid NOT NULL,state text NOT NULL,purge_job_id uuid,source_version bigint,
 capture_cursor uuid,capture_count bigint NOT NULL DEFAULT 0,capture_sha256 text,sealed_at timestamptz,
 born_at timestamptz NOT NULL DEFAULT clock_timestamp(),CONSTRAINT raw_source_inventories_pk PRIMARY KEY(organization_id,id),
 CONSTRAINT raw_source_inventory_org_fk FOREIGN KEY(organization_id) REFERENCES org.organizations(id),
 CONSTRAINT raw_source_inventory_scope CHECK((scope_kind='organization' AND source_id IS NULL AND purge_job_id IS NULL AND source_version IS NULL) OR(scope_kind='source' AND source_id IS NOT NULL)),
 CONSTRAINT raw_source_inventory_protocol CHECK(protocol_version IN(0,1) AND capture_count>=0),
 CONSTRAINT raw_source_inventory_state CHECK(state IN('open','capturing','sealed','legacy','restore_debt')),
 CONSTRAINT raw_source_inventory_hash CHECK(capture_sha256 IS NULL OR capture_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX raw_source_inventory_one_org ON lifecycle.raw_source_inventories(organization_id) WHERE scope_kind='organization';
CREATE UNIQUE INDEX raw_source_inventory_one_source ON lifecycle.raw_source_inventories(organization_id,source_id) WHERE scope_kind='source';
CREATE TABLE lifecycle.raw_object_writes(
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),source_id uuid NOT NULL,
 document_id uuid NOT NULL,write_id uuid NOT NULL,generation bigint NOT NULL,object_key text NOT NULL,
 content_sha256 text NOT NULL,size_bytes bigint NOT NULL,material_restore_generation uuid NOT NULL,state text NOT NULL,
 started_by_membership_id uuid,started_by_user_id uuid,put_token_sha256 text,put_auth_restore_generation uuid,
 admitted_at timestamptz,finished_at timestamptz,born_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT raw_object_writes_pk PRIMARY KEY(organization_id,id),
 CONSTRAINT raw_object_write_org_fk FOREIGN KEY(organization_id) REFERENCES org.organizations(id),
 CONSTRAINT raw_object_write_key CHECK(object_key=organization_id::text||'/knowledge/'||document_id::text),
 CONSTRAINT raw_object_write_hash CHECK(content_sha256 ~ '^[0-9a-f]{64}$' AND size_bytes>=0),
 CONSTRAINT raw_object_write_state CHECK((generation=0 AND state='catalog') OR(generation>0 AND state IN('intent','put_admitted','finished','unknown','legacy','not_dispatched'))),
 CONSTRAINT raw_object_write_receipt CHECK((state NOT IN('put_admitted','finished','unknown') OR(put_token_sha256 IS NOT NULL AND put_auth_restore_generation IS NOT NULL AND admitted_at IS NOT NULL)) AND(state<>'finished' OR finished_at IS NOT NULL)
  AND(state<>'not_dispatched' OR(finished_at IS NOT NULL AND put_auth_restore_generation IS NOT NULL AND put_token_sha256 IS NULL AND admitted_at IS NULL)))
);
CREATE UNIQUE INDEX raw_object_write_generation ON lifecycle.raw_object_writes(organization_id,document_id,generation);
CREATE UNIQUE INDEX raw_object_write_token ON lifecycle.raw_object_writes(organization_id,write_id);
CREATE INDEX raw_object_source_inventory ON lifecycle.raw_object_writes(organization_id,source_id,id);
--> statement-breakpoint
CREATE FUNCTION lifecycle.raw_metadata_scope(p_org uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(current_user='ensemus_migrator' AND(p_org::text=current_setting('lifecycle.raw_object_org',true)
  OR(session_user='ensemus_migrator' AND current_setting('lifecycle.raw_object_org',true)='migration')),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_metadata_scope(uuid) FROM PUBLIC;
ALTER TABLE lifecycle.raw_source_inventories ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.raw_source_inventories FORCE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.raw_object_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.raw_object_writes FORCE ROW LEVEL SECURITY;
CREATE POLICY raw_inventory_owner ON lifecycle.raw_source_inventories TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id)) WITH CHECK(lifecycle.raw_metadata_scope(organization_id));
CREATE POLICY raw_write_owner ON lifecycle.raw_object_writes TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id)) WITH CHECK(lifecycle.raw_metadata_scope(organization_id));
REVOKE ALL ON lifecycle.raw_source_inventories,lifecycle.raw_object_writes FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
CREATE POLICY raw_org_metadata ON org.organizations FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(id));
CREATE POLICY raw_org_lock ON org.organizations FOR UPDATE TO ensemus_migrator USING(lifecycle.raw_metadata_scope(id)) WITH CHECK(false);
CREATE POLICY raw_source_metadata ON knowledge.sources FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
CREATE POLICY raw_source_lock ON knowledge.sources FOR UPDATE TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id)) WITH CHECK(false);
CREATE POLICY raw_person_metadata ON org.memberships FOR SELECT TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id) AND id=app.current_membership_id() AND user_id=app.current_user_id());
CREATE POLICY raw_person_lock ON org.memberships FOR UPDATE TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id) AND id=app.current_membership_id() AND user_id=app.current_user_id()) WITH CHECK(false);
CREATE POLICY raw_document_metadata ON knowledge.documents FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
CREATE POLICY raw_document_receipt_update ON knowledge.documents FOR UPDATE TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id)) WITH CHECK(lifecycle.raw_metadata_scope(organization_id) AND session_user='ensemus_app' AND knowledge.is_service_actor());
CREATE POLICY raw_writer_metadata ON knowledge.object_writers FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
CREATE POLICY raw_job_metadata ON knowledge.purge_jobs FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
CREATE POLICY raw_job_lock ON knowledge.purge_jobs FOR UPDATE TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id)) WITH CHECK(false);
CREATE POLICY raw_tombstone_metadata ON platform.tombstones FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id) AND target_type='knowledge_source');
CREATE POLICY raw_hold_metadata ON lifecycle.legal_holds FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
CREATE POLICY raw_claim_metadata ON lifecycle.object_deletion_claims FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
-- A retained legacy organization marker is UNKNOWN HISTORICAL DEBT, not a ban on genuine new
-- source births. It may admit a new exact source protocol in this same material generation while
-- the global erasure predicate still refuses that marker forever until a separately reviewed
-- reconciliation exists. Old sources/writers are never upgraded. Restore-debt markers cannot admit.
CREATE FUNCTION lifecycle.raw_org_native_admission(p_material uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_material IS NOT NULL
  AND EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=app.current_organization_id() AND i.scope_kind='organization'
   AND i.material_restore_generation=p_material AND((i.protocol_version=1 AND i.state='open') OR(i.protocol_version=0 AND i.state='legacy')))
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_org_native_admission(uuid) FROM PUBLIC;
-- Existing metadata is legacy debt even when all former live headers have vanished. No provider
-- inventory or all-attempt writer fence exists to requalify it here, so no automatic clear is added.
DO $$ DECLARE previous text:=current_setting('lifecycle.raw_object_org',true);BEGIN
 PERFORM set_config('lifecycle.raw_object_org','migration',true);
 INSERT INTO lifecycle.raw_source_inventories(organization_id,scope_kind,protocol_version,material_restore_generation,state)
 SELECT id,'organization',0,material_restore_generation,'legacy' FROM org.organizations;
 INSERT INTO lifecycle.raw_source_inventories(organization_id,scope_kind,source_id,protocol_version,material_restore_generation,state)
 SELECT s.organization_id,'source',s.id,0,o.material_restore_generation,'legacy' FROM knowledge.sources s JOIN org.organizations o ON o.id=s.organization_id;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
--> statement-breakpoint
CREATE FUNCTION lifecycle.record_raw_native_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text:=current_setting('lifecycle.raw_object_org',true);tenant uuid;material uuid;native boolean;
 source_row record;doc record;org_scope record;source_scope record;catalog record;prior record;nonce uuid;
BEGIN
 IF TG_OP NOT IN('INSERT','UPDATE') OR TG_RELID NOT IN('org.organizations'::regclass,'knowledge.sources'::regclass,
  'knowledge.documents'::regclass,'knowledge.object_writers'::regclass,'knowledge.purge_jobs'::regclass)
  OR session_user NOT IN('ensemus_app','ensemus_migrator') THEN RAISE EXCEPTION 'INVALID_RAW_BIRTH' USING ERRCODE='42501';END IF;
 IF TG_RELID='org.organizations'::regclass THEN tenant:=NEW.id;material:=NEW.material_restore_generation;
 ELSE tenant:=NEW.organization_id;END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 native:=session_user='ensemus_app';
 IF TG_RELID='org.organizations'::regclass THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INVALID_RAW_BIRTH' USING ERRCODE='42501';END IF;
  INSERT INTO lifecycle.raw_source_inventories(organization_id,scope_kind,protocol_version,material_restore_generation,state)
   VALUES(tenant,'organization',CASE WHEN native THEN 1 ELSE 0 END,material,CASE WHEN native THEN 'open' ELSE 'legacy' END);
 ELSE
  SELECT actual.material_restore_generation INTO material FROM org.organizations actual WHERE actual.id=tenant;
  IF material IS NULL THEN RAISE EXCEPTION 'RAW_MATERIAL_GENERATION_REQUIRED' USING ERRCODE='EN850';END IF;
  SELECT * INTO org_scope FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.scope_kind='organization';
  native:=native AND org_scope.material_restore_generation=material AND((org_scope.protocol_version=1 AND org_scope.state='open') OR(org_scope.protocol_version=0 AND org_scope.state='legacy'));
  IF TG_RELID='knowledge.sources'::regclass THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INVALID_RAW_BIRTH' USING ERRCODE='42501';END IF;
   INSERT INTO lifecycle.raw_source_inventories(organization_id,scope_kind,source_id,protocol_version,material_restore_generation,state)
    VALUES(tenant,'source',NEW.id,CASE WHEN native THEN 1 ELSE 0 END,material,CASE WHEN native THEN 'open' ELSE 'legacy' END)
    ON CONFLICT(organization_id,source_id) WHERE scope_kind='source' DO UPDATE SET state='restore_debt';
  ELSIF TG_RELID='knowledge.documents'::regclass THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INVALID_RAW_BIRTH' USING ERRCODE='42501';END IF;
   SELECT s.id,s.state INTO source_row FROM knowledge.sources s WHERE s.organization_id=tenant AND s.id=NEW.source_id FOR SHARE NOWAIT;
   IF session_user='ensemus_app' AND(source_row.id IS NULL OR source_row.state<>'active') THEN
    RAISE EXCEPTION 'RAW_SOURCE_CLOSED' USING ERRCODE='EN850';END IF;
   IF NOT native THEN UPDATE lifecycle.raw_source_inventories SET state='restore_debt' WHERE organization_id=tenant AND source_id=NEW.source_id;END IF;
   nonce:=gen_random_uuid();
   INSERT INTO lifecycle.raw_object_writes(organization_id,id,source_id,document_id,write_id,generation,object_key,content_sha256,size_bytes,material_restore_generation,state)
    VALUES(tenant,nonce,NEW.source_id,NEW.id,nonce,0,tenant::text||'/knowledge/'||NEW.id::text,NEW.content_sha256,NEW.size_bytes,material,'catalog');
  ELSIF TG_RELID='knowledge.object_writers'::regclass THEN
   IF TG_OP='UPDATE' AND OLD.state='active' THEN
    IF NEW.state='settled' AND lifecycle.raw_write_quiescent(NEW.document_id,NEW.write_id,NEW.generation) IS DISTINCT FROM true THEN
     RAISE EXCEPTION 'RAW_WRITER_UNCONFIRMED' USING ERRCODE='EN850';END IF;
   ELSE
    SELECT * INTO source_scope FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.source_id=NEW.source_id;
    SELECT * INTO catalog FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND w.document_id=NEW.document_id AND w.generation=0;
    SELECT d.id,d.content_sha256,d.size_bytes INTO doc FROM knowledge.documents d WHERE d.organization_id=tenant AND d.id=NEW.document_id AND d.source_id=NEW.source_id;
    native:=native AND source_scope.protocol_version=1 AND source_scope.state='open' AND source_scope.material_restore_generation=material
     AND catalog.id IS NOT NULL AND catalog.material_restore_generation=material AND doc.id IS NOT NULL
     AND catalog.content_sha256=doc.content_sha256 AND catalog.size_bytes=doc.size_bytes;
    IF TG_OP='UPDATE' THEN
     SELECT * INTO prior FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND w.document_id=OLD.document_id AND w.write_id=OLD.write_id AND w.generation=OLD.generation;
     native:=native AND prior.state='finished' AND prior.material_restore_generation=material;
    END IF;
    IF session_user='ensemus_app' AND native IS DISTINCT FROM true THEN RAISE EXCEPTION 'RAW_LEGACY_WRITER_UNCONFIRMED' USING ERRCODE='EN850';END IF;
    INSERT INTO lifecycle.raw_object_writes(organization_id,source_id,document_id,write_id,generation,object_key,content_sha256,size_bytes,
     material_restore_generation,state,started_by_membership_id,started_by_user_id)
    VALUES(tenant,NEW.source_id,NEW.document_id,NEW.write_id,NEW.generation,tenant::text||'/knowledge/'||NEW.document_id::text,doc.content_sha256,doc.size_bytes,
     material,CASE WHEN native THEN 'intent' ELSE 'legacy' END,NEW.started_by_membership_id,CASE WHEN native THEN app.current_user_id() ELSE NULL END);
   END IF;
  ELSIF TG_RELID='knowledge.purge_jobs'::regclass THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INVALID_RAW_BIRTH' USING ERRCODE='42501';END IF;
   SELECT s.id,s.state,s.version INTO source_row FROM knowledge.sources s WHERE s.organization_id=tenant AND s.id=NEW.source_id;
   IF source_row.id IS NULL OR source_row.state NOT IN('revoked','deleted') OR NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=tenant AND t.target_type='knowledge_source' AND t.target_id=NEW.source_id) THEN
    RAISE EXCEPTION 'RAW_CLOSED_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
   SELECT * INTO source_scope FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.source_id=NEW.source_id FOR UPDATE;
   native:=native AND source_scope.protocol_version=1 AND source_scope.state='open' AND source_scope.purge_job_id IS NULL AND source_scope.material_restore_generation=material;
   UPDATE lifecycle.raw_source_inventories SET purge_job_id=NEW.id,source_version=source_row.version,
    state=CASE WHEN native THEN 'capturing' ELSE 'legacy' END,capture_cursor=NULL,capture_count=0,
    capture_sha256=CASE WHEN native THEN encode(public.digest(convert_to('raw:v1:'||tenant::text||':'||NEW.source_id::text||':'||source_row.version::text||':'||NEW.id::text||':'||material::text,'UTF8'),'sha256'),'hex') ELSE NULL END
    WHERE organization_id=tenant AND source_id=NEW.source_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'RAW_SOURCE_INVENTORY_MISSING' USING ERRCODE='EN850';END IF;
  END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.record_raw_native_birth() FROM PUBLIC;
CREATE TRIGGER organizations_raw_native_birth AFTER INSERT ON org.organizations FOR EACH ROW EXECUTE FUNCTION lifecycle.record_raw_native_birth();
CREATE TRIGGER sources_raw_native_birth AFTER INSERT ON knowledge.sources FOR EACH ROW EXECUTE FUNCTION lifecycle.record_raw_native_birth();
CREATE TRIGGER documents_raw_native_birth AFTER INSERT ON knowledge.documents FOR EACH ROW EXECUTE FUNCTION lifecycle.record_raw_native_birth();
CREATE TRIGGER writers_raw_native_birth AFTER INSERT OR UPDATE ON knowledge.object_writers FOR EACH ROW EXECUTE FUNCTION lifecycle.record_raw_native_birth();
CREATE TRIGGER purge_jobs_raw_native_birth AFTER INSERT ON knowledge.purge_jobs FOR EACH ROW EXECUTE FUNCTION lifecycle.record_raw_native_birth();
--> statement-breakpoint

CREATE FUNCTION lifecycle.admit_raw_put(p_document uuid,p_write uuid,p_generation bigint)
 RETURNS TABLE(state text,source_id uuid,object_key text,content_sha256 text,size_bytes bigint,material_generation uuid,auth_generation uuid,token text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 material uuid;auth uuid;w record;s record;actual record;opaque text;
BEGIN
 IF session_user<>'ensemus_app' OR tenant IS NULL OR p_document IS NULL OR p_write IS NULL OR p_generation IS NULL OR p_generation<1
  OR coalesce(app.current_actor_type(),'') NOT IN('user','service') THEN RAISE EXCEPTION 'RAW_NATIVE_WRITER_REQUIRED' USING ERRCODE='42501';END IF;
 auth:=app.current_auth_restore_generation();material:=ai.current_material_restore_generation();
 IF auth IS NULL OR material IS NULL THEN RAISE EXCEPTION 'RAW_RESTORE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT x.* INTO w FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=p_document AND x.write_id=p_write AND x.generation=p_generation;
 IF w.id IS NULL OR w.material_restore_generation IS DISTINCT FROM material THEN RAISE EXCEPTION 'RAW_NATIVE_WRITER_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT x.id,x.state INTO s FROM knowledge.sources x WHERE x.organization_id=tenant AND x.id=w.source_id FOR SHARE NOWAIT;
 IF s.id IS NULL OR s.state<>'active' THEN RAISE EXCEPTION 'RAW_SOURCE_CLOSED' USING ERRCODE='EN850';END IF;
 PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND OR lifecycle.raw_org_native_admission(material) IS DISTINCT FROM true
  OR NOT EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.source_id=w.source_id
   AND i.protocol_version=1 AND i.state='open' AND i.material_restore_generation=material) THEN
  RAISE EXCEPTION 'RAW_LEGACY_INVENTORY_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF app.current_actor_type()='user' THEN
  PERFORM knowledge.assert_human_source_authority(w.source_id,true);
  IF w.started_by_membership_id IS DISTINCT FROM app.current_membership_id() OR w.started_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'RAW_NATIVE_WRITER_REQUIRED' USING ERRCODE='42501';END IF;
 END IF;
 SELECT x.* INTO actual FROM knowledge.object_writers x WHERE x.organization_id=tenant AND x.document_id=p_document
  AND x.source_id=w.source_id AND x.write_id=p_write AND x.generation=p_generation;
 IF actual.document_id IS NULL OR actual.state<>'active' THEN RAISE EXCEPTION 'RAW_NATIVE_WRITER_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT x.* INTO w FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.id=w.id FOR UPDATE NOWAIT;
 IF w.state<>'intent' THEN RAISE EXCEPTION 'RAW_WRITE_ALREADY_ADMITTED' USING ERRCODE='EN850';END IF;
 opaque:=encode(public.gen_random_bytes(32),'hex');
 UPDATE lifecycle.raw_object_writes SET state='put_admitted',put_token_sha256=encode(public.digest(opaque,'sha256'),'hex'),
  put_auth_restore_generation=auth,admitted_at=clock_timestamp() WHERE organization_id=tenant AND id=w.id;
 RETURN QUERY SELECT 'send'::text,w.source_id,w.object_key,w.content_sha256,w.size_bytes,material,auth,opaque;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.admit_raw_put(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.admit_raw_put(uuid,uuid,bigint) TO ensemus_app;

CREATE FUNCTION lifecycle.finish_raw_put(p_document uuid,p_write uuid,p_generation bigint,p_token text,p_material uuid,p_auth uuid,p_outcome text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);w record;
BEGIN
 IF session_user<>'ensemus_app' OR tenant IS NULL OR coalesce(app.current_actor_type(),'') NOT IN('user','service')
  OR p_token IS NULL OR p_token!~'^[0-9a-f]{64}$' OR p_outcome IS NULL OR p_outcome NOT IN('written','unknown') THEN
  RAISE EXCEPTION 'RAW_NATIVE_OUTCOME_REQUIRED' USING ERRCODE='42501';END IF;
 IF p_material IS DISTINCT FROM ai.current_material_restore_generation() OR p_auth IS DISTINCT FROM app.current_auth_restore_generation() THEN
  RAISE EXCEPTION 'RAW_RESTORE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT x.* INTO w FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=p_document AND x.write_id=p_write AND x.generation=p_generation;
 IF w.id IS NULL THEN RAISE EXCEPTION 'RAW_NATIVE_OUTCOME_REQUIRED' USING ERRCODE='EN850';END IF;
 -- Source -> organization -> writer, including the post-I/O generation recheck. Loss of ordinary
 -- source ACL does not block completion accounting; a missing/locked header or restore does.
 PERFORM s.id FROM knowledge.sources s WHERE s.organization_id=tenant AND s.id=w.source_id FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'RAW_NATIVE_OUTCOME_REQUIRED' USING ERRCODE='EN850';END IF;
 PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND OR p_material IS DISTINCT FROM ai.current_material_restore_generation() OR p_auth IS DISTINCT FROM app.current_auth_restore_generation() THEN
  RAISE EXCEPTION 'RAW_RESTORE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT x.* INTO w FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=p_document AND x.write_id=p_write AND x.generation=p_generation FOR UPDATE NOWAIT;
 IF w.id IS NULL OR w.state<>'put_admitted' OR w.material_restore_generation IS DISTINCT FROM p_material OR w.put_auth_restore_generation IS DISTINCT FROM p_auth
  OR w.put_token_sha256 IS DISTINCT FROM encode(public.digest(p_token,'sha256'),'hex')
  OR(app.current_actor_type()='user' AND(w.started_by_membership_id IS DISTINCT FROM app.current_membership_id() OR w.started_by_user_id IS DISTINCT FROM app.current_user_id())) THEN
  RAISE EXCEPTION 'RAW_NATIVE_OUTCOME_REQUIRED' USING ERRCODE='EN850';END IF;
 -- Publication/ACL loss does not turn a genuinely finished exact PUT into an unknown writer. This
 -- records only native operation completion; no source serving, publication or byte purge is granted.
 UPDATE lifecycle.raw_object_writes SET state=CASE WHEN p_outcome='written' THEN 'finished' ELSE 'unknown' END,
  finished_at=CASE WHEN p_outcome='written' THEN clock_timestamp() ELSE NULL END WHERE organization_id=tenant AND id=w.id;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN p_outcome='written';
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.finish_raw_put(uuid,uuid,bigint,text,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.finish_raw_put(uuid,uuid,bigint,text,uuid,uuid,text) TO ensemus_app;

CREATE FUNCTION lifecycle.raw_write_quiescent(p_document uuid,p_write uuid,p_generation bigint) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);answer boolean:=false;material uuid;auth uuid;
BEGIN
 IF session_user<>'ensemus_app' OR tenant IS NULL OR coalesce(app.current_actor_type(),'') NOT IN('user','service') THEN RETURN false;END IF;
 material:=ai.current_material_restore_generation();auth:=app.current_auth_restore_generation();
 IF material IS NULL OR auth IS NULL THEN RETURN false;END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND w.document_id=p_document AND w.write_id=p_write AND w.generation=p_generation
  AND w.generation>0 AND w.state IN('finished','not_dispatched') AND w.finished_at IS NOT NULL
  AND((w.state='finished' AND w.put_token_sha256 IS NOT NULL AND w.admitted_at IS NOT NULL)
   OR(w.state='not_dispatched' AND w.put_token_sha256 IS NULL AND w.admitted_at IS NULL))
  AND w.material_restore_generation=material AND w.put_auth_restore_generation=auth
  AND(app.current_actor_type()='service' OR(w.started_by_membership_id=app.current_membership_id() AND w.started_by_user_id=app.current_user_id()))) INTO answer;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_write_quiescent(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.raw_write_quiescent(uuid,uuid,bigint) TO ensemus_app;

-- A source closure can permanently revoke an intent that was NEVER admitted. Source/admission use
-- the same row barrier, and native transport starts only after its admission commits. This is
-- positive future-protocol no-request authority, not a TTL/cancellation/provider-absence assertion.
CREATE FUNCTION lifecycle.close_unadmitted_raw_write(p_document uuid,p_write uuid,p_generation bigint) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);w record;s record;material uuid;auth uuid;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN RETURN false;END IF;
 material:=ai.current_material_restore_generation();auth:=app.current_auth_restore_generation();
 IF material IS NULL OR auth IS NULL THEN RETURN false;END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT * INTO w FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=p_document AND x.write_id=p_write AND x.generation=p_generation;
 IF w.id IS NULL OR w.generation<1 OR w.state<>'intent' OR w.put_token_sha256 IS NOT NULL OR w.admitted_at IS NOT NULL
  OR w.material_restore_generation IS DISTINCT FROM material THEN
  PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN false;END IF;
 SELECT x.id,x.state INTO s FROM knowledge.sources x WHERE x.organization_id=tenant AND x.id=w.source_id FOR SHARE NOWAIT;
 IF s.id IS NULL OR s.state NOT IN('revoked','deleted') THEN
  PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN false;END IF;
 PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND OR lifecycle.raw_org_native_admission(material) IS DISTINCT FROM true THEN
  PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN false;END IF;
 SELECT * INTO w FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.id=w.id FOR UPDATE NOWAIT;
 IF w.state<>'intent' OR w.put_token_sha256 IS NOT NULL OR w.admitted_at IS NOT NULL THEN
  PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN false;END IF;
 UPDATE lifecycle.raw_object_writes SET state='not_dispatched',finished_at=clock_timestamp(),put_auth_restore_generation=auth WHERE organization_id=tenant AND id=w.id;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN true;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.close_unadmitted_raw_write(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.close_unadmitted_raw_write(uuid,uuid,bigint) TO ensemus_app;

CREATE FUNCTION lifecycle.capture_raw_source_inventory(p_source uuid,p_version bigint,p_job uuid)
 RETURNS TABLE(more boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);i record;w record;rows integer:=0;digest text;cursor_id uuid;amount bigint;material uuid;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN RAISE EXCEPTION 'RAW_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM app.current_auth_restore_generation();material:=ai.current_material_restore_generation();
 IF material IS NULL OR lifecycle.source_projection_hold_free(p_source,p_version,p_job) IS DISTINCT FROM true THEN RAISE EXCEPTION 'RAW_SOURCE_HOLD_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT * INTO i FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant AND x.source_id=p_source FOR UPDATE NOWAIT;
 IF i.id IS NULL OR i.protocol_version<>1 OR i.purge_job_id IS DISTINCT FROM p_job OR i.source_version IS DISTINCT FROM p_version
  OR i.material_restore_generation IS DISTINCT FROM material OR i.state NOT IN('capturing','sealed')
  OR lifecycle.raw_org_native_admission(material) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'RAW_LEGACY_INVENTORY_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF i.state='sealed' THEN RETURN QUERY SELECT false;
 ELSE
  digest:=i.capture_sha256;cursor_id:=i.capture_cursor;amount:=i.capture_count;
  FOR w IN SELECT * FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.source_id=p_source
   AND(i.capture_cursor IS NULL OR x.id>i.capture_cursor) ORDER BY x.id LIMIT 25 LOOP
   digest:=encode(public.digest(convert_to(digest||':'||w.id::text||':'||w.document_id::text||':'||w.write_id::text||':'||w.generation::text||':'||w.content_sha256||':'||w.size_bytes::text,'UTF8'),'sha256'),'hex');
   cursor_id:=w.id;amount:=amount+1;rows:=rows+1;
  END LOOP;
  IF rows<25 AND(EXISTS(SELECT 1 FROM knowledge.documents d WHERE d.organization_id=tenant AND d.source_id=p_source AND NOT EXISTS(
   SELECT 1 FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=d.id AND x.source_id=p_source AND x.generation=0 AND x.content_sha256=d.content_sha256 AND x.size_bytes=d.size_bytes))
   OR EXISTS(SELECT 1 FROM knowledge.object_writers a WHERE a.organization_id=tenant AND a.source_id=p_source AND NOT EXISTS(
    SELECT 1 FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=a.document_id AND x.write_id=a.write_id AND x.generation=a.generation AND x.source_id=p_source))) THEN
   RAISE EXCEPTION 'RAW_INVENTORY_INCOMPLETE' USING ERRCODE='EN850';END IF;
  UPDATE lifecycle.raw_source_inventories SET capture_cursor=cursor_id,capture_count=amount,capture_sha256=digest,
   state=CASE WHEN rows<25 THEN 'sealed' ELSE 'capturing' END,sealed_at=CASE WHEN rows<25 THEN clock_timestamp() ELSE NULL END WHERE organization_id=tenant AND id=i.id;
  RETURN QUERY SELECT rows=25;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.capture_raw_source_inventory(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.capture_raw_source_inventory(uuid,bigint,uuid) TO ensemus_app;
--> statement-breakpoint

ALTER TABLE lifecycle.object_deletion_claims ALTER COLUMN artifact_id DROP NOT NULL;
ALTER TABLE lifecycle.object_deletion_claims ADD COLUMN raw_source_id uuid,ADD COLUMN raw_source_version bigint,
 ADD COLUMN raw_purge_job_id uuid,ADD COLUMN raw_document_id uuid,ADD COLUMN material_restore_generation uuid,ADD COLUMN auth_restore_generation uuid;
ALTER TABLE lifecycle.object_deletion_claims DROP CONSTRAINT object_deletion_claims_kind_check;
ALTER TABLE lifecycle.object_deletion_claims ADD CONSTRAINT object_deletion_claims_kind_check CHECK(kind IN('derived','ordinary','archive','raw_source'));
ALTER TABLE lifecycle.object_deletion_claims DROP CONSTRAINT object_deletion_claims_generation_check;
ALTER TABLE lifecycle.object_deletion_claims ADD CONSTRAINT object_deletion_claims_generation_check CHECK((kind='raw_source' AND generation>=0) OR(kind<>'raw_source' AND generation>0));
ALTER TABLE lifecycle.object_deletion_claims ADD CONSTRAINT raw_claim_version_nonnull CHECK(kind<>'raw_source' OR raw_source_version IS NOT NULL);
ALTER TABLE lifecycle.object_deletion_claims DROP CONSTRAINT object_deletion_key;
ALTER TABLE lifecycle.object_deletion_claims ADD CONSTRAINT object_deletion_key CHECK(
 (kind='raw_source' AND artifact_id IS NULL AND import_id IS NULL AND raw_source_id IS NOT NULL AND raw_source_version IS NOT NULL AND raw_source_version>0
  AND raw_purge_job_id IS NOT NULL AND raw_document_id IS NOT NULL AND material_restore_generation IS NOT NULL AND auth_restore_generation IS NOT NULL
  AND object_key=organization_id::text||'/knowledge/'||raw_document_id::text)
 OR(kind<>'raw_source' AND artifact_id IS NOT NULL AND raw_source_id IS NULL AND raw_source_version IS NULL AND raw_purge_job_id IS NULL AND raw_document_id IS NULL
  AND material_restore_generation IS NULL AND auth_restore_generation IS NULL AND((kind='archive' AND import_id IS NOT NULL
   AND object_key=organization_id::text||'/archive-quarantine/'||import_id::text||'/'||artifact_id::text||'/'||writer_token::text)
   OR(kind IN('derived','ordinary') AND import_id IS NULL AND object_key=organization_id::text||'/artifacts/'||artifact_id::text))));

CREATE FUNCTION lifecycle.raw_document_writers_ready(p_document uuid,p_material uuid,p_auth uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_material IS NOT NULL AND p_auth IS NOT NULL
  AND EXISTS(SELECT 1 FROM lifecycle.raw_object_writes c JOIN lifecycle.raw_source_inventories i
   ON i.organization_id=c.organization_id AND i.source_id=c.source_id WHERE c.organization_id=app.current_organization_id()
   AND c.document_id=p_document AND c.generation=0 AND c.state='catalog' AND c.material_restore_generation=p_material
   AND i.protocol_version=1 AND i.state='sealed' AND i.sealed_at IS NOT NULL AND i.purge_job_id IS NOT NULL AND i.source_version>0 AND i.material_restore_generation=p_material)
  AND lifecycle.raw_org_native_admission(p_material)
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=app.current_organization_id() AND w.document_id=p_document AND w.generation>0
   AND(w.material_restore_generation IS DISTINCT FROM p_material OR w.put_auth_restore_generation IS DISTINCT FROM p_auth OR w.finished_at IS NULL
    OR(w.state='finished' AND(w.put_token_sha256 IS NULL OR w.admitted_at IS NULL))
    OR(w.state='not_dispatched' AND(w.put_token_sha256 IS NOT NULL OR w.admitted_at IS NOT NULL)) OR w.state NOT IN('finished','not_dispatched')))
  AND NOT EXISTS(SELECT 1 FROM knowledge.object_writers a WHERE a.organization_id=app.current_organization_id() AND a.document_id=p_document
   AND(a.state<>'settled' OR NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=a.organization_id
    AND w.document_id=a.document_id AND w.source_id=a.source_id AND w.write_id=a.write_id AND w.generation=a.generation AND w.state IN('finished','not_dispatched'))))
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_document_writers_ready(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION lifecycle.raw_document_delete_target(p_document uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);c record;w record;i record;s record;j record;material uuid;auth uuid;answer jsonb;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN RETURN NULL;END IF;
 material:=ai.current_material_restore_generation();auth:=app.current_auth_restore_generation();
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT * INTO c FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=p_document AND x.generation=0;
 SELECT * INTO i FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant AND x.source_id=c.source_id;
 SELECT x.id,x.version,x.state INTO s FROM knowledge.sources x WHERE x.organization_id=tenant AND x.id=c.source_id;
 SELECT x.id INTO j FROM knowledge.purge_jobs x WHERE x.organization_id=tenant AND x.source_id=c.source_id AND x.id=i.purge_job_id;
 IF c.id IS NOT NULL AND i.id IS NOT NULL AND s.id IS NOT NULL AND s.state IN('revoked','deleted') AND s.version=i.source_version AND j.id IS NOT NULL
  AND lifecycle.raw_document_writers_ready(p_document,material,auth) THEN
  SELECT * INTO w FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=p_document ORDER BY x.generation DESC LIMIT 1;
  IF w.generation<=9007199254740991 THEN
   answer:=jsonb_build_object('kind','raw_source','sourceId',c.source_id,'sourceVersion',i.source_version::text,'purgeJobId',i.purge_job_id,
    'documentId',p_document,'writeId',w.write_id,'generation',w.generation,'materialRestoreGeneration',material,'authRestoreGeneration',auth);
  END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_document_delete_target(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.raw_document_delete_target(uuid) TO ensemus_app;

-- Clone only the three fixed reviewed public definitions at migration time, retaining their public
-- OIDs for parsed dependents. There is no runtime identifier/SQL selector or generic fallback.
DO $$ DECLARE item record;definition text;header text;replacement text;BEGIN
 FOR item IN SELECT * FROM(VALUES
  ('lifecycle.begin_object_deletion(jsonb)','begin_object_deletion','begin_object_deletion_before_raw'),
  ('lifecycle.object_delete_terminal(uuid,text)','object_delete_terminal','object_delete_terminal_before_raw'),
  ('lifecycle.object_delete_absent(uuid)','object_delete_absent','object_delete_absent_before_raw')
 ) fixed(signature,name,clone) LOOP
  definition:=pg_get_functiondef(item.signature::regprocedure);header:='CREATE OR REPLACE FUNCTION lifecycle.'||item.name||'(';
  replacement:='CREATE OR REPLACE FUNCTION lifecycle.'||item.clone||'(';
  IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'RAW_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
  EXECUTE replace(definition,header,replacement);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION lifecycle.begin_object_deletion_before_raw(jsonb),lifecycle.object_delete_terminal_before_raw(uuid,text),lifecycle.object_delete_absent_before_raw(uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;

CREATE OR REPLACE FUNCTION lifecycle.begin_object_deletion(p_target jsonb)
 RETURNS TABLE(state text,claim_id uuid,object_key text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);actual jsonb;c record;w record;i record;old_claim record;
 source_key uuid;doc_key uuid;job_key uuid;version bigint;material uuid;auth uuid;keys text[];
BEGIN
 IF p_target->>'kind' IS DISTINCT FROM 'raw_source' THEN RETURN QUERY SELECT * FROM lifecycle.begin_object_deletion_before_raw(p_target);RETURN;END IF;
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN RAISE EXCEPTION 'RAW_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(p_target) k;
 IF keys IS DISTINCT FROM ARRAY['authRestoreGeneration','documentId','generation','kind','materialRestoreGeneration','purgeJobId','sourceId','sourceVersion','writeId']::text[] THEN
  RAISE EXCEPTION 'RAW_TARGET_REQUIRED' USING ERRCODE='EN850';END IF;
 source_key:=(p_target->>'sourceId')::uuid;doc_key:=(p_target->>'documentId')::uuid;job_key:=(p_target->>'purgeJobId')::uuid;version:=(p_target->>'sourceVersion')::bigint;
 material:=ai.current_material_restore_generation();auth:=app.current_auth_restore_generation();
 IF material IS NULL OR auth IS NULL OR material IS DISTINCT FROM(p_target->>'materialRestoreGeneration')::uuid OR auth IS DISTINCT FROM(p_target->>'authRestoreGeneration')::uuid THEN
  RAISE EXCEPTION 'RAW_RESTORE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 -- Source ->organization NOWAIT ->job/inventory/claim. A hold and this admission share the org row.
 PERFORM s.id FROM knowledge.sources s WHERE s.organization_id=tenant AND s.id=source_key AND s.state IN('revoked','deleted') AND s.version=version FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'RAW_CLOSED_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
 PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'RAW_TENANT_REQUIRED' USING ERRCODE='EN850';END IF;
 IF EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active') THEN
  RETURN QUERY SELECT 'held'::text,NULL::uuid,NULL::text;
 ELSE
  PERFORM j.id FROM knowledge.purge_jobs j WHERE j.organization_id=tenant AND j.id=job_key AND j.source_id=source_key FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'RAW_JOB_REQUIRED' USING ERRCODE='EN850';END IF;
  actual:=lifecycle.raw_document_delete_target(doc_key);
  IF actual IS NULL OR actual IS DISTINCT FROM p_target THEN RAISE EXCEPTION 'RAW_TARGET_REQUIRED' USING ERRCODE='EN850';END IF;
  SELECT * INTO c FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=doc_key AND x.generation=0;
  SELECT * INTO w FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=doc_key ORDER BY x.generation DESC LIMIT 1;
  SELECT * INTO old_claim FROM lifecycle.object_deletion_claims x WHERE x.organization_id=tenant AND x.object_key=c.object_key
   ORDER BY CASE WHEN x.state IN('admitted','unknown') THEN 0 ELSE 1 END,x.admitted_at DESC,x.id DESC LIMIT 1 FOR UPDATE NOWAIT;
  IF old_claim.id IS NOT NULL THEN
   IF old_claim.kind='raw_source' AND old_claim.raw_source_id=source_key AND old_claim.raw_source_version=version AND old_claim.raw_purge_job_id=job_key
    AND old_claim.raw_document_id=doc_key AND old_claim.writer_token=w.write_id AND old_claim.generation=w.generation AND old_claim.sha256=c.content_sha256
    AND old_claim.material_restore_generation=material AND old_claim.auth_restore_generation=auth AND old_claim.state IN('deleted','proven') THEN
    RETURN QUERY SELECT 'deleted'::text,old_claim.id,c.object_key;
   ELSE RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;END IF;
  ELSE
   INSERT INTO lifecycle.object_deletion_claims(organization_id,kind,artifact_id,raw_source_id,raw_source_version,raw_purge_job_id,raw_document_id,
    writer_token,generation,object_key,sha256,state,material_restore_generation,auth_restore_generation)
    VALUES(tenant,'raw_source',NULL,source_key,version,job_key,doc_key,w.write_id,w.generation,c.object_key,c.content_sha256,'admitted',material,auth) RETURNING id INTO claim_id;
   RETURN QUERY SELECT 'admitted'::text,claim_id,c.object_key;
  END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;

CREATE FUNCTION lifecycle.lock_raw_delete_claim(p_claim uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();c record;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN RETURN false;END IF;
 SELECT * INTO c FROM lifecycle.object_deletion_claims x WHERE x.organization_id=tenant AND x.id=p_claim AND x.kind='raw_source';
 IF c.id IS NULL THEN RETURN false;END IF;
 PERFORM s.id FROM knowledge.sources s WHERE s.organization_id=tenant AND s.id=c.raw_source_id AND s.state IN('revoked','deleted') AND s.version=c.raw_source_version FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM j.id FROM knowledge.purge_jobs j WHERE j.organization_id=tenant AND j.id=c.raw_purge_job_id AND j.source_id=c.raw_source_id FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM x.id FROM lifecycle.object_deletion_claims x WHERE x.organization_id=tenant AND x.id=p_claim FOR UPDATE NOWAIT;
 RETURN c.material_restore_generation=ai.current_material_restore_generation() AND c.auth_restore_generation=app.current_auth_restore_generation();
END $$;
REVOKE ALL ON FUNCTION lifecycle.lock_raw_delete_claim(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION lifecycle.object_delete_terminal(p_claim uuid,p_outcome text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text:=current_setting('lifecycle.raw_object_org',true);c record;
BEGIN
 PERFORM set_config('lifecycle.raw_object_org',app.current_organization_id()::text,true);
 SELECT * INTO c FROM lifecycle.object_deletion_claims x WHERE x.organization_id=app.current_organization_id() AND x.id=p_claim;
 IF c.kind IS DISTINCT FROM 'raw_source' THEN PERFORM lifecycle.object_delete_terminal_before_raw(p_claim,p_outcome);
 ELSE
  IF lifecycle.lock_raw_delete_claim(p_claim) IS DISTINCT FROM true OR p_outcome IS NULL OR p_outcome NOT IN('unknown','deleted') THEN
   RAISE EXCEPTION 'RAW_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  UPDATE lifecycle.object_deletion_claims SET state=p_outcome WHERE organization_id=c.organization_id AND id=c.id AND state='admitted';
  IF NOT FOUND THEN RAISE EXCEPTION 'RAW_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;

CREATE OR REPLACE FUNCTION lifecycle.object_delete_absent(p_claim uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text:=current_setting('lifecycle.raw_object_org',true);c record;answer boolean:=false;
BEGIN
 PERFORM set_config('lifecycle.raw_object_org',app.current_organization_id()::text,true);
 SELECT * INTO c FROM lifecycle.object_deletion_claims x WHERE x.organization_id=app.current_organization_id() AND x.id=p_claim;
 IF c.kind IS DISTINCT FROM 'raw_source' THEN answer:=lifecycle.object_delete_absent_before_raw(p_claim);
 ELSIF lifecycle.lock_raw_delete_claim(p_claim) AND c.state IN('deleted','proven') AND c.terminal_at IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=c.organization_id AND h.status='active')
  AND lifecycle.raw_document_writers_ready(c.raw_document_id,c.material_restore_generation,c.auth_restore_generation) THEN
  IF c.state='deleted' THEN UPDATE lifecycle.object_deletion_claims SET state='proven' WHERE organization_id=c.organization_id AND id=c.id;END IF;
  -- Historical count only. This flag never substitutes for the retained native/physical proof.
  UPDATE knowledge.documents d SET object_purge_observed=EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w
   WHERE w.organization_id=c.organization_id AND w.document_id=c.raw_document_id AND w.generation>0 AND w.state='finished')
   WHERE d.organization_id=c.organization_id AND d.id=c.raw_document_id;
  answer:=true;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
--> statement-breakpoint

CREATE INDEX raw_delete_receipt_by_document ON lifecycle.object_deletion_claims(organization_id,raw_document_id,material_restore_generation) WHERE kind='raw_source';
CREATE INDEX raw_object_unconfirmed ON lifecycle.raw_object_writes(organization_id,source_id,state);

CREATE FUNCTION lifecycle.raw_document_material_complete(p_document uuid,p_material uuid,p_auth uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT lifecycle.raw_document_writers_ready(p_document,p_material,p_auth)
  AND EXISTS(SELECT 1 FROM lifecycle.raw_object_writes catalog JOIN lifecycle.raw_source_inventories inventory
   ON inventory.organization_id=catalog.organization_id AND inventory.source_id=catalog.source_id
   JOIN lifecycle.raw_object_writes last_write ON last_write.organization_id=catalog.organization_id AND last_write.document_id=catalog.document_id
   WHERE catalog.organization_id=app.current_organization_id() AND catalog.document_id=p_document AND catalog.generation=0
    AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes later WHERE later.organization_id=last_write.organization_id AND later.document_id=last_write.document_id AND later.generation>last_write.generation)
    AND EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=catalog.organization_id AND c.kind='raw_source'
     AND c.raw_document_id=catalog.document_id AND c.raw_source_id=catalog.source_id AND c.raw_source_version=inventory.source_version AND c.raw_purge_job_id=inventory.purge_job_id
     AND c.artifact_id IS NULL AND c.import_id IS NULL AND c.object_key=catalog.object_key AND c.sha256=catalog.content_sha256
     AND c.writer_token=last_write.write_id AND c.generation=last_write.generation AND c.material_restore_generation=p_material AND c.auth_restore_generation=p_auth
     AND c.state='proven' AND c.terminal_at IS NOT NULL AND c.absent_at>=c.terminal_at))
  AND NOT EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=app.current_organization_id()
   AND c.object_key=app.current_organization_id()::text||'/knowledge/'||p_document::text AND c.state<>'proven')
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_document_material_complete(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION lifecycle.raw_source_inventory_complete(p_source uuid,p_version bigint,p_job uuid,p_material uuid,p_auth uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_material IS NOT NULL AND p_auth IS NOT NULL
  AND lifecycle.raw_org_native_admission(p_material)
  AND EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=app.current_organization_id() AND i.source_id=p_source
   AND i.protocol_version=1 AND i.state='sealed' AND i.source_version=p_version AND i.purge_job_id=p_job AND i.material_restore_generation=p_material
   AND i.sealed_at IS NOT NULL AND i.capture_sha256 IS NOT NULL
   AND i.capture_count=(SELECT count(*) FROM lifecycle.raw_object_writes w WHERE w.organization_id=i.organization_id AND w.source_id=p_source))
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source
   AND(w.material_restore_generation IS DISTINCT FROM p_material OR(w.generation>0 AND(w.state NOT IN('finished','not_dispatched') OR w.put_auth_restore_generation IS DISTINCT FROM p_auth OR w.finished_at IS NULL))))
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source AND w.generation=0
   AND NOT lifecycle.raw_document_material_complete(w.document_id,p_material,p_auth))
  -- PG headers cannot be removed as a substitute for a retained physical proof; nor may completed
  -- status leave live raw document/writer metadata behind. Their DELETE guards use the per-document proof.
  AND NOT EXISTS(SELECT 1 FROM knowledge.documents d WHERE d.organization_id=app.current_organization_id() AND d.source_id=p_source)
  AND NOT EXISTS(SELECT 1 FROM knowledge.object_writers w WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_source_inventory_complete(uuid,bigint,uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION lifecycle.raw_source_material_complete(p_source uuid,p_source_version bigint,p_purge_job uuid,p_material_restore_generation uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);auth uuid;answer boolean:=false;
BEGIN
 IF current_user<>'ensemus_migrator' OR tenant IS NULL OR p_source IS NULL OR p_purge_job IS NULL OR p_source_version IS NULL OR p_source_version<1
  OR NOT((session_user IN('ensemus_app','ensemus_agent') AND knowledge.is_service_actor()) OR session_user='ensemus_eraser') THEN RETURN false;END IF;
 auth:=app.current_auth_restore_generation();
 IF auth IS NULL OR p_material_restore_generation IS NULL OR p_material_restore_generation IS DISTINCT FROM ai.current_material_restore_generation() THEN RETURN false;END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 PERFORM s.id FROM knowledge.sources s WHERE s.organization_id=tenant AND s.id=p_source AND s.version=p_source_version AND s.state IN('revoked','deleted') FOR SHARE NOWAIT;
 IF FOUND THEN
  PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
  IF FOUND AND NOT EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active') THEN
   -- BEFORE the completion UPDATE the real row is still pending/running/failed. Completed is also
   -- accepted for requalification; no caller can use the stored word as its raw material proof.
   PERFORM j.id FROM knowledge.purge_jobs j WHERE j.organization_id=tenant AND j.source_id=p_source AND j.id=p_purge_job
    AND j.state IN('pending','running','failed','completed') FOR SHARE NOWAIT;
   IF FOUND AND EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=tenant AND t.target_type='knowledge_source' AND t.target_id=p_source) THEN
    answer:=lifecycle.raw_source_inventory_complete(p_source,p_source_version,p_purge_job,p_material_restore_generation,auth);
   END IF;
  END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN lock_not_available THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN false;
 WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_source_material_complete(uuid,bigint,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.raw_source_material_complete(uuid,bigint,uuid,uuid) TO ensemus_app,ensemus_agent,ensemus_eraser;

CREATE FUNCTION lifecycle.raw_source_status(p_source uuid,p_job uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);s record;material uuid;auth uuid;answer boolean:=false;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'user' OR tenant IS NULL THEN RETURN false;END IF;
 -- This is a fresh readable-source metadata projection, not a body/mutation/service capability.
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 PERFORM knowledge.assert_human_source_authority(p_source,false);
 material:=ai.current_material_restore_generation();auth:=app.current_auth_restore_generation();
 SELECT x.id,x.version,x.state INTO s FROM knowledge.sources x WHERE x.organization_id=tenant AND x.id=p_source FOR SHARE NOWAIT;
 IF s.id IS NOT NULL AND s.state IN('revoked','deleted') AND material IS NOT NULL AND auth IS NOT NULL THEN
  PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
  IF FOUND AND NOT EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active')
   AND EXISTS(SELECT 1 FROM knowledge.purge_jobs j WHERE j.organization_id=tenant AND j.source_id=p_source AND j.id=p_job) THEN
   answer:=lifecycle.raw_source_inventory_complete(p_source,s.version,p_job,material,auth);
  END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN lock_not_available THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN false;
 WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_source_status(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.raw_source_status(uuid,uuid) TO ensemus_app;

CREATE FUNCTION lifecycle.raw_tenant_inventory_complete() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);material uuid;auth uuid;answer boolean;
BEGIN
 IF tenant IS NULL THEN RETURN false;END IF;
 material:=ai.current_material_restore_generation();auth:=app.current_auth_restore_generation();
 IF material IS NULL OR auth IS NULL THEN RETURN false;END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.scope_kind='organization'
   AND i.protocol_version=1 AND i.state='open' AND i.material_restore_generation=material)
  AND NOT EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active')
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.scope_kind='source'
   AND(i.protocol_version<>1 OR i.state<>'sealed' OR i.material_restore_generation IS DISTINCT FROM material OR i.purge_job_id IS NULL OR i.source_version IS NULL
    OR NOT lifecycle.raw_source_inventory_complete(i.source_id,i.source_version,i.purge_job_id,material,auth)))
  AND NOT EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=tenant AND(s.state='active' OR NOT EXISTS(
   SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.source_id=s.id AND i.source_version=s.version AND i.protocol_version=1 AND i.state='sealed')))
  AND NOT EXISTS(SELECT 1 FROM knowledge.documents d WHERE d.organization_id=tenant)
  AND NOT EXISTS(SELECT 1 FROM knowledge.object_writers w WHERE w.organization_id=tenant)
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND NOT EXISTS(
   SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.source_id=w.source_id AND i.protocol_version=1 AND i.state='sealed')) INTO answer;
 -- Retained inventory is read even after the source/job/document headers disappear. Missing rows
 -- cannot convert legacy/org/restore/unknown material debt to an empty per-live-source loop.
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_tenant_inventory_complete() FROM PUBLIC;

ALTER TABLE lifecycle.delegated_erasure_receipts ADD COLUMN raw_protocol_version integer,ADD COLUMN raw_inventory_sha256 text,
 ADD COLUMN raw_scope_count bigint,ADD COLUMN raw_write_count bigint;
ALTER TABLE lifecycle.delegated_erasure_receipts ADD CONSTRAINT delegated_erasure_raw_pin CHECK(
 (raw_protocol_version IS NULL AND raw_inventory_sha256 IS NULL AND raw_scope_count IS NULL AND raw_write_count IS NULL)
 OR(raw_protocol_version=1 AND raw_inventory_sha256 IS NOT NULL AND raw_inventory_sha256 ~ '^[0-9a-f]{64}$'
  AND raw_scope_count IS NOT NULL AND raw_scope_count>=0 AND raw_write_count IS NOT NULL AND raw_write_count>=0));
CREATE POLICY raw_erasure_receipt_read ON lifecycle.delegated_erasure_receipts FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
CREATE POLICY raw_erasure_intent_read ON lifecycle.offboardings FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));

CREATE FUNCTION lifecycle.raw_erasure_witness() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);material uuid;auth uuid;answer boolean:=false;
BEGIN
 IF tenant IS NULL OR session_user NOT IN('ensemus_app','ensemus_eraser') OR NOT knowledge.is_service_actor() THEN RETURN false;END IF;
 material:=ai.current_material_restore_generation();auth:=app.current_auth_restore_generation();
 IF material IS NULL OR auth IS NULL OR lifecycle.erasure_open(tenant) IS DISTINCT FROM true THEN RETURN false;END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT NOT EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active')
  AND EXISTS(SELECT 1 FROM lifecycle.delegated_erasure_receipts r JOIN lifecycle.offboardings o ON o.organization_id=r.organization_id AND o.id=r.offboarding_id
   JOIN lifecycle.offboarding_admissions a ON a.organization_id=o.organization_id AND a.offboarding_id=o.id
   WHERE r.organization_id=tenant AND o.state='erasing' AND o.erasure_started_at IS NOT NULL AND r.erasure_started_at=o.erasure_started_at
    AND r.admitted_at=a.admitted_at AND o.requested_by_membership_id=a.requested_by_membership_id
    AND r.material_restore_generation=material AND r.auth_restore_generation=auth
    AND r.raw_protocol_version=1 AND r.raw_inventory_sha256 ~ '^[0-9a-f]{64}$' AND r.raw_scope_count IS NOT NULL AND r.raw_scope_count>=0
    AND r.raw_write_count IS NOT NULL AND r.raw_write_count>=0) INTO answer;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_erasure_witness() FROM PUBLIC;
CREATE FUNCTION lifecycle.raw_tenant_material_complete() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT lifecycle.raw_erasure_witness() OR lifecycle.raw_tenant_inventory_complete()
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_tenant_material_complete() FROM PUBLIC;

CREATE FUNCTION lifecycle.bind_raw_erasure_witness() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text:=current_setting('lifecycle.raw_object_org',true);tenant uuid:=app.current_organization_id();scopes bigint;writes bigint;proof text;
BEGIN
 IF TG_RELID<>'lifecycle.delegated_erasure_receipts'::regclass OR TG_OP<>'INSERT' OR session_user<>'ensemus_app' OR NOT knowledge.is_service_actor()
  OR NEW.organization_id IS DISTINCT FROM tenant OR NEW.raw_protocol_version IS NOT NULL OR NEW.raw_inventory_sha256 IS NOT NULL OR NEW.raw_scope_count IS NOT NULL OR NEW.raw_write_count IS NOT NULL
  OR NEW.material_restore_generation IS DISTINCT FROM ai.current_material_restore_generation() OR NEW.auth_restore_generation IS DISTINCT FROM app.current_auth_restore_generation()
  OR lifecycle.admitted_offboarding(NEW.offboarding_id) IS DISTINCT FROM true OR lifecycle.erasure_open(tenant) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'RAW_NATIVE_ERASURE_WITNESS_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND OR lifecycle.raw_tenant_inventory_complete() IS DISTINCT FROM true THEN RAISE EXCEPTION 'RAW_ERASURE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT count(*) INTO scopes FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant;
 SELECT count(*) INTO writes FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant;
 SELECT encode(sha256(convert_to(jsonb_build_object('protocol','raw-erasure/v1','organization',tenant,'offboarding',NEW.offboarding_id,
  'material',NEW.material_restore_generation,'auth',NEW.auth_restore_generation,'admittedAt',NEW.admitted_at,'erasureStartedAt',NEW.erasure_started_at,
  'scopes',(SELECT coalesce(jsonb_agg(jsonb_build_array(x.id,x.source_id,x.protocol_version,x.material_restore_generation,x.state,x.purge_job_id,x.source_version,x.capture_count,x.capture_sha256) ORDER BY x.id),'[]'::jsonb) FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant),
  'writes',(SELECT coalesce(jsonb_agg(jsonb_build_array(x.id,x.document_id,x.write_id,x.generation,x.content_sha256,x.size_bytes,x.state,x.material_restore_generation,x.put_auth_restore_generation,x.put_token_sha256,x.admitted_at,x.finished_at) ORDER BY x.id),'[]'::jsonb) FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant),
  'deletes',(SELECT coalesce(jsonb_agg(jsonb_build_array(x.id,x.raw_source_id,x.raw_source_version,x.raw_purge_job_id,x.raw_document_id,x.writer_token,x.generation,x.sha256,x.material_restore_generation,x.auth_restore_generation,x.state,x.terminal_at,x.absent_at) ORDER BY x.id),'[]'::jsonb) FROM lifecycle.object_deletion_claims x WHERE x.organization_id=tenant AND x.kind='raw_source'))::text,'UTF8')),'hex') INTO proof;
 NEW.raw_protocol_version:=1;NEW.raw_inventory_sha256:=proof;NEW.raw_scope_count:=scopes;NEW.raw_write_count:=writes;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.bind_raw_erasure_witness() FROM PUBLIC;
CREATE TRIGGER delegated_erasure_raw_birth BEFORE INSERT ON lifecycle.delegated_erasure_receipts FOR EACH ROW EXECUTE FUNCTION lifecycle.bind_raw_erasure_witness();
-- A 0515-only seal cannot return success after raw scope is introduced. History stays immutable.
-- New native seals pass the actual INSERT hook. Raw-qualified seals remain usable during ordered
-- proof-row cleanup, under their original same-generation actual offboarding admission.
DO $$ DECLARE definition text;header text:='CREATE OR REPLACE FUNCTION lifecycle.seal_delegated_erasure(';BEGIN
 definition:=pg_get_functiondef('lifecycle.seal_delegated_erasure(uuid)'::regprocedure);
 IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'RAW_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,header,'CREATE OR REPLACE FUNCTION lifecycle.seal_delegated_erasure_before_raw(');
END $$;
REVOKE ALL ON FUNCTION lifecycle.seal_delegated_erasure_before_raw(uuid) FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser;
CREATE OR REPLACE FUNCTION lifecycle.seal_delegated_erasure(p_intent uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);answer boolean:=false;
BEGIN
 IF tenant IS NULL OR p_intent IS NULL OR session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() THEN RETURN false;END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
 IF FOUND AND NOT EXISTS(SELECT 1 FROM lifecycle.delegated_erasure_receipts r WHERE r.organization_id=tenant AND r.offboarding_id=p_intent
  AND(r.raw_protocol_version IS DISTINCT FROM 1 OR r.raw_inventory_sha256 IS NULL OR r.raw_scope_count IS NULL OR r.raw_write_count IS NULL))
  AND lifecycle.raw_tenant_material_complete() IS TRUE THEN
  answer:=lifecycle.seal_delegated_erasure_before_raw(p_intent);
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN lock_not_available THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN false;
 WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
DO $$ DECLARE definition text;header text:='CREATE OR REPLACE FUNCTION lifecycle.tenant_object_proofs_complete(';BEGIN
 definition:=pg_get_functiondef('lifecycle.tenant_object_proofs_complete()'::regprocedure);
 IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'RAW_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,header,'CREATE OR REPLACE FUNCTION lifecycle.tenant_object_proofs_complete_before_raw(');
END $$;
REVOKE ALL ON FUNCTION lifecycle.tenant_object_proofs_complete_before_raw() FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser;
CREATE OR REPLACE FUNCTION lifecycle.tenant_object_proofs_complete() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT lifecycle.tenant_object_proofs_complete_before_raw() AND lifecycle.raw_tenant_material_complete()
$$;
--> statement-breakpoint

CREATE FUNCTION lifecycle.guard_raw_inventory_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR TG_RELID<>'lifecycle.raw_source_inventories'::regclass OR current_user<>'ensemus_migrator'
  OR NOT lifecycle.raw_metadata_scope(OLD.organization_id) OR ROW(NEW.organization_id,NEW.id,NEW.scope_kind,NEW.source_id,NEW.protocol_version,NEW.material_restore_generation,NEW.born_at)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.scope_kind,OLD.source_id,OLD.protocol_version,OLD.material_restore_generation,OLD.born_at)
  OR(OLD.purge_job_id IS NOT NULL AND NEW.purge_job_id IS DISTINCT FROM OLD.purge_job_id)
  OR(OLD.source_version IS NOT NULL AND NEW.source_version IS DISTINCT FROM OLD.source_version)
  OR NEW.capture_count<OLD.capture_count OR NOT(NEW.state=OLD.state
   OR(OLD.state='open' AND NEW.state IN('capturing','legacy','restore_debt'))
   OR(OLD.state='capturing' AND NEW.state IN('sealed','restore_debt'))
   OR(OLD.state IN('sealed','legacy') AND NEW.state='restore_debt')) THEN
  RAISE EXCEPTION 'RAW_INVENTORY_IMMUTABLE' USING ERRCODE='42501';END IF;
 IF OLD.state='sealed' AND ROW(NEW.capture_cursor,NEW.capture_count,NEW.capture_sha256,NEW.sealed_at)
   IS DISTINCT FROM ROW(OLD.capture_cursor,OLD.capture_count,OLD.capture_sha256,OLD.sealed_at) THEN
  RAISE EXCEPTION 'RAW_INVENTORY_IMMUTABLE' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.guard_raw_inventory_change() FROM PUBLIC;
CREATE TRIGGER raw_inventory_change BEFORE UPDATE ON lifecycle.raw_source_inventories FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_raw_inventory_change();
CREATE FUNCTION lifecycle.guard_raw_write_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR TG_RELID<>'lifecycle.raw_object_writes'::regclass OR current_user<>'ensemus_migrator'
  OR NOT lifecycle.raw_metadata_scope(OLD.organization_id)
  OR ROW(NEW.organization_id,NEW.id,NEW.source_id,NEW.document_id,NEW.write_id,NEW.generation,NEW.object_key,NEW.content_sha256,NEW.size_bytes,
   NEW.material_restore_generation,NEW.started_by_membership_id,NEW.started_by_user_id,NEW.born_at)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.source_id,OLD.document_id,OLD.write_id,OLD.generation,OLD.object_key,OLD.content_sha256,OLD.size_bytes,
   OLD.material_restore_generation,OLD.started_by_membership_id,OLD.started_by_user_id,OLD.born_at)
  OR NOT((OLD.state='intent' AND NEW.state IN('put_admitted','not_dispatched')) OR(OLD.state='put_admitted' AND NEW.state IN('finished','unknown'))) THEN
  RAISE EXCEPTION 'RAW_WRITER_IMMUTABLE' USING ERRCODE='42501';END IF;
 IF OLD.state='put_admitted' AND ROW(NEW.put_token_sha256,NEW.put_auth_restore_generation,NEW.admitted_at)
  IS DISTINCT FROM ROW(OLD.put_token_sha256,OLD.put_auth_restore_generation,OLD.admitted_at) THEN
  RAISE EXCEPTION 'RAW_WRITER_IMMUTABLE' USING ERRCODE='42501';END IF;
 IF NEW.state='not_dispatched' AND(NEW.put_token_sha256 IS NOT NULL OR NEW.admitted_at IS NOT NULL OR NEW.finished_at IS NULL OR NEW.put_auth_restore_generation IS NULL) THEN
  RAISE EXCEPTION 'RAW_WRITER_IMMUTABLE' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.guard_raw_write_change() FROM PUBLIC;
CREATE TRIGGER raw_write_change BEFORE UPDATE ON lifecycle.raw_object_writes FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_raw_write_change();
CREATE TRIGGER raw_inventory_keep BEFORE TRUNCATE ON lifecycle.raw_source_inventories FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER raw_writes_keep BEFORE TRUNCATE ON lifecycle.raw_object_writes FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE FUNCTION lifecycle.require_raw_inventory_erasure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
BEGIN
 IF TG_OP<>'DELETE' OR TG_LEVEL<>'ROW' OR TG_RELID NOT IN('lifecycle.raw_source_inventories'::regclass,'lifecycle.raw_object_writes'::regclass)
  OR session_user<>'ensemus_eraser' OR current_user<>'ensemus_migrator' OR NOT knowledge.is_service_actor()
  OR tenant IS NULL OR OLD.organization_id IS DISTINCT FROM tenant THEN
  RAISE EXCEPTION 'RAW_PROOF_RETAINED' USING ERRCODE='42501';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 -- DELETE may already own a row: the common organization barrier is NOWAIT. No inverse wait and
 -- no role-name-only exception. The retained birth seal binds all rows/claims before the first
 -- metadata deletion and stays after them; neither a missing row nor legacy NULL pins is proof.
 IF lifecycle.lock_erasure_tenant() IS DISTINCT FROM true OR lifecycle.raw_erasure_witness() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'RAW_ERASURE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF TG_RELID='lifecycle.raw_source_inventories'::regclass THEN
  IF OLD.scope_kind='source' AND EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND w.source_id=OLD.source_id) THEN
   RAISE EXCEPTION 'RAW_WRITE_INVENTORY_RETAINED' USING ERRCODE='EN850';END IF;
  IF OLD.scope_kind='organization' AND(EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant)
   OR EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories s WHERE s.organization_id=tenant AND s.scope_kind='source')) THEN
   RAISE EXCEPTION 'RAW_SOURCE_INVENTORY_RETAINED' USING ERRCODE='EN850';END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN OLD;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.require_raw_inventory_erasure() FROM PUBLIC;
CREATE TRIGGER raw_inventory_erasure BEFORE DELETE ON lifecycle.raw_source_inventories FOR EACH ROW EXECUTE FUNCTION lifecycle.require_raw_inventory_erasure();
CREATE TRIGGER raw_writes_erasure BEFORE DELETE ON lifecycle.raw_object_writes FOR EACH ROW EXECUTE FUNCTION lifecycle.require_raw_inventory_erasure();
-- A whole-table DELETE has no row-order guarantee. Keep its two exact metadata phases inside one
-- native eraser operation, after the genuine raw witness and writer cleanup. The caller receives
-- only a count, never source identities or a selectable relation/scope/body capability.
CREATE FUNCTION lifecycle.erase_raw_source_inventories() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 source_rows bigint;organization_rows bigint;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_eraser' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN
  RAISE EXCEPTION 'RAW_ERASER_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 IF lifecycle.lock_erasure_tenant() IS DISTINCT FROM true OR lifecycle.raw_erasure_witness() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'RAW_ERASURE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant) THEN
  RAISE EXCEPTION 'RAW_WRITE_INVENTORY_RETAINED' USING ERRCODE='EN850';END IF;
 DELETE FROM lifecycle.raw_source_inventories WHERE organization_id=tenant AND scope_kind='source';
 GET DIAGNOSTICS source_rows=ROW_COUNT;
 DELETE FROM lifecycle.raw_source_inventories WHERE organization_id=tenant AND scope_kind='organization';
 GET DIAGNOSTICS organization_rows=ROW_COUNT;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN source_rows+organization_rows;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.erase_raw_source_inventories() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.erase_raw_source_inventories() TO ensemus_eraser;
-- Retain every old classification and its public OID. Only these explicitly guarded technical
-- inventories become erasable. 0518 must add their exact counts; LAST0999 reviews the actual grant
-- and FORCE-RLS tenant policy. There is intentionally no early reach/installer/DELETE grant here.
DO $$ DECLARE definition text;header text:='CREATE OR REPLACE FUNCTION lifecycle.retained_table(';BEGIN
 definition:=pg_get_functiondef('lifecycle.retained_table(text,text)'::regprocedure);
 IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'RAW_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,header,'CREATE OR REPLACE FUNCTION lifecycle.retained_table_before_raw(');
END $$;
REVOKE ALL ON FUNCTION lifecycle.retained_table_before_raw(text,text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION lifecycle.retained_table(p_schema text,p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_schema='lifecycle' AND p_table IN('raw_source_inventories','raw_object_writes') THEN false
  ELSE lifecycle.retained_table_before_raw(p_schema,p_table) END
$$;

CREATE FUNCTION lifecycle.guard_raw_claim_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'lifecycle.object_deletion_claims'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'INVALID_RAW_CLAIM_TARGET' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.raw_source_id,NEW.raw_source_version,NEW.raw_purge_job_id,NEW.raw_document_id,NEW.material_restore_generation,NEW.auth_restore_generation)
  IS DISTINCT FROM ROW(OLD.raw_source_id,OLD.raw_source_version,OLD.raw_purge_job_id,OLD.raw_document_id,OLD.material_restore_generation,OLD.auth_restore_generation) THEN
  RAISE EXCEPTION 'RAW_CLAIM_IMMUTABLE' USING ERRCODE='42501';END IF;
 IF TG_OP='INSERT' AND NEW.kind='raw_source' AND(current_user<>'ensemus_migrator' OR session_user<>'ensemus_app' OR NOT knowledge.is_service_actor()
  OR NOT lifecycle.raw_metadata_scope(NEW.organization_id) OR NEW.material_restore_generation IS DISTINCT FROM ai.current_material_restore_generation()
  OR NEW.auth_restore_generation IS DISTINCT FROM app.current_auth_restore_generation()) THEN
  RAISE EXCEPTION 'RAW_NATIVE_CLAIM_REQUIRED' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.guard_raw_claim_identity() FROM PUBLIC;
CREATE TRIGGER object_claim_raw_identity BEFORE INSERT OR UPDATE ON lifecycle.object_deletion_claims FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_raw_claim_identity();

CREATE FUNCTION knowledge.guard_raw_purge_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE source_version bigint;previous text:=current_setting('lifecycle.raw_object_org',true);
BEGIN
 IF TG_RELID<>'knowledge.purge_jobs'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN RAISE EXCEPTION 'INVALID_RAW_PURGE_TARGET' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND OLD.state='completed' AND NEW.state='failed' THEN
  NEW.prior_completed_at:=coalesce(OLD.prior_completed_at,OLD.completed_at);NEW.completed_at:=NULL;
 END IF;
 IF NEW.state='completed' THEN
  IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
   RAISE EXCEPTION 'RAW_NATIVE_COMPLETION_REQUIRED' USING ERRCODE='42501';END IF;
  PERFORM set_config('lifecycle.raw_object_org',NEW.organization_id::text,true);
  SELECT s.version INTO source_version FROM knowledge.sources s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.source_id;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR source_version IS NULL
   OR lifecycle.raw_source_material_complete(NEW.source_id,source_version,NEW.id,ai.current_material_restore_generation()) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'RAW_SOURCE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_raw_purge_completion() FROM PUBLIC;
CREATE TRIGGER purge_jobs_raw_completion BEFORE INSERT OR UPDATE ON knowledge.purge_jobs FOR EACH ROW EXECUTE FUNCTION knowledge.guard_raw_purge_completion();

CREATE POLICY raw_job_invalidation ON knowledge.purge_jobs FOR UPDATE TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id)) WITH CHECK(lifecycle.raw_metadata_scope(organization_id) AND state='failed' AND completed_at IS NULL AND last_error_code='RAW_SOURCE_UNCONFIRMED');
CREATE FUNCTION lifecycle.invalidate_raw_source_completion(p_source uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();
BEGIN
 IF current_user<>'ensemus_migrator' OR tenant IS NULL OR NOT lifecycle.raw_metadata_scope(tenant) THEN RAISE EXCEPTION 'RAW_METADATA_SCOPE_REQUIRED' USING ERRCODE='42501';END IF;
 -- Never wait job ->source/org or raw header ->job inversions. Refusal retains debt rather than
 -- allowing a new object/restore transition to race past an invisible completion transaction.
 PERFORM j.id FROM knowledge.purge_jobs j WHERE j.organization_id=tenant AND(p_source IS NULL OR j.source_id=p_source) ORDER BY j.id FOR UPDATE NOWAIT;
 UPDATE knowledge.purge_jobs SET state='failed',completed_at=NULL,last_error_code='RAW_SOURCE_UNCONFIRMED'
  WHERE organization_id=tenant AND(p_source IS NULL OR source_id=p_source) AND state='completed';
END $$;
REVOKE ALL ON FUNCTION lifecycle.invalidate_raw_source_completion(uuid) FROM PUBLIC;

CREATE FUNCTION lifecycle.raw_material_proof_lost() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text:=current_setting('lifecycle.raw_object_org',true);previous_tenant text:=current_setting('app.organization_id',true);tenant uuid;source_key uuid;
BEGIN
 IF TG_RELID='org.organizations'::regclass AND TG_OP='UPDATE' THEN
  IF NEW.material_restore_generation IS NOT DISTINCT FROM OLD.material_restore_generation THEN RETURN NEW;END IF;
  tenant:=NEW.id;PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
  UPDATE lifecycle.raw_source_inventories SET state='restore_debt' WHERE organization_id=tenant AND state<>'restore_debt';
 ELSIF TG_RELID='lifecycle.raw_object_writes'::regclass AND TG_OP='INSERT' THEN
  tenant:=NEW.organization_id;source_key:=NEW.source_id;PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
  UPDATE lifecycle.raw_source_inventories SET state='restore_debt' WHERE organization_id=tenant AND source_id=source_key AND state IN('capturing','sealed');
 ELSIF TG_RELID='lifecycle.raw_source_inventories'::regclass AND TG_OP='UPDATE' THEN
  IF NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state NOT IN('legacy','restore_debt') THEN RETURN NEW;END IF;
  tenant:=NEW.organization_id;source_key:=NEW.source_id;PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 ELSIF TG_RELID='lifecycle.legal_holds'::regclass AND TG_OP IN('INSERT','UPDATE') THEN
  IF NEW.status<>'active' OR(TG_OP='UPDATE' AND OLD.status='active') THEN RETURN NEW;END IF;
  tenant:=NEW.organization_id;PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 ELSE RAISE EXCEPTION 'INVALID_RAW_PROOF_LOSS_TARGET' USING ERRCODE='42501';END IF;
 IF tenant IS DISTINCT FROM app.current_organization_id() THEN
  -- Exact native offline org-row maintenance may be unbound. Bind only its actual tenant for
  -- negative cache invalidation; never fabricate a service/user actor or a positive physical proof.
  IF session_user<>'ensemus_migrator' THEN RAISE EXCEPTION 'RAW_METADATA_SCOPE_REQUIRED' USING ERRCODE='42501';END IF;
  PERFORM set_config('app.organization_id',tenant::text,true);
 END IF;
 PERFORM lifecycle.invalidate_raw_source_completion(source_key);
 PERFORM set_config('app.organization_id',coalesce(previous_tenant,''),true);
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.organization_id',coalesce(previous_tenant,''),true);PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_material_proof_lost() FROM PUBLIC;
CREATE TRIGGER raw_write_proof_lost AFTER INSERT ON lifecycle.raw_object_writes FOR EACH ROW EXECUTE FUNCTION lifecycle.raw_material_proof_lost();
CREATE TRIGGER raw_inventory_proof_lost AFTER UPDATE ON lifecycle.raw_source_inventories FOR EACH ROW EXECUTE FUNCTION lifecycle.raw_material_proof_lost();
CREATE TRIGGER raw_org_restore_proof_lost AFTER UPDATE OF material_restore_generation ON org.organizations FOR EACH ROW EXECUTE FUNCTION lifecycle.raw_material_proof_lost();
CREATE TRIGGER raw_hold_proof_lost AFTER INSERT OR UPDATE ON lifecycle.legal_holds FOR EACH ROW EXECUTE FUNCTION lifecycle.raw_material_proof_lost();

CREATE FUNCTION lifecycle.reconcile_raw_source_completions(p_source uuid DEFAULT NULL) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);j record;s record;changed integer:=0;material uuid;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN RAISE EXCEPTION 'RAW_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM app.current_auth_restore_generation();material:=ai.current_material_restore_generation();
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 FOR j IN SELECT x.id,x.source_id,x.state,x.retry_requests FROM knowledge.purge_jobs x
  LEFT JOIN lifecycle.raw_source_inventories i ON i.organization_id=x.organization_id AND i.source_id=x.source_id
  WHERE x.organization_id=tenant AND(p_source IS NULL OR x.source_id=p_source)
   AND((x.state='completed' AND(i.id IS NULL OR i.protocol_version<>1 OR i.state<>'sealed' OR i.material_restore_generation IS DISTINCT FROM material))
    OR(x.state='failed' AND x.last_error_code='RAW_SOURCE_UNCONFIRMED' AND x.next_retry_at IS NULL AND x.retry_requests<8))
  ORDER BY x.source_id LIMIT 25 LOOP
  SELECT actual.id,actual.version INTO s FROM knowledge.sources actual WHERE actual.organization_id=tenant AND actual.id=j.source_id AND actual.state IN('revoked','deleted') FOR SHARE NOWAIT;
  IF s.id IS NULL THEN CONTINUE;END IF;
  PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND THEN CONTINUE;END IF;
  PERFORM actual.id FROM knowledge.purge_jobs actual WHERE actual.organization_id=tenant AND actual.id=j.id FOR UPDATE NOWAIT;
  UPDATE knowledge.purge_jobs SET state='failed',completed_at=NULL,last_error_code='RAW_SOURCE_UNCONFIRMED',
   next_retry_at=CASE WHEN retry_requests<8 THEN coalesce(next_retry_at,clock_timestamp()) ELSE NULL END
   WHERE organization_id=tenant AND id=j.id AND(state='completed' OR(state='failed' AND last_error_code='RAW_SOURCE_UNCONFIRMED'));
  IF FOUND THEN changed:=changed+1;END IF;
 END LOOP;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN changed;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.reconcile_raw_source_completions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.reconcile_raw_source_completions(uuid) TO ensemus_app;

CREATE FUNCTION lifecycle.require_raw_header_delete_proof() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);doc uuid;source_key uuid;material uuid;auth uuid;i record;allowed boolean:=false;
BEGIN
 IF TG_OP<>'DELETE' OR TG_RELID NOT IN('knowledge.documents'::regclass,'knowledge.object_writers'::regclass,'knowledge.sources'::regclass)
  OR OLD.organization_id IS DISTINCT FROM tenant OR NOT(session_user IN('ensemus_app','ensemus_eraser') AND knowledge.is_service_actor()) THEN
  RAISE EXCEPTION 'RAW_DELETE_AUTHORITY_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 material:=ai.current_material_restore_generation();auth:=app.current_auth_restore_generation();
 IF session_user='ensemus_eraser' THEN
  -- The native birth seal survives source/job/inventory metadata cleanup. Requiring those live
  -- rows again would recreate their FK cycle; their absence alone still grants no authority.
  allowed:=lifecycle.lock_erasure_tenant() IS TRUE AND lifecycle.raw_erasure_witness() IS TRUE;
 ELSIF TG_RELID='knowledge.sources'::regclass THEN
  SELECT * INTO i FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant AND x.source_id=OLD.id;
  allowed:=i.id IS NOT NULL AND lifecycle.raw_source_material_complete(OLD.id,OLD.version,i.purge_job_id,material);
 ELSE
  IF TG_RELID='knowledge.documents'::regclass THEN doc:=OLD.id;source_key:=OLD.source_id;ELSE doc:=OLD.document_id;source_key:=OLD.source_id;END IF;
  SELECT * INTO i FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant AND x.source_id=source_key;
  PERFORM s.id FROM knowledge.sources s WHERE s.organization_id=tenant AND s.id=source_key AND s.state IN('revoked','deleted') AND s.version=i.source_version FOR SHARE NOWAIT;
  IF FOUND THEN
   PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
   IF FOUND AND NOT EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active') THEN
    allowed:=lifecycle.raw_document_material_complete(doc,material,auth);
   END IF;
  END IF;
 END IF;
 IF allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'RAW_OBJECT_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN OLD;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.require_raw_header_delete_proof() FROM PUBLIC;
CREATE TRIGGER documents_raw_delete_proof BEFORE DELETE ON knowledge.documents FOR EACH ROW EXECUTE FUNCTION lifecycle.require_raw_header_delete_proof();
CREATE TRIGGER writers_raw_delete_proof BEFORE DELETE ON knowledge.object_writers FOR EACH ROW EXECUTE FUNCTION lifecycle.require_raw_header_delete_proof();
CREATE TRIGGER sources_raw_delete_proof BEFORE DELETE ON knowledge.sources FOR EACH ROW EXECUTE FUNCTION lifecycle.require_raw_header_delete_proof();
--> statement-breakpoint
