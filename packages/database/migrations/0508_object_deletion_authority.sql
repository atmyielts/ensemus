-- Joined M8 lifecycle authority. Prerequisites: 0208/0214 generated writer receipts, 0415 inert
-- archives and 0500-0507. No migration journal/snapshot registration until joined SQL review.
-- Storage outcome is recorded by the trusted runtime after actual single-attempt transport I/O;
-- SQL validates identity/order/authority. It does not pretend a Boolean can inspect the provider.
DO $ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR pg_has_role(current_user,'ensemus_auth','member') THEN RAISE EXCEPTION 'OBJECT_LIFECYCLE_GUARD_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
END $;
--> statement-breakpoint
CREATE TABLE lifecycle.object_deletion_claims (
 organization_id uuid NOT NULL REFERENCES org.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN('derived','ordinary','archive')), artifact_id uuid NOT NULL,
 import_id uuid, writer_token uuid NOT NULL, generation bigint NOT NULL CHECK(generation>0),
 object_key text NOT NULL, sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN('admitted','unknown','deleted','proven')),
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(), terminal_at timestamptz, absent_at timestamptz,
 PRIMARY KEY(organization_id,id),
 CONSTRAINT object_deletion_key CHECK((kind='archive' AND import_id IS NOT NULL
  AND object_key=organization_id::text||'/archive-quarantine/'||import_id::text||'/'||artifact_id::text||'/'||writer_token::text)
  OR(kind IN('derived','ordinary') AND import_id IS NULL AND object_key=organization_id::text||'/artifacts/'||artifact_id::text)),
 CONSTRAINT object_deletion_receipt CHECK((state NOT IN('deleted','proven') OR terminal_at IS NOT NULL)
  AND(state<>'proven' OR(absent_at IS NOT NULL AND absent_at>=terminal_at)))
);
CREATE TABLE lifecycle.object_restore_debts(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),object_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN('derived','archive')),artifact_id uuid NOT NULL,import_id uuid,
 writer_token uuid NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,object_key)
);
ALTER TABLE lifecycle.object_restore_debts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.object_restore_debts FORCE ROW LEVEL SECURITY;
CREATE POLICY object_restore_fixed_owner ON lifecycle.object_restore_debts TO ensemus_migrator
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
REVOKE ALL ON lifecycle.object_restore_debts FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser;
CREATE TABLE lifecycle.offboarding_admissions(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),offboarding_id uuid NOT NULL,
 requested_by_membership_id uuid NOT NULL,user_id uuid NOT NULL,session_id uuid NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,offboarding_id),
 CONSTRAINT offboarding_admission_intent FOREIGN KEY(organization_id,offboarding_id)
  REFERENCES lifecycle.offboardings(organization_id,id)
);
ALTER TABLE lifecycle.offboarding_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.offboarding_admissions FORCE ROW LEVEL SECURITY;
CREATE POLICY offboarding_admission_fixed_owner ON lifecycle.offboarding_admissions TO ensemus_migrator
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
REVOKE ALL ON lifecycle.offboarding_admissions FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser;
CREATE FUNCTION lifecycle.check_offboarding_native_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'lifecycle.offboardings'::regclass OR TG_OP<>'INSERT' OR NEW.state<>'requested'
  OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
  OR NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id()
  OR NOT app.interactive_privilege_allowed('organization.manage') OR NOT studio.author_allowed() THEN
  RAISE EXCEPTION 'OFFBOARDING_NATIVE_ADMISSION_REQUIRED' USING ERRCODE='EN850';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION lifecycle.record_offboarding_native_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'lifecycle.offboardings'::regclass OR TG_OP<>'INSERT' OR session_user<>'ensemus_app'
  OR app.current_actor_type() IS DISTINCT FROM 'user' OR app.current_interactive_session_id() IS NULL
  OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
  OR NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
  RAISE EXCEPTION 'OFFBOARDING_NATIVE_ADMISSION_REQUIRED' USING ERRCODE='EN850';END IF;
 INSERT INTO lifecycle.offboarding_admissions(organization_id,offboarding_id,requested_by_membership_id,user_id,session_id)
  VALUES(NEW.organization_id,NEW.id,NEW.requested_by_membership_id,app.current_user_id(),app.current_interactive_session_id());
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.check_offboarding_native_birth(),lifecycle.record_offboarding_native_birth() FROM PUBLIC;
CREATE TRIGGER offboardings_native_birth BEFORE INSERT ON lifecycle.offboardings FOR EACH ROW EXECUTE FUNCTION lifecycle.check_offboarding_native_birth();
CREATE TRIGGER offboardings_native_receipt AFTER INSERT ON lifecycle.offboardings FOR EACH ROW EXECUTE FUNCTION lifecycle.record_offboarding_native_birth();
CREATE UNIQUE INDEX object_deletion_unresolved_key ON lifecycle.object_deletion_claims(organization_id,object_key)
 WHERE state<>'proven';
ALTER TABLE lifecycle.object_deletion_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.object_deletion_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY fixed_delete_owner ON lifecycle.object_deletion_claims TO ensemus_migrator
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
-- This table is retained lifecycle evidence, not content or a portability authority. No app SELECT,
-- INSERT/UPDATE/DELETE grants, and no eraser grant. Fixed functions expose only exact admitted keys.
REVOKE ALL ON lifecycle.object_deletion_claims FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser;
GRANT SELECT(id,organization_id,status,placed_at) ON lifecycle.legal_holds TO ensemus_migrator;
GRANT SELECT(organization_id,hold_id,scope_type,scope_id) ON lifecycle.legal_hold_scopes TO ensemus_migrator;
CREATE POLICY deletion_hold_scope_metadata ON lifecycle.legal_hold_scopes FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id());
CREATE POLICY deletion_hold_metadata ON lifecycle.legal_holds FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id());
GRANT SELECT(organization_id,state) ON lifecycle.offboardings TO ensemus_migrator;
CREATE POLICY deletion_offboarding_metadata ON lifecycle.offboardings FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id());
CREATE POLICY deletion_blob_metadata ON platform.blob_lifecycle TO ensemus_migrator
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
GRANT SELECT,UPDATE(state,purged_at) ON platform.blob_lifecycle TO ensemus_migrator;
CREATE POLICY deletion_lineage_metadata ON knowledge.artifact_lineage FOR UPDATE TO ensemus_migrator
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
GRANT UPDATE(physical_purged_at,held,restore_reapply_pending) ON knowledge.artifact_lineage TO ensemus_migrator;
GRANT SELECT(organization_id,artifact_id,run_id,write_id,generation,state) ON ai.run_output_writes TO ensemus_migrator;
CREATE POLICY deletion_writer_metadata ON ai.run_output_writes FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id());
--> statement-breakpoint
CREATE FUNCTION lifecycle.lock_delete_tenant() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user<>'ensemus_app' OR app.current_organization_id() IS NULL THEN
  RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850'; END IF;
 PERFORM g.id FROM org.organizations g WHERE g.id=app.current_organization_id() FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850'; END IF;
END $$;
REVOKE ALL ON FUNCTION lifecycle.lock_delete_tenant() FROM PUBLIC;
-- Internal-only: the public fixed entry points below own all calls.
CREATE FUNCTION lifecycle.hold_delete_barrier() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'lifecycle.legal_holds'::regclass OR TG_OP NOT IN('INSERT','UPDATE')
  OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
  RAISE EXCEPTION 'INVALID_HOLD_TARGET' USING ERRCODE='42501'; END IF;
 IF app.current_actor_type() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'HOLD_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM m.id FROM org.memberships m WHERE m.organization_id=NEW.organization_id AND m.id=app.current_membership_id()
  AND m.user_id=app.current_user_id() AND m.status='active' AND m.role='owner' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'HOLD_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF(TG_OP='INSERT' AND NEW.placed_by_membership_id IS DISTINCT FROM app.current_membership_id())
  OR(TG_OP='UPDATE' AND NEW.status='released' AND NEW.released_by_membership_id IS DISTINCT FROM app.current_membership_id()) THEN
  RAISE EXCEPTION 'HOLD_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF NEW.status='active' THEN
  PERFORM lifecycle.lock_delete_tenant();
  IF EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=NEW.organization_id AND c.state<>'proven') THEN
   -- Bytes may already be committed to deletion. Do not falsely promise a newly placed hold.
   RAISE EXCEPTION 'OBJECT_DELETE_IN_PROGRESS' USING ERRCODE='EN851'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.hold_delete_barrier() FROM PUBLIC;
