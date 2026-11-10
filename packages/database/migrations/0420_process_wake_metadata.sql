-- The dispatcher keeps only its event-header privileges. This fixed, read-only mapper returns
-- actual process IDs for a persisted outbox event, never Work/spec/approval text or event payloads.
CREATE POLICY process_wake_header ON platform.domain_events FOR SELECT TO ensemus_migrator USING(
 session_user='ensemus_dispatcher' AND organization_id::text=current_setting('studio.process_wake_organization_id',true)
 AND id::text=current_setting('studio.process_wake_event_id',true));
CREATE POLICY process_wake_outbox ON platform.outbox_events FOR SELECT TO ensemus_migrator USING(
 session_user='ensemus_dispatcher' AND organization_id::text=current_setting('studio.process_wake_organization_id',true)
 AND event_id::text=current_setting('studio.process_wake_event_id',true));
CREATE POLICY process_wake_runs ON studio.process_runs FOR SELECT TO ensemus_migrator USING(
 session_user='ensemus_dispatcher' AND organization_id::text=current_setting('studio.process_wake_organization_id',true)
 AND nullif(current_setting('studio.process_wake_event_id',true),'') IS NOT NULL);
CREATE POLICY process_wake_steps ON studio.process_run_steps FOR SELECT TO ensemus_migrator USING(
 session_user='ensemus_dispatcher' AND organization_id::text=current_setting('studio.process_wake_organization_id',true)
 AND nullif(current_setting('studio.process_wake_event_id',true),'') IS NOT NULL);
CREATE POLICY process_wake_intents ON studio.process_run_intents FOR SELECT TO ensemus_migrator USING(
 session_user='ensemus_dispatcher' AND organization_id::text=current_setting('studio.process_wake_organization_id',true)
 AND nullif(current_setting('studio.process_wake_event_id',true),'') IS NOT NULL);
CREATE FUNCTION studio.process_wake_targets(p_organization uuid,p_event uuid) RETURNS TABLE(process_run_id uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE event_header record;prior_organization text:=current_setting('studio.process_wake_organization_id',true);
 prior_event text:=current_setting('studio.process_wake_event_id',true);
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_dispatcher' OR p_organization IS NULL OR p_event IS NULL THEN
 RAISE EXCEPTION 'PROCESS_WAKE_DISPATCHER_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM set_config('studio.process_wake_organization_id',p_organization::text,true),
 set_config('studio.process_wake_event_id',p_event::text,true);
 BEGIN
   SELECT e.event_type,e.aggregate_type,e.aggregate_id INTO event_header FROM platform.domain_events e
   JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id
   WHERE e.organization_id=p_organization AND e.id=p_event;
   IF FOUND AND (
     (event_header.aggregate_type='work_unit' AND event_header.event_type IN('work.transitioned','approval.resolved','work.artifact_added','work.artifact_deleted'))
     OR (event_header.aggregate_type='agent_run' AND event_header.event_type='agent_run.finished')
     OR (event_header.aggregate_type='external_action' AND event_header.event_type IN(
       'external_action.sent','external_action.failed','external_action.unknown','external_action.cancelled','external_action.resolved'))
   ) THEN
     RETURN QUERY SELECT DISTINCT r.id FROM studio.process_run_intents i JOIN studio.process_runs r
     ON r.organization_id=i.organization_id AND r.id=i.run_id AND r.spec_id=i.spec_id
     AND r.root_work_unit_id=i.root_work_unit_id AND r.started_by_membership_id=i.started_by_membership_id
     LEFT JOIN studio.process_run_steps x ON x.organization_id=r.organization_id AND x.run_id=r.id
     WHERE r.organization_id=p_organization AND r.status NOT IN('completed','failed','cancelled') AND (
       (event_header.aggregate_type='work_unit' AND (r.root_work_unit_id=event_header.aggregate_id OR x.work_unit_id=event_header.aggregate_id))
       OR (event_header.aggregate_type='agent_run' AND x.agent_run_id=event_header.aggregate_id)
       OR (event_header.aggregate_type='external_action' AND x.external_action_id=event_header.aggregate_id)
     ) ORDER BY r.id;
   END IF;
 EXCEPTION WHEN OTHERS THEN
   PERFORM set_config('studio.process_wake_organization_id',coalesce(prior_organization,''),true),
   set_config('studio.process_wake_event_id',coalesce(prior_event,''),true);RAISE;
 END;
 PERFORM set_config('studio.process_wake_organization_id',coalesce(prior_organization,''),true),
 set_config('studio.process_wake_event_id',coalesce(prior_event,''),true);
END $$;
REVOKE ALL ON FUNCTION studio.process_wake_targets(uuid,uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA studio TO ensemus_dispatcher;
GRANT EXECUTE ON FUNCTION studio.process_wake_targets(uuid,uuid) TO ensemus_dispatcher;
