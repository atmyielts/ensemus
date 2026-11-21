-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-027 D1, ADR-033 D3, ADR-039 D2). Human review remains pending.
-- A web reader has no UPDATE grant on team_memberships, so cannot take a locking SELECT there.
-- This fixed definer locks only the actual source team's actual active member. No application
-- table grant is widened, and no source body or membership row leaves the function.
CREATE FUNCTION integrations.business_team_lock_scope() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT app.current_organization_id() IS NOT NULL
 AND nullif(current_setting('integrations.business_proposal_lock_record',true),'') IS NOT NULL
 AND nullif(current_setting('integrations.business_proposal_lock_member',true),'') IS NOT NULL
 AND nullif(current_setting('integrations.business_proposal_lock_team',true),'') IS NOT NULL
 AND((app.is_web_login() AND app.current_actor_type()='user') OR(session_user='ensemus_connector'
   AND current_setting('role',true) IN('none','ensemus_connector') AND knowledge.is_service_actor()))
$$;
REVOKE ALL ON FUNCTION integrations.business_team_lock_scope() FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY business_team_connection_fact ON integrations.connections FOR SELECT TO ensemus_migrator USING(
 integrations.business_team_lock_scope() AND organization_id=app.current_organization_id()
 AND EXISTS(SELECT 1 FROM integrations.business_records record WHERE record.organization_id=connections.organization_id
   AND record.id::text=current_setting('integrations.business_proposal_lock_record',true) AND record.connection_id=connections.id));
CREATE POLICY business_team_resource_fact ON integrations.external_resources FOR SELECT TO ensemus_migrator USING(
 integrations.business_team_lock_scope() AND organization_id=app.current_organization_id()
 AND EXISTS(SELECT 1 FROM integrations.business_records record WHERE record.organization_id=external_resources.organization_id
   AND record.id::text=current_setting('integrations.business_proposal_lock_record',true)
   AND record.connection_id=external_resources.connection_id AND record.external_id=external_resources.external_id
   AND record.stream=external_resources.stream));
CREATE POLICY business_team_grant_fact ON integrations.external_resource_acl FOR SELECT TO ensemus_migrator USING(
 integrations.business_team_lock_scope() AND organization_id=app.current_organization_id()
 AND team_id::text=current_setting('integrations.business_proposal_lock_team',true)
 AND EXISTS(SELECT 1 FROM integrations.external_resources resource WHERE resource.organization_id=external_resource_acl.organization_id AND resource.id=external_resource_acl.resource_id));
CREATE POLICY business_team_active_member ON org.memberships FOR SELECT TO ensemus_migrator USING(
 integrations.business_team_lock_scope() AND organization_id=app.current_organization_id()
 AND id::text=current_setting('integrations.business_proposal_lock_member',true));
CREATE POLICY business_team_member_fact ON org.team_memberships FOR SELECT TO ensemus_migrator USING(
 integrations.business_team_lock_scope() AND organization_id=app.current_organization_id()
 AND team_id::text=current_setting('integrations.business_proposal_lock_team',true)
 AND membership_id::text=current_setting('integrations.business_proposal_lock_member',true));
CREATE POLICY business_team_member_lock ON org.team_memberships FOR UPDATE TO ensemus_migrator USING(
 integrations.business_team_lock_scope() AND organization_id=app.current_organization_id()
 AND team_id::text=current_setting('integrations.business_proposal_lock_team',true)
 AND membership_id::text=current_setting('integrations.business_proposal_lock_member',true)) WITH CHECK(false);
--> statement-breakpoint
CREATE FUNCTION integrations.lock_business_proposal_team(p_record uuid,p_team uuid,p_member uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_record text:=current_setting('integrations.business_proposal_lock_record',true);
 previous_team text:=current_setting('integrations.business_proposal_lock_team',true);
 previous_member text:=current_setting('integrations.business_proposal_lock_member',true);
 record record;permitted boolean:=false;allowed_actor boolean:=false;
BEGIN
 IF current_user<>'ensemus_migrator' OR p_record IS NULL OR p_team IS NULL OR p_member IS NULL THEN RETURN false;END IF;
 allowed_actor:=(app.is_web_login() AND app.current_actor_type()='user') OR(session_user='ensemus_connector'
   AND current_setting('role',true) IN('none','ensemus_connector') AND knowledge.is_service_actor());
 IF NOT coalesce(allowed_actor,false) THEN RETURN false;END IF;
 PERFORM set_config('integrations.business_proposal_lock_record',p_record::text,true);
 PERFORM set_config('integrations.business_proposal_lock_team',p_team::text,true);
 PERFORM set_config('integrations.business_proposal_lock_member',p_member::text,true);
 SELECT r.* INTO record FROM integrations.business_records r WHERE r.organization_id=app.current_organization_id()
   AND r.id=p_record AND r.deleted_at IS NULL;
 IF FOUND THEN
  IF app.is_web_login() THEN
   allowed_actor:=integrations.business_record_reader(record.connection_id,record.stream,record.external_id,record.external_version,record.fields_sha256,record.classification);
  ELSE
   allowed_actor:=record.connection_id::text=current_setting('app.business_connection_id',true)
    AND EXISTS(SELECT 1 FROM integrations.connections connection WHERE connection.organization_id=record.organization_id
      AND connection.id=record.connection_id AND connection.state='active'
      AND connection.connector_type IN('crm_http','ticketing_http','accounting_http')
      AND connection.connector_type||'.read'=ANY(connection.granted_scopes)
      AND jsonb_typeof(connection.config->'streams')='array' AND(connection.config->'streams')?record.stream);
  END IF;
  IF coalesce(allowed_actor,false) THEN
   SELECT true INTO permitted FROM org.team_memberships member JOIN org.memberships person
     ON person.organization_id=member.organization_id AND person.id=member.membership_id AND person.status='active'
   WHERE member.organization_id=record.organization_id AND member.team_id=p_team AND member.membership_id=p_member
    AND EXISTS(SELECT 1 FROM integrations.external_resources resource JOIN integrations.external_resource_acl grant_row
      ON grant_row.organization_id=resource.organization_id AND grant_row.resource_id=resource.id
      WHERE resource.organization_id=record.organization_id AND resource.connection_id=record.connection_id
       AND resource.external_id=record.external_id AND resource.stream=record.stream AND resource.deleted_at IS NULL
       AND resource.acl_state IN('mapped','partial') AND resource.external_version IS NOT DISTINCT FROM record.external_version
       AND resource.content_sha256=record.fields_sha256 AND resource.classification=record.classification
       AND grant_row.team_id=p_team AND grant_row.access IN('read','write','owner')) FOR SHARE OF member NOWAIT;
  END IF;
 END IF;
 PERFORM set_config('integrations.business_proposal_lock_record',coalesce(previous_record,''),true);
 PERFORM set_config('integrations.business_proposal_lock_team',coalesce(previous_team,''),true);
 PERFORM set_config('integrations.business_proposal_lock_member',coalesce(previous_member,''),true);
 RETURN coalesce(permitted,false);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('integrations.business_proposal_lock_record',coalesce(previous_record,''),true);
 PERFORM set_config('integrations.business_proposal_lock_team',coalesce(previous_team,''),true);
 PERFORM set_config('integrations.business_proposal_lock_member',coalesce(previous_member,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION integrations.lock_business_proposal_team(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integrations.lock_business_proposal_team(uuid,uuid,uuid) TO ensemus_app;