CREATE TRIGGER legal_hold_delete_barrier BEFORE INSERT OR UPDATE ON lifecycle.legal_holds
 FOR EACH ROW EXECUTE FUNCTION lifecycle.hold_delete_barrier();
--> statement-breakpoint
CREATE FUNCTION lifecycle.begin_object_deletion(p_target jsonb)
 RETURNS TABLE(state text,claim_id uuid,object_key text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id(); kind_name text:=p_target->>'kind'; target uuid;
 header knowledge.artifact_lineage%ROWTYPE; file record;
 catalog knowledge.artifact_acl_catalog%ROWTYPE; blob platform.blob_lifecycle%ROWTYPE;
 previous lifecycle.object_deletion_claims%ROWTYPE; token uuid; gen bigint; key text; hash text; import_key uuid;
BEGIN
 PERFORM lifecycle.lock_delete_tenant();
 IF kind_name IS NULL OR kind_name NOT IN('derived','ordinary','archive')
  OR (kind_name<>'ordinary' AND NOT knowledge.is_service_actor())
  OR (kind_name='ordinary' AND coalesce(app.current_actor_type(),'') NOT IN('user','service')) THEN
  RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850'; END IF;
 -- Unknown archive lineage requires ANY active hold in the tenant, including scopes unrelated to a
 -- live Work FK. Use the same conservative rule for all these deletion operations.
 IF EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active') THEN
  RETURN QUERY SELECT 'held'::text,NULL::uuid,NULL::text; RETURN; END IF;
 IF kind_name='archive' THEN
  import_key:=(p_target->>'importId')::uuid;target:=(p_target->>'sourceArtifactId')::uuid;
  SELECT f.write_token,f.state,f.closed_at,f.write_state,f.write_finished_at,f.object_key,f.binary_sha256 INTO file FROM sovereign.imported_archive_files f WHERE f.organization_id=tenant
   AND f.import_id=import_key AND f.source_artifact_id=target FOR UPDATE;
  IF NOT FOUND OR file.write_token IS DISTINCT FROM(p_target->>'writeToken')::uuid
   OR file.state<>'closing' OR file.closed_at IS NULL OR file.write_state<>'settled' OR file.write_finished_at IS NULL THEN
   RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;RETURN; END IF;
  token:=file.write_token;gen:=1;key:=file.object_key;hash:=file.binary_sha256;
 ELSE
  target:=(p_target->>'artifactId')::uuid;
  SELECT * INTO catalog FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=tenant AND a.artifact_id=target FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;RETURN;END IF;
  SELECT * INTO blob FROM platform.blob_lifecycle b WHERE b.organization_id=tenant AND b.artifact_id=target FOR UPDATE;
  IF NOT FOUND OR blob.state<>'deleting' OR NOT EXISTS(SELECT 1 FROM platform.tombstones t
   WHERE t.organization_id=tenant AND t.target_type='artifact' AND t.target_id=target) THEN
   RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;RETURN;END IF;
  key:=blob.object_key;hash:=catalog.sha256;
  IF kind_name='derived' THEN
   SELECT * INTO header FROM knowledge.artifact_lineage l WHERE l.organization_id=tenant AND l.artifact_id=target FOR UPDATE;
   IF NOT FOUND OR header.write_id IS DISTINCT FROM(p_target->>'writeId')::uuid
    OR header.generation IS DISTINCT FROM(p_target->>'generation')::bigint OR header.state<>'blocked'
    OR header.write_state<>'settled' OR header.restore_reapply_pending OR header.object_key<>key OR header.artifact_sha256<>hash
    OR(header.execution_kind='agent_run' AND NOT EXISTS(SELECT 1 FROM ai.run_output_writes w WHERE w.organization_id=tenant
     AND w.artifact_id=target AND w.write_id=header.write_id AND w.generation=header.generation AND w.state='settled')) THEN
    RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;RETURN;END IF;
   token:=header.write_id;gen:=header.generation;
   UPDATE knowledge.artifact_lineage SET held=false WHERE organization_id=tenant AND artifact_id=target AND held;
   -- Do not manufacture a fence from an active/unknown writer. Only the already-settled exact writer
   -- reaches this metadata deletion. Source closure already blocked every body-serving context.
   PERFORM knowledge.erase_derived_artifact_metadata(target,token,gen);
  ELSE
   IF catalog.provenance_state<>'ordinary' OR EXISTS(SELECT 1 FROM knowledge.artifact_lineage l
    WHERE l.organization_id=tenant AND l.artifact_id=target) THEN
    RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;RETURN;END IF;
   IF catalog.alive THEN
    IF NOT knowledge.is_service_actor() OR lifecycle.erasure_open(tenant) IS DISTINCT FROM true THEN
     RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;RETURN;END IF;
    DELETE FROM work.artifacts a WHERE a.organization_id=tenant AND a.id=target;
    IF NOT FOUND THEN RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;RETURN;END IF;
   END IF;
   token:=target;gen:=1;
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM lifecycle.object_restore_debts d WHERE d.organization_id=tenant AND d.object_key=key) THEN
  RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;RETURN;END IF;
 SELECT * INTO previous FROM lifecycle.object_deletion_claims c WHERE c.organization_id=tenant AND c.object_key=key AND c.state<>'proven' FOR UPDATE;
 IF FOUND THEN
  IF previous.kind=kind_name AND previous.artifact_id=target AND previous.import_id IS NOT DISTINCT FROM import_key
   AND previous.writer_token=token AND previous.generation=gen AND previous.sha256=hash AND previous.state='deleted' THEN
   RETURN QUERY SELECT 'deleted'::text,previous.id,previous.object_key;
  ELSE RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text; END IF;
  RETURN;
 END IF;
 INSERT INTO lifecycle.object_deletion_claims(organization_id,kind,artifact_id,import_id,writer_token,generation,object_key,sha256,state)
  VALUES(tenant,kind_name,target,import_key,token,gen,key,hash,'admitted') RETURNING id INTO claim_id;
 RETURN QUERY SELECT 'admitted'::text,claim_id,key;
