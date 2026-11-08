-- Inert unknown-origin originals, never work.artifacts or a claim of ordinary human provenance.
-- Requires0409 verified parser receipts and0412 native session metadata. Unapplied source.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
   OR pg_catalog.pg_has_role(current_user,'ensemus_auth','member') THEN
   RAISE EXCEPTION 'ARCHIVE_FILE_GUARD_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE sovereign.imported_archive_files(
 organization_id uuid NOT NULL,import_id uuid NOT NULL,source_artifact_id uuid NOT NULL,
 metadata_part_path text NOT NULL,metadata_sha256 text NOT NULL CHECK(metadata_sha256~'^[0-9a-f]{64}$'),
 binary_part_path text NOT NULL,binary_sha256 text NOT NULL CHECK(binary_sha256~'^[0-9a-f]{64}$'),
 name text NOT NULL,mime_type text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 26214400),
 classification text NOT NULL CHECK(classification IN('public','internal','confidential')),
 custodian_membership_id uuid NOT NULL,write_token uuid NOT NULL,object_key text NOT NULL,
 state text NOT NULL CHECK(state IN('writing','unknown','quarantined','closing','purged')),
 write_state text NOT NULL CHECK(write_state IN('active','settled','fenced')),
 held boolean NOT NULL DEFAULT false,write_finished_at timestamptz,write_fenced_at timestamptz,
 closed_at timestamptz,physical_purged_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,import_id,source_artifact_id),
 CONSTRAINT archive_file_import_fk FOREIGN KEY(organization_id,import_id) REFERENCES sovereign.organization_imports(organization_id,id),
 CONSTRAINT archive_file_metadata_part_fk FOREIGN KEY(organization_id,import_id,metadata_part_path) REFERENCES sovereign.organization_import_manifests(organization_id,import_id,path),
 CONSTRAINT archive_file_binary_part_fk FOREIGN KEY(organization_id,import_id,binary_part_path) REFERENCES sovereign.organization_import_manifests(organization_id,import_id,path),
 CONSTRAINT archive_file_custodian_fk FOREIGN KEY(organization_id,custodian_membership_id) REFERENCES org.memberships(organization_id,id),
 CONSTRAINT archive_file_key CHECK(object_key=organization_id::text||'/archive-quarantine/'||import_id::text||'/'||source_artifact_id::text||'/'||write_token::text),
 CONSTRAINT archive_file_finished CHECK((state<>'quarantined' OR(write_state IN('settled','fenced') AND write_finished_at IS NOT NULL AND closed_at IS NULL))
   AND(state<>'purged' OR(write_state IN('settled','fenced') AND physical_purged_at IS NOT NULL AND closed_at IS NOT NULL)))
);
ALTER TABLE sovereign.imported_archive_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE sovereign.imported_archive_files FORCE ROW LEVEL SECURITY;
-- No app/agent table grant. The fixed metadata functions below expose only one admitted file or the
-- current native custodian's review metadata. Tokens and keys never become customer DTO fields.
CREATE POLICY archive_file_fixed_owner ON sovereign.imported_archive_files TO ensemus_migrator
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE POLICY archive_org_metadata_read ON org.organizations FOR SELECT TO ensemus_migrator USING(id=app.current_organization_id());
CREATE POLICY archive_org_metadata_lock ON org.organizations FOR UPDATE TO ensemus_migrator USING(id=app.current_organization_id()) WITH CHECK(false);
CREATE POLICY archive_source_metadata_read ON knowledge.sources FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND(knowledge.is_service_actor() OR app.current_actor_type()='user'));
CREATE POLICY archive_source_metadata_lock ON knowledge.sources FOR UPDATE TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND(knowledge.is_service_actor() OR app.current_actor_type()='user')) WITH CHECK(false);
CREATE POLICY archive_tombstone_metadata ON platform.tombstones FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND(knowledge.is_service_actor() OR app.current_actor_type()='user'));
CREATE POLICY archive_import_native_metadata ON sovereign.organization_imports FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND app.current_actor_type()='user' AND fallback_membership_id=app.current_membership_id());
CREATE POLICY archive_custodian_native_read ON org.memberships FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND app.current_actor_type()='user' AND id=app.current_membership_id() AND user_id=app.current_user_id());
CREATE POLICY archive_custodian_native_lock ON org.memberships FOR UPDATE TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND app.current_actor_type()='user' AND id=app.current_membership_id() AND user_id=app.current_user_id()) WITH CHECK(false);
-- Only the fixed existing readable_source_ids predicate runs in this private metadata scope. It
-- reads no body/config/secret column. The application gains no table/role/secret read privilege.
CREATE POLICY archive_named_grant_metadata ON knowledge.source_grants FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND nullif(current_setting('sovereign.archive_viewer',true),'') IS NOT NULL);
CREATE POLICY archive_named_team_metadata ON org.team_memberships FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND membership_id=nullif(current_setting('sovereign.archive_viewer',true),'')::uuid);
CREATE POLICY archive_named_resource_metadata ON integrations.external_resources FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND nullif(current_setting('sovereign.archive_viewer',true),'') IS NOT NULL);
CREATE POLICY archive_named_acl_metadata ON integrations.external_resource_acl FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND nullif(current_setting('sovereign.archive_viewer',true),'') IS NOT NULL);
CREATE POLICY archive_named_connection_metadata ON integrations.connections FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND nullif(current_setting('sovereign.archive_viewer',true),'') IS NOT NULL);
CREATE POLICY archive_named_work_assignment ON knowledge.structured_work_assignments FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND membership_id=nullif(current_setting('sovereign.archive_viewer',true),'')::uuid);
CREATE POLICY archive_named_client_reader ON work.client_readers FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND membership_id=nullif(current_setting('sovereign.archive_viewer',true),'')::uuid);
--> statement-breakpoint
CREATE FUNCTION sovereign.archive_source_admission_barrier() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid;
BEGIN
 IF TG_RELID IN('knowledge.sources'::regclass,'knowledge.structured_record_catalog'::regclass) AND TG_OP IN('INSERT','UPDATE','DELETE') THEN
   tenant:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
 ELSIF TG_RELID='platform.tombstones'::regclass AND TG_OP='INSERT' THEN
   IF NEW.target_type NOT IN('knowledge_source','work_unit','project','client','object_record') THEN RETURN NEW;END IF;tenant:=NEW.organization_id;
 ELSE RAISE EXCEPTION 'ARCHIVE_FILE_TRIGGER_TARGET_INVALID' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('archive_unknown_inputs:'||tenant::text,0));
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_source_admission_barrier() FROM PUBLIC;
CREATE TRIGGER archive_source_admission BEFORE INSERT OR UPDATE OR DELETE ON knowledge.sources FOR EACH ROW EXECUTE FUNCTION sovereign.archive_source_admission_barrier();
CREATE TRIGGER archive_tombstone_admission BEFORE INSERT ON platform.tombstones FOR EACH ROW EXECUTE FUNCTION sovereign.archive_source_admission_barrier();
CREATE TRIGGER archive_record_admission BEFORE INSERT OR UPDATE OR DELETE ON knowledge.structured_record_catalog FOR EACH ROW EXECUTE FUNCTION sovereign.archive_source_admission_barrier();
--> statement-breakpoint
CREATE FUNCTION sovereign.lock_archive_source_fence() RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() NOT IN('service','user') THEN RETURN false;END IF;
 -- Unknown lineage means every current source is an input. Source locks always precede file rows;
 -- a closure sees the pending writer, or this admission sees closure and refuses. Retained tombstones
 -- keep this conservative boundary after the source row itself has been erased.
 PERFORM pg_advisory_xact_lock(hashtextextended('archive_unknown_inputs:'||app.current_organization_id()::text,0));
 -- Unknown provenance cannot justify unbounded interactive scans/locks. Larger inventories need
 -- actual lineage/rehydration, not a truncated proof or an empty-success default.
 IF (SELECT count(*) FROM(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=app.current_organization_id() LIMIT 2001) bounded)>2000
   OR(SELECT count(*) FROM(SELECT 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=app.current_organization_id() LIMIT 2001) bounded)>2000 THEN RETURN false;END IF;
 BEGIN
  PERFORM o.id FROM org.organizations o WHERE o.id=app.current_organization_id() AND o.lifecycle='active' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN false;END IF;
  PERFORM s.id FROM knowledge.sources s WHERE s.organization_id=app.current_organization_id() ORDER BY s.id FOR SHARE NOWAIT;
  PERFORM c.record_id FROM knowledge.structured_record_catalog c WHERE c.organization_id=app.current_organization_id() ORDER BY c.record_kind,c.record_id FOR SHARE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RETURN false;END;
 RETURN NOT EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=app.current_organization_id() AND s.state<>'active')
   AND NOT EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=app.current_organization_id() AND NOT c.alive)
   AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=app.current_organization_id() AND t.target_type IN('knowledge_source','work_unit','project','client','object_record'));
