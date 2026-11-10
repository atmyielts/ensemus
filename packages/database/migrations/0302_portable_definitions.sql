-- Source draft. Requires the joined M3/M4/M5 schema and independent real-role migration review.
-- Imported definitions are review material, never executable publications, grants or trusted memory.
CREATE TABLE sovereign.imported_definitions (
  organization_id uuid NOT NULL REFERENCES org.organizations(id),
  import_id uuid NOT NULL,
  section text NOT NULL CHECK (section IN ('agents','policy','knowledge','connections','clients','history')),
  record_kind text NOT NULL CHECK (record_kind IN (
    'service_identity','agent_definition','agent_version','model_profile','rate_card','agent_run',
    'execution_step','agent_assignment','budget','usage_entry','policy_definition','external_resource',
    'external_acl','mcp_definition','client_reader','knowledge_source','source_grant','knowledge_document',
    'embedding_space','fact_definition','fact_evidence','graph_edge','artifact_citation','action_attempt')),
  source_id uuid NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential')),
  work_unit_id uuid,
  required_source_ids uuid[] NOT NULL,
  required_records jsonb NOT NULL CHECK (jsonb_typeof(required_records)='array'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=1048576),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,import_id,record_kind,source_id),
  FOREIGN KEY (organization_id,import_id) REFERENCES sovereign.organization_imports(organization_id,id),
  FOREIGN KEY (organization_id,work_unit_id) REFERENCES work.work_units(organization_id,id)
);
--> statement-breakpoint
ALTER TABLE sovereign.imported_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sovereign.imported_definitions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY portable_definitions_read ON sovereign.imported_definitions FOR SELECT TO ensemus_app
  USING (organization_id=app.current_organization_id() AND EXISTS (
    SELECT 1 FROM org.memberships m WHERE m.organization_id=app.current_organization_id()
      AND m.id=app.current_membership_id() AND m.status='active' AND m.role IN ('owner','admin'))
    AND (work_unit_id IS NULL OR knowledge.can_read_work(work_unit_id,app.current_membership_id()))
    AND NOT EXISTS(SELECT 1 FROM unnest(required_source_ids) wanted(id)
      LEFT JOIN knowledge.sources s ON s.organization_id=app.current_organization_id() AND s.id=wanted.id
      WHERE s.id IS NULL OR s.state<>'active' OR s.id NOT IN(SELECT knowledge.readable_source_ids(app.current_membership_id()))
        OR knowledge.class_rank(s.classification)>knowledge.class_rank(imported_definitions.classification)
        OR EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=app.current_organization_id()
          AND t.target_type='knowledge_source' AND t.target_id=s.id))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(required_records) r
      WHERE NOT knowledge.structured_record_readable(r->>'kind',(r->>'id')::uuid,app.current_membership_id())
        OR knowledge.structured_record_class(r->>'kind',(r->>'id')::uuid) IS NULL
        OR knowledge.class_rank(knowledge.structured_record_class(r->>'kind',(r->>'id')::uuid))>knowledge.class_rank(imported_definitions.classification)));
--> statement-breakpoint
CREATE POLICY portable_definitions_insert ON sovereign.imported_definitions FOR INSERT TO ensemus_app
  WITH CHECK (organization_id=app.current_organization_id() AND knowledge.is_service_actor()
    AND EXISTS (SELECT 1 FROM sovereign.organization_imports i JOIN org.memberships m
      ON m.organization_id=i.organization_id AND m.id=i.fallback_membership_id
      WHERE i.organization_id=app.current_organization_id() AND i.id=import_id AND i.status='running'
        AND m.status='active' AND m.role='owner'));
--> statement-breakpoint
GRANT SELECT,INSERT ON sovereign.imported_definitions TO ensemus_app;
--> statement-breakpoint
CREATE TRIGGER portable_definitions_immutable BEFORE UPDATE OR TRUNCATE
  ON sovereign.imported_definitions FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