END $$;
REVOKE ALL ON FUNCTION lifecycle.begin_object_deletion(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.begin_object_deletion(jsonb) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION lifecycle.object_delete_terminal(p_claim uuid,p_outcome text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claim lifecycle.object_deletion_claims%ROWTYPE;
BEGIN
 PERFORM lifecycle.lock_delete_tenant();
 SELECT * INTO claim FROM lifecycle.object_deletion_claims c WHERE c.organization_id=app.current_organization_id() AND c.id=p_claim FOR UPDATE;
 IF NOT FOUND OR(claim.kind<>'ordinary' AND NOT knowledge.is_service_actor())
  OR(claim.kind='ordinary' AND coalesce(app.current_actor_type(),'') NOT IN('user','service')) THEN
  RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN('unknown','deleted') THEN RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 UPDATE lifecycle.object_deletion_claims c SET state=p_outcome,terminal_at=CASE WHEN p_outcome='deleted' THEN clock_timestamp() ELSE NULL END
  WHERE c.organization_id=app.current_organization_id() AND c.id=p_claim AND c.state='admitted';
 IF NOT FOUND THEN RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
END $$;
REVOKE ALL ON FUNCTION lifecycle.object_delete_terminal(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.object_delete_terminal(uuid,text) TO ensemus_app;
CREATE FUNCTION lifecycle.object_delete_absent(p_claim uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claim lifecycle.object_deletion_claims%ROWTYPE;
BEGIN
 PERFORM lifecycle.lock_delete_tenant();
 SELECT * INTO claim FROM lifecycle.object_deletion_claims c WHERE c.organization_id=app.current_organization_id() AND c.id=p_claim FOR UPDATE;
 IF NOT FOUND OR(claim.kind<>'ordinary' AND NOT knowledge.is_service_actor())
  OR(claim.kind='ordinary' AND coalesce(app.current_actor_type(),'') NOT IN('user','service'))
  OR claim.state<>'deleted' OR claim.terminal_at IS NULL OR EXISTS(SELECT 1 FROM lifecycle.legal_holds h
  WHERE h.organization_id=claim.organization_id AND h.status='active') THEN RETURN false;END IF;
 -- The caller just obtained an independent, definitive absence result. No UNKNOWN claim reaches here.
 UPDATE lifecycle.object_deletion_claims SET state='proven',absent_at=clock_timestamp() WHERE organization_id=claim.organization_id AND id=p_claim;
 IF claim.kind<>'archive' THEN
  UPDATE platform.blob_lifecycle b SET state='purged',purged_at=clock_timestamp() WHERE b.organization_id=claim.organization_id
   AND b.artifact_id=claim.artifact_id AND b.object_key=claim.object_key AND b.state='deleting';
  IF NOT FOUND THEN RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  IF claim.kind='derived' THEN
   UPDATE knowledge.artifact_lineage l SET physical_purged_at=coalesce(l.physical_purged_at,clock_timestamp()),
    held=false,restore_reapply_pending=false WHERE l.organization_id=claim.organization_id AND l.artifact_id=claim.artifact_id
    AND l.write_id=claim.writer_token AND l.generation=claim.generation AND l.object_key=claim.object_key
    AND l.artifact_sha256=claim.sha256 AND l.write_state='settled' AND l.state='blocked';
   IF NOT FOUND THEN RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  END IF;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION lifecycle.object_delete_absent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.object_delete_absent(uuid) TO ensemus_app;
CREATE FUNCTION lifecycle.artifact_delete_target(p_artifact uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE header knowledge.artifact_lineage%ROWTYPE;
BEGIN
 PERFORM lifecycle.lock_delete_tenant();
 IF coalesce(app.current_actor_type(),'') NOT IN('user','service') OR NOT EXISTS(SELECT 1 FROM platform.tombstones t
  WHERE t.organization_id=app.current_organization_id() AND t.target_type='artifact' AND t.target_id=p_artifact) THEN RETURN NULL;END IF;
 SELECT * INTO header FROM knowledge.artifact_lineage l WHERE l.organization_id=app.current_organization_id() AND l.artifact_id=p_artifact FOR UPDATE NOWAIT;
 IF FOUND THEN
  IF NOT knowledge.is_service_actor() THEN RETURN NULL;END IF;
  IF header.state<>'blocked' THEN UPDATE knowledge.artifact_lineage SET state='blocked'
   WHERE organization_id=header.organization_id AND artifact_id=p_artifact;END IF;
  RETURN jsonb_build_object('kind','derived','artifactId',p_artifact,'writeId',header.write_id,'generation',header.generation);
 END IF;
 RETURN jsonb_build_object('kind','ordinary','artifactId',p_artifact);
END $$;
REVOKE ALL ON FUNCTION lifecycle.artifact_delete_target(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.artifact_delete_target(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION lifecycle.object_deletion_proven(p_kind text,p_artifact uuid,p_import uuid,p_token uuid,p_generation bigint,p_key text,p_hash text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=app.current_organization_id()
  AND c.kind=p_kind AND c.artifact_id=p_artifact AND c.import_id IS NOT DISTINCT FROM p_import
  AND c.writer_token=p_token AND c.generation=p_generation AND c.object_key=p_key AND c.sha256=p_hash
  AND c.state='proven' AND c.terminal_at IS NOT NULL AND c.absent_at>=c.terminal_at)
  AND NOT EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=app.current_organization_id()
   AND c.object_key=p_key AND c.state<>'proven')
  AND NOT EXISTS(SELECT 1 FROM lifecycle.object_restore_debts d WHERE d.organization_id=app.current_organization_id() AND d.object_key=p_key)
$$;
REVOKE ALL ON FUNCTION lifecycle.object_deletion_proven(text,uuid,uuid,uuid,bigint,text,text) FROM PUBLIC;
-- Existing proof queries may invoke this fixed exact-metadata predicate, but never read claims.
GRANT EXECUTE ON FUNCTION lifecycle.object_deletion_proven(text,uuid,uuid,uuid,bigint,text,text) TO ensemus_app,ensemus_eraser;
CREATE OR REPLACE FUNCTION sovereign.archive_file_has_physical_proof(p_file sovereign.imported_archive_files) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT coalesce((p_file).state='purged' AND NOT(p_file).held AND(p_file).closed_at IS NOT NULL
  AND(p_file).physical_purged_at IS NOT NULL AND(p_file).physical_purged_at>=(p_file).closed_at
  AND(p_file).write_state='settled' AND(p_file).write_finished_at IS NOT NULL
  AND(p_file).write_finished_at<=(p_file).physical_purged_at
  AND lifecycle.object_deletion_proven('archive',(p_file).source_artifact_id,(p_file).import_id,
   (p_file).write_token,1,(p_file).object_key,(p_file).binary_sha256),false)
$$;
-- The old runtime booleans cannot manufacture a writer fence or physical completion. This row
-- trigger is independent of the adapter and of the existing source-purge/archive SQL backstops.
CREATE FUNCTION lifecycle.require_object_delete_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID='sovereign.imported_archive_files'::regclass AND TG_OP='UPDATE' THEN
  IF NEW.state='purged' AND NOT lifecycle.object_deletion_proven('archive',NEW.source_artifact_id,NEW.import_id,
   NEW.write_token,1,NEW.object_key,NEW.binary_sha256) THEN
   RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 ELSIF TG_RELID='knowledge.artifact_lineage'::regclass AND TG_OP='UPDATE' THEN
  IF NEW.physical_purged_at IS NOT NULL AND NOT lifecycle.object_deletion_proven('derived',NEW.artifact_id,NULL,
   NEW.write_id,NEW.generation,NEW.object_key,NEW.artifact_sha256) THEN
   RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 ELSE RAISE EXCEPTION 'INVALID_DELETE_PROOF_TARGET' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.require_object_delete_receipt() FROM PUBLIC;
CREATE TRIGGER archive_0508_physical_receipt BEFORE UPDATE ON sovereign.imported_archive_files FOR EACH ROW EXECUTE FUNCTION lifecycle.require_object_delete_receipt();
CREATE TRIGGER lineage_0508_physical_receipt BEFORE UPDATE ON knowledge.artifact_lineage FOR EACH ROW EXECUTE FUNCTION lifecycle.require_object_delete_receipt();
--> statement-breakpoint
CREATE FUNCTION lifecycle.object_delete_counts() RETURNS TABLE(checked integer,unconfirmed integer,proven integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE legacy integer;
BEGIN
 IF session_user NOT IN('ensemus_app','ensemus_eraser') OR app.current_organization_id() IS NULL
  OR(session_user='ensemus_app' AND NOT knowledge.is_service_actor()) THEN
  RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT count(*)::integer INTO legacy FROM knowledge.artifact_lineage l WHERE l.organization_id=app.current_organization_id()
  AND l.physical_purged_at IS NOT NULL AND NOT lifecycle.object_deletion_proven('derived',l.artifact_id,NULL,l.write_id,l.generation,l.object_key,l.artifact_sha256);
 RETURN QUERY SELECT (count(*)+legacy+(SELECT count(*) FROM lifecycle.object_restore_debts d WHERE d.organization_id=app.current_organization_id()))::integer,
  (count(*)FILTER(WHERE c.state<>'proven')+legacy+(SELECT count(*) FROM lifecycle.object_restore_debts d WHERE d.organization_id=app.current_organization_id()))::integer,
  count(*)FILTER(WHERE c.state='proven')::integer FROM lifecycle.object_deletion_claims c WHERE c.organization_id=app.current_organization_id();
END $$;
REVOKE ALL ON FUNCTION lifecycle.object_delete_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.object_delete_counts() TO ensemus_app,ensemus_eraser;
CREATE FUNCTION lifecycle.source_purge_delete_proof() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'knowledge.purge_jobs'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'INVALID_DELETE_PROOF_TARGET' USING ERRCODE='42501';END IF;
 IF NEW.state='completed' AND EXISTS(SELECT 1 FROM lifecycle.object_delete_counts() p WHERE p.unconfirmed>0) THEN
  RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.source_purge_delete_proof() FROM PUBLIC;
CREATE TRIGGER purge_jobs_0508_delete_proof BEFORE INSERT OR UPDATE ON knowledge.purge_jobs
 FOR EACH ROW EXECUTE FUNCTION lifecycle.source_purge_delete_proof();
--> statement-breakpoint
-- Explicit metadata only. A role name alone never permits retained lineage/history deletion.
GRANT SELECT(organization_id) ON ai.unproven_child_work_inputs TO ensemus_migrator;
CREATE POLICY deletion_legacy_child_metadata ON ai.unproven_child_work_inputs FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id());
GRANT SELECT(organization_id,run_id,history_complete,fenced_at,fence_generation,payloads_purged_at,purged_fence_generation)
 ON ai.run_input_checkpoints TO ensemus_migrator;
CREATE POLICY deletion_run_checkpoint_metadata ON ai.run_input_checkpoints FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id());
CREATE FUNCTION lifecycle.tenant_object_proofs_complete() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app.current_organization_id() IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM lifecycle.object_restore_debts d WHERE d.organization_id=app.current_organization_id())
  AND NOT EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=app.current_organization_id() AND c.state<>'proven')
  AND NOT EXISTS(SELECT 1 FROM platform.blob_lifecycle b WHERE b.organization_id=app.current_organization_id() AND(b.state<>'purged' OR b.purged_at IS NULL))
  AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=app.current_organization_id() AND(a.alive
   OR NOT EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=a.organization_id
    AND c.artifact_id=a.artifact_id AND c.kind IN('derived','ordinary') AND c.sha256=a.sha256
    AND c.object_key=a.organization_id::text||'/artifacts/'||a.artifact_id::text AND c.state='proven' AND c.absent_at>=c.terminal_at)))
  AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_lineage l WHERE l.organization_id=app.current_organization_id()
   AND(l.physical_purged_at IS NULL OR l.write_state<>'settled' OR l.state<>'blocked' OR l.held OR l.restore_reapply_pending
    OR NOT lifecycle.object_deletion_proven('derived',l.artifact_id,NULL,l.write_id,l.generation,l.object_key,l.artifact_sha256)))
  AND NOT EXISTS(SELECT 1 FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id()
   AND NOT sovereign.archive_file_has_physical_proof(f))
  -- No archive receipt substitutes for legacy child Work/title or private transcript authority.
  AND NOT EXISTS(SELECT 1 FROM ai.unproven_child_work_inputs c WHERE c.organization_id=app.current_organization_id())
  AND NOT EXISTS(SELECT 1 FROM ai.run_input_checkpoints c WHERE c.organization_id=app.current_organization_id()
   AND(NOT c.history_complete OR c.fenced_at IS NULL OR c.payloads_purged_at IS NULL OR c.purged_fence_generation IS DISTINCT FROM c.fence_generation))
  AND NOT EXISTS(SELECT 1 FROM sovereign.organization_exports e WHERE e.organization_id=app.current_organization_id())
  AND NOT EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=app.current_organization_id())
