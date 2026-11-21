-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-033 D3, ADR-039 D2). Human review remains pending.
-- Tenant separation remains in the existing permissive policy. These restrictive policies also
-- hold source grants and native worker authority for direct SQL, not only the application API.
CREATE FUNCTION integrations.business_record_writer(p_connection uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(session_user='ensemus_connector' AND current_user='ensemus_connector'
   AND knowledge.is_service_actor() AND app.current_membership_id() IS NULL
   AND current_setting('app.business_connection_id',true)=p_connection::text,false)
$$;
REVOKE ALL ON FUNCTION integrations.business_record_writer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integrations.business_record_writer(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION integrations.business_record_purger(p_connection uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(session_user='ensemus_worker' AND current_user='ensemus_worker'
   AND knowledge.is_service_actor() AND app.current_membership_id() IS NULL
   AND current_setting('app.business_record_purge',true)='true'
   AND EXISTS(SELECT 1 FROM integrations.connections c WHERE c.organization_id=app.current_organization_id()
     AND c.id=p_connection AND c.state='revoked'),false)
$$;
REVOKE ALL ON FUNCTION integrations.business_record_purger(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integrations.business_record_purger(uuid) TO ensemus_app;
--> statement-breakpoint
-- Version/hash/class equality prevents new fields being read through a previous sync's grants
-- during the intentional two-transaction sink/cursor protocol. Partial ACL mapping grants only
-- the actual mapped person/team; an unmapped principal grants nobody anything.
CREATE FUNCTION integrations.business_record_reader(p_connection uuid,p_stream text,p_external text,
 p_version text,p_hash text,p_class text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(app.is_web_login() AND app.current_actor_type()='user'
   AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=app.current_organization_id()
     AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id()
     AND m.status='active' AND m.role IN('owner','admin','member'))
   AND EXISTS(SELECT 1 FROM integrations.connections c JOIN integrations.external_resources r
     ON r.organization_id=c.organization_id AND r.connection_id=c.id
     JOIN integrations.external_resource_acl a ON a.organization_id=r.organization_id AND a.resource_id=r.id
     WHERE c.organization_id=app.current_organization_id() AND c.id=p_connection AND c.state='active'
       AND (c.owner_membership_id IS NULL OR c.owner_membership_id=app.current_membership_id())
       AND c.connector_type IN('crm_http','ticketing_http','accounting_http')
       AND c.connector_type||'.read'=ANY(c.granted_scopes)
       AND jsonb_typeof(c.config->'streams')='array' AND (c.config->'streams') ? p_stream
       AND r.stream=p_stream AND r.external_id=p_external AND r.deleted_at IS NULL
       AND r.external_version IS NOT DISTINCT FROM p_version AND r.content_sha256=p_hash
       AND r.classification=p_class AND r.acl_state IN('mapped','partial')
       AND a.access IN('read','write','owner')
       AND (a.membership_id=app.current_membership_id() OR EXISTS(
         SELECT 1 FROM org.team_memberships tm WHERE tm.organization_id=a.organization_id
           AND tm.team_id=a.team_id AND tm.membership_id=app.current_membership_id()))),false)
$$;
REVOKE ALL ON FUNCTION integrations.business_record_reader(uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integrations.business_record_reader(uuid,text,text,text,text,text) TO ensemus_app;
--> statement-breakpoint
CREATE POLICY business_source_read ON integrations.business_records AS RESTRICTIVE FOR SELECT TO ensemus_app
 USING(integrations.business_record_writer(connection_id) OR integrations.business_record_purger(connection_id)
   OR (deleted_at IS NULL AND integrations.business_record_reader(connection_id,stream,external_id,external_version,fields_sha256,classification)));
CREATE POLICY business_native_insert ON integrations.business_records AS RESTRICTIVE FOR INSERT TO ensemus_app
 WITH CHECK(integrations.business_record_writer(connection_id));
CREATE POLICY business_native_update ON integrations.business_records AS RESTRICTIVE FOR UPDATE TO ensemus_app
 USING(integrations.business_record_writer(connection_id) OR integrations.business_record_purger(connection_id))
 WITH CHECK(integrations.business_record_writer(connection_id) OR integrations.business_record_purger(connection_id));
--> statement-breakpoint
-- Identity/source/first-seen remain immutable even for a worker holding column grants.
CREATE FUNCTION integrations.guard_business_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'integrations.business_records'::regclass OR TG_OP NOT IN('INSERT','UPDATE')
   OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
   RAISE EXCEPTION 'BUSINESS_RECORD_GUARD_TARGET_INVALID' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.organization_id,NEW.id,NEW.connection_id,NEW.stream,NEW.external_id,NEW.first_seen_at)
   IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.connection_id,OLD.stream,OLD.external_id,OLD.first_seen_at) THEN
   RAISE EXCEPTION 'BUSINESS_RECORD_SOURCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
 IF integrations.business_record_purger(NEW.connection_id) THEN
   IF TG_OP<>'UPDATE' OR NEW.fields<>'{}'::jsonb OR NEW.display_name IS NOT NULL OR NEW.deleted_at IS NULL
     OR NEW.fields_sha256<>encode(sha256(convert_to('{}','UTF8')),'hex')
     OR (to_jsonb(NEW)-ARRAY['fields','display_name','deleted_at','fields_sha256','updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['fields','display_name','deleted_at','fields_sha256','updated_at']) THEN
     RAISE EXCEPTION 'BUSINESS_RECORD_PURGE_ONLY' USING ERRCODE='42501'; END IF;
 ELSE
   IF NOT integrations.business_record_writer(NEW.connection_id) OR NOT EXISTS(
     SELECT 1 FROM integrations.connections c WHERE c.organization_id=NEW.organization_id
       AND c.id=NEW.connection_id AND c.state='active'
       AND c.connector_type IN('crm_http','ticketing_http','accounting_http')
       AND c.connector_type||'.read'=ANY(c.granted_scopes)
       AND jsonb_typeof(c.config->'streams')='array' AND (c.config->'streams') ? NEW.stream
       AND NEW.stream LIKE split_part(c.connector_type,'_',1)||'.%') THEN
     RAISE EXCEPTION 'BUSINESS_RECORD_WRITER_REQUIRED' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION integrations.guard_business_record() FROM PUBLIC;
CREATE TRIGGER business_record_guard BEFORE INSERT OR UPDATE ON integrations.business_records
 FOR EACH ROW EXECUTE FUNCTION integrations.guard_business_record();
