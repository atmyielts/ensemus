-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Tenant-local package metadata and public signer keys only. Bundle bytes, sandbox data and
-- cross-tenant marketplace or federation records still require their own cleanup protocols.
DO $migration$
DECLARE
  ref text;
  target regclass;
  definition text;
  strict_inventory text;
  scope constant text[] := ARRAY['skills.packages', 'skills.trusted_signers'];
  pending_protocols constant text := $pending$
    'federation.inbound_items','federation.org_settings','federation.outbound_items',
    'marketplace.installations','marketplace.publishers','marketplace.submissions',
    'sandbox.runs','skills.package_versions','skills.test_runs'
  $pending$;
  inventory_anchor constant text := '''work.work_units''';
  filter_anchor constant text :=
    'AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text) ORDER BY';
  schema_anchor constant text := '''support'',''platform'',''meetings'',''tenancy'')';
  restore_anchor constant text := '''support'',''lifecycle'',''operations'',''meetings'',''tenancy'']';
  append_anchor constant text := '''work.work_transitions''::regclass)';
BEGIN
  IF current_user <> 'ensemus_migrator' OR session_user <> 'ensemus_migrator'
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'SKILL_ERASURE_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;

  GRANT USAGE ON SCHEMA skills TO ensemus_eraser;
  FOREACH ref IN ARRAY scope LOOP
    target := to_regclass(ref);
    IF target IS NULL
      OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=target AND relrowsecurity AND relforcerowsecurity)
      OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=target
        AND attname='organization_id' AND atttypid='uuid'::regtype AND NOT attisdropped) THEN
      RAISE EXCEPTION 'SKILL_ERASURE_TABLE_CHANGED' USING ERRCODE='EN850', DETAIL=ref;
    END IF;
    EXECUTE format('GRANT SELECT(organization_id), DELETE ON %s TO ensemus_eraser', target);
    EXECUTE format('CREATE POLICY eraser_delete ON %s TO ensemus_eraser
      USING (organization_id=app.current_organization_id() AND lifecycle.erasure_open(organization_id))',
      target);
    EXECUTE format('CREATE TRIGGER skill_metadata_erasure_lock BEFORE DELETE ON %s
      FOR EACH STATEMENT EXECUTE FUNCTION lifecycle.lock_expansion_erase()', target);
  END LOOP;

  definition := pg_get_functiondef('app.reject_change()'::regprocedure);
  IF (length(definition)-length(replace(definition,append_anchor,'')))/length(append_anchor)<>1 THEN
    RAISE EXCEPTION 'SKILL_ERASURE_APPEND_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,append_anchor,'''skills.trusted_signers''::regclass, '||append_anchor);

  definition := pg_get_functiondef('lifecycle.refuse_erasing_birth()'::regprocedure);
  IF (length(definition)-length(replace(definition,schema_anchor,'')))/length(schema_anchor)<>1 THEN
    RAISE EXCEPTION 'SKILL_ERASURE_BIRTH_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,schema_anchor,'''support'',''platform'',''meetings'',''tenancy'',''skills'')');

  definition := pg_get_functiondef('identity.extend_auth_restore_admission()'::regprocedure);
  IF (length(definition)-length(replace(definition,restore_anchor,'')))/length(restore_anchor)<>1 THEN
    RAISE EXCEPTION 'SKILL_ERASURE_RESTORE_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,restore_anchor,'''support'',''lifecycle'',''operations'',''meetings'',''tenancy'',''skills'']');

  definition := pg_get_functiondef('lifecycle.install_erasure_count_projection()'::regprocedure);
  IF (length(definition)-length(replace(definition,inventory_anchor,'')))/length(inventory_anchor)<>1
    OR (length(definition)-length(replace(definition,filter_anchor,'')))/length(filter_anchor)<>1 THEN
    RAISE EXCEPTION 'SKILL_ERASURE_COUNT_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  strict_inventory := replace(definition,inventory_anchor,
    '''skills.packages'',''skills.trusted_signers'','||inventory_anchor);
  EXECUTE replace(strict_inventory,filter_anchor,format(
    'AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text) AND (n.nspname||''.''||c.relname)<>ALL(ARRAY[%s]) ORDER BY',
    pending_protocols));
  PERFORM lifecycle.install_erasure_count_projection();
  -- The runtime inventory and the permanent installer still fail closed for pending protocols.
  EXECUTE strict_inventory;
  PERFORM identity.extend_auth_restore_admission();

  FOREACH ref IN ARRAY scope LOOP
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
      RAISE EXCEPTION 'SKILL_ERASURE_POSTCONDITION' USING ERRCODE='EN850', DETAIL=ref;
    END IF;
  END LOOP;
END $migration$;
