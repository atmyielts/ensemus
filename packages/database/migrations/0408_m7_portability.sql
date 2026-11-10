-- Source only: requires 0300-0303, 0404, 0407, 0409-0410 and 0412. Journal ordering is explicit,
-- not numeric filename order. Joined /3 is a new unpublished contract;
-- neither legacy /1 nor /2 acquires new record shapes, body permissions or a larger byte limit.
DO $$ BEGIN
  IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
    OR pg_catalog.pg_has_role(current_user,'ensemus_auth','member') THEN
    RAISE EXCEPTION 'PORTABILITY_GUARD_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE sovereign.organization_exports ADD COLUMN inventory_version text
  CHECK(inventory_version IS NULL OR inventory_version='ensemus.m3-m7/3');
CREATE FUNCTION sovereign.guard_export_inventory_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.inventory_version IS NOT NULL THEN
      RAISE EXCEPTION 'EXPORT_INVENTORY_NOT_PINNED' USING ERRCODE='EN301';
    END IF;
  ELSIF OLD.status='requested' AND NEW.status='running' AND OLD.inventory_version IS NULL THEN
    IF NEW.inventory_version IS NOT NULL THEN
      RAISE EXCEPTION 'EXPORT_INVENTORY_NOT_PINNED' USING ERRCODE='EN301';
    END IF;
    NEW.inventory_version:='ensemus.m3-m7/3';
  ELSIF NEW.inventory_version IS DISTINCT FROM OLD.inventory_version THEN
    RAISE EXCEPTION 'EXPORT_INVENTORY_IMMUTABLE' USING ERRCODE='EN301';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sovereign.guard_export_inventory_pin() FROM PUBLIC;
CREATE TRIGGER export_inventory_pin BEFORE INSERT OR UPDATE ON sovereign.organization_exports
  FOR EACH ROW EXECUTE FUNCTION sovereign.guard_export_inventory_pin();
CREATE FUNCTION sovereign.guard_new_export_admission() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE person org.memberships%ROWTYPE;
BEGIN
  IF TG_RELID<>'sovereign.organization_exports'::regclass OR TG_OP<>'INSERT'
    OR session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'user'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id()
    OR NEW.status<>'requested' OR NEW.export_epoch IS NOT NULL OR NEW.inventory_version IS NOT NULL THEN
    RAISE EXCEPTION 'EXPORT_ADMISSION_REQUIRED' USING ERRCODE='EN301';
  END IF;
  SELECT m.* INTO person FROM org.memberships m WHERE m.organization_id=NEW.organization_id
    AND m.id=NEW.requested_by_membership_id AND m.user_id=app.current_user_id()
    AND m.status='active' AND m.role='owner' FOR SHARE;
  IF person.id IS NULL OR NOT identity.lock_studio_session(person.user_id,app.current_interactive_session_id()) THEN
    RAISE EXCEPTION 'EXPORT_ADMISSION_REQUIRED' USING ERRCODE='EN301';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sovereign.guard_new_export_admission() FROM PUBLIC;
CREATE TRIGGER exports_01_admission BEFORE INSERT ON sovereign.organization_exports
  FOR EACH ROW EXECUTE FUNCTION sovereign.guard_new_export_admission();
--> statement-breakpoint
-- The fixed owner reads only intent metadata and its actual named owner's membership. The scope
-- is a transaction-local selector, never an unforgeable credential or a substitute for admission.
CREATE POLICY portable_export_guard_read ON sovereign.organization_exports FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor()
    AND id=nullif(current_setting('app.portability_export_id',true),'')::uuid);
CREATE POLICY portable_export_epoch_guard_read ON sovereign.export_epochs FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor());
CREATE POLICY portable_export_viewer_read ON org.memberships FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor()
    AND id=nullif(current_setting('sovereign.export_guard_viewer',true),'')::uuid);
CREATE POLICY portable_export_viewer_lock ON org.memberships FOR UPDATE TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND knowledge.is_service_actor()
    AND id=nullif(current_setting('sovereign.export_guard_viewer',true),'')::uuid) WITH CHECK(false);
