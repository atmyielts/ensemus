-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Only a positively completed write from this restore generation may enter cleanup.
ALTER TABLE skills.bundle_uploads
  ADD COLUMN put_finished_at timestamptz,
  ADD COLUMN put_material_generation uuid,
  ADD COLUMN put_auth_generation uuid,
  ADD CONSTRAINT skill_upload_put_receipt CHECK (
    (put_finished_at IS NULL AND put_material_generation IS NULL AND put_auth_generation IS NULL)
    OR (put_finished_at IS NOT NULL AND put_material_generation IS NOT NULL AND put_auth_generation IS NOT NULL)
  );
GRANT UPDATE (put_finished_at) ON skills.bundle_uploads TO ensemus_app;
CREATE INDEX skill_upload_cleanup_ready ON skills.bundle_uploads(organization_id,put_finished_at,id)
  WHERE put_finished_at IS NOT NULL AND state IN ('writing','superseded');
CREATE POLICY skill_upload_cleanup_owner ON skills.bundle_uploads TO ensemus_migrator
  USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION skills.check_bundle_upload() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP='UPDATE' AND current_user='ensemus_migrator' AND session_user='ensemus_worker'
    AND app.current_actor_type()='service' AND OLD.organization_id=app.current_organization_id()
    AND OLD.state='writing' AND NEW.state='superseded' AND OLD.put_finished_at IS NOT NULL
    AND OLD.put_finished_at<=statement_timestamp()-interval '1 hour'
    AND (to_jsonb(NEW)-'state')=(to_jsonb(OLD)-'state') THEN
    RETURN NEW;
  END IF;
  IF session_user<>'ensemus_app' OR current_user<>session_user
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'SKILL_UPLOAD_MANAGER_REQUIRED' USING ERRCODE='42501';
  END IF;

  -- A request reports a completed PUT even when it no longer has permission to attach a version.
  IF TG_OP='UPDATE' AND NEW.put_finished_at IS DISTINCT FROM OLD.put_finished_at THEN
    IF OLD.put_finished_at IS NOT NULL OR NEW.put_finished_at IS NULL
      OR OLD.membership_id IS DISTINCT FROM app.current_membership_id()
      OR (to_jsonb(NEW)-'put_finished_at') IS DISTINCT FROM (to_jsonb(OLD)-'put_finished_at') THEN
      RAISE EXCEPTION 'SKILL_UPLOAD_RECEIPT_INVALID' USING ERRCODE='ES001';
    END IF;
    NEW.put_finished_at := clock_timestamp();
    NEW.put_material_generation := ai.current_material_restore_generation();
    NEW.put_auth_generation := app.current_auth_restore_generation();
    RETURN NEW;
  END IF;
  IF app.interactive_privilege_allowed('skill.manage') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.membership_id IS DISTINCT FROM app.current_membership_id() OR NEW.state<>'writing'
      OR NOT EXISTS (SELECT 1 FROM skills.packages p WHERE p.organization_id=NEW.organization_id
        AND p.id=NEW.package_id AND p.origin='tenant' AND p.state='active') THEN
      RAISE EXCEPTION 'SKILL_UPLOAD_NOT_ADMITTED' USING ERRCODE='ES001';
    END IF;
  ELSIF NOT COALESCE(OLD.state='writing' AND (
    (NEW.state='superseded' AND clock_timestamp() >= OLD.created_at + interval '2 minutes')
    OR (NEW.state='attached' AND OLD.membership_id=app.current_membership_id()
      AND EXISTS (SELECT 1 FROM skills.package_versions v
        WHERE v.organization_id=NEW.organization_id AND v.id=NEW.id
          AND v.package_id=NEW.package_id AND v.uploaded_by_membership_id=NEW.membership_id
          AND v.bundle_sha256=NEW.bundle_sha256 AND v.size_bytes=NEW.size_bytes
          AND v.bundle_object_key=NEW.organization_id::text||'/skills/'||NEW.id::text))
  ),false) THEN
    RAISE EXCEPTION 'SKILL_UPLOAD_TRANSITION_INVALID' USING ERRCODE='ES001';
  END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE FUNCTION skills.guard_bundle_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE reservation skills.bundle_uploads%ROWTYPE;
