-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-033 D3, ADR-039 D2). Human review remains pending.
-- Revocation closes the native sink's read path too; only the platform purge may see revoked rows.
CREATE OR REPLACE FUNCTION integrations.business_record_writer(p_connection uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(session_user='ensemus_connector' AND current_user='ensemus_connector'
   AND knowledge.is_service_actor() AND app.current_membership_id() IS NULL
   AND current_setting('app.business_connection_id',true)=p_connection::text
   AND EXISTS(SELECT 1 FROM integrations.connections c WHERE c.organization_id=app.current_organization_id()
     AND c.id=p_connection AND c.state='active'
     AND c.connector_type IN('crm_http','ticketing_http','accounting_http')
     AND c.connector_type||'.read'=ANY(c.granted_scopes)),false)
$$;
