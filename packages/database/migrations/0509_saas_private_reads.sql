-- Private SaaS bodies are not agent context. Requires 0500-0508; register before 0999.
-- session_user is the actual login: SET ROLE app and caller-controlled actor GUCs cannot turn the
-- agent login into the app login. No mutation, catalog, operator or support-desk grant is added.
CREATE FUNCTION app.saas_private_reader_role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN session_user='ensemus_app' AND current_user='ensemus_app' THEN
    CASE WHEN app.current_actor_type()='service' THEN 'service'
      WHEN app.current_actor_type()='user' THEN (
        SELECT m.role FROM org.memberships m WHERE m.organization_id=app.current_organization_id()
          AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active'
      ) ELSE NULL END ELSE NULL END
$$;
REVOKE ALL ON FUNCTION app.saas_private_reader_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.saas_private_reader_role() TO ensemus_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_accounts','subscriptions','subscription_changes','standing_changes',
    'billing_periods','credit_accounts','top_ups','credit_ledger','invoices','invoice_lines','payments',
    'payment_attempts','payment_events','payment_webhook_events','collection_cases'] LOOP
    EXECUTE format('CREATE POLICY private_billing_read ON billing.%I AS RESTRICTIVE FOR SELECT TO ensemus_app USING(app.saas_private_reader_role() IN (''owner'',''admin'',''service''))',t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY private_ticket_read ON support.tickets AS RESTRICTIVE FOR SELECT TO ensemus_app
  USING(app.saas_private_reader_role() IN('owner','admin','service') OR
    (app.saas_private_reader_role()='member' AND opened_by_membership_id=app.current_membership_id()));
CREATE POLICY private_message_read ON support.ticket_messages AS RESTRICTIVE FOR SELECT TO ensemus_app
  USING(EXISTS(SELECT 1 FROM support.tickets t WHERE t.organization_id=ticket_messages.organization_id AND t.id=ticket_messages.ticket_id));
CREATE POLICY private_break_glass_read ON support.break_glass_requests AS RESTRICTIVE FOR SELECT TO ensemus_app
  USING(app.saas_private_reader_role() IN('owner','service'));
CREATE POLICY private_break_glass_log_read ON support.break_glass_log AS RESTRICTIVE FOR SELECT TO ensemus_app
  USING(app.saas_private_reader_role() IN('owner','service'));
--> statement-breakpoint
-- A fixed metadata-only projection preserves standing/capacity checks for all actual members and
-- agent-worker principals. The owner has no RLS bypass; only this bounded function sets its scope.
CREATE POLICY entitlement_member_metadata ON org.memberships FOR SELECT TO ensemus_migrator
  USING(session_user IN('ensemus_app','ensemus_agent') AND organization_id=app.current_organization_id()
    AND organization_id::text=current_setting('billing.entitlement_org',true)
    AND id=app.current_membership_id() AND user_id=app.current_user_id() AND status='active');
CREATE POLICY entitlement_org_metadata ON org.organizations FOR SELECT TO ensemus_migrator
  USING(session_user IN('ensemus_app','ensemus_agent') AND id=app.current_organization_id()
    AND id::text=current_setting('billing.entitlement_org',true));
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions','credit_accounts','standing_changes'] LOOP
    EXECUTE format('CREATE POLICY entitlement_fixed_metadata ON billing.%I FOR SELECT TO ensemus_migrator USING(session_user IN(''ensemus_app'',''ensemus_agent'') AND organization_id=app.current_organization_id() AND organization_id::text=current_setting(''billing.entitlement_org'',true))',t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION billing.current_entitlement_metadata()
RETURNS TABLE("planVersionId" uuid,"subscriptionStatus" text,"balanceMicrocredits" bigint,"standingReasonCode" text,"standingChangedAt" timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_scope text:=current_setting('billing.entitlement_org',true);org_id uuid:=app.current_organization_id();
BEGIN
  IF current_user<>'ensemus_migrator' OR session_user NOT IN('ensemus_app','ensemus_agent') OR org_id IS NULL THEN
    RAISE EXCEPTION 'ENTITLEMENT_METADATA_TARGET' USING ERRCODE='42501';END IF;
  PERFORM set_config('billing.entitlement_org',org_id::text,true);
  IF app.current_actor_type() IS DISTINCT FROM 'service' THEN
    IF app.current_actor_type() IS NULL OR app.current_actor_type() NOT IN('user','agent','delegated') OR NOT EXISTS(
      SELECT 1 FROM org.memberships m WHERE m.organization_id=org_id AND m.id=app.current_membership_id()
        AND m.user_id=app.current_user_id() AND m.status='active'
    ) THEN RAISE EXCEPTION 'ENTITLEMENT_METADATA_PERSON' USING ERRCODE='42501';END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM org.organizations o WHERE o.id=org_id AND o.lifecycle<>'deleted') THEN
    RAISE EXCEPTION 'ENTITLEMENT_METADATA_TENANT' USING ERRCODE='42501';END IF;
  RETURN QUERY SELECT s.plan_version_id,s.status,coalesce(a.balance_microcredits,0::bigint),
    CASE WHEN c.reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$' THEN c.reason_code ELSE NULL END,c.occurred_at
    FROM(SELECT 1) singleton
    LEFT JOIN LATERAL(SELECT v.plan_version_id,v.status FROM billing.subscriptions v
      WHERE v.organization_id=org_id ORDER BY v.created_at DESC,v.id DESC LIMIT 1) s ON true
    LEFT JOIN billing.credit_accounts a ON a.organization_id=org_id
    LEFT JOIN LATERAL(SELECT h.reason_code,h.occurred_at FROM billing.standing_changes h
      WHERE h.organization_id=org_id ORDER BY h.occurred_at DESC,h.id DESC LIMIT 1) c ON true;
  PERFORM set_config('billing.entitlement_org',coalesce(previous_scope,''),true);
  RETURN;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('billing.entitlement_org',coalesce(previous_scope,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.current_entitlement_metadata() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.current_entitlement_metadata() TO ensemus_app;
