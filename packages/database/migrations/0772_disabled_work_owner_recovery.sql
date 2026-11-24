-- FLAGGED FOR HUMAN SECURITY REVIEW
-- WORK-03, ADR-024 D4, ADR-039 D1.
-- Recovery is a bounded control operation for a native organization owner. Ordinary Work,
-- inherited input, review and file body policies keep their existing authority.
CREATE FUNCTION work.owner_recovery_scope(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(app.is_web_login() AND app.current_actor_type()='user'
    AND p_org=app.current_organization_id()
    AND nullif(current_setting('work.owner_recovery_target',true),'') IS NOT NULL,false)
$$;
REVOKE ALL ON FUNCTION work.owner_recovery_scope(uuid) FROM PUBLIC;
CREATE POLICY owner_recovery_member_metadata ON org.memberships FOR SELECT TO ensemus_migrator
  USING(work.owner_recovery_scope(organization_id));
CREATE POLICY owner_recovery_organization ON org.organizations FOR SELECT TO ensemus_migrator
  USING(work.owner_recovery_scope(id));
CREATE POLICY owner_recovery_organization_lock ON org.organizations FOR UPDATE TO ensemus_migrator
  USING(work.owner_recovery_scope(id)) WITH CHECK(false);
CREATE FUNCTION work.is_recovery_owner(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT work.owner_recovery_scope(p_org) AND EXISTS(
    SELECT 1 FROM org.memberships actor WHERE actor.organization_id=p_org AND actor.id=app.current_membership_id()
      AND actor.user_id=app.current_user_id() AND actor.role='owner' AND actor.status='active')
$$;
REVOKE ALL ON FUNCTION work.is_recovery_owner(uuid) FROM PUBLIC;
CREATE POLICY owner_recovery_work_metadata ON work.work_units FOR SELECT TO ensemus_migrator
  USING(work.is_recovery_owner(organization_id)
    AND (id::text=current_setting('work.owner_recovery_target',true)
      OR (current_setting('work.owner_recovery_target',true)='list' AND EXISTS(
        SELECT 1 FROM org.memberships gone WHERE gone.organization_id=work_units.organization_id
          AND gone.id=work_units.owner_membership_id AND gone.status='disabled'))));
CREATE POLICY owner_recovery_work_transfer ON work.work_units FOR UPDATE TO ensemus_migrator
  USING(work.is_recovery_owner(organization_id) AND id::text=current_setting('work.owner_recovery_target',true))
  WITH CHECK(work.is_recovery_owner(organization_id) AND id::text=current_setting('work.owner_recovery_target',true));
CREATE POLICY owner_recovery_tombstones ON platform.tombstones FOR SELECT TO ensemus_migrator
  USING(work.owner_recovery_scope(organization_id) AND target_type='work_unit'
    AND current_setting('work.owner_recovery_target',true) IN('list',target_id::text));
CREATE POLICY owner_recovery_event ON platform.domain_events FOR INSERT TO ensemus_migrator
  WITH CHECK(work.owner_recovery_scope(organization_id) AND event_type='work.owner_changed'
    AND aggregate_type='work_unit' AND aggregate_id::text=current_setting('work.owner_recovery_target',true)
    AND actor_type='membership' AND actor_id=app.current_membership_id());
CREATE POLICY owner_recovery_outbox ON platform.outbox_events FOR INSERT TO ensemus_migrator
  WITH CHECK(work.owner_recovery_scope(organization_id) AND state='queued' AND attempts=0
    AND event_id::text=current_setting('work.owner_recovery_event',true));
CREATE POLICY owner_recovery_audit ON governance.audit_events FOR INSERT TO ensemus_migrator
  WITH CHECK(work.owner_recovery_scope(organization_id) AND action='work.owner_changed'
    AND target_ref='work_unit:'||current_setting('work.owner_recovery_target',true)
    AND actor_type='user' AND actor_id=app.current_membership_id()
    AND decision='allow' AND safe_reason='OWNER_DISABLED');
CREATE POLICY owner_recovery_notice ON platform.notifications FOR INSERT TO ensemus_migrator
  WITH CHECK(work.owner_recovery_scope(organization_id) AND recipient_membership_id<>app.current_membership_id()
    AND ((kind='work.assigned' AND target_ref='work_unit:'||current_setting('work.owner_recovery_target',true))
      OR (kind='work.owner_recovered' AND target_ref='membership:'||current_setting('work.owner_recovery_recipient',true))));
-- Preserve the existing notification-triggered mail queue without granting a mail read path.
CREATE POLICY owner_recovery_mail ON platform.mail_outbox FOR INSERT TO ensemus_migrator
  WITH CHECK(work.owner_recovery_scope(organization_id) AND pg_trigger_depth()>0
    AND kind='notification' AND reminder_number IS NULL AND status='queued' AND attempts=0
    AND current_setting('mail.notification_enqueue',true)=organization_id::text||':'||notification_id::text
    AND ((notification_kind='work.assigned' AND target_ref='work_unit:'||current_setting('work.owner_recovery_target',true))
      OR (notification_kind='work.owner_recovered' AND target_ref='membership:'||current_setting('work.owner_recovery_recipient',true))));
--> statement-breakpoint
-- Visible Work is determined by the ordinary caller, so inherited input and parent checks retain
-- their exact RLS context. The exclusion list can only remove rows from this metadata projection.
CREATE FUNCTION work.list_disabled_owner_recovery(p_visible uuid[]) RETURNS TABLE(id uuid,version bigint,status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();
  previous_target text:=current_setting('work.owner_recovery_target',true);
BEGIN
  IF current_user<>'ensemus_migrator' OR NOT app.is_web_login() OR app.current_actor_type() IS DISTINCT FROM 'user' THEN RETURN; END IF;
  PERFORM set_config('work.owner_recovery_target','list',true);
  IF work.is_recovery_owner(tenant) THEN
    RETURN QUERY
      SELECT item.id,item.version,item.status FROM work.work_units item
      JOIN org.memberships gone ON gone.organization_id=item.organization_id AND gone.id=item.owner_membership_id
      WHERE item.organization_id=tenant AND gone.status='disabled'
        AND NOT (item.id=ANY(coalesce(p_visible,'{}'::uuid[])))
        AND NOT EXISTS(SELECT 1 FROM platform.tombstones mark WHERE mark.organization_id=tenant
          AND mark.target_type='work_unit' AND mark.target_id=item.id)
      ORDER BY item.updated_at DESC,item.id
      LIMIT 50;
  END IF;
  PERFORM set_config('work.owner_recovery_target',coalesce(previous_target,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('work.owner_recovery_target',coalesce(previous_target,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION work.list_disabled_owner_recovery(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.list_disabled_owner_recovery(uuid[]) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION work.recover_disabled_owner(p_work uuid,p_version bigint,p_member uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id(); actor uuid:=app.current_membership_id();
  current_version bigint; level text; recipient_status text; event uuid; outcome text;
  previous_target text:=current_setting('work.owner_recovery_target',true);
  previous_event text:=current_setting('work.owner_recovery_event',true);
  previous_recipient text:=current_setting('work.owner_recovery_recipient',true);
BEGIN
  IF current_user<>'ensemus_migrator' OR NOT app.is_web_login() OR app.current_actor_type() IS DISTINCT FROM 'user'
    OR tenant IS NULL OR actor IS NULL THEN RETURN 'FORBIDDEN'; END IF;
  IF p_work IS NULL OR p_version IS NULL OR p_member IS NULL OR p_version<1 THEN RETURN 'INVALID_INPUT'; END IF;
  <<recovery>> BEGIN
    PERFORM set_config('work.owner_recovery_target',p_work::text,true);
    -- The same order as disable/demote. Membership ownership and the recipient cannot change between
    -- validation and the effect, including when this function waited for another transfer.
    PERFORM pg_advisory_xact_lock(hashtextextended('member_changes:'||tenant::text,0));
    IF work.is_recovery_owner(tenant) IS DISTINCT FROM true THEN outcome:='FORBIDDEN'; EXIT recovery; END IF;
    PERFORM 1 FROM org.organizations o WHERE o.id=tenant AND o.lifecycle='active' FOR SHARE NOWAIT;
    IF NOT FOUND THEN outcome:='TENANT_READ_ONLY'; EXIT recovery; END IF;

    SELECT item.version INTO current_version FROM work.work_units item
      JOIN org.memberships gone ON gone.organization_id=item.organization_id AND gone.id=item.owner_membership_id
      WHERE item.organization_id=tenant AND item.id=p_work AND gone.status='disabled'
        AND NOT EXISTS(SELECT 1 FROM platform.tombstones mark WHERE mark.organization_id=tenant
          AND mark.target_type='work_unit' AND mark.target_id=p_work)
      FOR UPDATE OF item;
    IF NOT FOUND THEN outcome:='NOT_FOUND'; EXIT recovery; END IF;
    IF current_version<>p_version THEN outcome:='VERSION_CONFLICT'; EXIT recovery; END IF;
    SELECT recipient.status INTO recipient_status FROM org.memberships recipient
      WHERE recipient.organization_id=tenant AND recipient.id=p_member;
    IF NOT FOUND THEN outcome:='FOREIGN_REFERENCE'; EXIT recovery; END IF;
    IF recipient_status<>'active' THEN outcome:='INVALID_INPUT'; EXIT recovery; END IF;

    UPDATE work.work_units item SET owner_membership_id=p_member,version=current_version+1,updated_at=clock_timestamp()
      WHERE item.organization_id=tenant AND item.id=p_work AND item.version=current_version
      RETURNING item.classification INTO level;
    IF NOT FOUND THEN outcome:='VERSION_CONFLICT'; EXIT recovery; END IF;

    -- A direct native invocation has the same audit, event and notices as the interactive path.
    -- Only identifiers and existing fixed event/status codes leave the Work row.
    event:=gen_random_uuid();
    PERFORM set_config('work.owner_recovery_event',event::text,true);
    PERFORM set_config('work.owner_recovery_recipient',p_member::text,true);
    INSERT INTO platform.domain_events(organization_id,id,event_type,aggregate_type,aggregate_id,
      aggregate_version,actor_type,actor_id,classification,payload,correlation_id)
      VALUES(tenant,event,'work.owner_changed','work_unit',p_work,current_version+1,'membership',actor,level,
        jsonb_build_object('work_unit_id',p_work,'owner_membership_id',p_member),event);
    INSERT INTO platform.outbox_events(organization_id,event_id) VALUES(tenant,event);
    INSERT INTO governance.audit_events(organization_id,actor_type,actor_id,action,target_ref,decision,safe_reason)
      VALUES(tenant,'user',actor,'work.owner_changed','work_unit:'||p_work::text,'allow','OWNER_DISABLED');
    IF actor<>p_member THEN
      INSERT INTO platform.notifications(organization_id,recipient_membership_id,kind,target_ref)
        VALUES(tenant,p_member,'work.assigned','work_unit:'||p_work::text);
    END IF;
    INSERT INTO platform.notifications(organization_id,recipient_membership_id,kind,target_ref)
      SELECT tenant,owner.id,'work.owner_recovered','membership:'||p_member::text FROM org.memberships owner
      WHERE owner.organization_id=tenant AND owner.role='owner' AND owner.status='active' AND owner.id<>actor;
    outcome:='RECOVERED';
  END recovery;
  PERFORM set_config('work.owner_recovery_target',coalesce(previous_target,''),true),
    set_config('work.owner_recovery_event',coalesce(previous_event,''),true),
    set_config('work.owner_recovery_recipient',coalesce(previous_recipient,''),true);
  RETURN outcome;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('work.owner_recovery_target',coalesce(previous_target,''),true),
    set_config('work.owner_recovery_event',coalesce(previous_event,''),true),
    set_config('work.owner_recovery_recipient',coalesce(previous_recipient,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION work.recover_disabled_owner(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.recover_disabled_owner(uuid,bigint,uuid) TO ensemus_app;
