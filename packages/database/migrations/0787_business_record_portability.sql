-- FLAGGED FOR HUMAN SECURITY REVIEW
-- COMM-05 and EXP-02. Archive the source references and action links under current source grants.
ALTER TABLE sovereign.organization_exports
  DROP CONSTRAINT organization_exports_inventory_version_check,
  ADD CONSTRAINT organization_exports_inventory_version_check CHECK (
    inventory_version IS NULL OR inventory_version IN (
      'ensemus.m3-m7/3','ensemus.m3-m7-federation/4','ensemus.skill-metadata/5',
      'ensemus.marketplace-publisher/6','ensemus.meeting-config/7','ensemus.meeting-history/8',
      'ensemus.business-records/9'
    )
  );
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.portable_profile_clear(text)'::regprocedure);
  old_tail constant text:='''ensemus.meeting-history/8'')';
  new_tail constant text:='''ensemus.meeting-history/8'',''ensemus.business-records/9'')';
  meeting_disable constant text:='p_profile<>''ensemus.meeting-history/8''';
  meeting_enable constant text:='p_profile=''ensemus.meeting-history/8''';
  relation text;
  probe text;
BEGIN
  IF strpos(definition,old_tail)=0 OR strpos(definition,meeting_disable)=0
    OR strpos(definition,meeting_enable)=0 THEN
    RAISE EXCEPTION 'PORTABLE_BUSINESS_PROFILE_CHANGED' USING ERRCODE='EN301';
  END IF;
  definition:=replace(definition,old_tail,new_tail);
  definition:=replace(definition,meeting_disable,'p_profile NOT IN('||new_tail);
  definition:=replace(definition,meeting_enable,'p_profile IN('||new_tail);
  FOREACH relation IN ARRAY ARRAY['business_record_actions','business_records'] LOOP
    probe:='EXISTS(SELECT 1 FROM integrations.'||relation||' WHERE organization_id=tenant)';
    IF strpos(definition,probe)=0 THEN
      RAISE EXCEPTION 'PORTABLE_BUSINESS_PROBE_CHANGED' USING ERRCODE='EN301';
    END IF;
    definition:=replace(definition,probe,'(p_profile<>''ensemus.business-records/9'' AND '||probe||')');
  END LOOP;
  EXECUTE definition;

  definition:=pg_get_functiondef('sovereign.guard_export_inventory_pin()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_BUSINESS_PIN_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_export_viewer()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_BUSINESS_VIEW_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);
END $migration$;
--> statement-breakpoint
-- Only the fixed definer in the named owner's archive scope needs to confirm linked Work.
CREATE POLICY archive_business_action_facts ON integrations.external_actions FOR SELECT TO ensemus_migrator
 USING(organization_id=app.current_organization_id() AND session_user='ensemus_worker'
   AND knowledge.is_service_actor() AND nullif(current_setting('sovereign.archive_viewer',true),'') IS NOT NULL
   AND EXISTS(SELECT 1 FROM integrations.business_record_actions b
     WHERE b.organization_id=external_actions.organization_id AND b.external_action_id=external_actions.id));
--> statement-breakpoint
CREATE FUNCTION sovereign.portable_business_page(p_kind text,p_after uuid,p_limit integer)
RETURNS TABLE (key uuid,record jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  tenant uuid:=app.current_organization_id();
  owner_id uuid;
  previous_viewer text;
  previous_guard_viewer text;
  snapshot timestamptz;
BEGIN
  IF session_user<>'ensemus_worker' OR NOT knowledge.is_service_actor()
    OR tenant IS NULL OR p_kind IS NULL OR p_kind NOT IN('check','record','action')
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RETURN; END IF;
  owner_id:=sovereign.portable_export_viewer();
  IF owner_id IS NULL THEN RETURN; END IF;
  SELECT e.snapshot_at INTO snapshot FROM sovereign.organization_exports e
    WHERE e.organization_id=tenant AND e.id::text=current_setting('app.portability_export_id',true)
      AND e.inventory_version='ensemus.business-records/9' AND e.status='running';
  IF snapshot IS NULL THEN RETURN; END IF;

  previous_viewer:=current_setting('sovereign.archive_viewer',true);
  previous_guard_viewer:=current_setting('sovereign.export_guard_viewer',true);
  PERFORM set_config('sovereign.archive_viewer',owner_id::text,true);
  PERFORM set_config('sovereign.export_guard_viewer',owner_id::text,true);
  BEGIN
    -- Require the same current resource, version, field fingerprint, class, mapped grant and
    -- connection scope as the live reader. Project only IDs and metadata from the source cache.
    RETURN QUERY WITH checked AS NOT MATERIALIZED (
        SELECT b.id,b.connection_id,b.stream,b.classification,b.first_seen_at,b.updated_at,r.id AS resource_id
        FROM integrations.business_records b
        LEFT JOIN integrations.connections c
          ON c.organization_id=b.organization_id AND c.id=b.connection_id
          AND c.state='active' AND (c.owner_membership_id IS NULL OR c.owner_membership_id=owner_id)
          AND c.connector_type IN('crm_http','ticketing_http','accounting_http')
          AND c.connector_type||'.read'=ANY(c.granted_scopes)
          AND jsonb_typeof(c.config->'streams')='array' AND (c.config->'streams') ? b.stream
        LEFT JOIN integrations.external_resources r
          ON r.organization_id=c.organization_id AND r.connection_id=c.id
          AND r.stream=b.stream AND r.external_id=b.external_id AND r.deleted_at IS NULL
          AND r.external_version IS NOT DISTINCT FROM b.external_version AND r.content_sha256=b.fields_sha256
          AND r.classification=b.classification AND r.acl_state IN('mapped','partial')
          AND EXISTS(SELECT 1 FROM integrations.external_resource_acl a
            WHERE a.organization_id=r.organization_id AND a.resource_id=r.id AND a.access IN('read','write','owner')
              AND (a.membership_id=owner_id OR EXISTS(SELECT 1 FROM org.team_memberships tm
                WHERE tm.organization_id=a.organization_id AND tm.team_id=a.team_id AND tm.membership_id=owner_id)))
          AND b.deleted_at IS NULL AND b.classification IN('public','internal','confidential')
        WHERE b.organization_id=tenant AND b.first_seen_at<=snapshot
          AND (p_kind<>'record' OR p_after IS NULL OR b.id>p_after)
      ), actions AS NOT MATERIALIZED (
        SELECT b.external_action_id,b.business_record_id,b.created_at,
          coalesce(a.classification IN('public','internal','confidential')
            AND knowledge.can_read_work(a.work_unit_id,owner_id),false) AS readable
        FROM integrations.business_record_actions b
        LEFT JOIN integrations.external_actions a
          ON a.organization_id=b.organization_id AND a.id=b.external_action_id
        WHERE b.organization_id=tenant AND b.created_at<=snapshot
          AND (p_kind<>'action' OR p_after IS NULL OR b.external_action_id>p_after)
      )
      SELECT NULL::uuid,jsonb_build_object('allowed',
        NOT EXISTS(SELECT 1 FROM checked q WHERE q.resource_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM actions a WHERE NOT a.readable))
      WHERE p_kind='check'
      UNION ALL
      (SELECT q.id,jsonb_build_object('kind','business_record_reference','id',q.id,
        'connection_id',q.connection_id,'resource_id',q.resource_id,'stream',q.stream,'classification',q.classification,
        'first_seen_at',to_char(q.first_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'updated_at',to_char(q.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      FROM checked q WHERE p_kind='record' AND q.resource_id IS NOT NULL ORDER BY q.id LIMIT p_limit)
      UNION ALL
      (SELECT b.external_action_id,jsonb_build_object(
        'kind','business_record_action_reference','id',b.external_action_id,'business_record_id',b.business_record_id,
        'created_at',to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      FROM actions b JOIN checked q ON q.id=b.business_record_id
      WHERE p_kind='action' AND b.readable AND q.resource_id IS NOT NULL
      ORDER BY b.external_action_id LIMIT p_limit);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('sovereign.archive_viewer',coalesce(previous_viewer,''),true);
    PERFORM set_config('sovereign.export_guard_viewer',coalesce(previous_guard_viewer,''),true);
    RAISE;
  END;
  PERFORM set_config('sovereign.archive_viewer',coalesce(previous_viewer,''),true);
  PERFORM set_config('sovereign.export_guard_viewer',coalesce(previous_guard_viewer,''),true);
END $function$;
REVOKE ALL ON FUNCTION sovereign.portable_business_page(text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.portable_business_page(text,uuid,integer) TO ensemus_worker;
--> statement-breakpoint
DO $migration$
DECLARE
  kind_check text;
  definition text:=pg_get_functiondef('sovereign.guard_portable_definition()'::regprocedure);
  anchor constant text:='allowed:=string_to_array(CASE NEW.record_kind';
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT kind_check FROM pg_constraint
    WHERE conrelid='sovereign.imported_definitions'::regclass AND conname='imported_definitions_record_kind_check';
  ALTER TABLE sovereign.imported_definitions DROP CONSTRAINT imported_definitions_record_kind_check;
  EXECUTE 'ALTER TABLE sovereign.imported_definitions ADD CONSTRAINT imported_definitions_record_kind_check '
    ||'CHECK (('||kind_check||') OR (section=''connections'' AND record_kind IN ('
    ||'''business_record_reference'',''business_record_action_reference'')))';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_BUSINESS_QUARANTINE_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,anchor,anchor||$sql$
    WHEN 'business_record_reference' THEN 'kind,id,connection_id,resource_id,stream,classification,first_seen_at,updated_at'
    WHEN 'business_record_action_reference' THEN 'kind,id,business_record_id,created_at'
  $sql$);
END $migration$;
--> statement-breakpoint
CREATE POLICY business_reference_review_custodian ON sovereign.imported_definitions
  AS RESTRICTIVE FOR SELECT TO ensemus_app USING (
    record_kind NOT IN ('business_record_reference','business_record_action_reference') OR EXISTS(
      SELECT 1 FROM sovereign.organization_imports i WHERE i.organization_id=imported_definitions.organization_id
        AND i.id=imported_definitions.import_id AND i.fallback_membership_id=app.current_membership_id()
    )
  );
