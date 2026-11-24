-- FLAGGED FOR HUMAN SECURITY REVIEW
-- LIFE-04 and ADR-034. Buyer installations have a tenant-local object protocol.
-- Keep publisher rows, listings, review decisions and deployment objects outside this eraser.
ALTER TABLE marketplace.installations
  ADD COLUMN birth_material_generation uuid,
  ADD COLUMN birth_auth_generation uuid,
  ADD CONSTRAINT marketplace_installation_birth_generation_pair CHECK (
    (birth_material_generation IS NULL) = (birth_auth_generation IS NULL)
  );
CREATE FUNCTION marketplace.capture_installation_birth() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  -- The native request guard has already checked the actor and listing. These fields
  -- describe the local protocol at birth and cannot be supplied by the requester.
  NEW.birth_material_generation := ai.current_material_restore_generation();
  NEW.birth_auth_generation := app.current_auth_restore_generation();
  IF NEW.birth_material_generation IS NULL OR NEW.birth_auth_generation IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_INSTALLATION_GENERATION_UNKNOWN' USING ERRCODE='EN850';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION marketplace.capture_installation_birth() FROM PUBLIC;
CREATE TRIGGER marketplace_installations_record_birth BEFORE INSERT ON marketplace.installations
FOR EACH ROW EXECUTE FUNCTION marketplace.capture_installation_birth();
--> statement-breakpoint
CREATE FUNCTION lifecycle.marketplace_buyer_copy_settled(
  installation marketplace.installations, require_absence boolean
) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $function$
DECLARE receipt skills.bundle_uploads%ROWTYPE;
  key constant text := installation.organization_id::text||'/skills/'||installation.id::text;
BEGIN
  IF installation.organization_id IS DISTINCT FROM app.current_organization_id()
    OR installation.state NOT IN ('failed','removed') THEN
    RETURN false;
  END IF;

  SELECT r.* INTO receipt FROM skills.bundle_uploads r
    WHERE r.organization_id=installation.organization_id AND r.id=installation.id;
  IF NOT FOUND THEN
    -- Legacy rows with no receipt cannot prove that this installation preceded every copy.
    -- A current native birth can: all writes under this protocol reserve this key first.
    RETURN installation.state='failed' AND installation.package_id IS NULL
      AND installation.skill_version_id IS NULL
      AND installation.birth_material_generation IS NOT NULL
      AND installation.birth_auth_generation IS NOT NULL
      AND installation.birth_material_generation=ai.current_material_restore_generation()
      AND installation.birth_auth_generation=app.current_auth_restore_generation()
      AND NOT EXISTS (SELECT 1 FROM skills.packages p
        WHERE p.organization_id=installation.organization_id AND p.id=installation.id)
      AND NOT EXISTS (SELECT 1 FROM skills.package_versions v
        WHERE v.organization_id=installation.organization_id AND (v.id=installation.id OR v.bundle_object_key=key));
  END IF;

  IF receipt.marketplace_copy IS DISTINCT FROM true
    OR receipt.membership_id IS DISTINCT FROM installation.requested_by_membership_id
    OR lifecycle.skill_write_is_current(receipt) IS DISTINCT FROM true
    OR receipt.copy_material_generation IS DISTINCT FROM receipt.put_material_generation
    OR receipt.copy_auth_generation IS DISTINCT FROM receipt.put_auth_generation
    OR lifecycle.skill_upload_delete_target(receipt) IS DISTINCT FROM true THEN
    RETURN false;
  END IF;

  IF receipt.state='attached' THEN
    IF installation.package_id IS DISTINCT FROM installation.id
      OR installation.skill_version_id IS DISTINCT FROM installation.id
      OR NOT EXISTS (
        SELECT 1 FROM skills.packages p JOIN skills.package_versions v
          ON v.organization_id=p.organization_id AND v.package_id=p.id
        WHERE p.organization_id=installation.organization_id AND p.id=installation.id
          AND p.origin='marketplace' AND p.listing_id=installation.listing_id
          AND p.state='disabled' AND v.id=installation.id
          AND (v.state='yanked' OR (installation.state='failed' AND v.state='rejected'))
          AND lifecycle.skill_version_matches_upload(receipt,v)
      ) THEN
      RETURN false;
    END IF;
  ELSIF installation.state<>'failed' OR installation.package_id IS NOT NULL
    OR installation.skill_version_id IS NOT NULL OR receipt.package_id IS NOT NULL
    OR receipt.state NOT IN ('writing','superseded') THEN
    RETURN false;
  END IF;

  IF NOT require_absence THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM lifecycle.object_deletion_claims c
    WHERE c.organization_id=installation.organization_id AND c.kind='skill_upload'
      AND c.artifact_id=installation.id AND c.writer_token=installation.id AND c.generation=1
      AND c.object_key=key AND c.sha256=receipt.bundle_sha256 AND c.state='proven'
      AND c.admitted_at>=receipt.put_finished_at AND c.terminal_at>=c.admitted_at AND c.absent_at>=c.terminal_at
      AND (c.skill_offboarding_id IS NULL OR EXISTS (
        SELECT 1 FROM lifecycle.offboardings o
        WHERE o.organization_id=installation.organization_id AND o.id=c.skill_offboarding_id
          AND o.state='erasing' AND lifecycle.admitted_offboarding(o.id)
      ))
  );