END $$;
REVOKE ALL ON FUNCTION sovereign.lock_archive_source_fence() FROM PUBLIC;
CREATE FUNCTION sovereign.archive_sources_readable(p_viewer uuid,p_class text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_viewer text;allowed boolean;
BEGIN
 IF p_viewer IS NULL OR p_class NOT IN('public','internal','confidential') THEN RETURN false;END IF;
 previous_viewer:=current_setting('sovereign.archive_viewer',true);
 PERFORM set_config('sovereign.archive_viewer',p_viewer::text,true);
 BEGIN
  allowed:=NOT EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=app.current_organization_id()
    AND(s.state<>'active' OR knowledge.class_rank(s.classification)>knowledge.class_rank(p_class)
      OR s.id NOT IN(SELECT knowledge.readable_source_ids(p_viewer))))
    AND NOT EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=app.current_organization_id()
      AND(NOT c.alive OR NOT knowledge.structured_record_readable(c.record_kind,c.record_id,p_viewer)
        OR knowledge.structured_record_class(c.record_kind,c.record_id) IS NULL
        OR knowledge.class_rank(knowledge.structured_record_class(c.record_kind,c.record_id))>knowledge.class_rank(p_class)));
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('sovereign.archive_viewer',coalesce(previous_viewer,''),true);RAISE;END;
 PERFORM set_config('sovereign.archive_viewer',coalesce(previous_viewer,''),true);RETURN allowed;
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_sources_readable(uuid,text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION sovereign.archive_custodian_current(p_import uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE person uuid;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'user' THEN RETURN false;END IF;
 SELECT m.id INTO person FROM org.memberships m WHERE m.organization_id=app.current_organization_id() AND m.id=app.current_membership_id()
   AND m.user_id=app.current_user_id() AND m.status='active' AND m.role='owner' FOR SHARE;
 RETURN person IS NOT NULL AND identity.lock_studio_session(app.current_user_id(),app.current_interactive_session_id())
   AND EXISTS(SELECT 1 FROM sovereign.organization_imports i WHERE i.organization_id=app.current_organization_id() AND i.id=p_import
     AND i.fallback_membership_id=person AND i.intent_authorized_at IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_custodian_current(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION sovereign.begin_archive_file(p_import uuid,p_record jsonb,p_bytes bytea)
 RETURNS TABLE(claimed boolean,object_key text,write_token uuid,state text,binary_sha256 text,size_bytes bigint)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE file sovereign.imported_archive_files%ROWTYPE;prior sovereign.imported_archive_files%ROWTYPE;binary_path text;binary_hash text;metadata_hash text;custodian uuid;new_token uuid;
BEGIN
 IF NOT sovereign.verified_import_record(p_import,p_record) OR p_record->>'kind' IS DISTINCT FROM 'artifact'
   OR NOT sovereign.lock_archive_source_fence() THEN RAISE EXCEPTION 'ARCHIVE_FILE_ADMISSION_REQUIRED' USING ERRCODE='EN415';END IF;
 binary_path:='artifacts/'||(p_record->>'id')::uuid::text||'.bin.sealed';binary_hash:=encode(pg_catalog.sha256(p_bytes),'hex');
 metadata_hash:=encode(pg_catalog.sha256(convert_to(p_record::text,'UTF8')),'hex');
 IF binary_hash IS DISTINCT FROM p_record->>'sha256' OR octet_length(p_bytes) IS DISTINCT FROM (p_record->>'size_bytes')::bigint
   OR octet_length(p_bytes) NOT BETWEEN 1 AND 26214400 OR p_record->>'classification' NOT IN('public','internal','confidential')
   OR NOT EXISTS(SELECT 1 FROM sovereign.organization_import_manifests proof WHERE proof.organization_id=app.current_organization_id()
     AND proof.import_id=p_import AND proof.path=binary_path AND proof.plaintext_sha256=binary_hash AND proof.section='artifacts')
   OR EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=app.current_organization_id() AND t.target_type='artifact' AND t.target_id=(p_record->>'id')::uuid)
 THEN RAISE EXCEPTION 'ARCHIVE_FILE_PART_CHANGED' USING ERRCODE='EN415';END IF;
 SELECT i.fallback_membership_id INTO custodian FROM sovereign.organization_imports i WHERE i.organization_id=app.current_organization_id() AND i.id=p_import;
 IF NOT sovereign.archive_sources_readable(custodian,p_record->>'classification') THEN RAISE EXCEPTION 'ARCHIVE_FILE_INPUT_AUTHORITY_REQUIRED' USING ERRCODE='EN415';END IF;
 new_token:=gen_random_uuid();
 INSERT INTO sovereign.imported_archive_files(organization_id,import_id,source_artifact_id,metadata_part_path,metadata_sha256,binary_part_path,binary_sha256,
   name,mime_type,size_bytes,classification,custodian_membership_id,write_token,object_key,state,write_state)
 VALUES(app.current_organization_id(),p_import,(p_record->>'id')::uuid,current_setting('app.portability_part_path',true),metadata_hash,binary_path,binary_hash,
   p_record->>'name',p_record->>'mime_type',octet_length(p_bytes),p_record->>'classification',custodian,new_token,
   app.current_organization_id()::text||'/archive-quarantine/'||p_import::text||'/'||(p_record->>'id')::uuid::text||'/'||new_token::text,'writing','active')
 ON CONFLICT DO NOTHING RETURNING * INTO file;
 IF file.source_artifact_id IS NOT NULL THEN
   RETURN QUERY SELECT true,file.object_key,file.write_token,file.state,file.binary_sha256,file.size_bytes;RETURN;
 END IF;
 SELECT * INTO prior FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id() AND f.import_id=p_import AND f.source_artifact_id=(p_record->>'id')::uuid FOR UPDATE;
 IF prior.metadata_sha256 IS DISTINCT FROM metadata_hash OR prior.binary_sha256 IS DISTINCT FROM binary_hash
   OR prior.size_bytes IS DISTINCT FROM octet_length(p_bytes)::bigint OR prior.metadata_part_path IS DISTINCT FROM current_setting('app.portability_part_path',true)
   OR prior.state<>'quarantined' OR prior.write_state NOT IN('settled','fenced') OR prior.closed_at IS NOT NULL THEN
   RAISE EXCEPTION 'ARCHIVE_FILE_WRITE_UNKNOWN_OR_CLOSED' USING ERRCODE='EN415';END IF;
 RETURN QUERY SELECT false,prior.object_key,prior.write_token,prior.state,prior.binary_sha256,prior.size_bytes;
END $$;
REVOKE ALL ON FUNCTION sovereign.begin_archive_file(uuid,jsonb,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.begin_archive_file(uuid,jsonb,bytea) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.finish_archive_file(p_import uuid,p_source uuid,p_token uuid,p_hash text,p_size bigint) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE can_serve boolean;file sovereign.imported_archive_files%ROWTYPE;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() THEN RAISE EXCEPTION 'ARCHIVE_FILE_SETTLEMENT_REQUIRED' USING ERRCODE='EN415';END IF;
 -- Import/member/source/file ordering matches admission. A revoked owner may still settle the
 -- original completed put for cleanup, but can never make those bytes reviewable.
 PERFORM i.id FROM sovereign.organization_imports i WHERE i.organization_id=app.current_organization_id() AND i.id=p_import FOR SHARE;
 can_serve:=sovereign.lock_running_import(p_import);can_serve:=sovereign.lock_archive_source_fence() AND can_serve;
 SELECT * INTO file FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id() AND f.import_id=p_import AND f.source_artifact_id=p_source FOR UPDATE;
 IF file.write_token IS DISTINCT FROM p_token OR file.binary_sha256 IS DISTINCT FROM p_hash OR file.size_bytes IS DISTINCT FROM p_size
   OR file.write_state<>'active' OR file.state NOT IN('writing','unknown','closing') THEN
   RAISE EXCEPTION 'ARCHIVE_FILE_SETTLEMENT_REQUIRED' USING ERRCODE='EN415';END IF;
 can_serve:=can_serve AND sovereign.archive_sources_readable(file.custodian_membership_id,file.classification) AND file.closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform.tombstones t
   WHERE t.organization_id=file.organization_id AND t.target_type='artifact' AND t.target_id=p_source);
 UPDATE sovereign.imported_archive_files f SET write_state='settled',write_finished_at=clock_timestamp(),
   state=CASE WHEN can_serve THEN 'quarantined' ELSE 'closing' END,closed_at=CASE WHEN can_serve THEN NULL ELSE coalesce(f.closed_at,clock_timestamp()) END
   WHERE f.organization_id=file.organization_id AND f.import_id=p_import AND f.source_artifact_id=p_source;
 RETURN can_serve;
END $$;
REVOKE ALL ON FUNCTION sovereign.finish_archive_file(uuid,uuid,uuid,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.finish_archive_file(uuid,uuid,uuid,text,bigint) TO ensemus_app;
CREATE FUNCTION sovereign.unknown_archive_file(p_import uuid,p_source uuid,p_token uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() THEN RAISE EXCEPTION 'ARCHIVE_FILE_SETTLEMENT_REQUIRED' USING ERRCODE='EN415';END IF;
 UPDATE sovereign.imported_archive_files f SET state=CASE WHEN f.closed_at IS NULL THEN 'unknown' ELSE 'closing' END
   WHERE f.organization_id=app.current_organization_id() AND f.import_id=p_import AND f.source_artifact_id=p_source
     AND f.write_token=p_token AND f.write_state='active' AND f.state IN('writing','unknown','closing');
END $$;
REVOKE ALL ON FUNCTION sovereign.unknown_archive_file(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.unknown_archive_file(uuid,uuid,uuid) TO ensemus_app;
CREATE FUNCTION sovereign.close_finished_archive_file(p_import uuid,p_source uuid,p_token uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() THEN RAISE EXCEPTION 'ARCHIVE_FILE_SETTLEMENT_REQUIRED' USING ERRCODE='EN415';END IF;
 -- The actual put promise fulfilled, but read-back/publication could not be proven. Its writer is
 -- quiescent, its bytes stay closed and cleanup does not depend on a revoked viewer's permission.
 UPDATE sovereign.imported_archive_files f SET state='closing',closed_at=coalesce(f.closed_at,clock_timestamp()),
   write_state='settled',write_finished_at=coalesce(f.write_finished_at,clock_timestamp())
   WHERE f.organization_id=app.current_organization_id() AND f.import_id=p_import AND f.source_artifact_id=p_source
     AND f.write_token=p_token AND f.write_state='active' AND f.state IN('writing','unknown','closing');
END $$;
REVOKE ALL ON FUNCTION sovereign.close_finished_archive_file(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.close_finished_archive_file(uuid,uuid,uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.archive_file_ready(p_import uuid,p_record jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT sovereign.verified_import_record(p_import,p_record) OR NOT sovereign.lock_archive_source_fence() THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id()
   AND f.import_id=p_import AND f.source_artifact_id=(p_record->>'id')::uuid AND f.state='quarantined'
   AND f.write_state IN('settled','fenced') AND f.write_finished_at IS NOT NULL AND f.closed_at IS NULL
   AND sovereign.archive_sources_readable(f.custodian_membership_id,f.classification)
   AND f.metadata_sha256=encode(pg_catalog.sha256(convert_to(p_record::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_file_ready(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.archive_file_ready(uuid,jsonb) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.archive_file_read(p_import uuid,p_source uuid)
 RETURNS TABLE(object_key text,binary_sha256 text,size_bytes bigint,name text,mime_type text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT sovereign.archive_custodian_current(p_import) OR NOT sovereign.lock_archive_source_fence() THEN RETURN;END IF;
 RETURN QUERY SELECT f.object_key,f.binary_sha256,f.size_bytes,f.name,f.mime_type FROM sovereign.imported_archive_files f
  WHERE f.organization_id=app.current_organization_id() AND f.import_id=p_import AND f.source_artifact_id=p_source
    AND f.custodian_membership_id=app.current_membership_id() AND f.state='quarantined'
    AND f.write_state IN('settled','fenced') AND f.write_finished_at IS NOT NULL AND f.closed_at IS NULL
    AND sovereign.archive_sources_readable(f.custodian_membership_id,f.classification)
    AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=f.organization_id AND t.target_type='artifact' AND t.target_id=f.source_artifact_id)
  FOR SHARE;
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_file_read(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.archive_file_read(uuid,uuid) TO ensemus_app;
CREATE FUNCTION sovereign.archive_file_list(p_import uuid,p_after uuid,p_limit integer)
 RETURNS TABLE(source_artifact_id uuid,name text,mime_type text,size_bytes bigint,classification text,state text,reviewable boolean,created_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE base_open boolean;allow_public boolean:=false;allow_internal boolean:=false;allow_confidential boolean:=false;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR NOT sovereign.archive_custodian_current(p_import) THEN RETURN;END IF;
 base_open:=sovereign.lock_archive_source_fence();
 IF base_open THEN
  allow_public:=sovereign.archive_sources_readable(app.current_membership_id(),'public');
  allow_internal:=sovereign.archive_sources_readable(app.current_membership_id(),'internal');
  allow_confidential:=sovereign.archive_sources_readable(app.current_membership_id(),'confidential');
 END IF;
 RETURN QUERY SELECT f.source_artifact_id,CASE WHEN visibility.allowed THEN f.name ELSE NULL END,
  CASE WHEN visibility.allowed THEN f.mime_type ELSE NULL END,f.size_bytes,CASE WHEN visibility.allowed THEN f.classification ELSE NULL END,
  f.state,(visibility.allowed AND f.state='quarantined' AND f.closed_at IS NULL),f.created_at
  FROM sovereign.imported_archive_files f CROSS JOIN LATERAL(SELECT(base_open AND f.closed_at IS NULL
    AND CASE f.classification WHEN 'public' THEN allow_public WHEN 'internal' THEN allow_internal ELSE allow_confidential END
    AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=f.organization_id AND t.target_type='artifact' AND t.target_id=f.source_artifact_id)) AS allowed) visibility
  WHERE f.organization_id=app.current_organization_id() AND f.import_id=p_import
   AND f.custodian_membership_id=app.current_membership_id() AND(p_after IS NULL OR f.source_artifact_id>p_after)
  ORDER BY f.source_artifact_id LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_file_list(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.archive_file_list(uuid,uuid,integer) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.close_archive_files_for_revocation() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid;
BEGIN
 IF TG_RELID='knowledge.structured_record_catalog'::regclass AND TG_OP IN('INSERT','UPDATE','DELETE') THEN
   tenant:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
   IF tenant IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'ARCHIVE_FILE_TENANT_REQUIRED' USING ERRCODE='42501';END IF;
   IF TG_OP<>'DELETE' THEN IF NEW.alive THEN RETURN NEW;END IF;END IF;
   UPDATE sovereign.imported_archive_files f SET state='closing',closed_at=coalesce(f.closed_at,clock_timestamp())
     WHERE f.organization_id=tenant AND f.physical_purged_at IS NULL;
 ELSIF TG_RELID='knowledge.sources'::regclass AND TG_OP='UPDATE' THEN
   IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'ARCHIVE_FILE_TENANT_REQUIRED' USING ERRCODE='42501';END IF;
   IF NEW.state='active' THEN RETURN NEW;END IF;
   UPDATE sovereign.imported_archive_files f SET state='closing',closed_at=coalesce(f.closed_at,clock_timestamp())
     WHERE f.organization_id=NEW.organization_id AND f.physical_purged_at IS NULL;
 ELSIF TG_RELID='platform.tombstones'::regclass AND TG_OP='INSERT' THEN
   IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'ARCHIVE_FILE_TENANT_REQUIRED' USING ERRCODE='42501';END IF;
   IF NEW.target_type IN('knowledge_source','work_unit','project','client','object_record') THEN
     UPDATE sovereign.imported_archive_files f SET state='closing',closed_at=coalesce(f.closed_at,clock_timestamp())
       WHERE f.organization_id=NEW.organization_id AND f.physical_purged_at IS NULL;
   ELSIF NEW.target_type='artifact' THEN
     UPDATE sovereign.imported_archive_files f SET state='closing',closed_at=coalesce(f.closed_at,clock_timestamp())
       WHERE f.organization_id=NEW.organization_id AND f.source_artifact_id=NEW.target_id AND f.physical_purged_at IS NULL;
   END IF;
 ELSE RAISE EXCEPTION 'ARCHIVE_FILE_TRIGGER_TARGET_INVALID' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sovereign.close_archive_files_for_revocation() FROM PUBLIC;
CREATE TRIGGER archive_files_source_close AFTER UPDATE OF state ON knowledge.sources FOR EACH ROW EXECUTE FUNCTION sovereign.close_archive_files_for_revocation();
CREATE TRIGGER archive_files_tombstone AFTER INSERT ON platform.tombstones FOR EACH ROW EXECUTE FUNCTION sovereign.close_archive_files_for_revocation();
CREATE TRIGGER archive_files_record_close AFTER INSERT OR UPDATE OR DELETE ON knowledge.structured_record_catalog FOR EACH ROW EXECUTE FUNCTION sovereign.close_archive_files_for_revocation();
--> statement-breakpoint
-- Inventory is complete even for writing/unknown/held rows. Every file has unknown Knowledge input
-- lineage, so every source closure conservatively requires physical disposal of every retained file.
CREATE FUNCTION sovereign.archive_file_inventory(p_source uuid,p_limit integer)
 RETURNS TABLE(import_id uuid,source_artifact_id uuid,object_key text,binary_sha256 text,write_token uuid,write_state text,state text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
   RAISE EXCEPTION 'ARCHIVE_FILE_CLEANUP_REQUIRED' USING ERRCODE='EN415';END IF;
 IF p_source IS NOT NULL AND NOT EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=app.current_organization_id() AND s.id=p_source AND s.state<>'active')
   AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=app.current_organization_id() AND t.target_type='knowledge_source' AND t.target_id=p_source) THEN
   RAISE EXCEPTION 'ARCHIVE_FILE_SOURCE_NOT_CLOSED' USING ERRCODE='EN415';END IF;
 -- Called outside any caller-held source transaction. The root tenant erasure adapter validates its
 -- actual erasure intent before using the NULL-source inventory. This function only closes serving.
 UPDATE sovereign.imported_archive_files f SET state='closing',closed_at=coalesce(f.closed_at,clock_timestamp())
  WHERE f.organization_id=app.current_organization_id() AND f.physical_purged_at IS NULL;
 RETURN QUERY SELECT f.import_id,f.source_artifact_id,f.object_key,f.binary_sha256,f.write_token,f.write_state,f.state
  FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id() AND f.physical_purged_at IS NULL
  ORDER BY f.held,f.import_id,f.source_artifact_id LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_file_inventory(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.archive_file_inventory(uuid,integer) TO ensemus_app;
CREATE FUNCTION sovereign.archive_file_record_inventory(p_kind text,p_record uuid,p_limit integer)
 RETURNS TABLE(import_id uuid,source_artifact_id uuid,object_key text,binary_sha256 text,write_token uuid,write_state text,state text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN('work_unit','project','client','object_record') OR NOT knowledge.is_service_actor()
   OR(NOT EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=app.current_organization_id()
     AND c.record_kind=p_kind AND c.record_id=p_record AND NOT c.alive)
     AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=app.current_organization_id() AND t.target_type=p_kind AND t.target_id=p_record)) THEN
   RAISE EXCEPTION 'ARCHIVE_FILE_RECORD_NOT_CLOSED' USING ERRCODE='EN415';END IF;
 RETURN QUERY SELECT * FROM sovereign.archive_file_inventory(NULL,p_limit);
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_file_record_inventory(text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.archive_file_record_inventory(text,uuid,integer) TO ensemus_app;
CREATE FUNCTION sovereign.archive_file_counts() RETURNS TABLE(removed integer,remaining integer,held integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() THEN RAISE EXCEPTION 'ARCHIVE_FILE_CLEANUP_REQUIRED' USING ERRCODE='EN415';END IF;
 RETURN QUERY SELECT count(*)FILTER(WHERE f.physical_purged_at IS NOT NULL)::integer,
   count(*)FILTER(WHERE f.physical_purged_at IS NULL)::integer,count(*)FILTER(WHERE f.held AND f.physical_purged_at IS NULL)::integer
   FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id();
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_file_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.archive_file_counts() TO ensemus_app;
CREATE FUNCTION sovereign.archive_file_target_conflicts(p_current_import uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
 IF session_user<>'ensemus_app' OR(app.current_actor_type() IS DISTINCT FROM 'user' AND NOT knowledge.is_service_actor()) THEN
  RAISE EXCEPTION 'ARCHIVE_FILE_INVENTORY_REQUIRED' USING ERRCODE='EN415';END IF;
 SELECT EXISTS(SELECT 1 FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id()
  AND f.physical_purged_at IS NULL AND(p_current_import IS NULL OR f.import_id<>p_current_import))::integer INTO n;RETURN n;
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_file_target_conflicts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.archive_file_target_conflicts(uuid) TO ensemus_app;
CREATE FUNCTION sovereign.archive_file_cleanup_receipt(p_import uuid,p_source uuid,p_token uuid,p_quiescent boolean,p_absent boolean,p_held boolean) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE file sovereign.imported_archive_files%ROWTYPE;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() THEN RAISE EXCEPTION 'ARCHIVE_FILE_CLEANUP_REQUIRED' USING ERRCODE='EN415';END IF;
 SELECT * INTO file FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id() AND f.import_id=p_import AND f.source_artifact_id=p_source FOR UPDATE;
 IF file.write_token IS DISTINCT FROM p_token OR file.closed_at IS NULL OR file.state<>'closing' THEN RETURN false;END IF;
 IF p_held THEN UPDATE sovereign.imported_archive_files f SET held=true WHERE f.organization_id=file.organization_id AND f.import_id=p_import AND f.source_artifact_id=p_source;RETURN false;END IF;
 IF p_held IS DISTINCT FROM false OR p_quiescent IS DISTINCT FROM true OR p_absent IS DISTINCT FROM true THEN RETURN false;END IF;
 -- These two facts are supplied only after the actual hold-aware lifecycle adapter and independent
 -- ObjectStore absence check. SQL pins identity/state; it does not pretend to inspect S3 itself.
 UPDATE sovereign.imported_archive_files f SET state='purged',write_state=CASE WHEN f.write_state='active' THEN 'fenced' ELSE f.write_state END,
   write_fenced_at=CASE WHEN f.write_state='active' THEN clock_timestamp() ELSE f.write_fenced_at END,
   physical_purged_at=clock_timestamp(),held=false WHERE f.organization_id=file.organization_id AND f.import_id=p_import AND f.source_artifact_id=p_source;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_file_cleanup_receipt(uuid,uuid,uuid,boolean,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.archive_file_cleanup_receipt(uuid,uuid,uuid,boolean,boolean,boolean) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.guard_archive_file_erasure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'sovereign.imported_archive_files'::regclass OR TG_OP<>'DELETE' OR current_user<>'ensemus_eraser'
   OR OLD.organization_id IS DISTINCT FROM app.current_organization_id() OR OLD.physical_purged_at IS NULL
   OR OLD.state<>'purged' OR OLD.write_state NOT IN('settled','fenced') OR OLD.closed_at IS NULL OR OLD.held
   OR lifecycle.erasure_open(OLD.organization_id) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'ARCHIVE_FILE_PHYSICAL_PROOF_REQUIRED' USING ERRCODE='42501';END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION sovereign.guard_archive_file_erasure() FROM PUBLIC;
CREATE TRIGGER archive_file_erasure_proof BEFORE DELETE ON sovereign.imported_archive_files FOR EACH ROW EXECUTE FUNCTION sovereign.guard_archive_file_erasure();
CREATE TRIGGER archive_file_no_truncate BEFORE TRUNCATE ON sovereign.imported_archive_files FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION sovereign.archive_file_restore_page(p_import uuid,p_source uuid,p_limit integer)
 RETURNS TABLE(import_id uuid,source_artifact_id uuid,object_key text,binary_sha256 text,size_bytes bigint,write_token uuid,state text,write_state text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  OR((p_import IS NULL)<>(p_source IS NULL)) THEN
   RAISE EXCEPTION 'ARCHIVE_FILE_RESTORE_REQUIRED' USING ERRCODE='EN415';END IF;
 RETURN QUERY SELECT f.import_id,f.source_artifact_id,f.object_key,f.binary_sha256,f.size_bytes,f.write_token,f.state,f.write_state
  FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id()
    AND(p_import IS NULL OR(f.import_id,f.source_artifact_id)>(p_import,p_source))
  ORDER BY f.import_id,f.source_artifact_id LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_file_restore_page(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.archive_file_restore_page(uuid,uuid,integer) TO ensemus_app;
CREATE FUNCTION sovereign.block_restored_archive_file(p_import uuid,p_source uuid,p_token uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integer;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() THEN RAISE EXCEPTION 'ARCHIVE_FILE_RESTORE_REQUIRED' USING ERRCODE='EN415';END IF;
 UPDATE sovereign.imported_archive_files f SET state='closing',closed_at=coalesce(f.closed_at,clock_timestamp()),physical_purged_at=NULL
   WHERE f.organization_id=app.current_organization_id() AND f.import_id=p_import AND f.source_artifact_id=p_source
    AND f.write_token=p_token AND f.state IN('purged','quarantined');
 GET DIAGNOSTICS changed=ROW_COUNT;RETURN changed=1;
END $$;
REVOKE ALL ON FUNCTION sovereign.block_restored_archive_file(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.block_restored_archive_file(uuid,uuid,uuid) TO ensemus_app;
CREATE FUNCTION sovereign.archive_file_restore_counts() RETURNS TABLE(checked integer,attention integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() THEN RAISE EXCEPTION 'ARCHIVE_FILE_RESTORE_REQUIRED' USING ERRCODE='EN415';END IF;
 RETURN QUERY SELECT count(*)::integer,count(*)FILTER(WHERE f.state IN('writing','unknown','closing') OR f.held)::integer
   FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id();
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_file_restore_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.archive_file_restore_counts() TO ensemus_app;
CREATE FUNCTION sovereign.archive_known_file_keys(p_keys text[]) RETURNS SETOF text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR p_keys IS NULL OR cardinality(p_keys)>1000 THEN
  RAISE EXCEPTION 'ARCHIVE_FILE_RESTORE_REQUIRED' USING ERRCODE='EN415';END IF;
 RETURN QUERY SELECT f.object_key FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id() AND f.object_key=ANY(p_keys);
END $$;
REVOKE ALL ON FUNCTION sovereign.archive_known_file_keys(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.archive_known_file_keys(text[]) TO ensemus_app;
