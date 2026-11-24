-- FLAGGED FOR HUMAN SECURITY REVIEW
-- A separate archive profile carries tenant-owned catalog configuration and receipts
-- for failed Marketplace requests with a confirmed current-generation zero-copy history.
ALTER TABLE sovereign.organization_exports
  DROP CONSTRAINT organization_exports_inventory_version_check,
  ADD CONSTRAINT organization_exports_inventory_version_check CHECK (
    inventory_version IS NULL OR inventory_version IN (
      'ensemus.m3-m7/3','ensemus.m3-m7-federation/4','ensemus.skill-metadata/5'
    )
  );
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.portable_profile_clear(text)'::regprocedure);
  profile_anchor constant text:='p_profile IS DISTINCT FROM ''ensemus.m3-m7-federation/4''';
  buyer_anchor constant text:='EXISTS(SELECT 1 FROM marketplace.installations WHERE organization_id=tenant)';
  catalog_anchor constant text:='EXISTS(SELECT 1 FROM skills.packages WHERE organization_id=tenant)';
  signers_anchor constant text:='EXISTS(SELECT 1 FROM skills.trusted_signers WHERE organization_id=tenant)';
  pin_anchor constant text:='NEW.inventory_version<>''ensemus.m3-m7-federation/4''';
  view_anchor constant text:='e.inventory_version IN(''ensemus.m3-m7/3'',''ensemus.m3-m7-federation/4'')';
BEGIN
  IF strpos(definition,profile_anchor)=0 OR strpos(definition,buyer_anchor)=0
    OR strpos(definition,catalog_anchor)=0 OR strpos(definition,signers_anchor)=0 THEN
    RAISE EXCEPTION 'PORTABLE_CATALOG_PROFILE_CHANGED' USING ERRCODE='EN301';
  END IF;
  definition:=replace(definition,profile_anchor,$sql$
    p_profile IS NULL OR p_profile NOT IN('ensemus.m3-m7-federation/4','ensemus.skill-metadata/5')
  $sql$);
  definition:=replace(definition,buyer_anchor,$sql$
    EXISTS(SELECT 1 FROM marketplace.installations installation WHERE organization_id=tenant
      AND (p_profile<>'ensemus.skill-metadata/5' OR installation.state<>'failed'
        OR installation.failure_code IS NULL
        OR lifecycle.marketplace_buyer_copy_settled(installation,false) IS DISTINCT FROM true
        OR EXISTS(SELECT 1 FROM skills.bundle_uploads receipt
          WHERE receipt.organization_id=tenant AND receipt.id=installation.id)))
  $sql$);
  definition:=replace(definition,catalog_anchor,$sql$
    EXISTS(SELECT 1 FROM skills.packages WHERE organization_id=tenant
      AND (p_profile<>'ensemus.skill-metadata/5' OR origin<>'tenant' OR content_classification='restricted'))
  $sql$);
  definition:=replace(definition,signers_anchor,
    '(p_profile<>''ensemus.skill-metadata/5'' AND '||signers_anchor||')');
  EXECUTE definition;

  definition:=pg_get_functiondef('sovereign.guard_export_inventory_pin()'::regprocedure);
  IF strpos(definition,pin_anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_CATALOG_PIN_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,pin_anchor,
    'NEW.inventory_version NOT IN(''ensemus.m3-m7-federation/4'',''ensemus.skill-metadata/5'')');

  definition:=pg_get_functiondef('sovereign.portable_export_viewer()'::regprocedure);
  IF strpos(definition,view_anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_CATALOG_VIEW_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,view_anchor,
    'e.inventory_version IN(''ensemus.m3-m7/3'',''ensemus.m3-m7-federation/4'',''ensemus.skill-metadata/5'')');
END $migration$;
--> statement-breakpoint
DO $migration$
DECLARE
  section_check text;
  kind_check text;
  definition text:=pg_get_functiondef('sovereign.guard_portable_definition()'::regprocedure);
  anchor constant text:='allowed:=string_to_array(CASE NEW.record_kind';
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT section_check FROM pg_constraint
    WHERE conrelid='sovereign.imported_definitions'::regclass AND conname='imported_definitions_section_check';
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT kind_check FROM pg_constraint
    WHERE conrelid='sovereign.imported_definitions'::regclass AND conname='imported_definitions_record_kind_check';
  ALTER TABLE sovereign.imported_definitions DROP CONSTRAINT imported_definitions_section_check,
    DROP CONSTRAINT imported_definitions_record_kind_check;
  EXECUTE 'ALTER TABLE sovereign.imported_definitions ADD CONSTRAINT imported_definitions_section_check '
    ||'CHECK (('||section_check||') OR section=''skills'')';
  EXECUTE 'ALTER TABLE sovereign.imported_definitions ADD CONSTRAINT imported_definitions_record_kind_check '
    ||'CHECK ((section<>''skills'' AND ('||kind_check||')) OR (section=''skills'' AND '
    ||'record_kind IN (''skill_package_metadata'',''skill_signer_metadata'',''marketplace_failed_installation'')))';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_CATALOG_QUARANTINE_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,anchor,anchor||$sql$
    WHEN 'skill_package_metadata' THEN 'kind,id,name,display_name,classification,state,owner_membership_id,version,created_at,updated_at'
    WHEN 'skill_signer_metadata' THEN 'kind,id,display_name,key_id,public_key_hex,state,created_at,revoked_at'
    WHEN 'marketplace_failed_installation' THEN 'kind,id,listing_id,requested_by_membership_id,failure_code,state,created_at,updated_at'
  $sql$);
END $migration$;
