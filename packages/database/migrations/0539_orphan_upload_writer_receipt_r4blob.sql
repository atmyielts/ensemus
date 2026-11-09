-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-029). Changes here need human review, never agent approval.
-- 0539 (r4 blob lifecycle): a proven-writer receipt for an ordinary upload whose row never arrived
-- (LIFE-01). Additive: 0508, 0516 and 0520 are registered and pushed, so they are not edited.
--
-- addArtifact writes platform.blob_lifecycle 'uploading' before its PUT and removes it when the file
-- row arrives. When the row never arrives (the Work stopped, a race lost, a crash), 0508 leaves the
-- bytes for ever: lifecycle.begin_object_deletion admits an 'ordinary' file only with a retained
-- catalog row and a tombstone, and the M8 join source says "orphan uploading rows without completion
-- remain unconfirmed", because no grace period proves that an old PUT has finished.
--
-- The writer itself is the only party that knows its PUT finished. This adds, and requires, exactly
-- that proof, as 0208/0419 do for generated writers (ai.run_output_writes):
--   * lifecycle.upload_writes: one content-free row per upload attempt (writer token, uploader, hash),
--     registered in the same transaction as the 'uploading' row, before any byte is sent. Several
--     requests that share one request-derived ID each register their own token.
--   * register_upload_write refuses a row that is not 'uploading', is tombstoned or is generated, so
--     once a row is fenced no new writer can join it.
--   * settle_upload_write is called by that same uploader ONLY after its own PUT promise fulfilled and
--     its file row did not arrive. When every registered token for the row has settled, no file row,
--     catalog row or lineage exists, and the row is still 'uploading', it fences the row ('deleting').
--     A token that never settles (a rejected or unknown PUT, a crash) keeps the row 'uploading' and
--     unconfirmed for ever, exactly as before: nothing here is age-based.
--   * begin_object_deletion admits such a fenced, fully settled orphan as an 'ordinary' claim with the
--     same tenant lock, legal-hold refusal, restore-debt refusal, single-unresolved-claim rule and
--     claim shape (writer_token = artifact, generation 1) as 0508's ordinary branch. Every other
--     target, and every ordinary target with a catalog row or with no registered writer, is handed to
--     the unchanged previous definition. object_delete_terminal/object_delete_absent are unchanged and
--     move the row to 'purged' only after a known DELETE and an independent absence check.
--   * artifact_delete_target names such an orphan as {kind:'ordinary'} even without a tombstone (an
--     orphan has no file row to block, and a tenant-wide legal hold would refuse the tombstone that
--     0501 places first). Every other artifact keeps the previous answer.
-- No grant on any existing table changes. The new table has forced RLS, no app/agent/eraser grant and
-- is retained lifecycle evidence (lifecycle.retained_table), like object_deletion_claims.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'UPLOAD_WRITER_RECEIPT_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('lifecycle.begin_object_deletion(jsonb)') IS NULL
  OR to_regprocedure('lifecycle.begin_object_deletion_before_raw(jsonb)') IS NULL
  OR to_regprocedure('lifecycle.artifact_delete_target(uuid)') IS NULL
  OR to_regprocedure('lifecycle.lock_delete_tenant()') IS NULL
  OR to_regprocedure('app.reject_change()') IS NULL
  OR to_regclass('lifecycle.object_deletion_claims') IS NULL OR to_regclass('lifecycle.object_restore_debts') IS NULL
  OR to_regclass('platform.blob_lifecycle') IS NULL OR to_regclass('platform.tombstones') IS NULL
  OR to_regclass('knowledge.artifact_acl_catalog') IS NULL OR to_regclass('knowledge.artifact_lineage') IS NULL
  OR lifecycle.retained_table('lifecycle','upload_writes') IS DISTINCT FROM true
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='platform.blob_lifecycle'::regclass AND p.polname='deletion_blob_metadata')
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='work.artifacts'::regclass AND p.polname='artifact_0208_maintenance_read')
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='platform.tombstones'::regclass AND p.polname='artifact_0208_tombstone_control') THEN
  RAISE EXCEPTION 'UPLOAD_WRITER_RECEIPT_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE lifecycle.upload_writes(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),
 artifact_id uuid NOT NULL, write_id uuid NOT NULL, membership_id uuid NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN('registered','settled')),
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp(), settled_at timestamptz,
 PRIMARY KEY(organization_id,artifact_id,write_id),
 CONSTRAINT upload_write_settlement CHECK((state='settled')=(settled_at IS NOT NULL))
);
ALTER TABLE lifecycle.upload_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.upload_writes FORCE ROW LEVEL SECURITY;
CREATE POLICY upload_write_fixed_owner ON lifecycle.upload_writes TO ensemus_migrator
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
REVOKE ALL ON lifecycle.upload_writes FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser;
CREATE FUNCTION lifecycle.guard_upload_write_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'lifecycle.upload_writes'::regclass OR TG_OP<>'UPDATE'
  OR ROW(NEW.organization_id,NEW.artifact_id,NEW.write_id,NEW.membership_id,NEW.sha256,NEW.registered_at)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.artifact_id,OLD.write_id,OLD.membership_id,OLD.sha256,OLD.registered_at)
  OR OLD.state<>'registered' OR NEW.state<>'settled' THEN
  RAISE EXCEPTION 'IMMUTABLE_UPLOAD_WRITE' USING ERRCODE='EN850';END IF;
 NEW.settled_at:=clock_timestamp();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.guard_upload_write_change() FROM PUBLIC;
