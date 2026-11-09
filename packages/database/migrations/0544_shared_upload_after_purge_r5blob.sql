-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-029). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW: written by an agent in CI repair round 5 (g6, check finding 11)
-- and not yet reviewed by a person. It changes the deletion authority's proof step for ordinary files.
--
-- 0544 (r5 blob uploads): a sharing upload writer whose PUT lands after the shared file was deleted
-- and purged (LIFE-01). Additive: 0508, 0516 and 0539 are registered and pushed, so they are not edited.
--
-- 0539 lets several requests that share one request-derived artifact ID each register a writer token
-- while the row is 'uploading'. The first to finish publishes the file, which removes the row. The
-- file can then be deleted (tombstone, row 'deleting') and purged (claim proven, row 'purged') while a
-- second registered writer is still sending the same bytes. Its PUT then lands on the purged key: the
-- deleted file's bytes are back, its publication is refused (ARTIFACT_DELETED), and 0539's
-- settle_upload_write answered 'kept' because the row was no longer 'uploading'. Nothing tracked
-- those bytes again; no sweep revisits a 'purged' row.
--
-- The late writer is the only party that knows its PUT finished, and it says so by settling (it does
-- so ONLY after its exact PUT promise fulfilled). This makes that settlement, and the proof step it
-- can race, put the key back on the owed list:
--   * settle_upload_write, for a token that settles on a deleted file (tombstoned, no file row, an
--     ordinary catalog entry, no generated lineage) whose row is 'purged', returns the row to
--     'deleting' and answers 'owed'; on a row still 'deleting' it answers 'owed' and changes nothing.
--     Every other case keeps 0539's answer. Registration is unchanged: 0539 already refuses a row
--     that is not 'uploading' or is tombstoned, so no writer can join a deleted or purged row.
--   * object_delete_absent keeps its answer for the claim, and then, for an ordinary claim, returns
--     the row to 'deleting' when any writer of that artifact settled at or after the claim was
--     admitted. Such a PUT may have landed after the claim's DELETE (or after its absence check), so
--     that claim proves nothing about its bytes. A writer that settled before the claim was admitted
--     finished before the DELETE was sent, and that DELETE removed its bytes.
-- An owed row is then deleted by the unchanged 0508 ordinary branch: tenant lock, legal-hold refusal,
-- restore-debt refusal, single-unresolved-claim rule, a new claim (the earlier one is proven), one
-- DELETE and an independent absence check before 'purged'. A writer that never settles (a rejected or
-- unknown PUT, a crash) stays unconfirmed exactly as before: nothing here is age-based.
-- No table, column, grant or policy changes. The clone below gets no runtime EXECUTE.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'SHARED_UPLOAD_AFTER_PURGE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('lifecycle.settle_upload_write(uuid,uuid)') IS NULL
  OR to_regprocedure('lifecycle.register_upload_write(uuid,uuid,text)') IS NULL
  OR to_regprocedure('lifecycle.object_delete_absent(uuid)') IS NULL
  OR to_regprocedure('lifecycle.object_delete_absent_before_raw(uuid)') IS NULL
  OR to_regclass('lifecycle.upload_writes') IS NULL OR to_regclass('lifecycle.object_deletion_claims') IS NULL
  OR to_regclass('platform.blob_lifecycle') IS NULL OR to_regclass('platform.tombstones') IS NULL
  OR to_regclass('knowledge.artifact_acl_catalog') IS NULL OR to_regclass('knowledge.artifact_lineage') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='platform.blob_lifecycle'::regclass AND p.polname='deletion_blob_metadata')
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='lifecycle.upload_writes'::regclass AND p.polname='upload_write_fixed_owner') THEN
  RAISE EXCEPTION 'SHARED_UPLOAD_AFTER_PURGE_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