$$;

REVOKE ALL ON FUNCTION lifecycle.tenant_object_proofs_complete() FROM PUBLIC;
CREATE FUNCTION lifecycle.erasure_physical_ready() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT lifecycle.erasure_open(app.current_organization_id()) IS TRUE AND lifecycle.tenant_object_proofs_complete()
 AND EXISTS(SELECT 1 FROM lifecycle.offboarding_admissions a JOIN lifecycle.offboardings o
  ON o.organization_id=a.organization_id AND o.id=a.offboarding_id
  WHERE a.organization_id=app.current_organization_id() AND o.state='erasing' AND o.requested_by_membership_id=a.requested_by_membership_id)
$$;
REVOKE ALL ON FUNCTION lifecycle.erasure_physical_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.erasure_physical_ready() TO ensemus_app,ensemus_eraser;
CREATE FUNCTION lifecycle.lock_erasure_tenant() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user<>'ensemus_eraser' OR app.current_organization_id() IS NULL THEN RETURN false;END IF;
 PERFORM g.id FROM org.organizations g WHERE g.id=app.current_organization_id() FOR NO KEY UPDATE NOWAIT;
 RETURN FOUND AND lifecycle.erasure_physical_ready();
END $$;
REVOKE ALL ON FUNCTION lifecycle.lock_erasure_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.lock_erasure_tenant() TO ensemus_eraser;

--> statement-breakpoint
-- This is a fixed reviewed list of existing append-only content tables, not a future-schema grant.
-- Every independent row guard (0208, 0214, 0414, 0415, 0417 etc.) still applies after this statement gate.
CREATE OR REPLACE FUNCTION app.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='ensemus_eraser' AND TG_OP='DELETE' AND TG_RELID IN(
  'ai.agent_runs'::regclass,
  'ai.agent_versions'::regclass,
  'ai.main_input_snapshots'::regclass,
  'ai.model_call_attempts'::regclass,
  'ai.model_call_inputs'::regclass,
  'ai.model_evaluations'::regclass,
  'ai.model_jobs'::regclass,
  'ai.model_operation_qualifications'::regclass,
  'ai.model_proposal_inputs'::regclass,
  'ai.model_workload_approvals'::regclass,
  'ai.model_workload_profiles'::regclass,
  'ai.rate_cards'::regclass,
  'ai.run_controls'::regclass,
  'ai.run_input_checkpoints'::regclass,
  'ai.run_input_observations'::regclass,
  'ai.run_output_writes'::regclass,
  'experience.onboarding_completions'::regclass,
  'experience.outcome_work_births'::regclass,
  'integrations.external_action_attempts'::regclass,
  'integrations.external_action_receipts'::regclass,
  'integrations.external_actions'::regclass,
  'knowledge.artifact_citations'::regclass,
  'knowledge.artifact_lineage'::regclass,
  'knowledge.artifact_lineage_inputs'::regclass,
  'knowledge.artifact_lineage_packages'::regclass,
  'knowledge.artifact_lineage_records'::regclass,
  'knowledge.artifact_lineage_sources'::regclass,
  'knowledge.artifact_verifications'::regclass,
  'knowledge.evidence_items'::regclass,
  'knowledge.evidence_package_facts'::regclass,
  'knowledge.evidence_packages'::regclass,
  'knowledge.model_calls'::regclass,
  'knowledge.sources'::regclass,
  'objects.type_versions'::regclass,
  'packs.installations'::regclass,
  'sovereign.imported_archive_files'::regclass,
  'sovereign.imported_definitions'::regclass,
  'sovereign.imported_records'::regclass,
  'sovereign.license_records'::regclass,
  'sovereign.organization_export_parts'::regclass,
  'sovereign.organization_import_manifests'::regclass,
  'sovereign.organization_import_parts'::regclass,
  'sovereign.signed_documents'::regclass,
  'studio.process_runs'::regclass,
  'studio.process_specs'::regclass,
  'studio.publish_reviews'::regclass,
  'studio.simulation_inputs'::regclass,
  'studio.simulation_runs'::regclass,
  'support.ticket_messages'::regclass,
  'work.approval_decisions'::regclass,
  'work.work_transitions'::regclass)
  AND lifecycle.erasure_physical_ready() IS TRUE THEN
  IF TG_LEVEL='ROW' THEN RETURN OLD;END IF;RETURN NULL;
 END IF;
 RAISE EXCEPTION 'APPEND_ONLY_CHANGE_REFUSED' USING ERRCODE='42501';
