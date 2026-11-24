-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (EXP-03, ADR-033 D6). Human security review remains pending.
ALTER TABLE meetings.derivation_runs ADD COLUMN dispatch_started_at timestamptz;
--> statement-breakpoint
GRANT UPDATE (dispatch_started_at) ON meetings.derivation_runs TO ensemus_agent;
--> statement-breakpoint
CREATE FUNCTION meetings.guard_derivation_dispatch() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'ensemus_agent' OR current_user IS DISTINCT FROM session_user
    OR app.current_actor_type() IS DISTINCT FROM 'service'
    OR OLD.dispatch_started_at IS NOT NULL OR NEW.dispatch_started_at IS NULL
    OR OLD.status <> 'running' OR NEW.status <> 'running'
    OR OLD.temporal_run_id IS NULL OR NEW.temporal_run_id IS DISTINCT FROM OLD.temporal_run_id
  THEN
    RAISE EXCEPTION 'MEETING_DERIVATION_DISPATCH_NOT_ALLOWED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION meetings.guard_derivation_dispatch() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER derivation_runs_guard_dispatch
  BEFORE UPDATE OF dispatch_started_at ON meetings.derivation_runs
  FOR EACH ROW EXECUTE FUNCTION meetings.guard_derivation_dispatch();
