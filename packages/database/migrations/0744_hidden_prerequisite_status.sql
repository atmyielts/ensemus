-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-027 D1, ADR-039 D2). Human review remains pending.
-- Preserve blocking without opening private Work bodies. A web person may learn only the status
-- of an actual prerequisite of Work they can currently read. No title, objective or review leaves
-- this fixed definer. Native agent/worker calls cannot borrow this human metadata purpose.
CREATE POLICY prerequisite_status_dependency ON work.work_dependencies FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND app.is_web_login() AND app.current_actor_type()='user'
   AND dependent_id::text=current_setting('work.prerequisite_status_dependent',true)
   AND prerequisite_id::text=current_setting('work.prerequisite_status_target',true));
CREATE POLICY prerequisite_status_work ON work.work_units FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND app.is_web_login() AND app.current_actor_type()='user'
   AND id::text=current_setting('work.prerequisite_status_target',true));
--> statement-breakpoint
CREATE FUNCTION work.prerequisite_status(p_dependent uuid,p_prerequisite uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result text;
 previous_dependent text:=current_setting('work.prerequisite_status_dependent',true);
 previous_target text:=current_setting('work.prerequisite_status_target',true);
BEGIN
 IF current_user<>'ensemus_migrator' OR NOT app.is_web_login() OR app.current_actor_type() IS DISTINCT FROM 'user'
   OR NOT coalesce(EXISTS(SELECT 1 FROM org.memberships person WHERE person.organization_id=app.current_organization_id()
     AND person.id=app.current_membership_id() AND person.user_id=app.current_user_id() AND person.status='active')
     AND knowledge.can_read_work(p_dependent,app.current_membership_id()),false) THEN RETURN NULL;END IF;
 PERFORM set_config('work.prerequisite_status_dependent',coalesce(p_dependent::text,''),true);
 PERFORM set_config('work.prerequisite_status_target',coalesce(p_prerequisite::text,''),true);
 SELECT w.status INTO result FROM work.work_dependencies dependency JOIN work.work_units w
   ON w.organization_id=dependency.organization_id AND w.id=dependency.prerequisite_id
   WHERE dependency.organization_id=app.current_organization_id() AND dependency.dependent_id=p_dependent
     AND dependency.prerequisite_id=p_prerequisite;
 PERFORM set_config('work.prerequisite_status_dependent',coalesce(previous_dependent,''),true);
 PERFORM set_config('work.prerequisite_status_target',coalesce(previous_target,''),true);
 RETURN result;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('work.prerequisite_status_dependent',coalesce(previous_dependent,''),true);
 PERFORM set_config('work.prerequisite_status_target',coalesce(previous_target,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION work.prerequisite_status(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.prerequisite_status(uuid,uuid) TO ensemus_app;