END $$;

--> statement-breakpoint
CREATE FUNCTION lifecycle.admitted_offboarding(p_intent uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM lifecycle.offboardings o JOIN lifecycle.offboarding_admissions a
  ON a.organization_id=o.organization_id AND a.offboarding_id=o.id
  WHERE o.organization_id=app.current_organization_id() AND o.id=p_intent
  AND o.requested_by_membership_id=a.requested_by_membership_id
  AND o.state IN('ready_for_erasure','erasing','verified','reported'))
$$;
REVOKE ALL ON FUNCTION lifecycle.admitted_offboarding(uuid) FROM PUBLIC;
GRANT SELECT(organization_id,aggregate_id,aggregate_type,event_type) ON platform.domain_events TO ensemus_migrator;
CREATE POLICY erasure_event_metadata ON platform.domain_events FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id());
CREATE FUNCTION lifecycle.prepare_erasure_artifacts(p_intent uuid,p_limit integer)
 RETURNS TABLE(artifact_id uuid,classification text,added boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item record;inserted integer;
BEGIN
 PERFORM lifecycle.lock_delete_tenant();
 IF NOT knowledge.is_service_actor() OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  OR NOT lifecycle.admitted_offboarding(p_intent) OR NOT EXISTS(SELECT 1 FROM lifecycle.offboardings o
   WHERE o.organization_id=app.current_organization_id() AND o.id=p_intent AND o.state='erasing')
  OR lifecycle.erasure_open(app.current_organization_id()) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'ERASURE_METADATA_INTENT_REQUIRED' USING ERRCODE='EN850';END IF;
 FOR item IN SELECT a.artifact_id,a.classification FROM knowledge.artifact_acl_catalog a
  WHERE a.organization_id=app.current_organization_id() AND(
   NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=a.organization_id AND t.target_type='artifact' AND t.target_id=a.artifact_id)
   OR NOT EXISTS(SELECT 1 FROM platform.blob_lifecycle b WHERE b.organization_id=a.organization_id AND b.artifact_id=a.artifact_id)
   OR NOT EXISTS(SELECT 1 FROM platform.domain_events e WHERE e.organization_id=a.organization_id AND e.aggregate_type='artifact'
    AND e.aggregate_id=a.artifact_id AND e.event_type='tombstone.recorded')) ORDER BY a.artifact_id LIMIT p_limit LOOP
  INSERT INTO platform.tombstones(organization_id,target_type,target_id,reason_code)
   VALUES(app.current_organization_id(),'artifact',item.artifact_id,'TENANT_ERASURE') ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  INSERT INTO platform.blob_lifecycle(organization_id,artifact_id,object_key,state,purge_after)
   VALUES(app.current_organization_id(),item.artifact_id,app.current_organization_id()::text||'/artifacts/'||item.artifact_id::text,'deleting',clock_timestamp()) ON CONFLICT DO NOTHING;
  UPDATE knowledge.artifact_lineage l SET state='blocked' WHERE l.organization_id=app.current_organization_id()
   AND l.artifact_id=item.artifact_id AND l.state<>'blocked';
  RETURN QUERY SELECT item.artifact_id::uuid,item.classification::text,inserted>0;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION lifecycle.prepare_erasure_artifacts(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.prepare_erasure_artifacts(uuid,integer) TO ensemus_app;
-- Migration-only generator. Runtime has a fixed CASE and no dynamic SQL or caller identifier.
-- This reviewed inventory is closed: any later/unknown tenant table makes installation refuse.
CREATE FUNCTION lifecycle.install_erasure_count_projection() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $installer$
DECLARE t record;branches text:='';body text;ref text;
BEGIN
 IF current_user<>'ensemus_migrator' THEN RAISE EXCEPTION 'ERASURE_METADATA_INSTALLER_REQUIRED' USING ERRCODE='42501';END IF;
 FOR t IN SELECT n.nspname AS schema_name,c.relname AS table_name,c.oid,c.relrowsecurity,c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
  AND a.attname='organization_id' AND NOT a.attisdropped WHERE c.relkind IN('r','p') AND NOT c.relispartition
  AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
  AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text) ORDER BY n.nspname,c.relname LOOP
  ref:=t.schema_name||'.'||t.table_name;
  IF ref<>ALL(ARRAY[
   'ai.agent_definitions',
   'ai.agent_publications',
   'ai.agent_runs',
   'ai.agent_versions',
   'ai.artifact_evidence',
   'ai.execution_steps',
   'ai.main_input_snapshots',
   'ai.model_call_attempts',
   'ai.model_call_inputs',
   'ai.model_evaluations',
   'ai.model_job_payloads',
   'ai.model_jobs',
   'ai.model_operation_qualifications',
   'ai.model_profiles',
   'ai.model_proposal_inputs',
   'ai.model_workload_approvals',
   'ai.model_workload_profiles',
   'ai.rate_cards',
   'ai.run_controls',
   'ai.run_input_checkpoints',
   'ai.run_input_observations',
   'ai.run_output_writes',
   'ai.step_payloads',
   'ai.tool_proposals',
   'ai.unproven_child_work_inputs',
   'billing.billing_accounts',
   'billing.billing_periods',
   'billing.collection_cases',
   'billing.collection_policies',
   'billing.credit_accounts',
   'billing.credit_ledger',
   'billing.invoice_lines',
   'billing.invoices',
   'billing.operator_actions',
   'billing.payment_attempts',
   'billing.payment_events',
   'billing.payment_webhook_events',
   'billing.payments',
   'billing.plan_versions',
   'billing.plans',
   'billing.provider_bills',
   'billing.rate_card_lines',
   'billing.rate_cards',
   'billing.standing_changes',
   'billing.subscription_changes',
   'billing.subscriptions',
   'billing.tax_treatments',
   'billing.top_up_offers',
   'billing.top_ups',
   'experience.onboarding_completions',
   'experience.onboarding_steps',
   'experience.outcome_drafts',
   'experience.outcome_work_births',
   'experience.pulse_signal_states',
   'governance.audit_events',
   'governance.egress_decisions',
   'governance.kill_switches',
   'governance.policy_bundles',
   'identity.accounts',
   'identity.rate_limits',
   'identity.session_assurances',
   'identity.sessions',
   'identity.setup_tokens',
   'identity.sso_providers',
   'identity.two_factors',
   'identity.users',
   'identity.verifications',
   'integrations.connections',
   'integrations.external_action_attempts',
   'integrations.external_action_receipts',
   'integrations.external_actions',
   'integrations.external_resource_acl',
   'integrations.external_resources',
   'integrations.mcp_tools',
   'integrations.sync_cursors',
   'integrations.webhook_deliveries',
   'integrations.webhook_endpoints',
   'knowledge.answer_citations',
   'knowledge.answer_sources',
   'knowledge.answers',
   'knowledge.artifact_acl_catalog',
   'knowledge.artifact_citations',
   'knowledge.artifact_lineage',
   'knowledge.artifact_lineage_inputs',
   'knowledge.artifact_lineage_packages',
   'knowledge.artifact_lineage_records',
   'knowledge.artifact_lineage_sources',
   'knowledge.artifact_verifications',
   'knowledge.artifact_work_links',
   'knowledge.chunks',
   'knowledge.document_staging',
   'knowledge.documents',
   'knowledge.edges',
   'knowledge.embedding_spaces',
   'knowledge.embeddings',
   'knowledge.evidence_items',
   'knowledge.evidence_package_facts',
   'knowledge.evidence_packages',
   'knowledge.fact_evidence',
   'knowledge.facts',
   'knowledge.model_calls',
   'knowledge.object_writers',
   'knowledge.purge_jobs',
   'knowledge.source_grants',
   'knowledge.sources',
   'knowledge.structured_record_catalog',
   'knowledge.structured_work_assignments',
   'lifecycle.erasure_log',
   'lifecycle.legal_hold_scopes',
   'lifecycle.legal_holds',
   'lifecycle.object_deletion_claims',
   'lifecycle.offboarding_admissions',
   'lifecycle.offboardings',
   'lifecycle.retention_cursors',
   'lifecycle.retention_rules',
   'lifecycle.retention_runs',
   'objects.migration_results',
   'objects.migrations',
   'objects.record_values',
   'objects.records',
   'objects.relation_slots',
   'objects.relations',
   'objects.type_acl_catalog',
   'objects.type_versions',
   'objects.types',
   'operations.drills',
   'operations.incident_updates',
   'operations.incidents',
   'operations.vulnerability_reports',
   'org.invitations',
   'org.memberships',
   'org.organizations',
   'org.scim_tokens',
   'org.security_policies',
   'org.service_identities',
   'org.sso_connections',
   'org.sso_member_links',
   'org.team_memberships',
   'org.teams',
   'packs.capability_reviews',
   'packs.installations',
   'packs.installed_items',
   'platform.blob_lifecycle',
   'platform.budget_reservations',
   'platform.budgets',
   'platform.domain_events',
   'platform.entitlements',
   'platform.idempotency_keys',
   'platform.inbox_events',
   'platform.notifications',
   'platform.outbox_events',
   'platform.tombstones',
   'platform.usage_ledger',
   'secrets.sealed_secrets',
   'sovereign.export_epochs',
   'sovereign.imported_archive_files',
   'sovereign.imported_definitions',
   'sovereign.imported_people',
   'sovereign.imported_records',
   'sovereign.license_records',
   'sovereign.organization_export_parts',
   'sovereign.organization_exports',
   'sovereign.organization_import_effects',
   'sovereign.organization_import_manifests',
   'sovereign.organization_import_parts',
   'sovereign.organization_imports',
   'sovereign.signed_documents',
   'studio.agent_drafts',
   'studio.process_drafts',
   'studio.process_run_steps',
   'studio.process_runs',
   'studio.process_specs',
   'studio.publish_reviews',
   'studio.simulation_inputs',
   'studio.simulation_runs',
   'support.break_glass_log',
   'support.break_glass_requests',
   'support.coverage_schedules',
   'support.ticket_messages',
   'support.tickets',
   'work.agent_assignments',
   'work.approval_decisions',
   'work.approvals',
   'work.artifacts',
   'work.client_onboardings',
   'work.client_readers',
   'work.clients',
   'work.projects',
   'work.work_artifacts',
   'work.work_assignments',
   'work.work_dependencies',
   'work.work_transitions',
   'work.work_units'
  ]) OR NOT t.relrowsecurity OR NOT t.relforcerowsecurity
   OR NOT has_table_privilege('ensemus_eraser',t.oid,'DELETE') THEN
   RAISE EXCEPTION 'ERASURE_METADATA_INVENTORY_UNREVIEWED' USING ERRCODE='EN850';END IF;
  EXECUTE format('GRANT SELECT(organization_id) ON %I.%I TO ensemus_migrator',t.schema_name,t.table_name);
  IF NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=t.oid AND p.polname='erasure_count_metadata') THEN
   EXECUTE format('CREATE POLICY erasure_count_metadata ON %I.%I FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id() AND organization_id::text=current_setting(''lifecycle.erasure_count_org'',true))',t.schema_name,t.table_name);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=t.oid AND g.tgname='lifecycle_erasure_birth_fence' AND NOT g.tgisinternal) THEN
   EXECUTE format('CREATE TRIGGER lifecycle_erasure_birth_fence BEFORE INSERT ON %I.%I FOR EACH ROW EXECUTE FUNCTION lifecycle.refuse_erasing_birth()',t.schema_name,t.table_name);
  END IF;
  branches:=branches||format(' WHEN %L THEN SELECT count(*) INTO answer FROM %I.%I WHERE organization_id=tenant;',ref,t.schema_name,t.table_name);
 END LOOP;
 body:=$body$
 DECLARE tenant uuid:=app.current_organization_id();previous_scope text;answer bigint;
 BEGIN
  IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL
   OR NOT lifecycle.admitted_offboarding(p_intent) THEN RAISE EXCEPTION 'ERASURE_METADATA_INTENT_REQUIRED' USING ERRCODE='EN850';END IF;
  previous_scope:=current_setting('lifecycle.erasure_count_org',true);
  PERFORM set_config('lifecycle.erasure_count_org',tenant::text,true);
  BEGIN
   CASE p_table $body$||branches||$body$
    ELSE RAISE EXCEPTION 'ERASURE_METADATA_INVENTORY_UNREVIEWED' USING ERRCODE='EN850';END CASE;
  EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.erasure_count_org',coalesce(previous_scope,''),true);RAISE;END;
  PERFORM set_config('lifecycle.erasure_count_org',coalesce(previous_scope,''),true);
  IF answer<0 OR answer>9007199254740991 THEN RAISE EXCEPTION 'ERASURE_COUNT_INVALID' USING ERRCODE='EN850';END IF;
  RETURN answer;
 END $body$;
 EXECUTE 'CREATE OR REPLACE FUNCTION lifecycle.erasure_table_rows(p_table text,p_intent uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS '||quote_literal(body);
 REVOKE ALL ON FUNCTION lifecycle.erasure_table_rows(text,uuid) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION lifecycle.erasure_table_rows(text,uuid) TO ensemus_app;
