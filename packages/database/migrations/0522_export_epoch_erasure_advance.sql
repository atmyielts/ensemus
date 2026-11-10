-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- 0522: additive repair for registered 0303 under the 0515/0518 erasure birth fence. 0303 advanced the
-- export epoch with INSERT ... ON CONFLICT DO UPDATE. PostgreSQL fires BEFORE INSERT row triggers for
-- every proposed row, even one that ends as the conflict UPDATE, so once a tenant is erasing, the
-- birth fence on sovereign.export_epochs refused every epoch advance and the real eraser could not
-- delete any epoch-tracked row (integrations.connections, work.work_units, ...): eraseTenantRows failed
-- with TENANT_ERASURE_IN_PROGRESS (EN850).
-- The advance is now an UPDATE of the existing epoch row, which is no birth. Only when that row is
-- absent is it created, exactly as before. While a tenant is erasing (the fence's own condition) an
-- absent row is left absent: every export reader (sovereign.portable_export_viewer,
-- isExportEpochCurrent, guard_export_epoch_pin) already treats a missing epoch as superseded, the
-- most-revoked state, and the fence would refuse that birth anyway. The fence itself is unchanged.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'EXPORT_EPOCH_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('sovereign.advance_export_epoch()') IS NULL OR to_regprocedure('lifecycle.refuse_erasing_birth()') IS NULL
  OR to_regclass('lifecycle.offboardings') IS NULL OR to_regclass('sovereign.export_epochs') IS NULL THEN
  RAISE EXCEPTION 'EXPORT_EPOCH_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid='sovereign.export_epochs'::regclass AND g.tgname='lifecycle_erasure_birth_fence'
  AND g.tgfoid='lifecycle.refuse_erasing_birth()'::regprocedure AND g.tgenabled IN('O','A') AND NOT g.tgisinternal) THEN
  RAISE EXCEPTION 'EXPORT_EPOCH_FENCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sovereign.advance_export_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid; before_row jsonb; after_row jsonb; tracked text[]; key text; changed boolean:=false; life text;
BEGIN
  before_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  after_row:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  tenant:=CASE WHEN TG_TABLE_SCHEMA='org' AND TG_TABLE_NAME='organizations'
    THEN (coalesce(after_row,before_row)->>'id')::uuid ELSE (coalesce(after_row,before_row)->>'organization_id')::uuid END;
  IF tenant IS NULL OR tenant IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'EXPORT_EPOCH_TENANT_REQUIRED' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' THEN
    tracked:=TG_ARGV;
    FOREACH key IN ARRAY tracked LOOP
      IF before_row->key IS DISTINCT FROM after_row->key THEN changed:=true; EXIT; END IF;
    END LOOP;
    IF NOT changed THEN RETURN NEW; END IF;
  END IF;
  UPDATE sovereign.export_epochs SET epoch=epoch+1 WHERE organization_id=tenant;
  IF NOT FOUND THEN
    SELECT actual.lifecycle INTO life FROM org.organizations actual WHERE actual.id=tenant;
    IF life='deleted' OR EXISTS(SELECT 1 FROM lifecycle.offboardings actual WHERE actual.organization_id=tenant
      AND actual.state IN('erasing','verified','reported')) THEN
      RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    END IF;
    INSERT INTO sovereign.export_epochs(organization_id,epoch) VALUES(tenant,1)
      ON CONFLICT(organization_id) DO UPDATE SET epoch=sovereign.export_epochs.epoch+1;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sovereign.advance_export_epoch() FROM PUBLIC;
