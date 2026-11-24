-- FLAGGED FOR HUMAN SECURITY REVIEW
-- COMM-05 and EXP-03. Carry customer-owned meeting configuration as review records.
-- Meeting content and consent remain barred from this profile. Import creates no live approvals.
ALTER TABLE sovereign.organization_exports
  DROP CONSTRAINT organization_exports_inventory_version_check,
  ADD CONSTRAINT organization_exports_inventory_version_check CHECK (
    inventory_version IS NULL OR inventory_version IN (
      'ensemus.m3-m7/3','ensemus.m3-m7-federation/4','ensemus.skill-metadata/5',
      'ensemus.marketplace-publisher/6','ensemus.meeting-config/7'
    )
  );
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.portable_profile_clear(text)'::regprocedure);
  last_profile constant text:='''ensemus.marketplace-publisher/6'')';
  extended_tail constant text:='''ensemus.marketplace-publisher/6'',''ensemus.meeting-config/7'')';
  publisher_gate constant text:='p_profile<>''ensemus.marketplace-publisher/6''';
  settings_gate constant text:='EXISTS(SELECT 1 FROM meetings.settings WHERE organization_id=tenant)';
  approvals_gate constant text:='EXISTS(SELECT 1 FROM meetings.provider_approvals WHERE organization_id=tenant)';
BEGIN
  IF strpos(definition,last_profile)=0 OR strpos(definition,publisher_gate)=0
    OR strpos(definition,settings_gate)=0 OR strpos(definition,approvals_gate)=0 THEN
    RAISE EXCEPTION 'PORTABLE_MEETING_PROFILE_CHANGED' USING ERRCODE='EN301';
  END IF;
  definition:=replace(definition,last_profile,extended_tail);
  definition:=replace(definition,publisher_gate,'p_profile NOT IN('||extended_tail);
  definition:=replace(definition,settings_gate,
    '(p_profile<>''ensemus.meeting-config/7'' AND '||settings_gate||')');
  definition:=replace(definition,approvals_gate,
    '(p_profile<>''ensemus.meeting-config/7'' AND '||approvals_gate||')');
  EXECUTE definition;

  definition:=pg_get_functiondef('sovereign.guard_export_inventory_pin()'::regprocedure);
  IF strpos(definition,last_profile)=0 THEN RAISE EXCEPTION 'PORTABLE_MEETING_PIN_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,last_profile,extended_tail);

  definition:=pg_get_functiondef('sovereign.portable_export_viewer()'::regprocedure);
  IF strpos(definition,last_profile)=0 THEN RAISE EXCEPTION 'PORTABLE_MEETING_VIEW_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,last_profile,extended_tail);
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
    ||'CHECK (('||kind_check||') OR (section=''policy'' AND record_kind IN ('
    ||'''meeting_settings_history'',''meeting_provider_approval_history'')))';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_MEETING_QUARANTINE_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,anchor,anchor||$sql$
    WHEN 'meeting_settings_history' THEN 'kind,id,enabled,notice_ref,version,updated_by_membership_id,updated_at'
    WHEN 'meeting_provider_approval_history' THEN 'kind,id,provider_kind,target_ref,purposes,max_classification,terms_ref,approved_by_membership_id,approved_at,expires_at,revoked_at,revoked_by_membership_id'
  $sql$);
END $migration$;
