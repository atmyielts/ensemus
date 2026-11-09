-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-026, ADR-029). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person
-- Written by an agent in CI repair round 7 (G2, check finding 7, F16 part 2). It adds one deletion
-- admission to the raw Knowledge object authority. Written as 0548, renumbered to 0547 at merge.
--
-- 0547 (r7 restore survivors): additive. 0508, 0516, 0520, 0539, 0543, 0544 and 0545 are registered
-- and pushed, so none of them is edited; the two fixed public entry points are cloned and wrapped the
-- way 0516, 0539 and 0544 did, keeping their OIDs and ACLs.
--
-- The defect (ADR-026 "What this does not cover"): a raw Knowledge object whose bytes survived a
-- restore had no deletion path. A restore rotation (0515, deferred by 0542) moves every source's raw
-- inventory to restore_debt from the earlier material generation, which no transition leaves
-- (guard_raw_inventory_change). 0516's raw admission needs raw_document_delete_target, which needs the
-- inventory sealed in the current generation (raw_document_writers_ready), so it refuses every object
-- of such a source for ever. 0543's per-source proof (requalify_raw_restore_source) records only when
-- every object is observed absent, so one surviving object kept its source unconfirmed, its purge job
-- failed and the tenant erasure witness (raw_tenant_inventory_complete) false for ever.
--
-- The repair is one more exact target for the existing lifecycle, never a second deletion protocol:
--   * lifecycle.raw_restore_survivor_delete_target(source,document) names one raw object of one
--     closed, tombstoned source whose inventory a restore left in debt: sealed before the restore,
--     from an earlier material generation, its capture still matching the writes, every writer of the
--     source concluded, and no live document or writer header. Service-only; IDs and the product's
--     own key fields only; NULL for anything else.
--   * lifecycle.begin_object_deletion accepts that target as kind 'raw_restore_survivor' and admits
--     an ordinary 0516 'raw_source' claim for that exact object, writer, generation, hash, source
--     version and purge job, in the current material and auth generation. It keeps 0516's
--     service-only caller, exact key set, source -> organization NOWAIT -> job/inventory/claim lock
--     order, the tenant-wide legal hold refusal ('held') and the exact-target recheck. A stale
--     generation, a source not in restore debt, an unresolved claim or any other identity refuses.
--     There is no pattern, count, source-wide or tenant-wide form: one call names one object.
--   * lifecycle.object_delete_terminal is unchanged: 0516's raw branch records the single DELETE.
--   * lifecycle.object_delete_absent proves such a claim only after a known terminal DELETE and the
--     runtime's independent physical-absence check, with no hold, through the same lock as 0516
--     (lock_raw_delete_claim: closed source at its version, organization, job, claim, current
--     generations) and the same survivor conditions rechecked. Every other claim keeps the previous
--     definition unchanged.
-- Retiring the source's restore debt is then 0543's own per-source proof, unchanged: it records only
-- when every object of the inventory is observed absent and no deletion claim is unresolved, so an
-- unknown, admitted or unproven deletion keeps the source unconfirmed. Like every restore proof it is
-- bound to the current material generation, so a later restore reopens the debt. Nothing here
-- clears, rewrites or deletes a row; no table, grant or policy is added; no runtime role gains a
-- table privilege. Only ensemus_app gains EXECUTE on the one new service-only target function.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'RAW_RESTORE_SURVIVOR_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regclass('lifecycle.raw_source_inventories') IS NULL OR to_regclass('lifecycle.raw_object_writes') IS NULL
  OR to_regclass('lifecycle.object_deletion_claims') IS NULL OR to_regclass('lifecycle.raw_restore_requalifications') IS NULL
  OR to_regprocedure('lifecycle.begin_object_deletion(jsonb)') IS NULL
  OR to_regprocedure('lifecycle.begin_object_deletion_before_upload(jsonb)') IS NULL
  OR to_regprocedure('lifecycle.object_delete_absent(uuid)') IS NULL
  OR to_regprocedure('lifecycle.object_delete_absent_before_late_upload(uuid)') IS NULL
  OR to_regprocedure('lifecycle.object_delete_terminal(uuid,text)') IS NULL
  OR to_regprocedure('lifecycle.lock_raw_delete_claim(uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_metadata_scope(uuid)') IS NULL
  OR to_regprocedure('lifecycle.requalify_raw_restore_source(uuid,uuid[])') IS NULL
  OR to_regprocedure('lifecycle.raw_source_requalified(uuid,bigint,uuid,uuid)') IS NULL
  OR to_regprocedure('knowledge.is_service_actor()') IS NULL
  OR to_regprocedure('app.current_auth_restore_generation()') IS NULL
  OR to_regprocedure('ai.current_material_restore_generation()') IS NULL THEN
  RAISE EXCEPTION 'RAW_RESTORE_SURVIVOR_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint

