-- Requires the complete 0417/0419 authority chain and 0508 hold-placement barrier. Unregistered
-- source foundation: this is not a Work redaction, object deletion or financial settlement grant.
-- Unlike 0510, an actual empty consumer set needs no invented child receipt to prove its hold fence.
CREATE FUNCTION lifecycle.record_purge_hold_scope(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(current_user='ensemus_migrator' AND session_user IN('ensemus_app','ensemus_agent')
    AND app.current_actor_type()='service' AND p_org=app.current_organization_id()
    AND p_org::text=current_setting('lifecycle.record_purge_org',true)
    AND current_setting('lifecycle.record_purge_kind',true) IN('work_unit','project','client','object_record')
    AND nullif(current_setting('lifecycle.record_purge_id',true),'') IS NOT NULL
    AND current_setting('lifecycle.record_purge_hash',true) ~ '^[0-9a-f]{64}$',false)
$$;
REVOKE ALL ON FUNCTION lifecycle.record_purge_hold_scope(uuid) FROM PUBLIC;
-- A locking SELECT needs UPDATE visibility in PostgreSQL. WITH CHECK(false) grants no effect.
CREATE POLICY record_purge_hold_org_read ON org.organizations FOR SELECT TO ensemus_migrator
  USING(lifecycle.record_purge_hold_scope(id));
CREATE POLICY record_purge_hold_org_lock ON org.organizations FOR UPDATE TO ensemus_migrator
  USING(lifecycle.record_purge_hold_scope(id)) WITH CHECK(false);
--> statement-breakpoint
CREATE FUNCTION lifecycle.record_purge_hold_free(p_kind text,p_id uuid,p_snapshot_sha256 text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();actual_snapshot text;permitted boolean:=false;
  previous_org text:=current_setting('lifecycle.record_purge_org',true);
  previous_kind text:=current_setting('lifecycle.record_purge_kind',true);
  previous_id text:=current_setting('lifecycle.record_purge_id',true);
  previous_hash text:=current_setting('lifecycle.record_purge_hash',true);
BEGIN
  IF current_user<>'ensemus_migrator' OR session_user NOT IN('ensemus_app','ensemus_agent')
    OR app.current_actor_type() IS DISTINCT FROM 'service' OR tenant IS NULL OR p_id IS NULL
    OR p_kind IS NULL OR p_kind NOT IN('work_unit','project','client','object_record')
    OR p_snapshot_sha256 IS NULL OR p_snapshot_sha256 !~ '^[0-9a-f]{64}$' THEN RETURN false;END IF;
  PERFORM set_config('lifecycle.record_purge_org',tenant::text,true);
  PERFORM set_config('lifecycle.record_purge_kind',p_kind,true);
  PERFORM set_config('lifecycle.record_purge_id',p_id::text,true);
  PERFORM set_config('lifecycle.record_purge_hash',p_snapshot_sha256,true);
  BEGIN
    <<proof>>
    BEGIN
      -- Preserve record/catalog -> org order. These NOWAIT acquisitions break the inverse hold
      -- placement order without sleeping or retrying inside an open transaction.
      actual_snapshot:=ai.lock_record_purge_snapshot(p_kind,p_id);
      IF actual_snapshot IS NULL OR actual_snapshot IS DISTINCT FROM p_snapshot_sha256 THEN EXIT proof;END IF;
      PERFORM actual.id FROM org.organizations actual WHERE actual.id=tenant FOR NO KEY UPDATE NOWAIT;
      IF NOT FOUND THEN EXIT proof;END IF;
      -- 0508 grants the definer only id/org/status/time hold metadata under tenant RLS. The
      -- conservative whole-tenant hold check covers record-specific and future scope kinds too.
      IF EXISTS(SELECT 1 FROM lifecycle.legal_holds hold WHERE hold.organization_id=tenant AND hold.status='active') THEN EXIT proof;END IF;
      IF ai.lock_record_purge_snapshot(p_kind,p_id) IS DISTINCT FROM p_snapshot_sha256 THEN EXIT proof;END IF;
      permitted:=true;
    END proof;
  EXCEPTION WHEN lock_not_available THEN permitted:=false;
  END;
  PERFORM set_config('lifecycle.record_purge_org',coalesce(previous_org,''),true);
  PERFORM set_config('lifecycle.record_purge_kind',coalesce(previous_kind,''),true);
  PERFORM set_config('lifecycle.record_purge_id',coalesce(previous_id,''),true);
  PERFORM set_config('lifecycle.record_purge_hash',coalesce(previous_hash,''),true);
  RETURN permitted;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('lifecycle.record_purge_org',coalesce(previous_org,''),true);
  PERFORM set_config('lifecycle.record_purge_kind',coalesce(previous_kind,''),true);
  PERFORM set_config('lifecycle.record_purge_id',coalesce(previous_id,''),true);
  PERFORM set_config('lifecycle.record_purge_hash',coalesce(previous_hash,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.record_purge_hold_free(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.record_purge_hold_free(text,uuid,text) TO ensemus_app,ensemus_agent;
