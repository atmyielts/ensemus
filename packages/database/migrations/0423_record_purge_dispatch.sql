-- Current native closure -> metadata outbox -> canonical Temporal cleanup. No historical read,
-- material disposition or byte absence is inferred here. Requires0419/0422; source only, unregistered.
CREATE POLICY record_purge_emit_header ON platform.domain_events FOR INSERT TO ensemus_migrator
 WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()>0
 AND id::text=current_setting('knowledge.record_purge_emit_event',true)
 AND event_type='knowledge.record_purge_requested' AND aggregate_type IN('work_unit','project','client','object_record')
 AND classification='restricted' AND actor_type='system' AND actor_id IS NULL AND payload='{}'::jsonb);
CREATE POLICY record_purge_emit_outbox ON platform.outbox_events FOR INSERT TO ensemus_migrator
 WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()>0
 AND event_id::text=current_setting('knowledge.record_purge_emit_event',true) AND state='queued' AND attempts=0);
CREATE FUNCTION knowledge.request_closed_record_purge() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid;kind text;target uuid;event_id uuid;prior_event text:=current_setting('knowledge.record_purge_emit_event',true);
BEGIN
 IF current_user<>'ensemus_migrator' OR TG_OP NOT IN('INSERT','UPDATE') OR
   (TG_TABLE_SCHEMA,TG_TABLE_NAME) NOT IN(('knowledge','structured_record_catalog'),('platform','tombstones')) THEN
   RAISE EXCEPTION 'RECORD_PURGE_EMIT_TARGET' USING ERRCODE='42501';END IF;
 -- Whole-tenant erasure already owns its exact proof/order; do not create new queue rows during it.
 -- This is an actual restricted LOGIN role, never a caller-controlled actor/GUC exception.
 IF session_user='ensemus_eraser' THEN RETURN NEW;END IF;
 tenant:=NEW.organization_id;
 IF tenant IS DISTINCT FROM app.current_organization_id() THEN
   RAISE EXCEPTION 'RECORD_PURGE_EMIT_TENANT' USING ERRCODE='42501';END IF;
 IF TG_TABLE_SCHEMA='knowledge' THEN
   IF NEW.alive THEN RETURN NEW;END IF;
   IF TG_OP='UPDATE' THEN
     IF NOT OLD.alive THEN RETURN NEW;END IF;
   END IF;
   kind:=NEW.record_kind;target:=NEW.record_id;
 ELSE
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'RECORD_PURGE_EMIT_TARGET' USING ERRCODE='42501';END IF;
   kind:=NEW.target_type;target:=NEW.target_id;
   IF kind NOT IN('work_unit','project','client','object_record') THEN RETURN NEW;END IF;
   -- An arbitrary tombstone without a native retained identity cannot authorize cleanup.
   IF NOT EXISTS(SELECT 1 FROM knowledge.structured_record_catalog actual
      WHERE actual.organization_id=tenant AND actual.record_kind=kind AND actual.record_id=target) THEN RETURN NEW;END IF;
 END IF;
 IF kind IS NULL OR kind NOT IN('work_unit','project','client','object_record') OR target IS NULL THEN
   RAISE EXCEPTION 'RECORD_PURGE_EMIT_TARGET' USING ERRCODE='42501';END IF;
 event_id:=gen_random_uuid();
 PERFORM set_config('knowledge.record_purge_emit_event',event_id::text,true);
 BEGIN
   INSERT INTO platform.domain_events(organization_id,id,event_type,schema_version,aggregate_type,aggregate_id,
     aggregate_version,actor_type,actor_id,classification,payload,correlation_id)
   VALUES(tenant,event_id,'knowledge.record_purge_requested',1,kind,target,1,'system',NULL,'restricted','{}'::jsonb,event_id);
   INSERT INTO platform.outbox_events(organization_id,event_id) VALUES(tenant,event_id);
 EXCEPTION WHEN OTHERS THEN
   PERFORM set_config('knowledge.record_purge_emit_event',coalesce(prior_event,''),true);RAISE;
 END;
 PERFORM set_config('knowledge.record_purge_emit_event',coalesce(prior_event,''),true);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.request_closed_record_purge() FROM PUBLIC;