-- 0539's body, with one added branch before its 'kept' answer. Same signature, owner and ACL.
CREATE OR REPLACE FUNCTION lifecycle.settle_upload_write(p_artifact uuid,p_write uuid) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();blob_state text;
BEGIN
 IF session_user<>'ensemus_app' OR tenant IS NULL OR app.current_actor_type() IS DISTINCT FROM 'user'
  OR app.current_membership_id() IS NULL OR p_artifact IS NULL OR p_write IS NULL THEN
  RAISE EXCEPTION 'UPLOAD_WRITE_REFUSED' USING ERRCODE='42501';END IF;
 SELECT b.state INTO blob_state FROM platform.blob_lifecycle b
  WHERE b.organization_id=tenant AND b.artifact_id=p_artifact FOR UPDATE;
 UPDATE lifecycle.upload_writes w SET state='settled' WHERE w.organization_id=tenant AND w.artifact_id=p_artifact
  AND w.write_id=p_write AND w.membership_id=app.current_membership_id() AND w.state='registered';
 IF NOT FOUND THEN RETURN 'unknown';END IF;
 -- 0544: the file this writer shared was deleted meanwhile, so these bytes may have landed after its
 -- purge. The key is owed again; the ordinary deletion authority removes it and proves it gone.
 IF blob_state IN('deleting','purged')
  AND EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=tenant AND t.target_type='artifact' AND t.target_id=p_artifact)
  AND EXISTS(SELECT 1 FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=tenant AND a.artifact_id=p_artifact
   AND NOT a.alive AND a.provenance_state='ordinary')
  AND NOT EXISTS(SELECT 1 FROM work.artifacts f WHERE f.organization_id=tenant AND f.id=p_artifact)
  AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_lineage l WHERE l.organization_id=tenant AND l.artifact_id=p_artifact) THEN
  IF blob_state='purged' THEN
   UPDATE platform.blob_lifecycle b SET state='deleting',purged_at=NULL
    WHERE b.organization_id=tenant AND b.artifact_id=p_artifact AND b.state='purged'
     AND b.object_key=tenant::text||'/artifacts/'||p_artifact::text;
   IF NOT FOUND THEN RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  END IF;
  RETURN 'owed';
 END IF;
 IF blob_state IS DISTINCT FROM 'uploading'
  OR EXISTS(SELECT 1 FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=tenant AND a.artifact_id=p_artifact)
  OR EXISTS(SELECT 1 FROM work.artifacts f WHERE f.organization_id=tenant AND f.id=p_artifact)
  OR EXISTS(SELECT 1 FROM knowledge.artifact_lineage l WHERE l.organization_id=tenant AND l.artifact_id=p_artifact) THEN
  RETURN 'kept';END IF;
 IF EXISTS(SELECT 1 FROM lifecycle.upload_writes w WHERE w.organization_id=tenant AND w.artifact_id=p_artifact
  AND w.state='registered') THEN RETURN 'pending';END IF;
 UPDATE platform.blob_lifecycle b SET state='deleting'
  WHERE b.organization_id=tenant AND b.artifact_id=p_artifact AND b.state='uploading';
 IF NOT FOUND THEN RETURN 'kept';END IF;
 RETURN 'fenced';
END $$;
--> statement-breakpoint
-- Clone the fixed reviewed public proof step, as 0516 and 0539 did, keeping its public OID and ACL.
DO $$ DECLARE definition text;header text;BEGIN
 definition:=pg_get_functiondef('lifecycle.object_delete_absent(uuid)'::regprocedure);
 header:='CREATE OR REPLACE FUNCTION lifecycle.object_delete_absent(';
 IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'SHARED_UPLOAD_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,header,'CREATE OR REPLACE FUNCTION lifecycle.object_delete_absent_before_late_upload(');
END $$;
REVOKE ALL ON FUNCTION lifecycle.object_delete_absent_before_late_upload(uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle.object_delete_absent(p_claim uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE answer boolean;c record;
BEGIN
 answer:=lifecycle.object_delete_absent_before_late_upload(p_claim);
 IF answer IS TRUE THEN
  SELECT x.organization_id,x.kind,x.artifact_id,x.object_key,x.admitted_at,x.state INTO c FROM lifecycle.object_deletion_claims x
   WHERE x.organization_id=app.current_organization_id() AND x.id=p_claim;
  -- A writer that settled at or after this claim was admitted may have put its bytes back after the
  -- DELETE; this claim proves nothing about them, so the key is owed again (see the header).
  IF c.kind='ordinary' AND c.state='proven' AND EXISTS(SELECT 1 FROM lifecycle.upload_writes w
   WHERE w.organization_id=c.organization_id AND w.artifact_id=c.artifact_id AND w.state='settled' AND w.settled_at>=c.admitted_at) THEN
   UPDATE platform.blob_lifecycle b SET state='deleting',purged_at=NULL WHERE b.organization_id=c.organization_id
    AND b.artifact_id=c.artifact_id AND b.object_key=c.object_key AND b.state='purged';
  END IF;
 END IF;
 RETURN answer;
END $$;
--> statement-breakpoint
-- Postconditions: the public ACLs are unchanged and the clone has no runtime access.
DO $$ BEGIN
 IF has_function_privilege('ensemus_app','lifecycle.object_delete_absent_before_late_upload(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_agent','lifecycle.object_delete_absent_before_late_upload(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.object_delete_absent_before_late_upload(uuid)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.object_delete_absent(uuid)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.settle_upload_write(uuid,uuid)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.register_upload_write(uuid,uuid,text)','EXECUTE')
  OR has_table_privilege('ensemus_app','lifecycle.upload_writes','SELECT,INSERT,UPDATE,DELETE') THEN
  RAISE EXCEPTION 'SHARED_UPLOAD_AFTER_PURGE_POSTCONDITION' USING ERRCODE='EN850';END IF;
END $$;