-- Whether one raw object of one source is a restore survivor this path may delete in p_material:
-- the source's inventory is restore debt a restore left behind (sealed, from an earlier generation,
-- at this exact version and purge job, its capture still matching the writes), the object is in that
-- inventory's catalog, every writer of the source concluded, and no live raw header remains. The same
-- conditions 0543's per-source proof needs, less the absence it is about to establish. Read inside the
-- raw metadata scope by the fixed functions below only.
CREATE FUNCTION lifecycle.raw_restore_survivor_ready(p_source uuid,p_version bigint,p_job uuid,p_document uuid,p_material uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_source IS NOT NULL AND p_version IS NOT NULL
  AND p_job IS NOT NULL AND p_document IS NOT NULL AND p_material IS NOT NULL
  AND EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=app.current_organization_id()
   AND i.scope_kind='source' AND i.source_id=p_source AND i.protocol_version=1 AND i.state='restore_debt'
   AND i.material_restore_generation<>p_material AND i.sealed_at IS NOT NULL AND i.capture_sha256 IS NOT NULL
   AND i.purge_job_id=p_job AND i.source_version=p_version
   AND i.capture_count=(SELECT count(*) FROM lifecycle.raw_object_writes w WHERE w.organization_id=i.organization_id AND w.source_id=p_source))
  AND EXISTS(SELECT 1 FROM lifecycle.raw_object_writes c WHERE c.organization_id=app.current_organization_id() AND c.source_id=p_source
   AND c.document_id=p_document AND c.generation=0 AND c.state='catalog'
   AND c.object_key=app.current_organization_id()::text||'/knowledge/'||p_document::text)
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=app.current_organization_id() AND w.document_id=p_document
   AND w.source_id IS DISTINCT FROM p_source)
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source
   AND w.generation>0 AND(w.state NOT IN('finished','not_dispatched') OR w.finished_at IS NULL))
  AND NOT EXISTS(SELECT 1 FROM knowledge.documents d WHERE d.organization_id=app.current_organization_id() AND d.source_id=p_source)
  AND NOT EXISTS(SELECT 1 FROM knowledge.object_writers w WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_restore_survivor_ready(uuid,bigint,uuid,uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;

-- The exact deletion target of one surviving raw object, for the trusted runtime to hand back to
-- begin_object_deletion. NULL for anything this path may not delete. No body, name or other tenant.
CREATE FUNCTION lifecycle.raw_restore_survivor_delete_target(p_source uuid,p_document uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 material uuid;auth uuid;s record;i record;w record;answer jsonb;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL OR p_source IS NULL OR p_document IS NULL THEN
  RAISE EXCEPTION 'RAW_RESTORE_SURVIVOR_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 -- Raises RESTORE_PENDING until the restore was reviewed and admitted.
 auth:=app.current_auth_restore_generation();material:=ai.current_material_restore_generation();
 IF auth IS NULL OR material IS NULL THEN RETURN NULL;END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT x.id,x.version,x.state INTO s FROM knowledge.sources x WHERE x.organization_id=tenant AND x.id=p_source;
 SELECT x.* INTO i FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant AND x.scope_kind='source' AND x.source_id=p_source;
 IF s.id IS NOT NULL AND s.state IN('revoked','deleted') AND i.id IS NOT NULL AND s.version=i.source_version
  AND EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=tenant AND t.target_type='knowledge_source' AND t.target_id=p_source)
  AND lifecycle.raw_restore_survivor_ready(p_source,i.source_version,i.purge_job_id,p_document,material) THEN
  SELECT x.* INTO w FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=p_document
   ORDER BY x.generation DESC LIMIT 1;
  IF w.generation<=9007199254740991 THEN
   answer:=jsonb_build_object('kind','raw_restore_survivor','sourceId',p_source,'sourceVersion',i.source_version::text,
    'purgeJobId',i.purge_job_id,'documentId',p_document,'writeId',w.write_id,'generation',w.generation,
    'priorMaterialRestoreGeneration',i.material_restore_generation,'materialRestoreGeneration',material,'authRestoreGeneration',auth);
  END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_restore_survivor_delete_target(uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
GRANT EXECUTE ON FUNCTION lifecycle.raw_restore_survivor_delete_target(uuid,uuid) TO ensemus_app;

-- Whether one claim is a restore-survivor claim: a raw_source claim of the current material
-- generation for a source whose inventory is restore debt from an earlier one. 0516's own admission
-- can never create such a claim (it needs that inventory sealed in the current generation, and
-- restore_debt is never left), so only the admission below does.
CREATE FUNCTION lifecycle.raw_restore_survivor_claim(p_claim uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 material uuid;c record;answer boolean:=false;
BEGIN
 IF tenant IS NULL OR p_claim IS NULL THEN RETURN false;END IF;
 -- Any other kind of claim is answered before anything else is read or locked.
 SELECT x.kind,x.raw_source_id,x.raw_source_version,x.raw_purge_job_id,x.material_restore_generation INTO c
  FROM lifecycle.object_deletion_claims x WHERE x.organization_id=tenant AND x.id=p_claim;
 IF c.kind IS DISTINCT FROM 'raw_source' THEN RETURN false;END IF;
 material:=ai.current_material_restore_generation();
 IF material IS NULL THEN RETURN false;END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 answer:=coalesce(c.material_restore_generation=material AND EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i
  WHERE i.organization_id=tenant AND i.scope_kind='source' AND i.source_id=c.raw_source_id AND i.protocol_version=1
   AND i.state='restore_debt' AND i.material_restore_generation<>material
   AND i.purge_job_id=c.raw_purge_job_id AND i.source_version=c.raw_source_version),false);
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_restore_survivor_claim(uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
--> statement-breakpoint

-- Clone the two fixed reviewed public definitions, as 0516, 0539 and 0544 did, keeping their public
-- OIDs and ACLs. There is no runtime identifier, SQL selector or generic fallback.
DO $$ DECLARE item record;definition text;header text;BEGIN
 FOR item IN SELECT * FROM(VALUES
  ('lifecycle.begin_object_deletion(jsonb)','begin_object_deletion','begin_object_deletion_before_survivor'),
  ('lifecycle.object_delete_absent(uuid)','object_delete_absent','object_delete_absent_before_survivor')
 ) fixed(signature,name,clone) LOOP
  definition:=pg_get_functiondef(item.signature::regprocedure);header:='CREATE OR REPLACE FUNCTION lifecycle.'||item.name||'(';
  IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'RAW_RESTORE_SURVIVOR_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
  EXECUTE replace(definition,header,'CREATE OR REPLACE FUNCTION lifecycle.'||item.clone||'(');
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION lifecycle.begin_object_deletion_before_survivor(jsonb),lifecycle.object_delete_absent_before_survivor(uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
--> statement-breakpoint

-- Every target but 'raw_restore_survivor' keeps the previous definition unchanged.
CREATE OR REPLACE FUNCTION lifecycle.begin_object_deletion(p_target jsonb)
 RETURNS TABLE(state text,claim_id uuid,object_key text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 keys text[];source_key uuid;doc_key uuid;job_key uuid;raw_version bigint;prior_material uuid;material uuid;auth uuid;
 actual jsonb;c record;w record;old_claim record;new_claim uuid;
 expected text[]:=ARRAY['authRestoreGeneration','documentId','generation','kind','materialRestoreGeneration',
  'priorMaterialRestoreGeneration','purgeJobId','sourceId','sourceVersion','writeId']::text[];
BEGIN
 IF jsonb_typeof(p_target) IS DISTINCT FROM 'object' OR p_target->>'kind' IS DISTINCT FROM 'raw_restore_survivor' THEN
  RETURN QUERY SELECT * FROM lifecycle.begin_object_deletion_before_survivor(p_target);RETURN;END IF;
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN
  RAISE EXCEPTION 'RAW_RESTORE_SURVIVOR_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 -- The exact key set, as 0516's raw target: never a pattern, a count, a source or a tenant.
 SELECT array_agg(k) INTO keys FROM jsonb_object_keys(p_target) k;
 IF keys IS NULL OR NOT(keys @> expected AND keys <@ expected) OR cardinality(keys)<>cardinality(expected)
  OR EXISTS(SELECT 1 FROM jsonb_each(p_target) e WHERE jsonb_typeof(e.value) NOT IN('string','number')) THEN
  RAISE EXCEPTION 'RAW_RESTORE_SURVIVOR_TARGET_REQUIRED' USING ERRCODE='EN850';END IF;
 source_key:=(p_target->>'sourceId')::uuid;doc_key:=(p_target->>'documentId')::uuid;job_key:=(p_target->>'purgeJobId')::uuid;
 raw_version:=(p_target->>'sourceVersion')::bigint;prior_material:=(p_target->>'priorMaterialRestoreGeneration')::uuid;
 material:=ai.current_material_restore_generation();auth:=app.current_auth_restore_generation();
 -- A target from another generation, or debt of this same generation, is stale.
 IF material IS NULL OR auth IS NULL OR material IS DISTINCT FROM(p_target->>'materialRestoreGeneration')::uuid
  OR auth IS DISTINCT FROM(p_target->>'authRestoreGeneration')::uuid OR prior_material IS NULL OR prior_material=material THEN
  RAISE EXCEPTION 'RAW_RESTORE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 -- Source -> organization NOWAIT -> job/inventory/claim, the 0516 order. A hold and this admission
 -- share the organization row.
 PERFORM s.id FROM knowledge.sources s WHERE s.organization_id=tenant AND s.id=source_key AND s.state IN('revoked','deleted')
  AND s.version=raw_version FOR SHARE NOWAIT;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=tenant AND t.target_type='knowledge_source'
  AND t.target_id=source_key) THEN RAISE EXCEPTION 'RAW_CLOSED_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
 PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'RAW_TENANT_REQUIRED' USING ERRCODE='EN850';END IF;
 IF EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active') THEN
  RETURN QUERY SELECT 'held'::text,NULL::uuid,NULL::text;
 ELSE
  PERFORM j.id FROM knowledge.purge_jobs j WHERE j.organization_id=tenant AND j.id=job_key AND j.source_id=source_key FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'RAW_JOB_REQUIRED' USING ERRCODE='EN850';END IF;
  IF NOT EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.scope_kind='source'
   AND i.source_id=source_key AND i.protocol_version=1 AND i.state='restore_debt' AND i.material_restore_generation=prior_material
   AND i.purge_job_id=job_key AND i.source_version=raw_version) THEN
   RAISE EXCEPTION 'RAW_RESTORE_DEBT_REQUIRED' USING ERRCODE='EN850';END IF;
  actual:=lifecycle.raw_restore_survivor_delete_target(source_key,doc_key);
  IF actual IS NULL OR actual IS DISTINCT FROM p_target THEN
   RAISE EXCEPTION 'RAW_RESTORE_SURVIVOR_TARGET_REQUIRED' USING ERRCODE='EN850';END IF;
  SELECT * INTO c FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=doc_key AND x.source_id=source_key AND x.generation=0;
  SELECT * INTO w FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=doc_key ORDER BY x.generation DESC LIMIT 1;
  -- An unresolved claim first, then the newest. Only this exact survivor claim of this generation
  -- continues; an older generation's proven claim is history, and the restored bytes are owed again.
  SELECT * INTO old_claim FROM lifecycle.object_deletion_claims x WHERE x.organization_id=tenant AND x.object_key=c.object_key
   ORDER BY CASE WHEN x.state<>'proven' THEN 0 ELSE 1 END,x.admitted_at DESC,x.id DESC LIMIT 1 FOR UPDATE NOWAIT;
  IF old_claim.id IS NOT NULL AND(old_claim.state<>'proven' OR old_claim.material_restore_generation IS NOT DISTINCT FROM material) THEN
   IF old_claim.kind='raw_source' AND old_claim.raw_source_id=source_key AND old_claim.raw_source_version=raw_version
    AND old_claim.raw_purge_job_id=job_key AND old_claim.raw_document_id=doc_key AND old_claim.writer_token=w.write_id
    AND old_claim.generation=w.generation AND old_claim.sha256=c.content_sha256 AND old_claim.material_restore_generation=material
    AND old_claim.auth_restore_generation=auth AND old_claim.state IN('deleted','proven') THEN
    RETURN QUERY SELECT 'deleted'::text,old_claim.id,c.object_key;
   ELSE RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;END IF;
  ELSE
   INSERT INTO lifecycle.object_deletion_claims(organization_id,kind,artifact_id,raw_source_id,raw_source_version,raw_purge_job_id,raw_document_id,
    writer_token,generation,object_key,sha256,state,material_restore_generation,auth_restore_generation)
    VALUES(tenant,'raw_source',NULL,source_key,raw_version,job_key,doc_key,w.write_id,w.generation,c.object_key,c.content_sha256,'admitted',material,auth)
    RETURNING id INTO new_claim;
   RETURN QUERY SELECT 'admitted'::text,new_claim,c.object_key;
  END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
--> statement-breakpoint

-- Every claim but a restore-survivor claim keeps the previous definition unchanged. A survivor claim
-- is proven only after a known terminal DELETE (state deleted, terminal_at set by 0508's claim guard)
-- and the runtime's independent physical-absence result, with no hold, under 0516's raw claim lock
-- and the survivor conditions rechecked for that exact writer, generation and hash.
CREATE OR REPLACE FUNCTION lifecycle.object_delete_absent(p_claim uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 c record;catalog record;w record;answer boolean:=false;
BEGIN
 IF lifecycle.raw_restore_survivor_claim(p_claim) IS NOT TRUE THEN RETURN lifecycle.object_delete_absent_before_survivor(p_claim);END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 IF lifecycle.lock_raw_delete_claim(p_claim) IS TRUE THEN
  SELECT x.* INTO c FROM lifecycle.object_deletion_claims x WHERE x.organization_id=tenant AND x.id=p_claim;
  SELECT x.* INTO catalog FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=c.raw_document_id
   AND x.source_id=c.raw_source_id AND x.generation=0;
  SELECT x.* INTO w FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=c.raw_document_id
   ORDER BY x.generation DESC LIMIT 1;
  IF c.state IN('deleted','proven') AND c.terminal_at IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active')
   AND catalog.id IS NOT NULL AND c.object_key=catalog.object_key AND c.sha256=catalog.content_sha256
   AND c.writer_token=w.write_id AND c.generation=w.generation
   AND lifecycle.raw_restore_survivor_ready(c.raw_source_id,c.raw_source_version,c.raw_purge_job_id,c.raw_document_id,c.material_restore_generation) THEN
   IF c.state='deleted' THEN UPDATE lifecycle.object_deletion_claims SET state='proven' WHERE organization_id=tenant AND id=c.id;END IF;
   answer:=true;
  END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
--> statement-breakpoint

-- Postconditions: the public entry points keep the ACLs they had, the clones and internal predicates
-- have no runtime access, the target function is ensemus_app's only, and no runtime role gained a
-- privilege on the claim or raw inventory tables.
DO $$ BEGIN
 IF NOT has_function_privilege('ensemus_app','lifecycle.begin_object_deletion(jsonb)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.object_delete_absent(uuid)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.object_delete_terminal(uuid,text)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.raw_restore_survivor_delete_target(uuid,uuid)','EXECUTE')
  -- ensemus_agent is a member of ensemus_app and inherits this EXECUTE by design (see 0545's
  -- postcondition note). What refuses the agent is the function's own opening session_user check, so
  -- assert no direct grant beyond the owner and ensemus_app, and that the refusal is still there.
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid='lifecycle.raw_restore_survivor_delete_target(uuid,uuid)'::regprocedure
    AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND a.grantee<>'ensemus_app'::regrole::oid)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.raw_restore_survivor_delete_target(uuid,uuid)'::regprocedure
   AND p.prosecdef AND strpos(p.prosrc,'IF session_user<>''ensemus_app'' OR NOT knowledge.is_service_actor() OR tenant IS NULL')>0)
  OR has_function_privilege('ensemus_eraser','lifecycle.raw_restore_survivor_delete_target(uuid,uuid)','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.begin_object_deletion_before_survivor(jsonb)','EXECUTE')
  OR has_function_privilege('ensemus_agent','lifecycle.begin_object_deletion_before_survivor(jsonb)','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.begin_object_deletion_before_survivor(jsonb)','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.object_delete_absent_before_survivor(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_agent','lifecycle.object_delete_absent_before_survivor(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.object_delete_absent_before_survivor(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.raw_restore_survivor_ready(uuid,bigint,uuid,uuid,uuid)','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.raw_restore_survivor_claim(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_agent','lifecycle.raw_restore_survivor_claim(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.raw_restore_survivor_claim(uuid)','EXECUTE')
  OR has_table_privilege('ensemus_app','lifecycle.object_deletion_claims','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_app','lifecycle.raw_source_inventories','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_app','lifecycle.raw_object_writes','SELECT,INSERT,UPDATE,DELETE')
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.begin_object_deletion(jsonb)'::regprocedure
   AND p.prosrc LIKE '%lifecycle.begin_object_deletion_before_survivor(p_target)%')
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.object_delete_absent(uuid)'::regprocedure
   AND p.prosrc LIKE '%lifecycle.object_delete_absent_before_survivor(p_claim)%') THEN
  RAISE EXCEPTION 'RAW_RESTORE_SURVIVOR_POSTCONDITION' USING ERRCODE='EN850';END IF;
END $$;