CREATE TRIGGER record_catalog_purge_requested AFTER INSERT OR UPDATE OF alive ON knowledge.structured_record_catalog
 FOR EACH ROW EXECUTE FUNCTION knowledge.request_closed_record_purge();
CREATE TRIGGER record_tombstone_purge_requested AFTER INSERT ON platform.tombstones
 FOR EACH ROW EXECUTE FUNCTION knowledge.request_closed_record_purge();
--> statement-breakpoint
-- Fixed owner-only metadata views inside the two dispatcher functions. Dispatcher receives no body
-- SELECT, catalog write, actor, event payload, tombstone reason or private proof grants.
CREATE POLICY record_purge_dispatch_catalog ON knowledge.structured_record_catalog FOR SELECT TO ensemus_migrator
 USING(session_user='ensemus_dispatcher' AND current_setting('knowledge.record_purge_dispatch_scope',true) IN('event-v1','scan-v1'));
CREATE POLICY record_purge_dispatch_tombstone ON platform.tombstones FOR SELECT TO ensemus_migrator
 USING(session_user='ensemus_dispatcher' AND current_setting('knowledge.record_purge_dispatch_scope',true) IN('event-v1','scan-v1')
 AND target_type IN('work_unit','project','client','object_record'));
CREATE POLICY record_purge_dispatch_org ON org.organizations FOR SELECT TO ensemus_migrator
 USING(session_user='ensemus_dispatcher' AND current_setting('knowledge.record_purge_dispatch_scope',true) IN('event-v1','scan-v1'));
CREATE POLICY record_purge_dispatch_header ON platform.domain_events FOR SELECT TO ensemus_migrator
 USING(session_user='ensemus_dispatcher' AND current_setting('knowledge.record_purge_dispatch_scope',true)='event-v1'
 AND organization_id::text=current_setting('knowledge.record_purge_dispatch_org',true)
 AND id::text=current_setting('knowledge.record_purge_dispatch_event',true));
CREATE POLICY record_purge_dispatch_outbox ON platform.outbox_events FOR SELECT TO ensemus_migrator
 USING(session_user='ensemus_dispatcher' AND current_setting('knowledge.record_purge_dispatch_scope',true)='event-v1'
 AND organization_id::text=current_setting('knowledge.record_purge_dispatch_org',true)
 AND event_id::text=current_setting('knowledge.record_purge_dispatch_event',true));