--> statement-breakpoint
CREATE FUNCTION sovereign.portable_export_viewer() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE export_id uuid;viewer uuid;previous_viewer text;pinned bigint;current_epoch bigint;active_owner uuid;
BEGIN
  IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() THEN RETURN NULL; END IF;
  BEGIN export_id:=nullif(current_setting('app.portability_export_id',true),'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END;
  IF export_id IS NULL THEN RETURN NULL; END IF;
  SELECT e.requested_by_membership_id,e.export_epoch,r.epoch INTO viewer,pinned,current_epoch
    FROM sovereign.organization_exports e JOIN sovereign.export_epochs r ON r.organization_id=e.organization_id
    WHERE e.organization_id=app.current_organization_id() AND e.id=export_id AND e.status='running'
      AND e.inventory_version='ensemus.m3-m7/3' AND e.scope='standard' AND e.snapshot_at IS NOT NULL;
  IF viewer IS NULL OR pinned IS NULL OR pinned IS DISTINCT FROM current_epoch THEN RETURN NULL; END IF;
  previous_viewer:=current_setting('sovereign.export_guard_viewer',true);
  PERFORM set_config('sovereign.export_guard_viewer',viewer::text,true);
  BEGIN
    SELECT m.id INTO active_owner FROM org.memberships m WHERE m.organization_id=app.current_organization_id()
      AND m.id=viewer AND m.role='owner' AND m.status='active' FOR SHARE;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('sovereign.export_guard_viewer',coalesce(previous_viewer,''),true);RAISE;
  END;
  PERFORM set_config('sovereign.export_guard_viewer',coalesce(previous_viewer,''),true);
  RETURN active_owner;
END $$;
REVOKE ALL ON FUNCTION sovereign.portable_export_viewer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.portable_export_viewer() TO ensemus_app;
--> statement-breakpoint
-- Named viewer predicates run before LIMIT. Absent intent/profile/owner refuses body access rather
-- than presenting a service-filtered zero-row page as a complete archive.
ALTER POLICY object_record_read ON objects.records USING(
  (objects.active_person() AND objects.record_row_readable(id,type_id,classification,owner_membership_id,deleted_at,app.current_membership_id()))
  OR objects.pending_migration(type_id)
  OR (sovereign.portable_export_viewer() IS NOT NULL
    AND objects.record_readable(id,sovereign.portable_export_viewer())
    AND objects.record_class(id) IN('public','internal','confidential')));
ALTER POLICY object_relations_read ON objects.relations USING(
  (objects.active_person() AND objects.record_readable(from_record_id,app.current_membership_id())
    AND objects.record_readable(to_record_id,app.current_membership_id()))
  OR (sovereign.portable_export_viewer() IS NOT NULL
    AND objects.record_readable(from_record_id,sovereign.portable_export_viewer())
    AND objects.record_readable(to_record_id,sovereign.portable_export_viewer())
    AND objects.record_class(from_record_id) IN('public','internal','confidential')
    AND objects.record_class(to_record_id) IN('public','internal','confidential')));
-- 0412's author predicates also guard writes. Split each ALL policy so the export branch exists
-- only on SELECT; adding it to an ALL USING expression would accidentally authorize DELETE.
DROP POLICY agent_drafts_person ON studio.agent_drafts;
CREATE POLICY agent_drafts_person ON studio.agent_drafts AS RESTRICTIVE FOR SELECT TO ensemus_app
  USING(studio.current_author() OR (studio.agent_draft_class(answers)<>'restricted' AND sovereign.portable_export_viewer() IS NOT NULL));
CREATE POLICY agent_drafts_person_insert ON studio.agent_drafts AS RESTRICTIVE FOR INSERT TO ensemus_app WITH CHECK(studio.current_author());
CREATE POLICY agent_drafts_person_update ON studio.agent_drafts AS RESTRICTIVE FOR UPDATE TO ensemus_app USING(studio.current_author()) WITH CHECK(studio.current_author());
CREATE POLICY agent_drafts_person_delete ON studio.agent_drafts AS RESTRICTIVE FOR DELETE TO ensemus_app USING(studio.current_author());
DROP POLICY process_drafts_person ON studio.process_drafts;
CREATE POLICY process_drafts_person ON studio.process_drafts AS RESTRICTIVE FOR SELECT TO ensemus_app
  USING((studio.current_author() AND(classification<>'restricted' OR owner_membership_id=app.current_membership_id()))
    OR (classification<>'restricted' AND sovereign.portable_export_viewer() IS NOT NULL));
CREATE POLICY process_drafts_person_insert ON studio.process_drafts AS RESTRICTIVE FOR INSERT TO ensemus_app
  WITH CHECK(studio.current_author() AND(classification<>'restricted' OR owner_membership_id=app.current_membership_id()));
CREATE POLICY process_drafts_person_update ON studio.process_drafts AS RESTRICTIVE FOR UPDATE TO ensemus_app
  USING(studio.current_author() AND(classification<>'restricted' OR owner_membership_id=app.current_membership_id()))
  WITH CHECK(studio.current_author() AND(classification<>'restricted' OR owner_membership_id=app.current_membership_id()));
CREATE POLICY process_drafts_person_delete ON studio.process_drafts AS RESTRICTIVE FOR DELETE TO ensemus_app
  USING(studio.current_author() AND(classification<>'restricted' OR owner_membership_id=app.current_membership_id()));
--> statement-breakpoint
-- New body/data mutations also invalidate the whole archive. Epoch locks remain last and readers
-- never lock them while waiting for body/ACL rows or object storage.
CREATE TRIGGER export_epoch_object_types AFTER INSERT OR UPDATE OR DELETE ON objects.types FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('slug','display_name','classification','current_version_number','state','version');
CREATE TRIGGER export_epoch_object_versions AFTER INSERT OR UPDATE OR DELETE ON objects.type_versions FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('type_id','version_number','fields','relations','schema_sha256');
CREATE TRIGGER export_epoch_object_records AFTER INSERT OR UPDATE OR DELETE ON objects.records FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('type_id','type_version_number','display_name','attributes','classification','owner_membership_id','deleted_at','version');
CREATE TRIGGER export_epoch_object_relations AFTER INSERT OR UPDATE OR DELETE ON objects.relations FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('relation_key','from_record_id','to_record_id');
CREATE TRIGGER export_epoch_agent_drafts AFTER INSERT OR UPDATE OR DELETE ON studio.agent_drafts FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('name','owner_membership_id','answers','spec_sha256','status','version');
CREATE TRIGGER export_epoch_process_drafts AFTER INSERT OR UPDATE OR DELETE ON studio.process_drafts FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('name','owner_membership_id','classification','graph','spec_sha256','status','version');
CREATE TRIGGER export_epoch_process_specs AFTER INSERT OR UPDATE OR DELETE ON studio.process_specs FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('spec','spec_sha256','classification','source','source_ref');
CREATE TRIGGER export_epoch_pack_installations AFTER INSERT OR UPDATE OR DELETE ON packs.installations FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('pack_key','pack_version','manifest_sha256');
CREATE TRIGGER export_epoch_pack_items AFTER INSERT OR UPDATE OR DELETE ON packs.installed_items FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('installation_id','item_kind','item_key','item_id');
CREATE TRIGGER export_epoch_security_settings AFTER INSERT OR UPDATE OR DELETE ON org.security_policies FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('mfa_for_administration','mfa_max_age_seconds','sso_enforcement');

--> statement-breakpoint
ALTER TABLE sovereign.imported_definitions DROP CONSTRAINT imported_definitions_section_check;
ALTER TABLE sovereign.imported_definitions ADD CONSTRAINT imported_definitions_section_check CHECK(section IN('agents','policy','knowledge','connections','clients','history','custom-objects'));
ALTER TABLE sovereign.imported_definitions DROP CONSTRAINT imported_definitions_record_kind_check;
ALTER TABLE sovereign.imported_definitions ADD CONSTRAINT imported_definitions_record_kind_check CHECK(record_kind IN(
    'service_identity','agent_definition','agent_version','model_profile','rate_card','agent_run',
    'execution_step','agent_assignment','budget','usage_entry','policy_definition','external_resource',
    'external_acl','mcp_definition','client_reader','knowledge_source','source_grant','knowledge_document',
    'embedding_space','fact_definition','fact_evidence','graph_edge','artifact_citation','action_attempt','studio_agent_draft','studio_process_draft','process_spec','pack_installation','pack_item','security_settings','custom_object_type','custom_object_version','custom_object_record','custom_object_relation'));
ALTER TABLE sovereign.imported_definitions DROP CONSTRAINT imported_definitions_record_check;
ALTER TABLE sovereign.imported_definitions ADD CONSTRAINT imported_definitions_record_check CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=CASE WHEN record_kind IN('studio_agent_draft','studio_process_draft','process_spec','pack_installation','pack_item','security_settings','custom_object_type','custom_object_version','custom_object_record','custom_object_relation') THEN 4194304 ELSE 1048576 END);
--> statement-breakpoint
CREATE FUNCTION sovereign.import_review_allowed(p_import uuid,p_viewer uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'user' OR p_viewer IS DISTINCT FROM app.current_membership_id() THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM sovereign.organization_imports i
    JOIN sovereign.organization_import_manifests proof ON proof.organization_id=i.organization_id AND proof.import_id=i.id AND proof.path='manifest.json.sealed' AND proof.verified_at IS NOT NULL
    JOIN org.memberships requester ON requester.organization_id=i.organization_id AND requester.id=i.requested_by_membership_id AND requester.status='active' AND requester.role='owner'
    JOIN org.memberships custodian ON custodian.organization_id=i.organization_id AND custodian.id=i.fallback_membership_id AND custodian.status='active' AND custodian.role='owner'
    JOIN org.memberships viewer ON viewer.organization_id=i.organization_id AND viewer.id=p_viewer AND viewer.status='active' AND viewer.role IN('owner','admin') AND viewer.user_id=app.current_user_id()
    WHERE i.organization_id=app.current_organization_id() AND i.id=p_import
      AND i.status IN('running','completed','completed_with_warnings','failed')
      AND i.intent_authorized_at IS NOT NULL AND i.intent_authorized_membership_id=i.requested_by_membership_id
      AND i.archive_sha256=proof.archive_sha256);
