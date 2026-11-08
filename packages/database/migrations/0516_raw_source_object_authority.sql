-- UNREGISTERED SOURCE, INCOMPLETE UNTIL THE SOURCE REPORT SAYS OTHERWISE. Never apply in isolation.
-- Actual0422 ready admission + protected material generation +0508/0515 are prerequisites.
-- Provider outcomes are supplied only by the trusted native storage executor. App-role SQL does
-- not independently attest the provider; a private metadata selector is not a physical proof.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR to_regprocedure('app.current_auth_restore_generation()') IS NULL OR to_regprocedure('ai.current_material_restore_generation()') IS NULL
  OR to_regprocedure('lifecycle.source_projection_hold_free(uuid,bigint,uuid)') IS NULL THEN
  RAISE EXCEPTION 'RAW_SOURCE_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE lifecycle.raw_source_inventories(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 scope_kind text NOT NULL,source_id uuid,protocol_version integer NOT NULL,
 material_restore_generation uuid NOT NULL,state text NOT NULL,purge_job_id uuid,source_version bigint,
 capture_cursor uuid,capture_count bigint NOT NULL DEFAULT 0,capture_sha256 text,sealed_at timestamptz,
 born_at timestamptz NOT NULL DEFAULT clock_timestamp(),CONSTRAINT raw_source_inventories_pk PRIMARY KEY(organization_id,id),
 CONSTRAINT raw_source_inventory_scope CHECK((scope_kind='organization' AND source_id IS NULL AND purge_job_id IS NULL AND source_version IS NULL) OR(scope_kind='source' AND source_id IS NOT NULL)),
 CONSTRAINT raw_source_inventory_protocol CHECK(protocol_version IN(0,1) AND capture_count>=0),
 CONSTRAINT raw_source_inventory_state CHECK(state IN('open','capturing','sealed','legacy','restore_debt')),
 CONSTRAINT raw_source_inventory_hash CHECK(capture_sha256 IS NULL OR capture_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX raw_source_inventory_one_org ON lifecycle.raw_source_inventories(organization_id) WHERE scope_kind='organization';
CREATE UNIQUE INDEX raw_source_inventory_one_source ON lifecycle.raw_source_inventories(organization_id,source_id) WHERE scope_kind='source';
CREATE TABLE lifecycle.raw_object_writes(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),id uuid NOT NULL DEFAULT gen_random_uuid(),source_id uuid NOT NULL,
 document_id uuid NOT NULL,write_id uuid NOT NULL,generation bigint NOT NULL,object_key text NOT NULL,
 content_sha256 text NOT NULL,size_bytes bigint NOT NULL,material_restore_generation uuid NOT NULL,state text NOT NULL,
 started_by_membership_id uuid,started_by_user_id uuid,put_token_sha256 text,put_auth_restore_generation uuid,
 admitted_at timestamptz,finished_at timestamptz,born_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT raw_object_writes_pk PRIMARY KEY(organization_id,id),
 CONSTRAINT raw_object_write_key CHECK(object_key=organization_id::text||'/knowledge/'||document_id::text),
 CONSTRAINT raw_object_write_hash CHECK(content_sha256 ~ '^[0-9a-f]{64}$' AND size_bytes>=0),
 CONSTRAINT raw_object_write_state CHECK((generation=0 AND state='catalog') OR(generation>0 AND state IN('intent','put_admitted','finished','unknown','legacy'))),
 CONSTRAINT raw_object_write_receipt CHECK((state NOT IN('put_admitted','finished','unknown') OR(put_token_sha256 IS NOT NULL AND put_auth_restore_generation IS NOT NULL AND admitted_at IS NOT NULL)) AND(state<>'finished' OR finished_at IS NOT NULL))
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
CREATE POLICY raw_document_metadata ON knowledge.documents FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
CREATE POLICY raw_writer_metadata ON knowledge.object_writers FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
CREATE POLICY raw_job_metadata ON knowledge.purge_jobs FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
CREATE POLICY raw_job_lock ON knowledge.purge_jobs FOR UPDATE TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id)) WITH CHECK(false);
CREATE POLICY raw_tombstone_metadata ON platform.tombstones FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id) AND target_type='knowledge_source');
CREATE POLICY raw_hold_metadata ON lifecycle.legal_holds FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
CREATE POLICY raw_claim_metadata ON lifecycle.object_deletion_claims FOR SELECT TO ensemus_migrator USING(lifecycle.raw_metadata_scope(organization_id));
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
  native:=native AND org_scope.protocol_version=1 AND org_scope.state='open' AND org_scope.material_restore_generation=material;
  IF TG_RELID='knowledge.sources'::regclass THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INVALID_RAW_BIRTH' USING ERRCODE='42501';END IF;
   INSERT INTO lifecycle.raw_source_inventories(organization_id,scope_kind,source_id,protocol_version,material_restore_generation,state)
    VALUES(tenant,'source',NEW.id,CASE WHEN native THEN 1 ELSE 0 END,material,CASE WHEN native THEN 'open' ELSE 'legacy' END)
    ON CONFLICT(organization_id,source_id) WHERE scope_kind='source' DO UPDATE SET state='restore_debt';
  ELSIF TG_RELID='knowledge.documents'::regclass THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INVALID_RAW_BIRTH' USING ERRCODE='42501';END IF;
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
    SELECT * INTO doc FROM knowledge.documents d WHERE d.organization_id=tenant AND d.id=NEW.document_id AND d.source_id=NEW.source_id;
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
   SELECT * INTO source_row FROM knowledge.sources s WHERE s.organization_id=tenant AND s.id=NEW.source_id;
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
 RETURNS TABLE(state text,object_key text,content_sha256 text,size_bytes bigint,material_generation uuid,auth_generation uuid,token text)
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
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.scope_kind='organization'
  AND i.protocol_version=1 AND i.state='open' AND i.material_restore_generation=material)
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
 RETURN QUERY SELECT 'send'::text,w.object_key,w.content_sha256,w.size_bytes,material,auth,opaque;
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
  AND w.generation>0 AND w.state='finished' AND w.finished_at IS NOT NULL AND w.put_token_sha256 IS NOT NULL
  AND w.material_restore_generation=material AND w.put_auth_restore_generation=auth
  AND(app.current_actor_type()='service' OR(w.started_by_membership_id=app.current_membership_id() AND w.started_by_user_id=app.current_user_id()))) INTO answer;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_write_quiescent(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.raw_write_quiescent(uuid,uuid,bigint) TO ensemus_app;

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
  OR NOT EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant AND x.scope_kind='organization' AND x.protocol_version=1 AND x.state='open' AND x.material_restore_generation=material) THEN
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