END $installer$;
REVOKE ALL ON FUNCTION lifecycle.install_erasure_count_projection() FROM PUBLIC;

--> statement-breakpoint
-- Exact offboarding-owned stop. It never releases a budget/operator/customer switch.
CREATE TABLE lifecycle.offboarding_agent_stops(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),offboarding_id uuid NOT NULL,
 switch_id uuid NOT NULL REFERENCES governance.kill_switches(id),PRIMARY KEY(organization_id,offboarding_id),
 CONSTRAINT offboarding_agent_stop_intent FOREIGN KEY(organization_id,offboarding_id) REFERENCES lifecycle.offboardings(organization_id,id)
);
ALTER TABLE lifecycle.offboarding_agent_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.offboarding_agent_stops FORCE ROW LEVEL SECURITY;
CREATE POLICY offboarding_stop_fixed_owner ON lifecycle.offboarding_agent_stops TO ensemus_migrator
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
REVOKE ALL ON lifecycle.offboarding_agent_stops FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser;
CREATE POLICY offboarding_stop_kill_owner ON governance.kill_switches TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND scope='organization' AND reason_code='TENANT_OFFBOARDING')
 WITH CHECK(organization_id=app.current_organization_id() AND scope='organization' AND reason_code='TENANT_OFFBOARDING');
CREATE FUNCTION lifecycle.offboarding_agent_stop(p_intent uuid,p_release boolean)
 RETURNS TABLE(switch_id uuid,changed boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE intent record;stop uuid;made boolean:=false;
BEGIN
 PERFORM lifecycle.lock_delete_tenant();
 IF coalesce(app.current_actor_type(),'') NOT IN('user','service') THEN RAISE EXCEPTION 'OFFBOARDING_NATIVE_ADMISSION_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT o.organization_id,o.id,o.state,o.requested_by_membership_id INTO intent FROM lifecycle.offboardings o WHERE o.organization_id=app.current_organization_id() AND o.id=p_intent FOR UPDATE NOWAIT;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM lifecycle.offboarding_admissions a WHERE a.organization_id=intent.organization_id
  AND a.offboarding_id=intent.id AND a.requested_by_membership_id=intent.requested_by_membership_id)
  OR(p_release IS DISTINCT FROM false AND p_release IS DISTINCT FROM true) THEN
  RAISE EXCEPTION 'OFFBOARDING_NATIVE_ADMISSION_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT s.switch_id INTO stop FROM lifecycle.offboarding_agent_stops s WHERE s.organization_id=intent.organization_id AND s.offboarding_id=intent.id;
 IF p_release THEN
  IF intent.state NOT IN('cancelled','reported') THEN RAISE EXCEPTION 'OFFBOARDING_STOP_NOT_RELEASEABLE' USING ERRCODE='EN850';END IF;
  IF stop IS NOT NULL THEN
   UPDATE governance.kill_switches k SET released_at=clock_timestamp() WHERE k.id=stop AND k.organization_id=intent.organization_id
    AND k.scope='organization' AND k.reason_code='TENANT_OFFBOARDING' AND k.released_at IS NULL;
   made:=FOUND;
  END IF;
 ELSE
  IF intent.state IN('cancelled','reported') THEN RAISE EXCEPTION 'OFFBOARDING_STOP_NOT_ALLOWED' USING ERRCODE='EN850';END IF;
  IF stop IS NULL THEN
   INSERT INTO governance.kill_switches(organization_id,scope,reason_code)
    VALUES(intent.organization_id,'organization','TENANT_OFFBOARDING') RETURNING id INTO stop;
   INSERT INTO lifecycle.offboarding_agent_stops(organization_id,offboarding_id,switch_id) VALUES(intent.organization_id,intent.id,stop);made:=true;
  END IF;
 END IF;
 RETURN QUERY SELECT stop,made;
