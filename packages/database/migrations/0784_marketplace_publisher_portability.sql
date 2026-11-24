-- FLAGGED FOR HUMAN SECURITY REVIEW
-- COMM-05. Carry only the tenant's publisher profile as history. Listings, submissions,
-- reviews and material-bearing installations still need separate custody and rights proofs.
ALTER TABLE sovereign.organization_exports
  DROP CONSTRAINT organization_exports_inventory_version_check,
  ADD CONSTRAINT organization_exports_inventory_version_check CHECK (
    inventory_version IS NULL OR inventory_version IN (
      'ensemus.m3-m7/3','ensemus.m3-m7-federation/4','ensemus.skill-metadata/5','ensemus.marketplace-publisher/6'
    )
  );
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.portable_profile_clear(text)'::regprocedure);
  profile constant text:='p_profile IS NULL OR p_profile NOT IN(''ensemus.m3-m7-federation/4'',''ensemus.skill-metadata/5'')';
  skill_gate constant text:='p_profile<>''ensemus.skill-metadata/5''';
  publisher_gate constant text:='EXISTS(SELECT 1 FROM marketplace.publishers WHERE organization_id=tenant)';
  pin constant text:='NEW.inventory_version NOT IN(''ensemus.m3-m7-federation/4'',''ensemus.skill-metadata/5'')';
  viewer constant text:='e.inventory_version IN(''ensemus.m3-m7/3'',''ensemus.m3-m7-federation/4'',''ensemus.skill-metadata/5'')';
BEGIN
  IF strpos(definition,profile)=0 OR strpos(definition,skill_gate)=0 OR strpos(definition,publisher_gate)=0 THEN
    RAISE EXCEPTION 'PORTABLE_PUBLISHER_PROFILE_CHANGED' USING ERRCODE='EN301';
  END IF;
  definition:=replace(definition,profile,
    'p_profile IS NULL OR p_profile NOT IN(''ensemus.m3-m7-federation/4'',''ensemus.skill-metadata/5'',''ensemus.marketplace-publisher/6'')');
  definition:=replace(definition,skill_gate,
    'p_profile NOT IN(''ensemus.skill-metadata/5'',''ensemus.marketplace-publisher/6'')');
  definition:=replace(definition,publisher_gate,
    '(p_profile<>''ensemus.marketplace-publisher/6'' AND '||publisher_gate||')');
  EXECUTE definition;

  definition:=pg_get_functiondef('sovereign.guard_export_inventory_pin()'::regprocedure);
  IF strpos(definition,pin)=0 THEN RAISE EXCEPTION 'PORTABLE_PUBLISHER_PIN_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,pin,
    'NEW.inventory_version NOT IN(''ensemus.m3-m7-federation/4'',''ensemus.skill-metadata/5'',''ensemus.marketplace-publisher/6'')');

  definition:=pg_get_functiondef('sovereign.portable_export_viewer()'::regprocedure);
  IF strpos(definition,viewer)=0 THEN RAISE EXCEPTION 'PORTABLE_PUBLISHER_VIEW_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,viewer,
    'e.inventory_version IN(''ensemus.m3-m7/3'',''ensemus.m3-m7-federation/4'',''ensemus.skill-metadata/5'',''ensemus.marketplace-publisher/6'')');
END $migration$;
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
    ||'CHECK (('||kind_check||') OR (section=''skills'' AND record_kind=''marketplace_publisher_history''))';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_PUBLISHER_QUARANTINE_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,anchor,anchor||$sql$
    WHEN 'marketplace_publisher_history' THEN 'kind,id,display_name,state,version,created_at,updated_at'
  $sql$);
END $migration$;
