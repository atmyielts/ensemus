-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-029). Changes here need human review, never agent approval.
-- Additive repairs for 0516, which is registered and pushed, so it is not edited. Both defects stop
-- the native raw Knowledge lifecycle for every tenant; neither repair widens who may act.
--
-- 1. lifecycle.admit_raw_put is SECURITY DEFINER (owner ensemus_migrator, which obeys FORCE RLS) and,
-- for a person, calls knowledge.assert_human_source_authority(...,true). That check reads
-- knowledge.readable_source_ids(current membership), which needs the source's grants and the caller's
-- own team memberships. 0516 gave the migrator raw-scope metadata policies on sources, documents and
-- the caller's own membership, but none on knowledge.source_grants or org.team_memberships, so the
-- readable-upload check saw no grant and refused every human upload with
-- SOURCE_READABLE_UPLOAD_REQUIRED, including the uploader's own always-written membership grant.
-- The two read-only policies below apply only while a raw lifecycle function has set
-- lifecycle.raw_object_org to the current tenant (lifecycle.raw_metadata_scope), only to the migrator,
-- and only to the rows readable_source_ids consults for the calling person: their own membership
-- grants, organization/team grants (whose class narrowing stays in readable_source_ids), and their own
-- team memberships. No write, other tenant, other person's team list, or runtime-role grant changes.
-- The readable-upload requirement itself is unchanged.
--
-- 2. 0516's lifecycle.begin_object_deletion declared a PL/pgSQL variable named "version" and compared
-- it as s.version=version, which PostgreSQL rejects as an ambiguous column reference (42702) on every
-- raw_source call, so no closed source's raw object could ever be admitted for deletion. The body
-- below is 0516's text with that variable renamed to raw_version and nothing else changed: the same
-- service-only caller, exact target keys, restore generations, source/org/job lock order, hold check,
-- exact-target recheck and claim insert. CREATE OR REPLACE keeps the function's OID and 0516's ACL.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR to_regprocedure('lifecycle.raw_metadata_scope(uuid)') IS NULL
  OR to_regprocedure('lifecycle.admit_raw_put(uuid,uuid,bigint)') IS NULL
  OR to_regprocedure('lifecycle.begin_object_deletion_before_raw(jsonb)') IS NULL
  OR to_regprocedure('lifecycle.raw_document_delete_target(uuid)') IS NULL
  OR to_regprocedure('knowledge.readable_source_ids(uuid)') IS NULL THEN
  RAISE EXCEPTION 'RAW_LIFECYCLE_REPAIR_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE POLICY raw_grant_metadata ON knowledge.source_grants FOR SELECT TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id)
  AND(membership_id=app.current_membership_id() OR principal_kind IN('organization','team')));
CREATE POLICY raw_team_metadata ON org.team_memberships FOR SELECT TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id) AND membership_id=app.current_membership_id());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle.begin_object_deletion(p_target jsonb)
 RETURNS TABLE(state text,claim_id uuid,object_key text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);actual jsonb;c record;w record;i record;old_claim record;
 source_key uuid;doc_key uuid;job_key uuid;raw_version bigint;material uuid;auth uuid;keys text[];
BEGIN
 IF p_target->>'kind' IS DISTINCT FROM 'raw_source' THEN RETURN QUERY SELECT * FROM lifecycle.begin_object_deletion_before_raw(p_target);RETURN;END IF;
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN RAISE EXCEPTION 'RAW_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(p_target) k;
 IF keys IS DISTINCT FROM ARRAY['authRestoreGeneration','documentId','generation','kind','materialRestoreGeneration','purgeJobId','sourceId','sourceVersion','writeId']::text[] THEN
  RAISE EXCEPTION 'RAW_TARGET_REQUIRED' USING ERRCODE='EN850';END IF;
 source_key:=(p_target->>'sourceId')::uuid;doc_key:=(p_target->>'documentId')::uuid;job_key:=(p_target->>'purgeJobId')::uuid;raw_version:=(p_target->>'sourceVersion')::bigint;
 material:=ai.current_material_restore_generation();auth:=app.current_auth_restore_generation();
 IF material IS NULL OR auth IS NULL OR material IS DISTINCT FROM(p_target->>'materialRestoreGeneration')::uuid OR auth IS DISTINCT FROM(p_target->>'authRestoreGeneration')::uuid THEN
  RAISE EXCEPTION 'RAW_RESTORE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 -- Source ->organization NOWAIT ->job/inventory/claim. A hold and this admission share the org row.
 PERFORM s.id FROM knowledge.sources s WHERE s.organization_id=tenant AND s.id=source_key AND s.state IN('revoked','deleted') AND s.version=raw_version FOR SHARE NOWAIT;
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
   IF old_claim.kind='raw_source' AND old_claim.raw_source_id=source_key AND old_claim.raw_source_version=raw_version AND old_claim.raw_purge_job_id=job_key
    AND old_claim.raw_document_id=doc_key AND old_claim.writer_token=w.write_id AND old_claim.generation=w.generation AND old_claim.sha256=c.content_sha256
    AND old_claim.material_restore_generation=material AND old_claim.auth_restore_generation=auth AND old_claim.state IN('deleted','proven') THEN
    RETURN QUERY SELECT 'deleted'::text,old_claim.id,c.object_key;
   ELSE RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;END IF;
  ELSE
   INSERT INTO lifecycle.object_deletion_claims(organization_id,kind,artifact_id,raw_source_id,raw_source_version,raw_purge_job_id,raw_document_id,
    writer_token,generation,object_key,sha256,state,material_restore_generation,auth_restore_generation)
    VALUES(tenant,'raw_source',NULL,source_key,raw_version,job_key,doc_key,w.write_id,w.generation,c.object_key,c.content_sha256,'admitted',material,auth) RETURNING id INTO claim_id;
   RETURN QUERY SELECT 'admitted'::text,claim_id,c.object_key;
  END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
