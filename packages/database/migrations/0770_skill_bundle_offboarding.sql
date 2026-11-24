-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Attached skill bytes may be deleted only for a native, admitted erasure intent.
ALTER TABLE lifecycle.object_deletion_claims
  ADD COLUMN skill_offboarding_id uuid,
  ADD CONSTRAINT skill_delete_offboarding_kind CHECK (skill_offboarding_id IS NULL OR kind='skill_upload'),
  ADD CONSTRAINT skill_delete_offboarding_admission_fk FOREIGN KEY (organization_id,skill_offboarding_id)
    REFERENCES lifecycle.offboarding_admissions(organization_id,offboarding_id);
--> statement-breakpoint
CREATE FUNCTION lifecycle.skill_offboarding_open(p_intent uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT lifecycle.erasure_object_intent(p_intent) IS TRUE
    AND lifecycle.erasure_open(app.current_organization_id()) IS TRUE
    AND EXISTS (SELECT 1 FROM lifecycle.offboardings o WHERE o.organization_id=app.current_organization_id()
      AND o.id=p_intent AND o.state='erasing')
$function$;
CREATE FUNCTION lifecycle.skill_write_is_current(r skills.bundle_uploads) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $function$
  SELECT r.put_finished_at IS NOT NULL
    AND r.put_material_generation IS NOT DISTINCT FROM ai.current_material_restore_generation()
    AND r.put_auth_generation IS NOT DISTINCT FROM app.current_auth_restore_generation()
$function$;
CREATE FUNCTION lifecycle.skill_version_matches_upload(r skills.bundle_uploads, v skills.package_versions)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
  SELECT r.state='attached' AND v.organization_id=r.organization_id AND v.id=r.id AND v.package_id=r.package_id
    AND v.uploaded_by_membership_id IS NOT DISTINCT FROM r.membership_id
    AND v.bundle_sha256=r.bundle_sha256 AND v.size_bytes=r.size_bytes
    AND v.bundle_object_key=r.organization_id::text||'/skills/'||r.id::text
$function$;
CREATE FUNCTION lifecycle.skill_upload_delete_target(r skills.bundle_uploads) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $function$
  SELECT lifecycle.skill_write_is_current(r) AND CASE WHEN r.state='attached' THEN EXISTS (
    SELECT 1 FROM skills.package_versions v WHERE v.organization_id=r.organization_id AND v.id=r.id
      AND lifecycle.skill_version_matches_upload(r,v)
  ) ELSE NOT EXISTS (
    SELECT 1 FROM skills.package_versions v WHERE v.organization_id=r.organization_id
      AND (v.id=r.id OR v.bundle_object_key=r.organization_id::text||'/skills/'||r.id::text)
  ) END
$function$;
REVOKE ALL ON FUNCTION lifecycle.skill_offboarding_open(uuid),
  lifecycle.skill_write_is_current(skills.bundle_uploads),
  lifecycle.skill_version_matches_upload(skills.bundle_uploads,skills.package_versions),
  lifecycle.skill_upload_delete_target(skills.bundle_uploads) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION lifecycle.list_skill_offboarding_uploads(p_intent uuid,p_limit integer)
RETURNS TABLE(upload_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF lifecycle.skill_offboarding_open(p_intent) IS DISTINCT FROM true
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'SKILL_ERASURE_NOT_OPEN' USING ERRCODE='EN850';
  END IF;
  RETURN QUERY SELECT r.id FROM skills.bundle_uploads r
    LEFT JOIN lifecycle.object_deletion_claims c
      ON c.organization_id=r.organization_id AND c.artifact_id=r.id AND c.kind='skill_upload'
    WHERE r.organization_id=app.current_organization_id() AND lifecycle.skill_upload_delete_target(r)
      AND (c.id IS NULL OR (c.state='deleted' AND (c.skill_offboarding_id IS NULL OR c.skill_offboarding_id=p_intent)))
    ORDER BY r.id LIMIT p_limit;
END $function$;
CREATE FUNCTION lifecycle.begin_skill_offboarding_deletion(p_intent uuid,p_upload uuid)
RETURNS TABLE(state text,claim_id uuid,object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  tenant uuid := app.current_organization_id();
  reservation skills.bundle_uploads%ROWTYPE;
  prior lifecycle.object_deletion_claims%ROWTYPE;
  key text := tenant::text||'/skills/'||p_upload::text;
BEGIN
  IF lifecycle.erasure_object_intent(p_intent) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SKILL_ERASURE_NOT_OPEN' USING ERRCODE='EN850';
  END IF;
  PERFORM lifecycle.lock_delete_tenant();
  IF EXISTS (SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active') THEN
    RETURN QUERY SELECT 'held'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  IF lifecycle.skill_offboarding_open(p_intent) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SKILL_ERASURE_NOT_OPEN' USING ERRCODE='EN850';
  END IF;
  SELECT * INTO reservation FROM skills.bundle_uploads r WHERE r.organization_id=tenant AND r.id=p_upload FOR UPDATE;
  IF NOT FOUND OR lifecycle.skill_upload_delete_target(reservation) IS DISTINCT FROM true THEN
    RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  SELECT * INTO prior FROM lifecycle.object_deletion_claims c
    WHERE c.organization_id=tenant AND c.artifact_id=p_upload AND c.kind='skill_upload' FOR UPDATE;
  IF FOUND THEN
    IF prior.state='deleted' AND prior.admitted_at>=reservation.put_finished_at
      AND prior.sha256=reservation.bundle_sha256
      AND (prior.skill_offboarding_id IS NULL OR prior.skill_offboarding_id=p_intent) THEN
      RETURN QUERY SELECT 'deleted'::text,prior.id,key;
    ELSE RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;
    END IF;
    RETURN;
  END IF;
  INSERT INTO lifecycle.object_deletion_claims(organization_id,kind,artifact_id,writer_token,generation,object_key,sha256,state,skill_offboarding_id)
    VALUES(tenant,'skill_upload',p_upload,p_upload,1,key,reservation.bundle_sha256,'admitted',p_intent)
    RETURNING id INTO prior.id;
  RETURN QUERY SELECT 'admitted'::text,prior.id,key;
END $function$;
REVOKE ALL ON FUNCTION lifecycle.list_skill_offboarding_uploads(uuid,integer),
  lifecycle.begin_skill_offboarding_deletion(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.list_skill_offboarding_uploads(uuid,integer),
  lifecycle.begin_skill_offboarding_deletion(uuid,uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION lifecycle.skill_offboarding_bundles_removed(p_intent uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT CASE WHEN lifecycle.erasure_object_intent(p_intent) IS TRUE THEN (
    SELECT count(*) FROM lifecycle.object_deletion_claims c WHERE c.organization_id=app.current_organization_id()
      AND c.kind='skill_upload' AND c.skill_offboarding_id=p_intent AND c.state='proven'
  ) END
$function$;
REVOKE ALL ON FUNCTION lifecycle.skill_offboarding_bundles_removed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.skill_offboarding_bundles_removed(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION lifecycle.skill_upload_claim_allowed(c lifecycle.object_deletion_claims, p_proof boolean)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $function$
  SELECT COALESCE(app.current_actor_type()='service' AND c.organization_id=app.current_organization_id()
    AND EXISTS (SELECT 1 FROM skills.bundle_uploads r WHERE r.organization_id=c.organization_id
      AND r.id=c.artifact_id AND r.put_finished_at<=c.admitted_at AND r.bundle_sha256=c.sha256
      AND lifecycle.skill_upload_delete_target(r)
      AND CASE
        WHEN c.skill_offboarding_id IS NOT NULL THEN lifecycle.skill_offboarding_open(c.skill_offboarding_id)
        WHEN session_user='ensemus_worker' THEN r.state='superseded'
        WHEN p_proof AND c.state='deleted' AND r.state='superseded' THEN EXISTS (
          SELECT 1 FROM lifecycle.offboardings o WHERE o.organization_id=r.organization_id
            AND o.state='erasing' AND lifecycle.skill_offboarding_open(o.id)
        )
        ELSE false
      END),false)
$function$;
REVOKE ALL ON FUNCTION lifecycle.skill_upload_claim_allowed(lifecycle.object_deletion_claims,boolean) FROM PUBLIC;
--> statement-breakpoint
DO $migration$
DECLARE
  terminal text := pg_get_functiondef('lifecycle.object_delete_terminal_before_raw(uuid,text)'::regprocedure);
  absent text := pg_get_functiondef('lifecycle.object_delete_absent_before_raw(uuid)'::regprocedure);
  anchor constant text := $guard$(claim.kind='skill_upload' AND (
    session_user<>'ensemus_worker' OR app.current_actor_type() IS DISTINCT FROM 'service'
    OR NOT EXISTS (SELECT 1 FROM skills.bundle_uploads r WHERE r.organization_id=claim.organization_id
      AND r.id=claim.artifact_id AND r.state='superseded' AND r.put_finished_at<=claim.admitted_at
      AND r.bundle_sha256=claim.sha256 AND r.put_material_generation=ai.current_material_restore_generation()
      AND r.put_auth_generation=app.current_auth_restore_generation())
  ))$guard$;
  guard_change text := pg_get_functiondef('lifecycle.guard_delete_claim_change()'::regprocedure);
  column_anchor constant text := 'NEW.admitted_at)';
  old_column_anchor constant text := 'OLD.admitted_at)';
BEGIN
  IF strpos(terminal,anchor)=0 OR strpos(absent,anchor)=0 OR strpos(guard_change,column_anchor)=0
    OR strpos(guard_change,old_column_anchor)=0 THEN
    RAISE EXCEPTION 'SKILL_ERASURE_RECEIPT_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(terminal,anchor,'(claim.kind=''skill_upload'' AND NOT lifecycle.skill_upload_claim_allowed(claim,false))');
  EXECUTE replace(absent,anchor,'(claim.kind=''skill_upload'' AND NOT lifecycle.skill_upload_claim_allowed(claim,true))');
  EXECUTE replace(replace(guard_change,column_anchor,'NEW.admitted_at,NEW.skill_offboarding_id)'),
    old_column_anchor,'OLD.admitted_at,OLD.skill_offboarding_id)');
END $migration$;
--> statement-breakpoint
CREATE FUNCTION lifecycle.skill_bundle_material_complete() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $function$
  SELECT NOT EXISTS (
    SELECT 1 FROM skills.bundle_uploads r WHERE r.organization_id=app.current_organization_id()
      AND (NOT lifecycle.skill_write_is_current(r) OR NOT EXISTS (
        SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=r.organization_id
          AND c.artifact_id=r.id AND c.kind='skill_upload' AND c.state='proven'
          AND c.admitted_at>=r.put_finished_at AND c.sha256=r.bundle_sha256 AND c.absent_at>=c.terminal_at
      ))
  ) AND NOT EXISTS (
    SELECT 1 FROM skills.package_versions v WHERE v.organization_id=app.current_organization_id()
      AND NOT EXISTS (SELECT 1 FROM skills.bundle_uploads r WHERE r.organization_id=v.organization_id AND r.id=v.id
        AND lifecycle.skill_version_matches_upload(r,v))
  )
$function$;
REVOKE ALL ON FUNCTION lifecycle.skill_bundle_material_complete() FROM PUBLIC;
CREATE OR REPLACE FUNCTION lifecycle.tenant_object_proofs_complete() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT lifecycle.tenant_object_proofs_complete_before_raw() AND lifecycle.raw_tenant_material_complete()
    AND lifecycle.skill_bundle_material_complete()
$function$;
--> statement-breakpoint
-- Keep the write evidence until the corresponding version row has been removed.
CREATE FUNCTION lifecycle.guard_skill_upload_erasure_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF session_user<>'ensemus_eraser' OR OLD.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'SKILL_UPLOAD_ERASURE_NOT_OPEN' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM skills.package_versions v WHERE v.organization_id=OLD.organization_id AND v.id=OLD.id) THEN
    RAISE EXCEPTION 'SKILL_UPLOAD_VERSION_REMAINS' USING ERRCODE='23503';
  END IF;
  RETURN OLD;
END $function$;
REVOKE ALL ON FUNCTION lifecycle.guard_skill_upload_erasure_order() FROM PUBLIC;
CREATE TRIGGER skill_uploads_erasure_order BEFORE DELETE ON skills.bundle_uploads
FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_skill_upload_erasure_order();
--> statement-breakpoint
DO $migration$
DECLARE
  ref text;
  definition text;
  strict_inventory text;
  scope constant text[] := ARRAY['skills.bundle_uploads','skills.package_versions','skills.test_runs'];
  pending_protocols constant text := $pending$
    'federation.inbound_items','federation.org_settings','federation.outbound_items',
    'marketplace.installations','marketplace.publishers','marketplace.submissions','sandbox.runs'
  $pending$;
  inventory_anchor constant text := '''work.work_units''';
  filter_anchor constant text := 'AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text) ORDER BY';
  append_anchor constant text := '''work.work_transitions''::regclass)';
BEGIN
  FOREACH ref IN ARRAY scope LOOP
    EXECUTE format('GRANT SELECT(organization_id),DELETE ON %s TO ensemus_eraser', ref);
    EXECUTE format('CREATE POLICY eraser_delete ON %s TO ensemus_eraser
      USING (organization_id=app.current_organization_id() AND lifecycle.erasure_open(organization_id))', ref);
    EXECUTE format('CREATE TRIGGER skill_bundle_erasure_lock BEFORE DELETE ON %s
      FOR EACH STATEMENT EXECUTE FUNCTION lifecycle.lock_expansion_erase()', ref);
  END LOOP;
  definition := pg_get_functiondef('app.reject_change()'::regprocedure);
  IF strpos(definition,append_anchor)=0 THEN
    RAISE EXCEPTION 'SKILL_BUNDLE_ERASURE_APPEND_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,append_anchor,'''skills.package_versions''::regclass, ''skills.test_runs''::regclass, '||append_anchor);
  definition := pg_get_functiondef('lifecycle.install_erasure_count_projection()'::regprocedure);
  IF strpos(definition,inventory_anchor)=0 OR strpos(definition,filter_anchor)=0 THEN
    RAISE EXCEPTION 'SKILL_BUNDLE_ERASURE_COUNT_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  strict_inventory := replace(definition,inventory_anchor,
    '''skills.bundle_uploads'',''skills.package_versions'',''skills.test_runs'','||inventory_anchor);
  EXECUTE replace(strict_inventory,filter_anchor,format(
    'AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text) AND (n.nspname||''.''||c.relname)<>ALL(ARRAY[%s]) ORDER BY',
    pending_protocols));
  PERFORM lifecycle.install_erasure_count_projection();
  EXECUTE strict_inventory;
  PERFORM identity.extend_auth_restore_admission();
END $migration$;