CREATE FUNCTION knowledge.record_purge_event_target(p_org uuid,p_event uuid)
 RETURNS TABLE(organization_id uuid,record_kind text,record_id uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior_scope text:=current_setting('knowledge.record_purge_dispatch_scope',true);
 prior_org text:=current_setting('knowledge.record_purge_dispatch_org',true);prior_event text:=current_setting('knowledge.record_purge_dispatch_event',true);
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_dispatcher' OR p_org IS NULL OR p_event IS NULL THEN
   RAISE EXCEPTION 'RECORD_PURGE_DISPATCHER_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM app.assert_restore_admitted();
 PERFORM set_config('knowledge.record_purge_dispatch_scope','event-v1',true),
   set_config('knowledge.record_purge_dispatch_org',p_org::text,true),set_config('knowledge.record_purge_dispatch_event',p_event::text,true);
 BEGIN
   RETURN QUERY SELECT actual.organization_id,actual.record_kind,actual.record_id
   FROM platform.domain_events event JOIN platform.outbox_events outbox
     ON outbox.organization_id=event.organization_id AND outbox.event_id=event.id
   JOIN knowledge.structured_record_catalog actual ON actual.organization_id=event.organization_id
     AND actual.record_kind=event.aggregate_type AND actual.record_id=event.aggregate_id
   JOIN org.organizations tenant ON tenant.id=actual.organization_id AND tenant.lifecycle<>'deleted'
   WHERE event.organization_id=p_org AND event.id=p_event AND event.event_type='knowledge.record_purge_requested'
     AND actual.record_kind IN('work_unit','project','client','object_record')
     AND(NOT actual.alive OR EXISTS(SELECT 1 FROM platform.tombstones closed WHERE closed.organization_id=actual.organization_id
       AND closed.target_type=actual.record_kind AND closed.target_id=actual.record_id));
 EXCEPTION WHEN OTHERS THEN
   PERFORM set_config('knowledge.record_purge_dispatch_scope',coalesce(prior_scope,''),true),
     set_config('knowledge.record_purge_dispatch_org',coalesce(prior_org,''),true),set_config('knowledge.record_purge_dispatch_event',coalesce(prior_event,''),true);RAISE;
 END;
 PERFORM set_config('knowledge.record_purge_dispatch_scope',coalesce(prior_scope,''),true),
   set_config('knowledge.record_purge_dispatch_org',coalesce(prior_org,''),true),set_config('knowledge.record_purge_dispatch_event',coalesce(prior_event,''),true);
END $$;
REVOKE ALL ON FUNCTION knowledge.record_purge_event_target(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION knowledge.closed_record_purge_targets(p_after_org uuid,p_after_kind text,p_after_id uuid,p_limit integer)
 RETURNS TABLE(organization_id uuid,record_kind text,record_id uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior_scope text:=current_setting('knowledge.record_purge_dispatch_scope',true);
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_dispatcher' THEN
   RAISE EXCEPTION 'RECORD_PURGE_DISPATCHER_REQUIRED' USING ERRCODE='42501';END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 26 OR
   NOT((p_after_org IS NULL AND p_after_kind IS NULL AND p_after_id IS NULL)
     OR(p_after_org IS NOT NULL AND p_after_kind IS NOT NULL AND p_after_kind IN('work_unit','project','client','object_record') AND p_after_id IS NOT NULL)) THEN
   RAISE EXCEPTION 'RECORD_PURGE_PAGE_INVALID' USING ERRCODE='22023';END IF;
 PERFORM app.assert_restore_admitted();
 PERFORM set_config('knowledge.record_purge_dispatch_scope','scan-v1',true);
 BEGIN
   RETURN QUERY SELECT actual.organization_id,actual.record_kind,actual.record_id
   FROM knowledge.structured_record_catalog actual JOIN org.organizations tenant
     ON tenant.id=actual.organization_id AND tenant.lifecycle<>'deleted'
   WHERE actual.record_kind IN('work_unit','project','client','object_record')
     AND(p_after_org IS NULL OR(actual.organization_id,actual.record_kind COLLATE "C",actual.record_id)>
       (p_after_org,p_after_kind COLLATE "C",p_after_id))
     AND(NOT actual.alive OR EXISTS(SELECT 1 FROM platform.tombstones closed WHERE closed.organization_id=actual.organization_id
       AND closed.target_type=actual.record_kind AND closed.target_id=actual.record_id))
   ORDER BY actual.organization_id,actual.record_kind COLLATE "C",actual.record_id LIMIT p_limit;
 EXCEPTION WHEN OTHERS THEN
   PERFORM set_config('knowledge.record_purge_dispatch_scope',coalesce(prior_scope,''),true);RAISE;
 END;
 PERFORM set_config('knowledge.record_purge_dispatch_scope',coalesce(prior_scope,''),true);
END $$;
REVOKE ALL ON FUNCTION knowledge.closed_record_purge_targets(uuid,text,uuid,integer) FROM PUBLIC;
GRANT USAGE ON SCHEMA knowledge TO ensemus_dispatcher;
GRANT EXECUTE ON FUNCTION knowledge.record_purge_event_target(uuid,uuid),knowledge.closed_record_purge_targets(uuid,text,uuid,integer) TO ensemus_dispatcher;