CREATE TRIGGER upload_write_settle_only BEFORE UPDATE ON lifecycle.upload_writes FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_upload_write_change();
CREATE TRIGGER upload_write_keep BEFORE DELETE OR TRUNCATE ON lifecycle.upload_writes FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
-- Internal only (no EXECUTE for any runtime role). The orphan's key and its single hash, only while
-- its row is fenced, every registered writer settled, and it never became a file of any kind.
CREATE FUNCTION lifecycle.abandoned_upload(p_artifact uuid) RETURNS TABLE(object_key text,sha256 text)
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT b.object_key,min(w.sha256)
  FROM platform.blob_lifecycle b JOIN lifecycle.upload_writes w
   ON w.organization_id=b.organization_id AND w.artifact_id=b.artifact_id
  WHERE b.organization_id=app.current_organization_id() AND b.artifact_id=p_artifact AND b.state='deleting'
   AND b.object_key=b.organization_id::text||'/artifacts/'||b.artifact_id::text
   AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=b.organization_id AND a.artifact_id=b.artifact_id)
   AND NOT EXISTS(SELECT 1 FROM work.artifacts f WHERE f.organization_id=b.organization_id AND f.id=b.artifact_id)
   AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_lineage l WHERE l.organization_id=b.organization_id AND l.artifact_id=b.artifact_id)
  GROUP BY b.object_key
  HAVING bool_and(w.state='settled') AND count(DISTINCT w.sha256)=1
