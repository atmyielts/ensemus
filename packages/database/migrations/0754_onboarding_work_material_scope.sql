-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Let the native platform worker advance a committed onboarding under its initiator's current ACL.
-- A transaction selector identifies the exact request, but cannot replace the request event or
-- grant any visibility beyond the four Work items already associated with it.
CREATE OR REPLACE FUNCTION work.material_reader(p_work uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
 IF app.is_web_login() AND app.current_actor_type()='user' THEN
   RETURN coalesce(EXISTS(SELECT 1 FROM org.memberships person WHERE person.organization_id=app.current_organization_id()
     AND person.id=app.current_membership_id() AND person.user_id=app.current_user_id() AND person.status='active')
     AND knowledge.can_read_work(p_work,app.current_membership_id()),false);
 END IF;
 IF session_user IN('ensemus_worker','ensemus_connector') AND current_user=session_user
   AND knowledge.is_service_actor() THEN RETURN true;END IF;
 IF session_user='ensemus_agent' AND current_user='ensemus_agent' AND app.current_actor_type()='agent' THEN
   RETURN coalesce(EXISTS(SELECT 1 FROM ai.agent_runs run JOIN org.memberships initiator
     ON initiator.organization_id=run.organization_id AND initiator.id=run.initiator_membership_id AND initiator.status='active'
     WHERE run.organization_id=app.current_organization_id() AND run.id::text=current_setting('app.agent_run_id',true)
       AND run.initiator_membership_id=app.current_membership_id() AND initiator.user_id=app.current_user_id()
       AND run.status IN('queued','preparing','running','paused','waiting_for_approval','waiting_for_child','verifying')
       AND (ai.run_scope_preflight(run.id) OR (run.parent_run_id IS NULL AND run.work_unit_id=p_work AND run.status IN('queued','preparing'))))
     AND knowledge.can_read_work(p_work,app.current_membership_id()),false);
 END IF;
 IF session_user='ensemus_worker' AND current_user='ensemus_worker' AND app.current_actor_type()='delegated' THEN
   RETURN coalesce((EXISTS(SELECT 1 FROM studio.process_run_intents intent
     WHERE intent.organization_id=app.current_organization_id()
       AND intent.started_by_membership_id=app.current_membership_id() AND studio.process_requested(intent.run_id)
       AND EXISTS(SELECT 1 FROM org.memberships person WHERE person.organization_id=intent.organization_id
         AND person.id=intent.started_by_membership_id AND person.user_id=app.current_user_id() AND person.status='active')
       AND (intent.root_work_unit_id=p_work OR EXISTS(SELECT 1 FROM studio.process_step_births birth
         WHERE birth.organization_id=intent.organization_id AND birth.run_id=intent.run_id AND birth.work_unit_id=p_work)))
     OR EXISTS(SELECT 1 FROM work.client_onboardings onboarding
       JOIN org.memberships person ON person.organization_id=onboarding.organization_id
         AND person.id=onboarding.requested_by_membership_id
       WHERE onboarding.organization_id=app.current_organization_id()
         AND onboarding.id::text=current_setting('app.client_onboarding_id',true)
         AND onboarding.state IN('started','waiting_for_brief','waiting_for_acceptance','waiting_for_send')
         AND person.id=app.current_membership_id() AND person.user_id=app.current_user_id()
         AND person.status='active' AND person.role IN('owner','admin')
         AND p_work IN(onboarding.work_unit_id,onboarding.brief_work_unit_id,
                       onboarding.review_work_unit_id,onboarding.send_work_unit_id)
         AND EXISTS(SELECT 1 FROM platform.domain_events requested
           WHERE requested.organization_id=onboarding.organization_id
             AND requested.aggregate_id=onboarding.id AND requested.aggregate_type='client_onboarding'
             AND requested.event_type='client_onboarding.requested' AND requested.aggregate_version=1
             AND requested.actor_type='membership' AND requested.actor_id=person.id)))
     AND knowledge.can_read_work(p_work,app.current_membership_id()),false);
 END IF;
 RETURN false;
END $$;
