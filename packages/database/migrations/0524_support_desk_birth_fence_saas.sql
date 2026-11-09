-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- 0524 (saas): additive repair for registered 0508/0515, which are pushed, so they are not edited.
--
-- 0507 (human reviewed) gives support.tickets and support.ticket_messages their own erasure fence,
-- support.fence_erasing_content(), for every writer including the desk role. ensemus_support reads
-- every tenant's queue and is deliberately never bound to a tenant: it cannot read org.* at all, and
-- 0507's fixed trigger locks the row's actual organization FOR NO KEY UPDATE NOWAIT (EN807 when busy)
-- and refuses a lifecycle outside active/read_only/suspended/offboarding, an unknown stage, an
-- offboarding with no stage, and every erasing/verified/reported stage (25006).
--
-- 0508 then installed lifecycle.refuse_erasing_birth() on every tenant table, support's two content
-- tables included, and it first requires NEW.organization_id = app.current_organization_id(). The
-- unbound desk role can never satisfy that, so since 0508 every desk reply (replyAsDesk, the only
-- production desk write) failed with INVALID_ERASURE_BIRTH_TENANT (42501) before 0507's fence ran,
-- and 0507's EN807/25006 contract was unreachable (saas-support CI, run 42587577445).
--
-- For exactly those two tables, and only while 0507's own fixed trigger is installed and enabled on
-- the table, the generic birth fence now defers to it. 0507 refuses every birth 0508 refuses
-- (no organization row, a deleted tenant, an erasing/verified/reported offboarding) and more, and it
-- takes a stronger lock on the same organization row, so births still serialize with the eraser's
-- tenant barrier. A customer's write is still bound to its own tenant by RLS (customer_write and the
-- tickets tenant policy); the desk role keeps its support-only grants and author_kind policy; the
-- composite (organization_id, ticket_id) foreign key still refuses relabelling another tenant's
-- ticket. Every other table, including support.break_glass_*, keeps 0515's body unchanged.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'SUPPORT_BIRTH_FENCE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('lifecycle.refuse_erasing_birth()') IS NULL OR to_regprocedure('support.fence_erasing_content()') IS NULL
  OR to_regclass('support.tickets') IS NULL OR to_regclass('support.ticket_messages') IS NULL THEN
  RAISE EXCEPTION 'SUPPORT_BIRTH_FENCE_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
 IF (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid IN('support.tickets'::regclass,'support.ticket_messages'::regclass)
   AND g.tgname='support_content_write_fence' AND g.tgfoid='support.fence_erasing_content()'::regprocedure
   AND g.tgenabled IN('O','A') AND NOT g.tgisinternal)<>2 THEN
  RAISE EXCEPTION 'SUPPORT_CONTENT_FENCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
-- 0515's text, with only the support-content deferral added after the fixed target check.
CREATE OR REPLACE FUNCTION lifecycle.refuse_erasing_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid;life text;proof_append boolean:=false;
BEGIN
  IF TG_OP<>'INSERT' OR (TG_TABLE_SCHEMA NOT IN('ai','org','work','knowledge','integrations','secrets','studio','objects','packs','experience','sovereign','support','platform')
    AND (TG_TABLE_SCHEMA,TG_TABLE_NAME) NOT IN(('lifecycle','raw_source_inventories'),('lifecycle','raw_object_writes')))
    OR TG_RELID IS DISTINCT FROM to_regclass(quote_ident(TG_TABLE_SCHEMA)||'.'||quote_ident(TG_TABLE_NAME)) THEN
    RAISE EXCEPTION 'INVALID_ERASURE_BIRTH_TARGET' USING ERRCODE='42501';END IF;
  -- 0507's fixed support-content fence owns these two births, for the customer and the unbound desk.
  IF TG_RELID IN('support.tickets'::regclass,'support.ticket_messages'::regclass)
    AND EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=TG_RELID AND g.tgname='support_content_write_fence'
      AND g.tgfoid='support.fence_erasing_content()'::regprocedure AND g.tgenabled IN('O','A') AND NOT g.tgisinternal) THEN
    RETURN NEW;END IF;
  tenant:=NEW.organization_id;
  IF tenant IS NULL OR tenant IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'INVALID_ERASURE_BIRTH_TENANT' USING ERRCODE='42501';END IF;
  SELECT actual.lifecycle INTO life FROM org.organizations actual WHERE actual.id=tenant FOR SHARE NOWAIT;
  IF NOT FOUND OR life='deleted' THEN RAISE EXCEPTION 'TENANT_ERASURE_IN_PROGRESS' USING ERRCODE='EN850';END IF;
  IF EXISTS(SELECT 1 FROM lifecycle.offboardings actual WHERE actual.organization_id=tenant AND actual.state IN('erasing','verified','reported')) THEN
    IF session_user='ensemus_agent' AND knowledge.is_service_actor()
      AND EXISTS(SELECT 1 FROM lifecycle.offboardings actual WHERE actual.organization_id=tenant AND actual.state='erasing'
        AND lifecycle.admitted_offboarding(actual.id)) THEN
      -- Separate RELID branches are necessary: PostgreSQL resolves record fields before a Boolean
      -- short circuit, and these three protected row types intentionally have different fields.
      IF TG_RELID='ai.source_run_closures'::regclass THEN
        proof_append:=NEW.restore_generation=ai.current_material_restore_generation() AND NEW.fence_generation=1;
      ELSIF TG_RELID='ai.record_run_closures'::regclass THEN
        proof_append:=NEW.restore_generation=ai.current_material_restore_generation() AND NEW.fence_generation=1;
      ELSIF TG_RELID='ai.record_purge_jobs'::regclass THEN
        proof_append:=NEW.snapshot_sha256=ai.lock_record_purge_snapshot(NEW.record_kind,NEW.record_id)
          AND NEW.checked_at IS NULL AND NEW.restore_generation IS NULL;
      END IF;
    END IF;
    IF proof_append IS DISTINCT FROM true THEN RAISE EXCEPTION 'TENANT_ERASURE_IN_PROGRESS' USING ERRCODE='EN850';END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lifecycle.refuse_erasing_birth() FROM PUBLIC;
