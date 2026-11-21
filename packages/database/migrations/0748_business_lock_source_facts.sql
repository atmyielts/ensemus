-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-033 D3, ADR-039 D2). Human review remains pending.
-- The fixed definer needs the actual source facts used by business_record_reader, under forced RLS.
-- These policies give only the migration owner inside the web-person lock purpose the exact source
-- connection, resource, grants and current person's team facts. No application grant is widened.
CREATE POLICY business_proposal_connection_fact ON integrations.connections FOR SELECT TO ensemus_migrator USING(
 organization_id=app.current_organization_id() AND app.is_web_login() AND app.current_actor_type()='user'
 AND EXISTS(SELECT 1 FROM integrations.business_records record WHERE record.organization_id=connections.organization_id
   AND record.id::text=current_setting('integrations.business_proposal_lock_record',true) AND record.connection_id=connections.id));
CREATE POLICY business_proposal_resource_fact ON integrations.external_resources FOR SELECT TO ensemus_migrator USING(
 organization_id=app.current_organization_id() AND app.is_web_login() AND app.current_actor_type()='user'
 AND EXISTS(SELECT 1 FROM integrations.business_records record WHERE record.organization_id=external_resources.organization_id
   AND record.id::text=current_setting('integrations.business_proposal_lock_record',true) AND record.connection_id=external_resources.connection_id
   AND record.external_id=external_resources.external_id AND record.stream=external_resources.stream));
CREATE POLICY business_proposal_grant_fact ON integrations.external_resource_acl FOR SELECT TO ensemus_migrator USING(
 organization_id=app.current_organization_id() AND app.is_web_login() AND app.current_actor_type()='user'
 AND EXISTS(SELECT 1 FROM integrations.external_resources resource WHERE resource.organization_id=external_resource_acl.organization_id
   AND resource.id=external_resource_acl.resource_id));
CREATE POLICY business_proposal_team_fact ON org.team_memberships FOR SELECT TO ensemus_migrator USING(
 organization_id=app.current_organization_id() AND app.is_web_login() AND app.current_actor_type()='user'
 AND membership_id=app.current_membership_id() AND EXISTS(SELECT 1 FROM integrations.external_resource_acl grant_row
   WHERE grant_row.organization_id=team_memberships.organization_id AND grant_row.team_id=team_memberships.team_id));