BEGIN
  SELECT * INTO reservation FROM skills.bundle_uploads r
    WHERE r.organization_id=NEW.organization_id AND r.id=NEW.id FOR UPDATE;
  IF FOUND AND (reservation.state<>'writing' OR reservation.package_id<>NEW.package_id
    OR reservation.membership_id IS DISTINCT FROM NEW.uploaded_by_membership_id
    OR reservation.bundle_sha256<>NEW.bundle_sha256 OR reservation.size_bytes<>NEW.size_bytes
    OR NEW.bundle_object_key<>NEW.organization_id::text||'/skills/'||NEW.id::text) THEN
    RAISE EXCEPTION 'SKILL_UPLOAD_FENCED' USING ERRCODE='ES001';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION skills.guard_bundle_attachment() FROM PUBLIC;
CREATE TRIGGER skill_versions_guard_storage_admission BEFORE INSERT ON skills.package_versions
FOR EACH ROW EXECUTE FUNCTION skills.guard_bundle_attachment();
--> statement-breakpoint
ALTER TABLE lifecycle.object_deletion_claims DROP CONSTRAINT object_deletion_claims_kind_check;
ALTER TABLE lifecycle.object_deletion_claims ADD CONSTRAINT object_deletion_claims_kind_check
  CHECK (kind IN ('derived','ordinary','archive','raw_source','skill_upload'));
ALTER TABLE lifecycle.object_deletion_claims DROP CONSTRAINT object_deletion_key;
ALTER TABLE lifecycle.object_deletion_claims ADD CONSTRAINT object_deletion_key CHECK (
  (kind='raw_source' AND artifact_id IS NULL AND import_id IS NULL AND raw_source_id IS NOT NULL
    AND raw_source_version IS NOT NULL AND raw_source_version>0 AND raw_purge_job_id IS NOT NULL
    AND raw_document_id IS NOT NULL AND material_restore_generation IS NOT NULL AND auth_restore_generation IS NOT NULL
    AND object_key=organization_id::text||'/knowledge/'||raw_document_id::text)
  OR (kind<>'raw_source' AND artifact_id IS NOT NULL AND raw_source_id IS NULL AND raw_source_version IS NULL
    AND raw_purge_job_id IS NULL AND raw_document_id IS NULL AND material_restore_generation IS NULL
    AND auth_restore_generation IS NULL AND (
      (kind='archive' AND import_id IS NOT NULL
        AND object_key=organization_id::text||'/archive-quarantine/'||import_id::text||'/'||artifact_id::text||'/'||writer_token::text)
      OR (kind IN ('derived','ordinary') AND import_id IS NULL
        AND object_key=organization_id::text||'/artifacts/'||artifact_id::text)
      OR (kind='skill_upload' AND import_id IS NULL AND writer_token=artifact_id AND generation=1
        AND object_key=organization_id::text||'/skills/'||artifact_id::text)
    ))
);
CREATE UNIQUE INDEX skill_upload_one_delete ON lifecycle.object_deletion_claims(organization_id,artifact_id)
  WHERE kind='skill_upload';
--> statement-breakpoint
CREATE FUNCTION lifecycle.next_skill_upload_cleanup() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF session_user<>'ensemus_worker' OR app.current_actor_type() IS DISTINCT FROM 'service'
    OR app.current_organization_id() IS NULL THEN
    RAISE EXCEPTION 'SKILL_CLEANUP_WORKER_REQUIRED' USING ERRCODE='42501';
  END IF;
  RETURN (SELECT r.id FROM skills.bundle_uploads r
    LEFT JOIN lifecycle.object_deletion_claims c
      ON c.organization_id=r.organization_id AND c.artifact_id=r.id AND c.kind='skill_upload'
    WHERE r.organization_id=app.current_organization_id() AND r.put_finished_at IS NOT NULL
      AND r.put_material_generation=ai.current_material_restore_generation()
      AND r.put_auth_generation=app.current_auth_restore_generation()
      AND (r.state='superseded' OR (r.state='writing' AND r.put_finished_at<=statement_timestamp()-interval '1 hour'))
      AND (c.id IS NULL OR c.state='deleted')
    ORDER BY r.put_finished_at,r.id LIMIT 1);
