-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-029). Changes here need human review, never agent approval.
-- Additive repair for 0205 and 0516, which are registered and pushed, so they are not edited.
--
-- An upload whose admitted native PUT lost its response could never be recovered. finish_raw_put
-- records that outcome as 'unknown', which is terminal (guard_raw_write_change), so the writer can
-- never settle (raw_write_quiescent needs 'finished' or 'not_dispatched'). 0205's check_object_writer
-- lets an active writer only settle, so beginObjectWrite refused every retry of the same upload with
-- INVALID_STATE, forever: the document stayed 'received', unannounced and unreadable.
--
-- The repair lets that exact writer be superseded by its next generation while its source is active:
-- the retry admits and sends a fresh single-attempt PUT of the same bytes through admit_raw_put and
-- finish_raw_put, exactly like any other native write. Nothing about the lost attempt is certified:
-- its row stays 'unknown' for ever, so raw_document_writers_ready and raw_source_inventory_complete
-- still refuse to delete or complete that document's raw object, as 0516 intends for an attempt
-- that may still land. The document key and its content hash are fixed when the document is born,
-- so a late landing of the lost attempt can only write the bytes the new generation wrote.
--
-- Only a writer whose current generation is natively 'unknown', with no later generation, in the
-- current material restore generation, may be superseded. An admitted PUT that is still in flight
-- ('put_admitted'), an intent, a finished or legacy write, a closed source and every other actor
-- rule of 0205/0212 refuse exactly as before. No grant changes except EXECUTE on the new read-only
-- predicate for ensemus_app, which answers one Boolean about the caller's own tenant.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR to_regprocedure('knowledge.check_object_writer()') IS NULL
  OR to_regprocedure('lifecycle.record_raw_native_birth()') IS NULL
  OR to_regprocedure('lifecycle.admit_raw_put(uuid,uuid,bigint)') IS NULL
  OR to_regprocedure('lifecycle.finish_raw_put(uuid,uuid,bigint,text,uuid,uuid,text)') IS NULL
  OR to_regclass('lifecycle.raw_object_writes') IS NULL THEN
  RAISE EXCEPTION 'RAW_SUPERSEDE_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION lifecycle.raw_write_supersedable(p_document uuid,p_write uuid,p_generation bigint) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);answer boolean:=false;material uuid;