END $function$;
REVOKE ALL ON FUNCTION lifecycle.marketplace_buyer_copy_settled(marketplace.installations,boolean) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION lifecycle.guard_marketplace_buyer_erase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF session_user<>'ensemus_eraser' OR current_setting('role') NOT IN ('none','ensemus_eraser')
    OR NOT knowledge.is_service_actor() OR OLD.organization_id IS DISTINCT FROM app.current_organization_id()
    OR lifecycle.erasure_open(OLD.organization_id) IS DISTINCT FROM true
    OR lifecycle.marketplace_buyer_copy_settled(OLD,true) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'MARKETPLACE_BUYER_ERASURE_PROOF_MISSING' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
END $function$;
REVOKE ALL ON FUNCTION lifecycle.guard_marketplace_buyer_erase() FROM PUBLIC;
CREATE TRIGGER marketplace_installations_buyer_erasure_proof BEFORE DELETE ON marketplace.installations
FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_marketplace_buyer_erase();
CREATE TRIGGER marketplace_installations_erasure_lock BEFORE DELETE ON marketplace.installations
FOR EACH STATEMENT EXECUTE FUNCTION lifecycle.lock_expansion_erase();
GRANT USAGE ON SCHEMA marketplace TO ensemus_eraser;
GRANT SELECT (organization_id), DELETE ON marketplace.installations TO ensemus_eraser;
CREATE POLICY eraser_delete ON marketplace.installations TO ensemus_eraser
  USING(organization_id=app.current_organization_id() AND lifecycle.erasure_open(organization_id));
