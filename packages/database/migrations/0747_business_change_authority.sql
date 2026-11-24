-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-027 D1, ADR-033 D3, ADR-039 D2). Human review remains pending.
-- A permitted person can lock an exact snapshot without acquiring UPDATE visibility on source data.
CREATE POLICY business_proposal_lock_read ON integrations.business_records FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND app.is_web_login() AND app.current_actor_type()='user'
   AND id::text=current_setting('integrations.business_proposal_lock_record',true));
CREATE POLICY business_proposal_lock_row ON integrations.business_records FOR UPDATE TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND app.is_web_login() AND app.current_actor_type()='user'
   AND id::text=current_setting('integrations.business_proposal_lock_record',true)) WITH CHECK(false);
--> statement-breakpoint
CREATE FUNCTION integrations.lock_business_proposal_record(p_record uuid,p_version text,p_hash text,p_class text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE permitted boolean:=false;previous_record text:=current_setting('integrations.business_proposal_lock_record',true);
BEGIN
 IF current_user<>'ensemus_migrator' OR NOT app.is_web_login() OR app.current_actor_type() IS DISTINCT FROM 'user' OR p_record IS NULL THEN RETURN false;END IF;
 PERFORM set_config('integrations.business_proposal_lock_record',p_record::text,true);
 SELECT true INTO permitted FROM integrations.business_records record WHERE record.organization_id=app.current_organization_id()
   AND record.id=p_record AND record.deleted_at IS NULL AND record.external_version IS NOT DISTINCT FROM p_version
   AND record.fields_sha256=p_hash AND record.classification=p_class
   AND integrations.business_record_reader(record.connection_id,record.stream,record.external_id,record.external_version,record.fields_sha256,record.classification)
   FOR SHARE OF record NOWAIT;
 PERFORM set_config('integrations.business_proposal_lock_record',coalesce(previous_record,''),true);RETURN coalesce(permitted,false);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('integrations.business_proposal_lock_record',coalesce(previous_record,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION integrations.lock_business_proposal_record(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integrations.lock_business_proposal_record(uuid,text,text,text) TO ensemus_app;
--> statement-breakpoint
-- A Work grant never converts a source grant into a permanent copy in a review or an action.
-- The exact native processing roles retain their existing tenant processing purpose; worker-human
-- impersonation still fails material_reader, and the worker cannot borrow this person's purpose.
CREATE FUNCTION integrations.business_change_reader(p_connection uuid,p_tool text,p_payload jsonb,p_class text) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE expected_type text;expected_stream text;external_key text;
BEGIN
 IF p_tool='crm.record.update' THEN expected_type:='crm_http';expected_stream:=p_payload->'record'->>'stream';external_key:=p_payload->'record'->>'external_id';
 ELSIF p_tool IN('ticketing.record.update','ticketing.comment.add') THEN
   expected_type:='ticketing_http';expected_stream:=CASE WHEN p_tool='ticketing.comment.add' THEN 'ticketing.tickets' ELSE p_payload->'record'->>'stream' END;
   external_key:=CASE WHEN p_tool='ticketing.comment.add' THEN p_payload->'ticket'->>'external_id' ELSE p_payload->'record'->>'external_id' END;
 ELSIF p_tool IN('accounting.record.update','accounting.invoice_draft.create') THEN
   expected_type:='accounting_http';expected_stream:=p_payload->'record'->>'stream';external_key:=p_payload->'record'->>'external_id';
 ELSE RETURN false;END IF;
 IF session_user IN('ensemus_connector','ensemus_worker') AND current_user=session_user AND knowledge.is_service_actor() THEN RETURN true;END IF;
 IF NOT app.is_web_login() OR app.current_actor_type() IS DISTINCT FROM 'user' THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM org.memberships person WHERE person.organization_id=app.current_organization_id()
   AND person.id=app.current_membership_id() AND person.user_id=app.current_user_id() AND person.status='active') THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM integrations.connections connection WHERE connection.organization_id=app.current_organization_id()
   AND connection.id=p_connection AND connection.connector_type=expected_type AND connection.state='active'
   AND expected_type||'.read'=ANY(connection.granted_scopes)
   AND(connection.owner_membership_id IS NULL OR connection.owner_membership_id=app.current_membership_id())) THEN RETURN false;END IF;
 IF p_tool='accounting.invoice_draft.create' THEN RETURN coalesce(knowledge.class_rank(p_class)>=3,false);END IF;
 RETURN coalesce(EXISTS(SELECT 1 FROM integrations.business_records record WHERE record.organization_id=app.current_organization_id()
   AND record.connection_id=p_connection AND record.stream=expected_stream AND record.external_id=external_key AND record.deleted_at IS NULL
   AND knowledge.class_rank(p_class)>=knowledge.class_rank(record.classification)),false);
END $$;
REVOKE ALL ON FUNCTION integrations.business_change_reader(uuid,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integrations.business_change_reader(uuid,text,jsonb,text) TO ensemus_app;
--> statement-breakpoint
CREATE POLICY business_action_source_read ON integrations.external_actions AS RESTRICTIVE FOR SELECT TO ensemus_app USING(
 tool_name NOT IN('crm.record.update','ticketing.record.update','ticketing.comment.add','accounting.record.update','accounting.invoice_draft.create')
 OR integrations.business_change_reader(connection_id,tool_name,payload,knowledge.work_scope_class(work_unit_id)));
CREATE POLICY business_approval_source_read ON work.approvals AS RESTRICTIVE FOR SELECT TO ensemus_app USING(
 tool_name NOT IN('crm.record.update','ticketing.record.update','ticketing.comment.add','accounting.record.update','accounting.invoice_draft.create')
 OR integrations.business_change_reader(CASE WHEN target_ref ~ '^connection:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN substring(target_ref FROM 12)::uuid ELSE NULL END,
   tool_name,action->'payload',knowledge.work_scope_class(work_unit_id)));