BEGIN
 IF session_user<>'ensemus_app' OR tenant IS NULL OR p_document IS NULL OR p_write IS NULL OR p_generation IS NULL OR p_generation<1
  OR coalesce(app.current_actor_type(),'') NOT IN('user','service') THEN RETURN false;END IF;
 material:=ai.current_material_restore_generation();
 IF material IS NULL THEN RETURN false;END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND w.document_id=p_document
   AND w.write_id=p_write AND w.generation=p_generation AND w.state='unknown' AND w.material_restore_generation=material
   AND w.put_token_sha256 IS NOT NULL AND w.admitted_at IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes later WHERE later.organization_id=tenant
    AND later.document_id=p_document AND later.generation>p_generation)) INTO answer;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_write_supersedable(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.raw_write_supersedable(uuid,uuid,bigint) TO ensemus_app;
--> statement-breakpoint
-- 0205's body, with one added branch: an active writer whose native generation is 'unknown' may move
-- to its next generation, under every check a new generation already meets (active source, exact
-- generation+1, a new write ID, the same document and source, a still-unpublished document, and the
-- writing person's own membership). Settling is unchanged.
CREATE OR REPLACE FUNCTION knowledge.check_object_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT knowledge.is_service_actor() OR OLD.state<>'settled' THEN
      RAISE EXCEPTION 'KNOWLEDGE_OBJECT_WRITER_UNCONFIRMED' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.state='active' AND NOT(NEW.state='active'
    AND lifecycle.raw_write_supersedable(OLD.document_id,OLD.write_id,OLD.generation) IS TRUE) THEN
    IF NEW.state<>'settled' OR ROW(NEW.organization_id,NEW.document_id,NEW.source_id,NEW.generation,NEW.write_id,NEW.started_at,NEW.started_by_membership_id)
      IS DISTINCT FROM ROW(OLD.organization_id,OLD.document_id,OLD.source_id,OLD.generation,OLD.write_id,OLD.started_at,OLD.started_by_membership_id)
      OR (NOT knowledge.is_service_actor() AND OLD.started_by_membership_id IS DISTINCT FROM app.current_membership_id()) THEN
      RAISE EXCEPTION 'KNOWLEDGE_OBJECT_WRITER_UNCONFIRMED' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM knowledge.sources WHERE organization_id=NEW.organization_id AND id=NEW.source_id
    AND state='active' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KNOWLEDGE_OBJECT_WRITER_UNCONFIRMED' USING ERRCODE='42501';
  END IF;
  IF NEW.state<>'active' OR (TG_OP='INSERT' AND NEW.generation<>1)
    OR (TG_OP='UPDATE' AND (NEW.generation<>OLD.generation+1 OR NEW.write_id=OLD.write_id
      OR ROW(NEW.organization_id,NEW.document_id,NEW.source_id) IS DISTINCT FROM ROW(OLD.organization_id,OLD.document_id,OLD.source_id)))
    OR NOT EXISTS(SELECT 1 FROM knowledge.sources s JOIN knowledge.documents d
      ON d.organization_id=s.organization_id AND d.source_id=s.id
      WHERE s.organization_id=NEW.organization_id AND s.id=NEW.source_id AND s.state='active'
        AND d.id=NEW.document_id AND d.state IN ('received','failed','parsing'))
    OR (NOT knowledge.is_service_actor() AND (app.current_actor_type()<>'user'
      OR NEW.started_by_membership_id IS DISTINCT FROM app.current_membership_id())) THEN
    RAISE EXCEPTION 'KNOWLEDGE_OBJECT_WRITER_UNCONFIRMED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 0516's record_raw_native_birth records a new generation only after a settled writer, and does
-- nothing for an active-to-active update. This records the superseding generation's native intent,
-- with the same identity, material generation and inventory checks 0516 applies to any new writer.
CREATE FUNCTION lifecycle.record_raw_supersede() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text:=current_setting('lifecycle.raw_object_org',true);tenant uuid;material uuid;prior record;source_scope record;catalog record;doc record;
BEGIN
 IF TG_OP<>'UPDATE' OR TG_RELID<>'knowledge.object_writers'::regclass OR session_user<>'ensemus_app'
  OR coalesce(app.current_actor_type(),'') NOT IN('user','service')
  OR OLD.state<>'active' OR NEW.state<>'active' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
  OR NEW.generation<>OLD.generation+1 OR NEW.write_id=OLD.write_id
  OR ROW(NEW.organization_id,NEW.document_id,NEW.source_id) IS DISTINCT FROM ROW(OLD.organization_id,OLD.document_id,OLD.source_id) THEN
  RAISE EXCEPTION 'RAW_SUPERSEDE_REQUIRED' USING ERRCODE='42501';END IF;
 tenant:=NEW.organization_id;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT actual.material_restore_generation INTO material FROM org.organizations actual WHERE actual.id=tenant;
 SELECT * INTO prior FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND w.document_id=OLD.document_id
  AND w.write_id=OLD.write_id AND w.generation=OLD.generation;
 SELECT * INTO source_scope FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.source_id=NEW.source_id;
 SELECT * INTO catalog FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND w.document_id=NEW.document_id AND w.generation=0;
 SELECT d.id,d.content_sha256,d.size_bytes INTO doc FROM knowledge.documents d WHERE d.organization_id=tenant AND d.id=NEW.document_id AND d.source_id=NEW.source_id;
 IF material IS NULL OR material IS DISTINCT FROM ai.current_material_restore_generation()
  OR prior.id IS NULL OR prior.state<>'unknown' OR prior.material_restore_generation IS DISTINCT FROM material
  OR EXISTS(SELECT 1 FROM lifecycle.raw_object_writes later WHERE later.organization_id=tenant AND later.document_id=NEW.document_id AND later.generation>OLD.generation)
  OR source_scope.id IS NULL OR source_scope.protocol_version<>1 OR source_scope.state<>'open' OR source_scope.material_restore_generation IS DISTINCT FROM material
  OR lifecycle.raw_org_native_admission(material) IS DISTINCT FROM true
  OR catalog.id IS NULL OR catalog.material_restore_generation IS DISTINCT FROM material OR doc.id IS NULL
  OR catalog.content_sha256 IS DISTINCT FROM doc.content_sha256 OR catalog.size_bytes IS DISTINCT FROM doc.size_bytes
  OR prior.content_sha256 IS DISTINCT FROM doc.content_sha256 OR prior.size_bytes IS DISTINCT FROM doc.size_bytes THEN
  RAISE EXCEPTION 'RAW_SUPERSEDE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 INSERT INTO lifecycle.raw_object_writes(organization_id,source_id,document_id,write_id,generation,object_key,content_sha256,size_bytes,
  material_restore_generation,state,started_by_membership_id,started_by_user_id)
 VALUES(tenant,NEW.source_id,NEW.document_id,NEW.write_id,NEW.generation,tenant::text||'/knowledge/'||NEW.document_id::text,doc.content_sha256,doc.size_bytes,
  material,'intent',NEW.started_by_membership_id,app.current_user_id());
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.record_raw_supersede() FROM PUBLIC;
CREATE TRIGGER writers_raw_supersede AFTER UPDATE ON knowledge.object_writers FOR EACH ROW
 WHEN (OLD.state='active' AND NEW.state='active') EXECUTE FUNCTION lifecycle.record_raw_supersede();