$$;
REVOKE ALL ON FUNCTION lifecycle.abandoned_upload(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Same transaction as the 'uploading' row, before the PUT. The native app login acting as the
-- uploading person only (ensemus_agent inherits the EXECUTE grant, and its session is refused here);
-- the row lock serializes against settlement and admission.
CREATE FUNCTION lifecycle.register_upload_write(p_artifact uuid,p_write uuid,p_sha256 text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();blob_state text;blob_key text;
BEGIN
 IF session_user<>'ensemus_app' OR tenant IS NULL OR app.current_actor_type() IS DISTINCT FROM 'user'
  OR app.current_membership_id() IS NULL OR p_artifact IS NULL OR p_write IS NULL
  OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'UPLOAD_WRITE_REFUSED' USING ERRCODE='42501';END IF;
 SELECT b.state,b.object_key INTO blob_state,blob_key FROM platform.blob_lifecycle b
  WHERE b.organization_id=tenant AND b.artifact_id=p_artifact FOR UPDATE;
 IF blob_state IS DISTINCT FROM 'uploading' OR blob_key IS DISTINCT FROM tenant::text||'/artifacts/'||p_artifact::text
  OR EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=tenant AND t.target_type='artifact' AND t.target_id=p_artifact)
  OR EXISTS(SELECT 1 FROM knowledge.artifact_lineage l WHERE l.organization_id=tenant AND l.artifact_id=p_artifact) THEN
  RETURN false;END IF;
 INSERT INTO lifecycle.upload_writes(organization_id,artifact_id,write_id,membership_id,sha256,state)
  VALUES(tenant,p_artifact,p_write,app.current_membership_id(),p_sha256,'registered');
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION lifecycle.register_upload_write(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.register_upload_write(uuid,uuid,text) TO ensemus_app;
--> statement-breakpoint
-- The trusted uploader calls this ONLY after its exact PUT promise fulfilled and its file row did not
-- arrive. A rejected or unknown PUT never calls it. Answers 'fenced' when this was the last writer
-- of a row that never became a file, 'pending' while another registered writer has not settled,
-- 'kept' when the row became a file (or is already fenced), and 'unknown' for no such open token.
CREATE FUNCTION lifecycle.settle_upload_write(p_artifact uuid,p_write uuid) RETURNS text
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
REVOKE ALL ON FUNCTION lifecycle.settle_upload_write(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.settle_upload_write(uuid,uuid) TO ensemus_app;
--> statement-breakpoint
-- Clone the two fixed reviewed public definitions, as 0516 did, keeping their public OIDs and ACLs.
DO $$ DECLARE item record;definition text;header text;BEGIN
 FOR item IN SELECT * FROM(VALUES
  ('lifecycle.begin_object_deletion(jsonb)','begin_object_deletion','begin_object_deletion_before_upload'),
  ('lifecycle.artifact_delete_target(uuid)','artifact_delete_target','artifact_delete_target_before_upload')
 ) fixed(signature,name,clone) LOOP
  definition:=pg_get_functiondef(item.signature::regprocedure);header:='CREATE OR REPLACE FUNCTION lifecycle.'||item.name||'(';
  IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'UPLOAD_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
  EXECUTE replace(definition,header,'CREATE OR REPLACE FUNCTION lifecycle.'||item.clone||'(');
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION lifecycle.begin_object_deletion_before_upload(jsonb),lifecycle.artifact_delete_target_before_upload(uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle.artifact_delete_target(p_artifact uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_artifact IS NOT NULL AND EXISTS(SELECT 1 FROM lifecycle.abandoned_upload(p_artifact)) THEN
  PERFORM lifecycle.lock_delete_tenant();
  IF coalesce(app.current_actor_type(),'') NOT IN('user','service') THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('kind','ordinary','artifactId',p_artifact);
 END IF;
 RETURN lifecycle.artifact_delete_target_before_upload(p_artifact);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle.begin_object_deletion(p_target jsonb)
 RETURNS TABLE(state text,claim_id uuid,object_key text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();target uuid;blob_state text;key_text text;hash_text text;new_claim uuid;
 previous lifecycle.object_deletion_claims%ROWTYPE;
BEGIN
 IF p_target->>'kind' IS DISTINCT FROM 'ordinary' THEN
  RETURN QUERY SELECT * FROM lifecycle.begin_object_deletion_before_upload(p_target);RETURN;END IF;
 target:=(p_target->>'artifactId')::uuid;
 -- A published file (it has a catalog row) and an ordinary target with no writer receipt keep 0508.
 IF target IS NULL OR EXISTS(SELECT 1 FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=tenant AND a.artifact_id=target)
  OR NOT EXISTS(SELECT 1 FROM lifecycle.upload_writes w WHERE w.organization_id=tenant AND w.artifact_id=target) THEN
  RETURN QUERY SELECT * FROM lifecycle.begin_object_deletion_before_upload(p_target);RETURN;END IF;
 PERFORM lifecycle.lock_delete_tenant();
 IF coalesce(app.current_actor_type(),'') NOT IN('user','service') THEN
  RAISE EXCEPTION 'OBJECT_DELETE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active') THEN
  RETURN QUERY SELECT 'held'::text,NULL::uuid,NULL::text;RETURN;END IF;
 SELECT b.state INTO blob_state FROM platform.blob_lifecycle b WHERE b.organization_id=tenant AND b.artifact_id=target FOR UPDATE;
 SELECT a.object_key,a.sha256 INTO key_text,hash_text FROM lifecycle.abandoned_upload(target) a;
 IF blob_state IS DISTINCT FROM 'deleting' OR key_text IS NULL OR hash_text IS NULL
  OR EXISTS(SELECT 1 FROM lifecycle.object_restore_debts d WHERE d.organization_id=tenant AND d.object_key=key_text) THEN
  RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;RETURN;END IF;
 SELECT * INTO previous FROM lifecycle.object_deletion_claims c
  WHERE c.organization_id=tenant AND c.object_key=key_text AND c.state<>'proven' FOR UPDATE;
 IF FOUND THEN
  IF previous.kind='ordinary' AND previous.artifact_id=target AND previous.import_id IS NULL AND previous.writer_token=target
   AND previous.generation=1 AND previous.sha256=hash_text AND previous.state='deleted' THEN
   RETURN QUERY SELECT 'deleted'::text,previous.id,previous.object_key;
  ELSE RETURN QUERY SELECT 'unconfirmed'::text,NULL::uuid,NULL::text;END IF;
  RETURN;
 END IF;
 INSERT INTO lifecycle.object_deletion_claims(organization_id,kind,artifact_id,import_id,writer_token,generation,object_key,sha256,state)
  VALUES(tenant,'ordinary',target,NULL,target,1,key_text,hash_text,'admitted') RETURNING id INTO new_claim;
 RETURN QUERY SELECT 'admitted'::text,new_claim,key_text;
END $$;
--> statement-breakpoint
-- Postconditions: fixed ACLs, forced RLS and no runtime access to the internal helper or the clones.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='lifecycle.upload_writes'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
  OR has_table_privilege('ensemus_app','lifecycle.upload_writes','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_agent','lifecycle.upload_writes','SELECT,INSERT,UPDATE,DELETE')
  OR has_function_privilege('ensemus_app','lifecycle.abandoned_upload(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.begin_object_deletion_before_upload(jsonb)','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.artifact_delete_target_before_upload(uuid)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.register_upload_write(uuid,uuid,text)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.settle_upload_write(uuid,uuid)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.begin_object_deletion(jsonb)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.artifact_delete_target(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'UPLOAD_WRITER_RECEIPT_POSTCONDITION' USING ERRCODE='EN850';END IF;
END $$;