END $function$;
CREATE FUNCTION lifecycle.begin_skill_upload_deletion(p_upload uuid)
RETURNS TABLE(state text,claim_id uuid,object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  tenant uuid := app.current_organization_id();
  reservation skills.bundle_uploads%ROWTYPE;
  prior lifecycle.object_deletion_claims%ROWTYPE;
  key text := tenant::text||'/skills/'||p_upload::text;
BEGIN
  IF session_user<>'ensemus_worker' OR app.current_actor_type() IS DISTINCT FROM 'service'
    OR tenant IS NULL THEN
    RAISE EXCEPTION 'SKILL_CLEANUP_WORKER_REQUIRED' USING ERRCODE='42501';
  END IF;
  PERFORM lifecycle.lock_delete_tenant();
  IF EXISTS (SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active') THEN
    RETURN QUERY SELECT 'held'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  SELECT * INTO reservation FROM skills.bundle_uploads r WHERE r.organization_id=tenant AND r.id=p_upload FOR UPDATE;
  IF NOT FOUND OR reservation.put_finished_at IS NULL
    OR reservation.put_material_generation IS DISTINCT FROM ai.current_material_restore_generation()
    OR reservation.put_auth_generation IS DISTINCT FROM app.current_auth_restore_generation()
    OR NOT (reservation.state='superseded'
      OR (reservation.state='writing' AND reservation.put_finished_at<=statement_timestamp()-interval '1 hour'))
    OR EXISTS (SELECT 1 FROM skills.package_versions v WHERE v.organization_id=tenant
      AND (v.id=p_upload OR v.bundle_object_key=key)) THEN
    RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  SELECT * INTO prior FROM lifecycle.object_deletion_claims c
    WHERE c.organization_id=tenant AND c.artifact_id=p_upload AND c.kind='skill_upload' FOR UPDATE;
  IF FOUND THEN
    IF prior.state='deleted' AND prior.admitted_at>=reservation.put_finished_at
      AND prior.sha256=reservation.bundle_sha256 THEN
      RETURN QUERY SELECT 'deleted'::text,prior.id,key;
    ELSE RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;
    END IF;
    RETURN;
  END IF;
  IF reservation.state='writing' THEN
    UPDATE skills.bundle_uploads r SET state='superseded' WHERE r.organization_id=tenant AND r.id=p_upload;
  END IF;
  INSERT INTO lifecycle.object_deletion_claims(organization_id,kind,artifact_id,writer_token,generation,object_key,sha256,state)
    VALUES(tenant,'skill_upload',p_upload,p_upload,1,key,reservation.bundle_sha256,'admitted')
    RETURNING id INTO prior.id;
  RETURN QUERY SELECT 'admitted'::text,prior.id,key;
END $function$;
REVOKE ALL ON FUNCTION lifecycle.next_skill_upload_cleanup(),lifecycle.begin_skill_upload_deletion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.next_skill_upload_cleanup(),lifecycle.begin_skill_upload_deletion(uuid) TO ensemus_worker;
--> statement-breakpoint
-- The generic absence executor remains the same. The fixed receipt functions
-- recognize this kind while keeping the scope and transitions of every other kind.
DO $migration$
DECLARE
  terminal text := pg_get_functiondef('lifecycle.object_delete_terminal_before_raw(uuid,text)'::regprocedure);
  absent text := pg_get_functiondef('lifecycle.object_delete_absent_before_raw(uuid)'::regprocedure);
  guard constant text := 'IF NOT FOUND OR(claim.kind<>''ordinary'' AND NOT knowledge.is_service_actor())';
  update_blob constant text := 'IF claim.kind<>''archive'' THEN';
  replacement constant text := 'IF NOT FOUND OR (claim.kind=''skill_upload'' AND (
    session_user<>''ensemus_worker'' OR app.current_actor_type() IS DISTINCT FROM ''service''
    OR NOT EXISTS (SELECT 1 FROM skills.bundle_uploads r WHERE r.organization_id=claim.organization_id
      AND r.id=claim.artifact_id AND r.state=''superseded'' AND r.put_finished_at<=claim.admitted_at
      AND r.bundle_sha256=claim.sha256 AND r.put_material_generation=ai.current_material_restore_generation()
      AND r.put_auth_generation=app.current_auth_restore_generation())
  )) OR(claim.kind<>''ordinary'' AND NOT knowledge.is_service_actor())';
BEGIN
  IF strpos(terminal,guard)=0 OR strpos(absent,guard)=0 OR strpos(absent,update_blob)=0 THEN
    RAISE EXCEPTION 'SKILL_CLEANUP_AUTHORITY_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(terminal,guard,replacement);
  EXECUTE replace(replace(absent,guard,replacement),update_blob,'IF claim.kind NOT IN (''archive'',''skill_upload'') THEN');
END $migration$;