-- Strict field validation lives in the typed import adapter. Direct inserts still cannot attach a
-- record to another tenant or change its declared kind/identity, nor carry tenant/credential fields.
CREATE FUNCTION sovereign.guard_portable_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[]; source_id uuid; source_state text; r jsonb;
BEGIN
  IF NOT knowledge.is_service_actor() OR NEW.record->>'kind' IS DISTINCT FROM NEW.record_kind
    OR NEW.record->>'id' IS DISTINCT FROM NEW.source_id::text
    OR NEW.record ?| ARRAY['organization_id','organizationId','secret_ref','credential_secret_id',
      'credential','refresh_token','access_token','signing_secret','config','content']
  THEN RAISE EXCEPTION 'PORTABLE_DEFINITION_REFUSED' USING ERRCODE='42501'; END IF;
  allowed:=string_to_array(CASE NEW.record_kind
    WHEN 'service_identity' THEN 'kind,id,created_at,owner_membership_id,purpose'
    WHEN 'agent_definition' THEN 'kind,id,created_at,slug,name,owner_membership_id,service_identity_id'
    WHEN 'agent_version' THEN 'kind,id,definition_id,version_number,spec,spec_sha256,published_at'
    WHEN 'model_profile' THEN 'kind,id,created_at,alias,model_id,provider_kind,billing_owner,capabilities,allowed_classes,allowed_purposes,limits'
    WHEN 'rate_card' THEN 'kind,id,created_at,profile_id,version,input_micros_per_mtok,output_micros_per_mtok,effective_from'
    WHEN 'agent_run' THEN 'kind,id,created_at,work_unit_id,agent_version_id,status,effective_classification,model_turns,tool_calls,input_tokens,output_tokens,cost_micros'
    WHEN 'execution_step' THEN 'kind,id,run_id,work_unit_id,step_number,step_kind,state,label_code,started_at'
    WHEN 'agent_assignment' THEN 'kind,id,work_unit_id,service_identity_id,agent_run_id,created_at'
    WHEN 'budget' THEN 'kind,id,created_at,scope,agent_version_id,period,limit_micros'
    WHEN 'usage_entry' THEN 'kind,id,created_at,work_unit_id,run_id,meter,quantity,cost_micros,billing_period,commercial_mode'
    WHEN 'policy_definition' THEN 'kind,id,created_at,version,sha256,document_text'
    WHEN 'external_resource' THEN 'kind,id,connection_id,stream,resource_type,external_id,external_version,display_name,classification,first_seen_at'
    WHEN 'external_acl' THEN 'kind,id,resource_id,principal_kind,principal_external_id,access,membership_id,team_id,updated_at'
    WHEN 'mcp_definition' THEN 'kind,id,connection_id,tool_name,definition_sha256,first_seen_at'
    WHEN 'client_reader' THEN 'kind,id,client_id,membership_id,created_at'
    WHEN 'action_attempt' THEN 'kind,id,external_action_id,work_unit_id,attempt_no,request_hash,outcome,recorded_at,finished_at'
    WHEN 'knowledge_source' THEN 'kind,id,created_at,source_kind,connection_id,external_resource_id,classification,owner_membership_id'
    WHEN 'source_grant' THEN 'kind,id,created_at,source_id,principal_kind,membership_id,team_id'
    WHEN 'knowledge_document' THEN 'kind,id,created_at,source_id,version_no,title,content_sha256,size_bytes,media_type,classification,source_version,superseded_at'
    WHEN 'embedding_space' THEN 'kind,id,created_at,model_id,dimension,vector_space_version'
    WHEN 'fact_definition' THEN 'kind,id,created_at,subject_ref,predicate,claim_text,classification,source_ids'
    WHEN 'fact_evidence' THEN 'kind,id,fact_id,source_id,chunk_id,content_sha256,quote_start,quote_end,created_at'
    WHEN 'graph_edge' THEN 'kind,id,created_at,from_ref,to_ref,relation,fact_id'
    WHEN 'artifact_citation' THEN 'kind,id,artifact_id,source_id,document_id,chunk_id,content_sha256,artifact_start,artifact_end,created_at,work_unit_ids'
    ELSE '' END,',');
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.record) k WHERE NOT k=ANY(allowed))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.required_records) x
      WHERE jsonb_typeof(x)<>'object' OR x->>'kind' IS NULL OR x->>'kind' NOT IN('work_unit','project','client')
        OR x->>'id' IS NULL OR x->>'id' !~ '^[0-9a-f-]{36}$'
        OR (SELECT count(*) FROM jsonb_object_keys(x))<>2)
    OR (NEW.record ? 'work_unit_id' AND (NEW.work_unit_id::text IS DISTINCT FROM NEW.record->>'work_unit_id'
      OR NOT NEW.required_records @> jsonb_build_array(jsonb_build_object('kind','work_unit','id',NEW.work_unit_id))))
    OR (NEW.record ? 'source_id' AND NOT (NEW.record->>'source_id')::uuid=ANY(NEW.required_source_ids))
    OR (NEW.record_kind='knowledge_source' AND NOT NEW.source_id=ANY(NEW.required_source_ids))
  THEN RAISE EXCEPTION 'PORTABLE_DEFINITION_REFUSED' USING ERRCODE='42501'; END IF;
  FOREACH source_id IN ARRAY NEW.required_source_ids LOOP
    SELECT state INTO source_state FROM knowledge.sources WHERE organization_id=NEW.organization_id AND id=source_id FOR SHARE;
    IF FOUND AND source_state<>'active' THEN
      RAISE EXCEPTION 'PORTABLE_SOURCE_CLOSED' USING ERRCODE='42501'; END IF;
    IF EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=NEW.organization_id
      AND t.target_type='knowledge_source' AND t.target_id=source_id) THEN
      RAISE EXCEPTION 'PORTABLE_SOURCE_CLOSED' USING ERRCODE='42501'; END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(NEW.required_records) LOOP
    PERFORM knowledge.lock_structured_record(r->>'kind',(r->>'id')::uuid);
    IF FOUND AND EXISTS(SELECT 1 FROM knowledge.structured_record_catalog WHERE organization_id=NEW.organization_id
      AND record_kind=r->>'kind' AND record_id=(r->>'id')::uuid AND NOT alive) THEN
      RAISE EXCEPTION 'PORTABLE_RECORD_CLOSED' USING ERRCODE='42501'; END IF;
    IF EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=NEW.organization_id
      AND t.target_type=r->>'kind' AND t.target_id=(r->>'id')::uuid) THEN
      RAISE EXCEPTION 'PORTABLE_RECORD_CLOSED' USING ERRCODE='42501'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sovereign.guard_portable_definition() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER portable_definition_guard BEFORE INSERT ON sovereign.imported_definitions
  FOR EACH ROW EXECUTE FUNCTION sovereign.guard_portable_definition();