--> statement-breakpoint
DO $migration$
DECLARE definition text;
  proof_anchor constant text := 'EXISTS(SELECT 1 FROM marketplace.installations WHERE organization_id=tenant)';
  pending_anchor constant text := '(''marketplace'',''installations''),';
  fence_anchor constant text := 'TG_RELID NOT IN(''federation.org_settings''::regclass,''sandbox.runs''::regclass)';
  app_anchor constant text := '''work.work_transitions''::regclass)';
  count_anchor constant text := '''work.work_units''';
  count_filter constant text := 'AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text) ORDER BY';
  strict_filter constant text := 'AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text)'
    ||' AND NOT lifecycle.erasure_requires_empty(n.nspname::text,c.relname::text) ORDER BY';
  restore_anchor constant text := '(''federation'',''org_settings''),(''sandbox'',''runs'')';
BEGIN
  IF current_user<>'ensemus_migrator' OR session_user<>current_user
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
    OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='marketplace.installations'::regclass
      AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'MARKETPLACE_ERASURE_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;

  definition := pg_get_functiondef('lifecycle.fence_deferred_module_write()'::regprocedure);
  IF (length(definition)-length(replace(definition,fence_anchor,'')))/length(fence_anchor)<>1 THEN
    RAISE EXCEPTION 'MARKETPLACE_ERASURE_FENCE_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,fence_anchor,
    'TG_RELID NOT IN(''federation.org_settings''::regclass,''sandbox.runs''::regclass,''marketplace.installations''::regclass)');
  -- Reuse the stricter module fence as the inventory's birth fence, as for federation settings.
  -- The generic birth trigger deliberately has no Marketplace table authority.
  ALTER TRIGGER lifecycle_deferred_erasure_write ON marketplace.installations RENAME TO lifecycle_erasure_birth_fence;

  definition := pg_get_functiondef('lifecycle.deferred_erasure_tables_empty()'::regprocedure);
  IF (length(definition)-length(replace(definition,proof_anchor,'')))/length(proof_anchor)<>1 THEN
    RAISE EXCEPTION 'MARKETPLACE_ERASURE_ADMISSION_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,proof_anchor,$proof$
    EXISTS(SELECT 1 FROM marketplace.installations i WHERE i.organization_id=tenant
      AND lifecycle.marketplace_buyer_copy_settled(i,false) IS DISTINCT FROM true)$proof$);

  definition := pg_get_functiondef('lifecycle.erasure_requires_empty(text,text)'::regprocedure);
  IF (length(definition)-length(replace(definition,pending_anchor,'')))/length(pending_anchor)<>1 THEN
    RAISE EXCEPTION 'MARKETPLACE_ERASURE_PENDING_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,pending_anchor,'');

  definition := pg_get_functiondef('app.reject_change()'::regprocedure);
  IF (length(definition)-length(replace(definition,app_anchor,'')))/length(app_anchor)<>1 THEN
    RAISE EXCEPTION 'MARKETPLACE_ERASURE_APPEND_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,app_anchor,'''marketplace.installations''::regclass,'||app_anchor);

  definition := pg_get_functiondef('lifecycle.install_erasure_count_projection()'::regprocedure);
  IF (length(definition)-length(replace(definition,count_anchor,'')))/length(count_anchor)<>1 THEN
    RAISE EXCEPTION 'MARKETPLACE_ERASURE_COUNT_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  IF (length(definition)-length(replace(definition,count_filter,'')))/length(count_filter)=1 THEN
    definition := replace(definition,count_filter,strict_filter);
  ELSIF (length(definition)-length(replace(definition,strict_filter,'')))/length(strict_filter)<>1 THEN
    RAISE EXCEPTION 'MARKETPLACE_ERASURE_COUNT_FILTER_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,count_anchor,'''marketplace.installations'','||count_anchor);
  PERFORM lifecycle.install_erasure_count_projection();

  definition := pg_get_functiondef('identity.extend_auth_restore_admission()'::regprocedure);
  IF (length(definition)-length(replace(definition,restore_anchor,'')))/length(restore_anchor)<>1 THEN
    RAISE EXCEPTION 'MARKETPLACE_ERASURE_RESTORE_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,restore_anchor,restore_anchor||','||'(''marketplace'',''installations'')');
  PERFORM identity.extend_auth_restore_admission();

  IF has_table_privilege('ensemus_eraser','marketplace.installations','SELECT,INSERT,UPDATE,TRUNCATE')
    OR NOT has_table_privilege('ensemus_eraser','marketplace.installations','DELETE')
    OR NOT has_column_privilege('ensemus_eraser','marketplace.installations','organization_id','SELECT')
    OR EXISTS (SELECT 1 FROM pg_attribute a
      WHERE a.attrelid='marketplace.installations'::regclass AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname<>'organization_id' AND has_column_privilege('ensemus_eraser',a.attrelid,a.attnum,'SELECT'))
    OR (SELECT count(*) FROM pg_policy WHERE polrelid='marketplace.installations'::regclass
      AND polname IN ('eraser_delete','erasure_count_metadata','auth_restore_0422_eraser'))<>3
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='marketplace' AND c.relname<>'installations'
        AND (has_table_privilege('ensemus_eraser',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
          OR has_any_column_privilege('ensemus_eraser',c.oid,'SELECT,INSERT,UPDATE'))) THEN
    RAISE EXCEPTION 'MARKETPLACE_ERASURE_POSTCONDITION' USING ERRCODE='EN850';
  END IF;
END $migration$;
--> statement-breakpoint
-- A prior eraser pass may have removed the export epoch while another table still held a
-- foreign key. Missing already invalidates every export for this tenant. As in 0522, leave
-- it missing for resumed erasure. Other writers and peer tenants still require their epoch.
DO $epoch$
DECLARE definition text := pg_get_functiondef('sovereign.advance_pending_module_epoch()'::regprocedure);
  anchor constant text := '        RAISE EXCEPTION ''PORTABILITY_PENDING_EPOCH_REQUIRED'' USING ERRCODE=''EN301'';';
BEGIN
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
    RAISE EXCEPTION 'MARKETPLACE_ERASURE_EPOCH_GUARD_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,anchor,$body$
        IF TG_OP='DELETE' AND session_user='ensemus_eraser'
          AND current_setting('role') IN('none','ensemus_eraser') AND knowledge.is_service_actor()
          AND tenant=app.current_organization_id() AND lifecycle.erasure_open(tenant) IS TRUE THEN
          CONTINUE;
        END IF;
$body$||anchor);
END $epoch$;
