-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (LIFE-04, ADR-032 D7). Human security review remains pending.
-- Add counts and restricted deletion for tenant-local expansion data. Future coverage is still
-- fail-closed: the runtime inventory checks every non-retained table, including those with a
-- separate file or counterparty cleanup protocol still to be composed.
CREATE FUNCTION lifecycle.lock_expansion_erase() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF current_user='ensemus_eraser' AND lifecycle.lock_erasure_tenant() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ERASURE_NOT_OPEN' USING ERRCODE='42501';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lifecycle.lock_expansion_erase() FROM PUBLIC;
--> statement-breakpoint
DO $migration$
DECLARE
  ref text;
  schema_name text;
  table_name text;
  target regclass;
  definition text;
  strict_inventory text;
  remaining text;
  table_refs constant text[] := ARRAY[
    'integrations.business_record_actions',
    'integrations.business_records',
    'meetings.consent_records',
    'meetings.derivation_runs',
    'meetings.import_requests',
    'meetings.meetings',
    'meetings.notes',
    'meetings.participants',
    'meetings.proposed_items',
    'meetings.provider_approvals',
    'meetings.settings',
    'meetings.summaries',
    'tenancy.residency_requirements'
  ];
  other_protocols constant text[] := ARRAY[
    'federation.inbound_items',
    'federation.org_settings',
    'federation.outbound_items',
    'marketplace.installations',
    'marketplace.publishers',
    'marketplace.submissions',
    'sandbox.runs',
    'skills.package_versions',
    'skills.packages',
    'skills.test_runs',
    'skills.trusted_signers'
  ];
  inventory_anchor constant text := '''work.work_units''';
  filter_anchor constant text :=
    'AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text) ORDER BY';
  schema_anchor constant text := '''support'',''platform'')';
  restore_anchor constant text := '''support'',''lifecycle'',''operations'']';
  append_anchor constant text := '''work.work_transitions''::regclass)';
  participant_anchor constant text := 'BEGIN
  IF TG_OP = ''DELETE'' THEN';
BEGIN
  IF current_user <> 'ensemus_migrator' OR session_user <> 'ensemus_migrator'
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'EXPANSION_ERASURE_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;

  FOREACH ref IN ARRAY table_refs LOOP
    schema_name := split_part(ref,'.',1);
    table_name := split_part(ref,'.',2);
    target := to_regclass(ref);
    IF target IS NULL OR lifecycle.retained_table(schema_name,table_name)
      OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=target AND relrowsecurity AND relforcerowsecurity)
      OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=target
        AND attname='organization_id' AND atttypid='uuid'::regtype AND NOT attisdropped) THEN
      RAISE EXCEPTION 'EXPANSION_ERASURE_TABLE_CHANGED' USING ERRCODE='EN850', DETAIL=ref;
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO ensemus_eraser', schema_name);
    EXECUTE format('GRANT SELECT(organization_id), DELETE ON %I.%I TO ensemus_eraser',schema_name,table_name);
    EXECUTE format('CREATE POLICY eraser_delete ON %I.%I TO ensemus_eraser
       USING (organization_id=app.current_organization_id() AND lifecycle.erasure_open(organization_id))',
      schema_name,table_name);
    EXECUTE format('CREATE TRIGGER expansion_erasure_lock BEFORE DELETE ON %I.%I
      FOR EACH STATEMENT EXECUTE FUNCTION lifecycle.lock_expansion_erase()',schema_name,table_name);
  END LOOP;

  -- Only these append-only tables can pass the existing physical proof predicate for a DELETE.
  -- Updates, truncation and retention evidence still pass through the original refusals.
  definition := pg_get_functiondef('app.reject_change()'::regprocedure);
  IF (length(definition)-length(replace(definition,append_anchor,'')))/length(append_anchor)<>1 THEN
    RAISE EXCEPTION 'EXPANSION_ERASURE_APPEND_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,append_anchor,
    array_to_string(ARRAY[
      '''meetings.consent_records''::regclass',
      '''meetings.derivation_runs''::regclass',
      '''meetings.import_requests''::regclass',
      '''meetings.meetings''::regclass',
      '''meetings.notes''::regclass',
      '''meetings.proposed_items''::regclass',
      '''meetings.provider_approvals''::regclass',
      '''meetings.summaries''::regclass',
      append_anchor
    ], E',\n  '));

  -- Ordinary participant changes continue checking meeting state and freezing the roster after
  -- notes exist. The restricted eraser has no read access to that content and uses the root lock.
  definition := pg_get_functiondef('meetings.check_participant_change()'::regprocedure);
  IF (length(definition)-length(replace(definition,participant_anchor,'')))/length(participant_anchor)<>1 THEN
    RAISE EXCEPTION 'EXPANSION_ERASURE_PARTICIPANT_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,participant_anchor,$participant$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'ensemus_eraser' AND session_user = 'ensemus_eraser' THEN
    IF OLD.organization_id IS DISTINCT FROM app.current_organization_id() THEN
      RAISE EXCEPTION 'ERASURE_NOT_OPEN' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN$participant$);

  definition := pg_get_functiondef('lifecycle.refuse_erasing_birth()'::regprocedure);
  IF (length(definition)-length(replace(definition,schema_anchor,'')))/length(schema_anchor)<>1 THEN
    RAISE EXCEPTION 'EXPANSION_ERASURE_BIRTH_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,schema_anchor,'''support'',''platform'',''meetings'',''tenancy'')');

  definition := pg_get_functiondef('identity.extend_auth_restore_admission()'::regprocedure);
  IF (length(definition)-length(replace(definition,restore_anchor,'')))/length(restore_anchor)<>1 THEN
    RAISE EXCEPTION 'EXPANSION_ERASURE_RESTORE_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,restore_anchor,'''support'',''lifecycle'',''operations'',''meetings'',''tenancy'']');

  definition := pg_get_functiondef('lifecycle.install_erasure_count_projection()'::regprocedure);
  IF (length(definition)-length(replace(definition,inventory_anchor,'')))/length(inventory_anchor)<>1
    OR (length(definition)-length(replace(definition,filter_anchor,'')))/length(filter_anchor)<>1 THEN
    RAISE EXCEPTION 'EXPANSION_ERASURE_COUNT_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  strict_inventory := replace(definition,inventory_anchor,
    (SELECT string_agg(quote_literal(item), E',\n   ' ORDER BY item) FROM unnest(table_refs) item)
    || E',\n   ' || inventory_anchor);
  SELECT string_agg(quote_literal(item), ',' ORDER BY item) INTO remaining FROM unnest(other_protocols) item;
  -- Compose the newly supported tables with the earlier count projection. This filter exists only
  -- while this migration installs it. Restore the strict installer before committing so a later
  -- composition must add all of its remaining tables explicitly.
  EXECUTE replace(strict_inventory,filter_anchor,format(
    'AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text) AND (n.nspname||''.''||c.relname)<>ALL(ARRAY[%s]) ORDER BY',
    remaining));
  PERFORM lifecycle.install_erasure_count_projection();
  EXECUTE strict_inventory;
  PERFORM identity.extend_auth_restore_admission();

  FOREACH ref IN ARRAY table_refs LOOP
    target := to_regclass(ref);
    IF has_table_privilege('ensemus_eraser',target,'SELECT,INSERT,UPDATE,TRUNCATE')
      OR NOT has_table_privilege('ensemus_eraser',target,'DELETE')
      OR NOT has_column_privilege('ensemus_eraser',target,'organization_id','SELECT')
      OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=target AND attnum>0 AND NOT attisdropped
        AND attname<>'organization_id' AND has_column_privilege('ensemus_eraser',target,attnum,'SELECT'))
      OR (SELECT count(*) FROM pg_policy WHERE polrelid=target
        AND polname IN ('eraser_delete','erasure_count_metadata','auth_restore_0422_eraser'))<>3
      OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=target AND NOT tgisinternal
        AND tgname='lifecycle_erasure_birth_fence' AND tgfoid='lifecycle.refuse_erasing_birth()'::regprocedure) THEN
      RAISE EXCEPTION 'EXPANSION_ERASURE_POSTCONDITION' USING ERRCODE='EN850', DETAIL=ref;
    END IF;
  END LOOP;
END $migration$;
