-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- 0532 (harden-saas): additive repair for registered 0529, which is pushed, so it is not edited.
--
-- 0529 made lifecycle.refuse_erasing_birth() return before 0508's tenant binding
-- (NEW.organization_id = app.current_organization_id()) and before its lifecycle check for
-- support.tickets and support.ticket_messages. That dropped the birth fence's tenant binding for
-- every writer of those two tables, the customer role included, and left only 0507's fence.
--
-- This restores 0515's body for every table, support's two included: a birth must name the tenant
-- the transaction is bound to, and that tenant must exist, not be deleted and have no
-- erasing/verified/reported offboarding. The desk is not exempt. It binds app.organization_id to the
-- tenant of the ticket it has just locked (replyAsDesk, requestBreakGlass), which is the tenant its
-- write must name anyway: 0501 desk_write admits any tenant, so the binding plus the composite
-- (organization_id, ticket_id) foreign key is what pins a desk message to the ticket's own tenant.
--
-- For these two tables only, the refusals keep 0507's published desk contract: a busy organization
-- row (NOWAIT) is EN807 SUPPORT_CONTENT_BUSY, which replyAsDesk reports as retryable, and an erased or
-- erasing tenant is 25006 SUPPORT_CONTENT_ERASURE_FENCED. The refused set is exactly 0508's. 0507's
-- own fixed trigger still runs after this one and keeps its stricter checks. Every other table keeps
-- 0515's body and codes unchanged. SECURITY DEFINER, search_path and the PUBLIC revoke are unchanged.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'SUPPORT_BIRTH_BINDING_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('lifecycle.refuse_erasing_birth()') IS NULL OR to_regprocedure('support.fence_erasing_content()') IS NULL
  OR to_regclass('support.tickets') IS NULL OR to_regclass('support.ticket_messages') IS NULL THEN
  RAISE EXCEPTION 'SUPPORT_BIRTH_BINDING_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
 IF (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid IN('support.tickets'::regclass,'support.ticket_messages'::regclass)
   AND g.tgname='lifecycle_erasure_birth_fence' AND g.tgfoid='lifecycle.refuse_erasing_birth()'::regprocedure
   AND g.tgenabled IN('O','A') AND NOT g.tgisinternal)<>2 THEN
  RAISE EXCEPTION 'SUPPORT_BIRTH_FENCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
-- 0515's text, with only the support-content refusal codes added after the restored tenant binding.
CREATE OR REPLACE FUNCTION lifecycle.refuse_erasing_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid;life text;proof_append boolean:=false;org_found boolean:=false;
BEGIN
  IF TG_OP<>'INSERT' OR (TG_TABLE_SCHEMA NOT IN('ai','org','work','knowledge','integrations','secrets','studio','objects','packs','experience','sovereign','support','platform')
    AND (TG_TABLE_SCHEMA,TG_TABLE_NAME) NOT IN(('lifecycle','raw_source_inventories'),('lifecycle','raw_object_writes')))
    OR TG_RELID IS DISTINCT FROM to_regclass(quote_ident(TG_TABLE_SCHEMA)||'.'||quote_ident(TG_TABLE_NAME)) THEN
    RAISE EXCEPTION 'INVALID_ERASURE_BIRTH_TARGET' USING ERRCODE='42501';END IF;
  tenant:=NEW.organization_id;
  IF tenant IS NULL OR tenant IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'INVALID_ERASURE_BIRTH_TENANT' USING ERRCODE='42501';END IF;
  -- Support content: the same bound tenant and the same refusals, under 0507's desk-facing codes.
  IF TG_RELID IN('support.tickets'::regclass,'support.ticket_messages'::regclass) THEN
    BEGIN
      SELECT actual.lifecycle INTO life FROM org.organizations actual WHERE actual.id=tenant FOR SHARE NOWAIT;
      org_found:=FOUND;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'SUPPORT_CONTENT_BUSY' USING ERRCODE='EN807';
    END;
    IF NOT org_found OR life='deleted' OR EXISTS(SELECT 1 FROM lifecycle.offboardings actual
      WHERE actual.organization_id=tenant AND actual.state IN('erasing','verified','reported')) THEN
      RAISE EXCEPTION 'SUPPORT_CONTENT_ERASURE_FENCED' USING ERRCODE='25006';END IF;
    RETURN NEW;
  END IF;
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
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.refuse_erasing_birth()'::regprocedure
   AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'])
  OR has_function_privilege('public','lifecycle.refuse_erasing_birth()','EXECUTE') THEN
  RAISE EXCEPTION 'SUPPORT_BIRTH_BINDING_POSTCONDITION' USING ERRCODE='EN850';END IF;
END $$;
