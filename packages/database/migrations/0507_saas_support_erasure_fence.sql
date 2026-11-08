-- Human review required. The desk keeps support-only grants. This fixed trigger may inspect only
-- the exact mutation tenant's control rows, through depth/GUC-scoped migrator RLS policies.
-- ensemus_migrator is LOGIN/NOBYPASSRLS: these policies do not enable owner reads outside a trigger.
CREATE POLICY support_fence_org_read ON org.organizations FOR SELECT TO ensemus_migrator
  USING (pg_catalog.pg_trigger_depth()>0
         AND id::text=pg_catalog.current_setting('support.write_fence_org',true));
--> statement-breakpoint
CREATE POLICY support_fence_org_lock ON org.organizations FOR UPDATE TO ensemus_migrator
  USING (pg_catalog.pg_trigger_depth()>0
         AND id::text=pg_catalog.current_setting('support.write_fence_org',true))
  WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY support_fence_stage_read ON lifecycle.offboardings FOR SELECT TO ensemus_migrator
  USING (pg_catalog.pg_trigger_depth()>0
         AND organization_id::text=pg_catalog.current_setting('support.write_fence_org',true));
--> statement-breakpoint
CREATE FUNCTION support.fence_erasing_content() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
  AS $$
DECLARE
  prior_fence text;
  actual_lifecycle text;
  stage_count bigint;
  stages_known boolean;
  content_closed boolean;
BEGIN
  IF current_user<>'ensemus_migrator' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN ('INSERT','UPDATE')
     OR TG_TABLE_SCHEMA<>'support'
     OR TG_RELID NOT IN ('support.tickets'::regclass,'support.ticket_messages'::regclass)
     OR (TG_RELID='support.tickets'::regclass AND TG_TABLE_NAME<>'tickets')
     OR (TG_RELID='support.ticket_messages'::regclass AND TG_TABLE_NAME<>'ticket_messages') THEN
    RAISE EXCEPTION 'SUPPORT_CONTENT_GUARD_INVALID' USING ERRCODE='25006';
  END IF;
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'SUPPORT_CONTENT_TENANT_IMMUTABLE' USING ERRCODE='25006';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'SUPPORT_CONTENT_TENANT_IMMUTABLE' USING ERRCODE='25006';
    END IF;
  END IF;
  prior_fence:=pg_catalog.current_setting('support.write_fence_org',true);
  PERFORM pg_catalog.set_config('support.write_fence_org',NEW.organization_id::text,true);
  BEGIN
    -- UPDATE already holds its ticket row. NOWAIT is essential: never wait ticket -> org while
    -- erasure owns org and is about to delete tickets. Refusal rolls the mutation back; no replay.
    BEGIN
      SELECT o.lifecycle INTO actual_lifecycle FROM org.organizations o
        WHERE o.id=NEW.organization_id FOR NO KEY UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'SUPPORT_CONTENT_BUSY' USING ERRCODE='EN807';
    END;
    IF actual_lifecycle IS NULL OR actual_lifecycle NOT IN ('active','read_only','suspended','offboarding') THEN
      RAISE EXCEPTION 'SUPPORT_CONTENT_ERASURE_FENCED' USING ERRCODE='25006';
    END IF;
    SELECT count(*),coalesce(bool_and(o.state IN
      ('requested','export_offered','in_transition','winding_down','ready_for_erasure','erasing','verified','reported','cancelled')),true),
      coalesce(bool_or(o.state IN ('erasing','verified','reported')),false)
      INTO stage_count,stages_known,content_closed
      FROM lifecycle.offboardings o WHERE o.organization_id=NEW.organization_id;
    IF NOT stages_known OR content_closed OR (actual_lifecycle='offboarding' AND stage_count=0) THEN
      RAISE EXCEPTION 'SUPPORT_CONTENT_ERASURE_FENCED' USING ERRCODE='25006';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('support.write_fence_org',coalesce(prior_fence,''),true);
    RAISE;
  END;
  PERFORM pg_catalog.set_config('support.write_fence_org',coalesce(prior_fence,''),true);
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION support.fence_erasing_content() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER support_content_write_fence BEFORE INSERT OR UPDATE ON support.tickets
  FOR EACH ROW EXECUTE FUNCTION support.fence_erasing_content();
--> statement-breakpoint
CREATE TRIGGER support_content_write_fence BEFORE INSERT OR UPDATE ON support.ticket_messages
  FOR EACH ROW EXECUTE FUNCTION support.fence_erasing_content();
