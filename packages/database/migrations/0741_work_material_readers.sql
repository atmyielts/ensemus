-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-027 D1/D3, ADR-039 D2). Human review remains pending.
-- Preserve the existing Work ACL/parent/input closure, and distinguish native execution purposes
-- from a worker borrowing a person's bindings. This returns no Work, review or effect content.
CREATE FUNCTION work.material_reader(p_work uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(
   (app.is_web_login() AND app.current_actor_type()='user' AND EXISTS(
     SELECT 1 FROM org.memberships person WHERE person.organization_id=app.current_organization_id()
       AND person.id=app.current_membership_id() AND person.user_id=app.current_user_id() AND person.status='active')
     AND knowledge.can_read_work(p_work,app.current_membership_id()))
   OR (session_user IN('ensemus_worker','ensemus_connector') AND current_user=session_user
     AND knowledge.is_service_actor())
   OR (session_user='ensemus_agent' AND current_user='ensemus_agent' AND app.current_actor_type()='agent'
     AND EXISTS(SELECT 1 FROM ai.agent_runs run JOIN org.memberships initiator
       ON initiator.organization_id=run.organization_id AND initiator.id=run.initiator_membership_id AND initiator.status='active'
       WHERE run.organization_id=app.current_organization_id() AND run.id::text=current_setting('app.agent_run_id',true)
         AND run.initiator_membership_id=app.current_membership_id() AND initiator.user_id=app.current_user_id()
         AND run.status IN('queued','preparing','running','paused','waiting_for_approval','waiting_for_child','verifying')
         AND (ai.run_scope_preflight(run.id) OR (run.parent_run_id IS NULL AND run.work_unit_id=p_work AND run.status IN('queued','preparing'))))
     AND knowledge.can_read_work(p_work,app.current_membership_id()))
   OR (session_user='ensemus_worker' AND current_user='ensemus_worker' AND app.current_actor_type()='delegated'
     AND EXISTS(SELECT 1 FROM studio.process_run_intents intent
       WHERE intent.organization_id=app.current_organization_id() AND intent.run_id::text=current_setting('app.process_step_run_id',true)
         AND intent.started_by_membership_id=app.current_membership_id() AND studio.process_requested(intent.run_id)
         AND (intent.root_work_unit_id=p_work OR EXISTS(SELECT 1 FROM studio.process_step_births birth
           WHERE birth.organization_id=intent.organization_id AND birth.run_id=intent.run_id AND birth.work_unit_id=p_work
             AND birth.step_key=current_setting('app.process_step_key',true))))
     AND knowledge.can_read_work(p_work,app.current_membership_id())),false)
$$;
REVOKE ALL ON FUNCTION work.material_reader(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.material_reader(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE POLICY work_material_read ON work.work_units AS RESTRICTIVE FOR SELECT TO ensemus_app
 USING(work.material_reader(id));
CREATE POLICY approval_work_material_read ON work.approvals AS RESTRICTIVE FOR SELECT TO ensemus_app
 USING(work.material_reader(work_unit_id));
CREATE POLICY external_action_work_material_read ON integrations.external_actions AS RESTRICTIVE FOR SELECT TO ensemus_app
 USING(work.material_reader(work_unit_id));
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
   WHERE p.oid='work.material_reader(uuid)'::regprocedure AND (p.prosecdef OR owner.rolname<>'ensemus_migrator'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] OR has_function_privilege('public',p.oid,'execute'))) THEN
   RAISE EXCEPTION 'WORK_MATERIAL_READER_POSTCONDITION' USING ERRCODE='42501'; END IF;
END $$;