END $$;
REVOKE ALL ON FUNCTION sovereign.import_review_allowed(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.import_review_allowed(uuid,uuid) TO ensemus_app;
CREATE FUNCTION sovereign.quarantine_record_readable(p_import uuid,p_kind text,p_id uuid,p_viewer uuid,p_class text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
  IF p_kind NOT IN('work_unit','project','client','object_record') THEN RETURN false; END IF;
  IF p_kind='object_record' AND NOT EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c
      WHERE c.organization_id=app.current_organization_id() AND c.record_kind=p_kind AND c.record_id=p_id) THEN
    -- This ID names inert archive material, not a restored live object. A retained closed catalog
    -- never falls through here, and a tombstone blocks even a never-materialized copy.
    RETURN p_class IN('public','internal','confidential') AND sovereign.import_review_allowed(p_import,p_viewer)
      AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=app.current_organization_id()
        AND t.target_type='object_record' AND t.target_id=p_id);
  END IF;
  RETURN knowledge.structured_record_readable(p_kind,p_id,p_viewer)
    AND knowledge.structured_record_class(p_kind,p_id) IS NOT NULL
    AND knowledge.class_rank(knowledge.structured_record_class(p_kind,p_id))<=knowledge.class_rank(p_class);
END $$;
REVOKE ALL ON FUNCTION sovereign.quarantine_record_readable(uuid,text,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.quarantine_record_readable(uuid,text,uuid,uuid,text) TO ensemus_app;
ALTER POLICY portable_definitions_read ON sovereign.imported_definitions
  USING (organization_id=app.current_organization_id() AND app.current_actor_type()='user' AND EXISTS (
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
      WHERE NOT sovereign.quarantine_record_readable(import_id,r->>'kind',(r->>'id')::uuid,app.current_membership_id(),classification)));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sovereign.guard_portable_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[]; source_id uuid; source_state text; r jsonb;
BEGIN
  IF NOT knowledge.is_service_actor() OR NOT sovereign.verified_import_record(NEW.import_id,NEW.record)
    OR NEW.record->>'kind' IS DISTINCT FROM NEW.record_kind
    OR NEW.record->>'id' IS DISTINCT FROM NEW.source_id::text
    OR NEW.record ?| ARRAY['organization_id','organizationId','secret_ref','credential_secret_id',
      'credential','refresh_token','access_token','signing_secret','config','content']
  THEN RAISE EXCEPTION 'PORTABLE_DEFINITION_REFUSED' USING ERRCODE='42501'; END IF;
  allowed:=string_to_array(CASE NEW.record_kind
    WHEN 'studio_agent_draft' THEN 'kind,id,created_at,name,owner_membership_id,classification,answers,spec_sha256,version,updated_at'
    WHEN 'studio_process_draft' THEN 'kind,id,created_at,name,owner_membership_id,classification,graph,spec_sha256,version,updated_at'
    WHEN 'process_spec' THEN 'kind,id,created_at,process_key,version_number,name,classification,spec,spec_sha256,source,source_ref'
    WHEN 'pack_installation' THEN 'kind,id,created_at,pack_key,pack_version,manifest_sha256'
    WHEN 'pack_item' THEN 'kind,id,created_at,installation_id,item_kind,item_key,item_id'
    WHEN 'security_settings' THEN 'kind,id,created_at,classification,mfa_for_administration,mfa_max_age_seconds,sso_enforcement'
    WHEN 'custom_object_type' THEN 'kind,id,created_at,slug,display_name,classification,current_version_number'
    WHEN 'custom_object_version' THEN 'kind,id,created_at,type_id,version_number,classification,type_slug,fields,relations,schema_sha256'
    WHEN 'custom_object_record' THEN 'kind,id,created_at,type_id,type_version_number,display_name,classification,type_classification,owner_membership_id,version,updated_at,type_slug,fields,relations,schema_sha256,attributes'
    WHEN 'custom_object_relation' THEN 'kind,id,created_at,relation_key,from_record_id,to_record_id,classification'
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
      WHERE jsonb_typeof(x)<>'object' OR x->>'kind' IS NULL OR x->>'kind' NOT IN('work_unit','project','client','object_record')
        OR x->>'id' IS NULL OR x->>'id' !~ '^[0-9a-f-]{36}$'
        OR (SELECT count(*) FROM jsonb_object_keys(x))<>2)
    OR (NEW.record ? 'work_unit_id' AND (NEW.work_unit_id::text IS DISTINCT FROM NEW.record->>'work_unit_id'
      OR NOT NEW.required_records @> jsonb_build_array(jsonb_build_object('kind','work_unit','id',NEW.work_unit_id))))
    OR (NEW.record ? 'source_id' AND NOT (NEW.record->>'source_id')::uuid=ANY(NEW.required_source_ids))
    OR (NEW.record_kind='knowledge_source' AND NOT NEW.source_id=ANY(NEW.required_source_ids))
  THEN RAISE EXCEPTION 'PORTABLE_DEFINITION_REFUSED' USING ERRCODE='42501'; END IF;
  IF (NEW.record_kind='studio_agent_draft' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.record#>'{answers,knowledgeSourceIds}') wanted(id) WHERE NOT wanted.id::uuid=ANY(NEW.required_source_ids)))
    OR (NEW.record_kind='custom_object_record' AND NOT NEW.required_records @> jsonb_build_array(jsonb_build_object('kind','object_record','id',NEW.source_id)))
    OR (NEW.record_kind='custom_object_relation' AND (NOT NEW.required_records @> jsonb_build_array(jsonb_build_object('kind','object_record','id',NEW.record->>'from_record_id')) OR NOT NEW.required_records @> jsonb_build_array(jsonb_build_object('kind','object_record','id',NEW.record->>'to_record_id'))))
  THEN RAISE EXCEPTION 'PORTABLE_DEFINITION_REFUSED' USING ERRCODE='42501'; END IF;
  FOREACH source_id IN ARRAY ARRAY(SELECT DISTINCT wanted FROM unnest(NEW.required_source_ids) wanted ORDER BY wanted) LOOP
    SELECT state INTO source_state FROM knowledge.sources WHERE organization_id=NEW.organization_id AND id=source_id FOR SHARE;
    IF FOUND AND source_state<>'active' THEN
      RAISE EXCEPTION 'PORTABLE_SOURCE_CLOSED' USING ERRCODE='42501'; END IF;
    IF EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=NEW.organization_id
      AND t.target_type='knowledge_source' AND t.target_id=source_id) THEN
      RAISE EXCEPTION 'PORTABLE_SOURCE_CLOSED' USING ERRCODE='42501'; END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(NEW.required_records) ORDER BY value->>'kind',value->>'id' LOOP
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
CREATE OR REPLACE FUNCTION sovereign.imported_definitions_remaining(p_kind text,p_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
  IF NOT knowledge.is_service_actor() OR p_kind NOT IN('knowledge_source','work_unit','project','client','object_record') THEN
    RAISE EXCEPTION 'PORTABLE_ERASURE_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  SELECT count(*)::int INTO n FROM sovereign.imported_definitions d
    WHERE d.organization_id=app.current_organization_id() AND
      ((p_kind='knowledge_source' AND p_id=ANY(d.required_source_ids)) OR
       d.required_records @> jsonb_build_array(jsonb_build_object('kind',p_kind,'id',p_id)));
  RETURN n;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sovereign.erase_imported_definitions(p_kind text,p_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
  IF NOT knowledge.is_service_actor() OR p_kind NOT IN('knowledge_source','work_unit','project','client','object_record') THEN
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
--> statement-breakpoint
