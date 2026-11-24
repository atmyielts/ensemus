-- FLAGGED FOR HUMAN SECURITY REVIEW
-- COMM-05 and EXP-03. An additive profile for purged meeting receipts only.
ALTER TABLE sovereign.organization_exports
  DROP CONSTRAINT organization_exports_inventory_version_check,
  ADD CONSTRAINT organization_exports_inventory_version_check CHECK (
    inventory_version IS NULL OR inventory_version IN (
      'ensemus.m3-m7/3','ensemus.m3-m7-federation/4','ensemus.skill-metadata/5',
      'ensemus.marketplace-publisher/6','ensemus.meeting-config/7','ensemus.meeting-history/8'
    )
  );
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.portable_profile_clear(text)'::regprocedure);
  last_profile constant text:='''ensemus.meeting-config/7'')';
  extended_tail constant text:='''ensemus.meeting-config/7'',''ensemus.meeting-history/8'')';
  config_gate constant text:='p_profile<>''ensemus.meeting-config/7''';
  return_anchor constant text:='RETURN NOT (';
  relation text;
  probe text;
BEGIN
  IF strpos(definition,last_profile)=0 OR strpos(definition,config_gate)=0
    OR strpos(definition,return_anchor)=0 THEN
    RAISE EXCEPTION 'PORTABLE_MEETING_HISTORY_PROFILE_CHANGED' USING ERRCODE='EN301';
  END IF;
  definition:=replace(definition,last_profile,extended_tail);
  definition:=replace(definition,config_gate,'p_profile NOT IN('||extended_tail);
  FOREACH relation IN ARRAY ARRAY[
    'meetings','participants','consent_records','notes','summaries',
    'proposed_items','derivation_runs','import_requests'
  ] LOOP
    probe:='EXISTS(SELECT 1 FROM meetings.'||relation||' WHERE organization_id=tenant)';
    IF strpos(definition,probe)=0 THEN
      RAISE EXCEPTION 'PORTABLE_MEETING_HISTORY_PROBE_CHANGED' USING ERRCODE='EN301';
    END IF;
    definition:=replace(definition,probe,'(p_profile<>''ensemus.meeting-history/8'' AND '||probe||')');
  END LOOP;
  definition:=replace(definition,return_anchor,return_anchor||$sql$
    (p_profile='ensemus.meeting-history/8' AND (
      EXISTS(SELECT 1 FROM meetings.meetings WHERE organization_id=tenant
        AND (status<>'purged' OR purged_at IS NULL OR title<>'Removed' OR classification='restricted'))
      OR EXISTS(SELECT 1 FROM meetings.notes WHERE organization_id=tenant
        AND (body IS NOT NULL OR purged_at IS NULL OR classification='restricted'))
      OR EXISTS(SELECT 1 FROM meetings.summaries WHERE organization_id=tenant
        AND (body IS NOT NULL OR purged_at IS NULL OR classification='restricted'))
      OR EXISTS(SELECT 1 FROM meetings.proposed_items WHERE organization_id=tenant
        AND (status='proposed' OR title IS NOT NULL OR detail IS NOT NULL OR decision_reason IS NOT NULL
          OR purged_at IS NULL OR classification='restricted'))
      OR EXISTS(SELECT 1 FROM meetings.derivation_runs WHERE organization_id=tenant
        AND status IN ('requested','running'))
      OR EXISTS(SELECT 1 FROM meetings.import_requests WHERE organization_id=tenant AND status='requested')
    ))
    OR
  $sql$);
  EXECUTE definition;

  definition:=pg_get_functiondef('sovereign.guard_export_inventory_pin()'::regprocedure);
  IF strpos(definition,last_profile)=0 THEN RAISE EXCEPTION 'PORTABLE_MEETING_HISTORY_PIN_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,last_profile,extended_tail);

  definition:=pg_get_functiondef('sovereign.portable_export_viewer()'::regprocedure);
  IF strpos(definition,last_profile)=0 THEN RAISE EXCEPTION 'PORTABLE_MEETING_HISTORY_VIEW_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,last_profile,extended_tail);
END $migration$;
--> statement-breakpoint
DO $migration$
DECLARE
  kind_check text;
  definition text:=pg_get_functiondef('sovereign.guard_portable_definition()'::regprocedure);
  anchor constant text:='allowed:=string_to_array(CASE NEW.record_kind';
  kinds constant text:=$kinds$
    'meeting_purge_history','meeting_participant_history','meeting_consent_history',
    'meeting_note_purge_history','meeting_summary_purge_history','meeting_proposal_history',
    'meeting_derivation_history','meeting_import_history'
  $kinds$;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT kind_check FROM pg_constraint
    WHERE conrelid='sovereign.imported_definitions'::regclass AND conname='imported_definitions_record_kind_check';
  ALTER TABLE sovereign.imported_definitions DROP CONSTRAINT imported_definitions_record_kind_check;
  EXECUTE 'ALTER TABLE sovereign.imported_definitions ADD CONSTRAINT imported_definitions_record_kind_check '
    ||'CHECK (('||kind_check||') OR (section=''policy'' AND record_kind IN ('||kinds||')))';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_MEETING_HISTORY_QUARANTINE_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,anchor,anchor||$sql$
    WHEN 'meeting_purge_history' THEN 'kind,id,organizer_membership_id,classification,source_kind,occurred_at,created_at,purged_at'
    WHEN 'meeting_participant_history' THEN 'kind,id,meeting_id,classification,member_id,participant_kind,created_at'
    WHEN 'meeting_consent_history' THEN 'kind,id,meeting_id,classification,participant_id,decision,basis,notice_ref,recorded_by_membership_id,recorded_at,position'
    WHEN 'meeting_note_purge_history' THEN 'kind,id,meeting_id,classification,version,source_kind,source_approval_id,imported_by_membership_id,created_at,purged_at'
    WHEN 'meeting_summary_purge_history' THEN 'kind,id,meeting_id,classification,run_id,created_at,purged_at'
    WHEN 'meeting_proposal_history' THEN 'kind,id,meeting_id,classification,run_id,ordinal,proposal_kind,status,decided_by_membership_id,decided_at,created_at,purged_at'
    WHEN 'meeting_derivation_history' THEN 'kind,id,meeting_id,classification,notes_id,provider_approval_id,purpose,status,requested_by_membership_id,created_at,finished_at'
    WHEN 'meeting_import_history' THEN 'kind,id,meeting_id,classification,source_approval_id,status,requested_by_membership_id,created_at,finished_at'
  $sql$);

  -- An owner who authorized the import can review these receipts. Other destination administrators
  -- do not inherit the room's privileges by virtue of their role.
  EXECUTE 'CREATE POLICY meeting_history_review_custodian ON sovereign.imported_definitions '
    ||'AS RESTRICTIVE FOR SELECT TO ensemus_app USING (record_kind NOT IN ('||kinds||') OR EXISTS('
    ||'SELECT 1 FROM sovereign.organization_imports i WHERE i.organization_id=imported_definitions.organization_id '
    ||'AND i.id=imported_definitions.import_id AND i.fallback_membership_id=app.current_membership_id()))';
END $migration$;