--> statement-breakpoint
-- Narrow retained-copy maintenance, under the same fixed metadata-only role pattern as0208.
-- No DELETE grant or serving bypass is given to the application or agent role.
CREATE POLICY portable_definition_maintenance_read ON sovereign.imported_definitions FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor());
CREATE POLICY portable_definition_maintenance_delete ON sovereign.imported_definitions FOR DELETE TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor());
CREATE POLICY portable_source_maintenance_read ON knowledge.sources FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor());
CREATE POLICY portable_source_maintenance_lock ON knowledge.sources FOR UPDATE TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor()) WITH CHECK(false);
CREATE POLICY portable_record_maintenance_read ON knowledge.structured_record_catalog FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor());
CREATE POLICY portable_record_maintenance_lock ON knowledge.structured_record_catalog FOR UPDATE TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor()) WITH CHECK(false);
--> statement-breakpoint
CREATE FUNCTION sovereign.imported_definitions_remaining(p_kind text,p_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
  IF NOT knowledge.is_service_actor() OR p_kind NOT IN('knowledge_source','work_unit','project','client') THEN
    RAISE EXCEPTION 'PORTABLE_ERASURE_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  SELECT count(*)::int INTO n FROM sovereign.imported_definitions d
    WHERE d.organization_id=app.current_organization_id() AND
      ((p_kind='knowledge_source' AND p_id=ANY(d.required_source_ids)) OR
       d.required_records @> jsonb_build_array(jsonb_build_object('kind',p_kind,'id',p_id)));
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION sovereign.imported_definitions_remaining(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.imported_definitions_remaining(text,uuid) TO ensemus_app;
--> statement-breakpoint
-- Resume recognizes only exact immutable reservation content; this returns no source text.
CREATE FUNCTION sovereign.imported_definition_matches(p_import uuid,p_kind text,p_id uuid,p_record jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT knowledge.is_service_actor() THEN RAISE EXCEPTION 'PORTABLE_RESUME_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  RETURN EXISTS(SELECT 1 FROM sovereign.imported_definitions d WHERE d.organization_id=app.current_organization_id()
    AND d.import_id=p_import AND d.record_kind=p_kind AND d.source_id=p_id AND d.record=p_record);
END $$;
REVOKE ALL ON FUNCTION sovereign.imported_definition_matches(uuid,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.imported_definition_matches(uuid,text,uuid,jsonb) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.reserved_import_document_ids(p_import uuid) RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT knowledge.is_service_actor() THEN RAISE EXCEPTION 'PORTABLE_RESUME_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT d.source_id FROM sovereign.imported_definitions d WHERE d.organization_id=app.current_organization_id()
    AND d.import_id=p_import AND d.record_kind='knowledge_document';
END $$;
REVOKE ALL ON FUNCTION sovereign.reserved_import_document_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.reserved_import_document_ids(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.erase_imported_definitions(p_kind text,p_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
  IF NOT knowledge.is_service_actor() OR p_kind NOT IN('knowledge_source','work_unit','project','client') THEN
    RAISE EXCEPTION 'PORTABLE_ERASURE_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  IF p_kind='knowledge_source' THEN
    PERFORM id FROM knowledge.sources WHERE organization_id=app.current_organization_id() AND id=p_id AND state<>'active' FOR SHARE;
    IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=app.current_organization_id()
      AND t.target_type='knowledge_source' AND t.target_id=p_id) THEN
      RAISE EXCEPTION 'PORTABLE_ERASURE_UNCONFIRMED' USING ERRCODE='42501'; END IF;
  ELSE
    PERFORM record_id FROM knowledge.structured_record_catalog WHERE organization_id=app.current_organization_id()
      AND record_kind=p_kind AND record_id=p_id AND NOT alive FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PORTABLE_ERASURE_UNCONFIRMED' USING ERRCODE='42501'; END IF;
  END IF;
  DELETE FROM sovereign.imported_definitions d WHERE d.organization_id=app.current_organization_id() AND
    ((p_kind='knowledge_source' AND p_id=ANY(d.required_source_ids)) OR
      d.required_records @> jsonb_build_array(jsonb_build_object('kind',p_kind,'id',p_id)));
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION sovereign.erase_imported_definitions(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.erase_imported_definitions(text,uuid) TO ensemus_app;
