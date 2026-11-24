-- FLAGGED FOR HUMAN SECURITY REVIEW
-- LIFE-04, ADR-032. Human security review remains pending.
-- Missing populated-module protocols still refuse erasure. An admitted tenant with none of that
-- data may erase its supported content, after a database proof that also covers counterparties.
CREATE FUNCTION lifecycle.erasure_requires_empty(p_schema text,p_table text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (p_schema,p_table) IN (
    ('federation','org_settings'),('federation','grants'),('federation','outbound_items'),
    ('federation','inbound_items'),('federation','crossings'),
    ('marketplace','installations'),('marketplace','listings'),('marketplace','publishers'),
    ('marketplace','security_reviews'),('marketplace','submissions'),('sandbox','runs')
  )
$$;
REVOKE ALL ON FUNCTION lifecycle.erasure_requires_empty(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.erasure_requires_empty(text,text) TO ensemus_app,ensemus_eraser;
--> statement-breakpoint
-- The write fence selects and locks only the actual affected tenant at trigger depth.
CREATE POLICY deferred_module_write_org_read ON org.organizations FOR SELECT TO ensemus_migrator
  USING (pg_trigger_depth()>0 AND id::text=current_setting('lifecycle.deferred_module_tenant',true));
CREATE POLICY deferred_module_write_org_lock ON org.organizations FOR UPDATE TO ensemus_migrator
  USING (pg_trigger_depth()>0 AND id::text=current_setting('lifecycle.deferred_module_tenant',true))
  WITH CHECK(false);
CREATE POLICY deferred_module_write_standing ON lifecycle.offboardings FOR SELECT TO ensemus_migrator
  USING (pg_trigger_depth()>0 AND organization_id::text=current_setting('lifecycle.deferred_module_tenant',true));
CREATE POLICY deferred_module_write_stage_lock ON lifecycle.offboardings FOR UPDATE TO ensemus_migrator
  USING (pg_trigger_depth()>0 AND organization_id::text=current_setting('lifecycle.deferred_module_tenant',true))
  WITH CHECK(false);
CREATE FUNCTION lifecycle.fence_deferred_module_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenants uuid[]; previous uuid[]:='{}'; target uuid; life text; phase text;
  saved text:=current_setting('lifecycle.deferred_module_tenant',true);
BEGIN
  IF TG_OP NOT IN('INSERT','UPDATE') OR TG_LEVEL<>'ROW'
    OR lifecycle.erasure_requires_empty(TG_TABLE_SCHEMA,TG_TABLE_NAME) IS DISTINCT FROM true
    OR TG_RELID IS DISTINCT FROM to_regclass(format('%I.%I',TG_TABLE_SCHEMA,TG_TABLE_NAME))
  THEN RAISE EXCEPTION 'INVALID_DEFERRED_ERASURE_WRITE' USING ERRCODE='42501';END IF;
  CASE TG_RELID
    WHEN 'federation.grants'::regclass THEN
      tenants:=ARRAY[NEW.sharing_organization_id,NEW.receiving_organization_id,NEW.ended_by_organization_id];
      IF TG_OP='UPDATE' THEN previous:=ARRAY[OLD.sharing_organization_id,OLD.receiving_organization_id,OLD.ended_by_organization_id];END IF;
    WHEN 'federation.inbound_items'::regclass THEN
      tenants:=ARRAY[NEW.organization_id,NEW.sender_organization_id];
      IF TG_OP='UPDATE' THEN previous:=ARRAY[OLD.organization_id,OLD.sender_organization_id];END IF;
    WHEN 'federation.crossings'::regclass THEN
      tenants:=ARRAY[NEW.sender_organization_id,NEW.receiver_organization_id];
      IF TG_OP='UPDATE' THEN previous:=ARRAY[OLD.sender_organization_id,OLD.receiver_organization_id];END IF;
    WHEN 'marketplace.listings'::regclass THEN
      tenants:=ARRAY[NEW.publisher_organization_id];
      IF TG_OP='UPDATE' THEN previous:=ARRAY[OLD.publisher_organization_id];END IF;
    WHEN 'marketplace.security_reviews'::regclass THEN
      tenants:=ARRAY[NEW.submission_organization_id];
      IF TG_OP='UPDATE' THEN previous:=ARRAY[OLD.submission_organization_id];END IF;
    ELSE
      tenants:=ARRAY[NEW.organization_id];
      IF TG_OP='UPDATE' THEN previous:=ARRAY[OLD.organization_id];END IF;
  END CASE;
  -- The root lock conflicts with an erasure proof. Updating existing associations for
  -- revocation or cleanup is allowed because it cannot invalidate a zero proof.
  BEGIN
    FOR target IN
      SELECT DISTINCT id FROM unnest(tenants) AS participant(id)
        WHERE id IS NOT NULL AND NOT id=ANY(array_remove(previous,NULL)) ORDER BY id
    LOOP
      PERFORM set_config('lifecycle.deferred_module_tenant',target::text,true);
      SELECT org.lifecycle INTO life FROM org.organizations org WHERE org.id=target FOR SHARE NOWAIT;
      IF NOT FOUND OR life='deleted' THEN
        RAISE EXCEPTION 'TENANT_ERASURE_IN_PROGRESS' USING ERRCODE='EN850';
      END IF;
      -- Lock any current intent so a repeatable-read writer cannot reuse an older stage.
      FOR phase IN
        SELECT offboarding.state FROM lifecycle.offboardings offboarding
        WHERE offboarding.organization_id=target AND offboarding.state<>'cancelled' FOR SHARE NOWAIT
      LOOP
        IF phase IN('ready_for_erasure','erasing','verified','reported') THEN
          RAISE EXCEPTION 'TENANT_ERASURE_IN_PROGRESS' USING ERRCODE='EN850';
        END IF;
      END LOOP;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('lifecycle.deferred_module_tenant',coalesce(saved,''),true);
    RAISE;
  END;
  PERFORM set_config('lifecycle.deferred_module_tenant',coalesce(saved,''),true);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.fence_deferred_module_write() FROM PUBLIC;
--> statement-breakpoint
DO $migration$
DECLARE entry record;
  tables constant jsonb:='{
    "federation.org_settings":["organization_id"],
    "federation.grants":["sharing_organization_id","receiving_organization_id","ended_by_organization_id"],
    "federation.outbound_items":["organization_id"],
    "federation.inbound_items":["organization_id","sender_organization_id"],
    "federation.crossings":["sender_organization_id","receiver_organization_id"],
    "marketplace.installations":["organization_id"],
    "marketplace.listings":["publisher_organization_id"],
    "marketplace.publishers":["organization_id"],
    "marketplace.security_reviews":["submission_organization_id"],
    "marketplace.submissions":["organization_id"],
    "sandbox.runs":["organization_id"]
  }';
BEGIN
  IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator'
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  THEN RAISE EXCEPTION 'ERASURE_METADATA_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
  FOR entry IN SELECT ref::regclass AS relation,
      (SELECT string_agg(format('%I',item),', ') FROM jsonb_array_elements_text(cols) AS names(item)) AS columns,
      (SELECT string_agg(format('%I=app.current_organization_id()',item),' OR ')
       FROM jsonb_array_elements_text(cols) AS names(item)) AS predicate
    FROM jsonb_each(tables) AS coverage(ref,cols)
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=entry.relation AND c.relrowsecurity AND c.relforcerowsecurity)
    THEN RAISE EXCEPTION 'DEFERRED_ERASURE_TABLE_UNREVIEWED' USING ERRCODE='EN850';END IF;
    EXECUTE format('CREATE POLICY erasure_deferred_presence ON %s FOR SELECT TO ensemus_migrator USING (%s)',
      entry.relation,entry.predicate);
    EXECUTE format('CREATE TRIGGER lifecycle_deferred_erasure_write BEFORE INSERT OR UPDATE OF %s
      ON %s FOR EACH ROW EXECUTE FUNCTION lifecycle.fence_deferred_module_write()',entry.columns,entry.relation);
  END LOOP;
END $migration$;
--> statement-breakpoint
CREATE FUNCTION lifecycle.deferred_erasure_tables_empty() RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();
BEGIN
  -- Return a boolean only. Predicates include both sides of associations, including tables
  -- whose tenant identifiers differ from the normal erasure inventory's organization_id.
  RETURN tenant IS NOT NULL AND NOT (
    EXISTS(SELECT 1 FROM federation.org_settings WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM federation.grants WHERE sharing_organization_id=tenant OR receiving_organization_id=tenant OR ended_by_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM federation.outbound_items WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM federation.inbound_items WHERE organization_id=tenant OR sender_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM federation.crossings WHERE sender_organization_id=tenant OR receiver_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.installations WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.listings WHERE publisher_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.publishers WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.security_reviews WHERE submission_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.submissions WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM sandbox.runs WHERE organization_id=tenant)
  );
END $$;
REVOKE ALL ON FUNCTION lifecycle.deferred_erasure_tables_empty() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION lifecycle.deferred_erasure_clear(p_intent uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();
BEGIN
  IF NOT app.is_web_login() OR current_setting('role') NOT IN('none','ensemus_app')
    OR NOT knowledge.is_service_actor() OR tenant IS NULL
    OR NOT lifecycle.admitted_offboarding(p_intent) THEN RETURN false;END IF;
  PERFORM 1 FROM org.organizations WHERE id=tenant FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN false;END IF;
  -- Each deferred writer also advances this epoch. Locking it prevents a repeatable-read
  -- proof from missing a writer committed after its snapshot. The eraser may remove it later.
  PERFORM 1 FROM sovereign.export_epochs WHERE organization_id=tenant FOR SHARE NOWAIT;
  RETURN lifecycle.deferred_erasure_tables_empty();
END $$;
REVOKE ALL ON FUNCTION lifecycle.deferred_erasure_clear(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.deferred_erasure_clear(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION lifecycle.require_deferred_erasure_clear() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN('erasing','verified','reported')
    AND lifecycle.deferred_erasure_clear(OLD.id) IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'DEFERRED_ERASURE_CONTENT_PRESENT' USING ERRCODE='EN850';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.require_deferred_erasure_clear() FROM PUBLIC;
CREATE TRIGGER offboardings_require_deferred_clear BEFORE UPDATE OF state ON lifecycle.offboardings
  FOR EACH ROW EXECUTE FUNCTION lifecycle.require_deferred_erasure_clear();
--> statement-breakpoint
-- The same proof applies to physical work on erasure intents that were already open at upgrade.
CREATE OR REPLACE FUNCTION lifecycle.erasure_physical_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT lifecycle.erasure_open(app.current_organization_id()) IS TRUE
    AND lifecycle.tenant_object_proofs_complete() AND lifecycle.deferred_erasure_tables_empty()
    AND EXISTS(SELECT 1 FROM lifecycle.offboarding_admissions a JOIN lifecycle.offboardings o
      ON o.organization_id=a.organization_id AND o.id=a.offboarding_id
      WHERE a.organization_id=app.current_organization_id() AND o.state='erasing'
        AND o.requested_by_membership_id=a.requested_by_membership_id)
$$;
CREATE OR REPLACE FUNCTION lifecycle.erasure_object_intent(p_intent uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT app.is_web_login() AND knowledge.is_service_actor()
    AND lifecycle.admitted_offboarding(p_intent) AND lifecycle.deferred_erasure_tables_empty()
    AND EXISTS(SELECT 1 FROM lifecycle.offboardings o WHERE o.organization_id=app.current_organization_id()
      AND o.id=p_intent AND o.state IN('erasing','reported'))
$$;