END $$;
REVOKE ALL ON FUNCTION lifecycle.offboarding_agent_stop(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.offboarding_agent_stop(uuid,boolean) TO ensemus_app;
CREATE FUNCTION lifecycle.protect_offboarding_stop() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'governance.kill_switches'::regclass OR TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'INVALID_STOP_TARGET' USING ERRCODE='42501';END IF;
 IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL AND EXISTS(SELECT 1 FROM lifecycle.offboarding_agent_stops s
  JOIN lifecycle.offboardings o ON o.organization_id=s.organization_id AND o.id=s.offboarding_id
  WHERE s.organization_id=OLD.organization_id AND s.switch_id=OLD.id AND o.state NOT IN('cancelled','reported')) THEN
  RAISE EXCEPTION 'OFFBOARDING_STOP_NOT_RELEASEABLE' USING ERRCODE='EN850';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.protect_offboarding_stop() FROM PUBLIC;
CREATE TRIGGER kill_switch_offboarding_release BEFORE UPDATE ON governance.kill_switches FOR EACH ROW EXECUTE FUNCTION lifecycle.protect_offboarding_stop();

--> statement-breakpoint
GRANT SELECT(organization_id) ON sovereign.organization_exports TO ensemus_migrator;
CREATE POLICY erasure_export_writer_debt ON sovereign.organization_exports FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id());
-- Existing export headers lack the actual new transport/writer certificate. They deliberately block
-- positive tenant erasure, even if an old purge timestamp exists, until the M6 export lifecycle joins.
CREATE FUNCTION lifecycle.erasure_object_intent(p_intent uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT session_user='ensemus_app' AND knowledge.is_service_actor() AND lifecycle.admitted_offboarding(p_intent)
 AND EXISTS(SELECT 1 FROM lifecycle.offboardings o WHERE o.organization_id=app.current_organization_id() AND o.id=p_intent AND o.state IN('erasing','reported'))
$$;
REVOKE ALL ON FUNCTION lifecycle.erasure_object_intent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.erasure_object_intent(uuid) TO ensemus_app;
CREATE FUNCTION lifecycle.erasure_object_proofs(p_intent uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT lifecycle.erasure_object_intent(p_intent) AND lifecycle.tenant_object_proofs_complete()
$$;
REVOKE ALL ON FUNCTION lifecycle.erasure_object_proofs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.erasure_object_proofs(uuid) TO ensemus_app;

--> statement-breakpoint
CREATE FUNCTION lifecycle.offboarding_latest_export() RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE found_id uuid;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR NOT EXISTS(SELECT 1 FROM lifecycle.offboardings o
  JOIN lifecycle.offboarding_admissions a ON a.organization_id=o.organization_id AND a.offboarding_id=o.id
  WHERE o.organization_id=app.current_organization_id() AND o.state IN('requested','export_offered','in_transition','winding_down','ready_for_erasure')) THEN
  RAISE EXCEPTION 'OFFBOARDING_NATIVE_ADMISSION_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT e.id INTO found_id FROM sovereign.organization_exports e WHERE e.organization_id=app.current_organization_id()
  AND e.status='ready' AND e.finished_at IS NOT NULL AND e.purged_at IS NULL ORDER BY e.finished_at DESC,e.id DESC LIMIT 1;
 RETURN found_id;
END $$;
REVOKE ALL ON FUNCTION lifecycle.offboarding_latest_export() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.offboarding_latest_export() TO ensemus_app;
-- Raw Knowledge/source and prior M6 export inventories deliberately prevent positive whole-tenant
-- completion until their exact hold/transport/writer lifecycle ports are implemented. Never interpret
-- missing qualification as empty data. Their ordinary source guards and0414/0417 remain independent.

--> statement-breakpoint
-- Births serialize with the restricted eraser's tenant barrier. After a zero count, a late worker
-- cannot silently recreate a private row. UPDATE cannot recreate a row already removed; each
-- byte-producing path separately requires its retained before-put writer/intent admission.
CREATE FUNCTION lifecycle.refuse_erasing_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid;life text;
BEGIN
 IF TG_OP<>'INSERT' OR TG_TABLE_SCHEMA NOT IN('ai','org','work','knowledge','integrations','secrets','studio','objects','packs','experience','sovereign','support','platform')
  OR TG_RELID IS DISTINCT FROM to_regclass(quote_ident(TG_TABLE_SCHEMA)||'.'||quote_ident(TG_TABLE_NAME)) THEN
  RAISE EXCEPTION 'INVALID_ERASURE_BIRTH_TARGET' USING ERRCODE='42501';END IF;
 tenant:=NEW.organization_id;
 IF tenant IS NULL OR tenant IS DISTINCT FROM app.current_organization_id() THEN
  RAISE EXCEPTION 'INVALID_ERASURE_BIRTH_TENANT' USING ERRCODE='42501';END IF;
 SELECT g.lifecycle INTO life FROM org.organizations g WHERE g.id=tenant FOR SHARE NOWAIT;
 IF NOT FOUND OR life='deleted' OR EXISTS(SELECT 1 FROM lifecycle.offboardings o WHERE o.organization_id=tenant AND o.state IN('erasing','verified','reported')) THEN
  RAISE EXCEPTION 'TENANT_ERASURE_IN_PROGRESS' USING ERRCODE='EN850';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.refuse_erasing_birth() FROM PUBLIC;
CREATE FUNCTION lifecycle.refuse_closed_upload_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE life text;
BEGIN
 IF TG_RELID<>'platform.blob_lifecycle'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
  RAISE EXCEPTION 'INVALID_UPLOAD_BIRTH_TARGET' USING ERRCODE='42501';END IF;
 IF NEW.state='uploading' THEN
  SELECT g.lifecycle INTO life FROM org.organizations g WHERE g.id=NEW.organization_id FOR SHARE NOWAIT;
  IF NOT FOUND OR life<>'active' THEN RAISE EXCEPTION 'TENANT_ERASURE_IN_PROGRESS' USING ERRCODE='EN850';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.refuse_closed_upload_birth() FROM PUBLIC;
CREATE TRIGGER blob_upload_0508_tenant_birth BEFORE INSERT ON platform.blob_lifecycle FOR EACH ROW EXECUTE FUNCTION lifecycle.refuse_closed_upload_birth();

--> statement-breakpoint
CREATE FUNCTION lifecycle.record_object_restore_debt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID='sovereign.imported_archive_files'::regclass AND TG_OP='UPDATE' THEN
  IF OLD.physical_purged_at IS NOT NULL AND NEW.physical_purged_at IS NULL THEN
   INSERT INTO lifecycle.object_restore_debts(organization_id,object_key,kind,artifact_id,import_id,writer_token)
    VALUES(NEW.organization_id,NEW.object_key,'archive',NEW.source_artifact_id,NEW.import_id,NEW.write_token) ON CONFLICT DO NOTHING;
  END IF;
 ELSIF TG_RELID='knowledge.artifact_lineage'::regclass AND TG_OP='UPDATE' THEN
  IF NEW.restore_reapply_pending AND NOT OLD.restore_reapply_pending THEN
   INSERT INTO lifecycle.object_restore_debts(organization_id,object_key,kind,artifact_id,writer_token)
    VALUES(NEW.organization_id,NEW.object_key,'derived',NEW.artifact_id,NEW.write_id) ON CONFLICT DO NOTHING;
  END IF;
 ELSE RAISE EXCEPTION 'INVALID_RESTORE_DEBT_TARGET' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.record_object_restore_debt() FROM PUBLIC;
CREATE TRIGGER archive_0508_restore_debt AFTER UPDATE ON sovereign.imported_archive_files FOR EACH ROW EXECUTE FUNCTION lifecycle.record_object_restore_debt();
CREATE TRIGGER lineage_0508_restore_debt AFTER UPDATE ON knowledge.artifact_lineage FOR EACH ROW EXECUTE FUNCTION lifecycle.record_object_restore_debt();
-- Actual provider/restore-writer quiescence certification is not implemented here. No DELETE grant,
-- elapsed-time reset, HEAD promotion or app-supplied success flag can remove this retained debt.

--> statement-breakpoint
-- Direct restricted-role DELETE must obey the same physical admission, even for tables whose
-- original append guard is a row trigger or TRUNCATE-only. No role-name-only escape remains.
CREATE FUNCTION lifecycle.require_erasure_object_receipts() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $
BEGIN
 IF TG_OP<>'DELETE' OR TG_RELID NOT IN('sovereign.imported_archive_files'::regclass,'knowledge.artifact_acl_catalog'::regclass,
  'knowledge.artifact_work_links'::regclass,'knowledge.artifact_lineage'::regclass,'knowledge.artifact_lineage_sources'::regclass,
  'knowledge.artifact_lineage_inputs'::regclass,'knowledge.artifact_lineage_packages'::regclass,'knowledge.artifact_lineage_records'::regclass,
  'platform.blob_lifecycle'::regclass,'work.artifacts'::regclass) THEN RAISE EXCEPTION 'INVALID_ERASURE_OBJECT_TARGET' USING ERRCODE='42501';END IF;
 IF current_user='ensemus_eraser' AND(OLD.organization_id IS DISTINCT FROM app.current_organization_id()
  OR lifecycle.erasure_physical_ready() IS DISTINCT FROM true) THEN RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION lifecycle.require_erasure_object_receipts() FROM PUBLIC;
CREATE TRIGGER archive_0508_erase_receipts BEFORE DELETE ON sovereign.imported_archive_files FOR EACH ROW EXECUTE FUNCTION lifecycle.require_erasure_object_receipts();
CREATE TRIGGER catalog_0508_erase_receipts BEFORE DELETE ON knowledge.artifact_acl_catalog FOR EACH ROW EXECUTE FUNCTION lifecycle.require_erasure_object_receipts();
CREATE TRIGGER links_0508_erase_receipts BEFORE DELETE ON knowledge.artifact_work_links FOR EACH ROW EXECUTE FUNCTION lifecycle.require_erasure_object_receipts();
CREATE TRIGGER lineage_0508_erase_receipts BEFORE DELETE ON knowledge.artifact_lineage FOR EACH ROW EXECUTE FUNCTION lifecycle.require_erasure_object_receipts();
CREATE TRIGGER sources_0508_erase_receipts BEFORE DELETE ON knowledge.artifact_lineage_sources FOR EACH ROW EXECUTE FUNCTION lifecycle.require_erasure_object_receipts();
CREATE TRIGGER inputs_0508_erase_receipts BEFORE DELETE ON knowledge.artifact_lineage_inputs FOR EACH ROW EXECUTE FUNCTION lifecycle.require_erasure_object_receipts();
CREATE TRIGGER packages_0508_erase_receipts BEFORE DELETE ON knowledge.artifact_lineage_packages FOR EACH ROW EXECUTE FUNCTION lifecycle.require_erasure_object_receipts();
CREATE TRIGGER records_0508_erase_receipts BEFORE DELETE ON knowledge.artifact_lineage_records FOR EACH ROW EXECUTE FUNCTION lifecycle.require_erasure_object_receipts();
CREATE TRIGGER blobs_0508_erase_receipts BEFORE DELETE ON platform.blob_lifecycle FOR EACH ROW EXECUTE FUNCTION lifecycle.require_erasure_object_receipts();
CREATE TRIGGER artifacts_0508_erase_receipts BEFORE DELETE ON work.artifacts FOR EACH ROW EXECUTE FUNCTION lifecycle.require_erasure_object_receipts();

--> statement-breakpoint
CREATE FUNCTION lifecycle.invalidate_source_delete_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior_scope text;
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID NOT IN('lifecycle.object_deletion_claims'::regclass,'lifecycle.object_restore_debts'::regclass)
  OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'INVALID_DELETE_DEBT_TARGET' USING ERRCODE='42501';END IF;
 prior_scope:=current_setting('sovereign.archive_source_proof',true);
 PERFORM set_config('sovereign.archive_source_proof','v1',true);
 BEGIN
  -- Final source confirmation already owns its source/job. Do not reverse that order by waiting.
  PERFORM j.id FROM knowledge.purge_jobs j WHERE j.organization_id=NEW.organization_id ORDER BY j.id FOR UPDATE NOWAIT;
  UPDATE knowledge.purge_jobs SET state='failed',completed_at=NULL,last_error_code='ARTIFACT_PURGE_UNCONFIRMED'
   WHERE organization_id=NEW.organization_id AND state='completed';
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('sovereign.archive_source_proof',coalesce(prior_scope,''),true);RAISE;END;
 PERFORM set_config('sovereign.archive_source_proof',coalesce(prior_scope,''),true);RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.invalidate_source_delete_completion() FROM PUBLIC;
CREATE TRIGGER object_claim_source_proof_lost AFTER INSERT ON lifecycle.object_deletion_claims FOR EACH ROW EXECUTE FUNCTION lifecycle.invalidate_source_delete_completion();
CREATE TRIGGER object_restore_source_proof_lost AFTER INSERT ON lifecycle.object_restore_debts FOR EACH ROW EXECUTE FUNCTION lifecycle.invalidate_source_delete_completion();

--> statement-breakpoint
CREATE FUNCTION lifecycle.guard_delete_claim_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'lifecycle.object_deletion_claims'::regclass OR TG_OP<>'UPDATE'
  OR ROW(NEW.organization_id,NEW.id,NEW.kind,NEW.artifact_id,NEW.import_id,NEW.writer_token,NEW.generation,NEW.object_key,NEW.sha256,NEW.admitted_at)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.kind,OLD.artifact_id,OLD.import_id,OLD.writer_token,OLD.generation,OLD.object_key,OLD.sha256,OLD.admitted_at)
  OR NOT((OLD.state='admitted' AND NEW.state IN('unknown','deleted')) OR(OLD.state='deleted' AND NEW.state='proven')) THEN
  RAISE EXCEPTION 'IMMUTABLE_OBJECT_DELETE_CLAIM' USING ERRCODE='EN850';END IF;
 IF OLD.state='admitted' THEN
  NEW.terminal_at:=CASE WHEN NEW.state='deleted' THEN clock_timestamp() ELSE NULL END;NEW.absent_at:=NULL;
 ELSE NEW.terminal_at:=OLD.terminal_at;NEW.absent_at:=clock_timestamp();END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.guard_delete_claim_change() FROM PUBLIC;
CREATE TRIGGER object_delete_claim_immutable BEFORE UPDATE ON lifecycle.object_deletion_claims FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_delete_claim_change();
CREATE TRIGGER object_delete_claim_keep BEFORE DELETE OR TRUNCATE ON lifecycle.object_deletion_claims FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER object_restore_debt_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.object_restore_debts FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER offboarding_admission_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.offboarding_admissions FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER offboarding_stop_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.offboarding_agent_stops FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
