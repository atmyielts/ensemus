-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-033). Changes here need human review, never agent approval.

-- Forced RLS and the tenant policy on every new table. tests/integration/tenant-isolation.test.ts fails if
-- one misses it, and lists `meetings` among the tenant schemas.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname = 'meetings'
       OR (schemaname = 'integrations' AND tablename IN ('business_records', 'business_record_actions'))
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format(
      'CREATE POLICY tenant_scoped ON %I.%I TO ensemus_app '
      'USING (organization_id = app.current_organization_id()) '
      'WITH CHECK (organization_id = app.current_organization_id())',
      t.schemaname, t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

-- Only the application role comes here. The dispatcher sees event metadata, the auth role sees sessions, and
-- the secrets role sees sealed values, and none of them has any business with what was said in a meeting.
GRANT USAGE ON SCHEMA meetings TO ensemus_app;
--> statement-breakpoint

-- Business records. A record's identity and source are fixed once written.
GRANT SELECT, INSERT ON integrations.business_records TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (external_version, display_name, fields, fields_sha256, classification, deleted_at, updated_at)
  ON integrations.business_records TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON integrations.business_record_actions TO ensemus_app;
--> statement-breakpoint

GRANT SELECT, INSERT ON meetings.settings TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (enabled, notice_ref, version, updated_by_membership_id, updated_at)
  ON meetings.settings TO ensemus_app;
--> statement-breakpoint

-- A meeting's class and source are fixed. Changing either would change what people agreed to.
GRANT SELECT, INSERT ON meetings.meetings TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (title, occurred_at, organizer_membership_id, status, version, updated_at, purged_at)
  ON meetings.meetings TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON meetings.participants TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON meetings.consent_records TO ensemus_app;
--> statement-breakpoint

-- An approval is revoked or it expires. Widening one means writing a new one, with a new person's name on it.
GRANT SELECT, INSERT ON meetings.provider_approvals TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_by_membership_id) ON meetings.provider_approvals TO ensemus_app;
--> statement-breakpoint

-- Text goes and never comes back. The triggers below hold the "never comes back".
GRANT SELECT, INSERT ON meetings.notes TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (body, purged_at) ON meetings.notes TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON meetings.summaries TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (body, purged_at) ON meetings.summaries TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON meetings.derivation_runs TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, status_code, temporal_run_id, model_ref, input_tokens, output_tokens, version,
              started_at, finished_at)
  ON meetings.derivation_runs TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON meetings.proposed_items TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (title, detail, status, decided_by_membership_id, decided_at, decision_reason, work_unit_id,
              version, updated_at, purged_at)
  ON meetings.proposed_items TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON meetings.import_requests TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, status_code, temporal_run_id, version, finished_at)
  ON meetings.import_requests TO ensemus_app;
--> statement-breakpoint

-- What someone said about their own data is a record, kept as written, for everyone including the owner.
CREATE TRIGGER consent_records_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON meetings.consent_records
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER provider_approvals_keep
  BEFORE DELETE OR TRUNCATE ON meetings.provider_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER meetings_keep
  BEFORE DELETE OR TRUNCATE ON meetings.meetings
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER notes_keep
  BEFORE DELETE OR TRUNCATE ON meetings.notes
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER derivation_runs_keep
  BEFORE DELETE OR TRUNCATE ON meetings.derivation_runs
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER summaries_keep
  BEFORE DELETE OR TRUNCATE ON meetings.summaries
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER proposed_items_keep
  BEFORE DELETE OR TRUNCATE ON meetings.proposed_items
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER import_requests_keep
  BEFORE DELETE OR TRUNCATE ON meetings.import_requests
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- Everyone listed has said yes, and their newest word is what counts. Nobody listed means no consent. These
-- two run as the caller, so row-level security still confines them to the bound tenant.
CREATE FUNCTION meetings.consent_complete(org uuid, meeting uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  SELECT EXISTS (
           SELECT 1 FROM meetings.participants p
            WHERE p.organization_id = org AND p.meeting_id = meeting)
     AND NOT EXISTS (
           SELECT 1 FROM meetings.participants p
            WHERE p.organization_id = org AND p.meeting_id = meeting
              AND coalesce((SELECT c.decision FROM meetings.consent_records c
                             WHERE c.organization_id = org AND c.participant_id = p.id
                             ORDER BY c.seq DESC LIMIT 1), 'none') <> 'granted')
$$;
--> statement-breakpoint

-- One provider, one purpose, one class, now. `restricted` has no place in the list, so it never passes.
CREATE FUNCTION meetings.provider_approved(
    org uuid, approval uuid, wanted_kind text, wanted_purpose text, wanted_class text
  ) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM meetings.provider_approvals a
     WHERE a.organization_id = org
       AND a.id = approval
       AND a.kind = wanted_kind
       AND wanted_purpose = ANY (a.purposes)
       AND a.revoked_at IS NULL
       AND a.expires_at > now()
       AND array_position(ARRAY['public','internal','confidential'], wanted_class)
           <= array_position(ARRAY['public','internal','confidential'], a.max_classification))
$$;
--> statement-breakpoint

-- Meetings are off until an administrator turns them on. Nothing starts further along than the start.
CREATE FUNCTION meetings.check_new_meeting() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status <> 'open' OR NEW.version <> 1 OR NEW.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'MEETING_INVALID_START' USING ERRCODE = 'EN112';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM meetings.settings s
     WHERE s.organization_id = NEW.organization_id AND s.enabled
  ) THEN
    RAISE EXCEPTION 'MEETINGS_NOT_ENABLED' USING ERRCODE = 'EN110';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER meetings_check_new
  BEFORE INSERT ON meetings.meetings
  FOR EACH ROW EXECUTE FUNCTION meetings.check_new_meeting();
--> statement-breakpoint

-- Purging is one way, and it takes the title with it, since a title can say what the meeting was about.
CREATE FUNCTION meetings.check_meeting_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'purged' THEN
    RAISE EXCEPTION 'MEETING_PURGED' USING ERRCODE = 'EN112';
  END IF;
  IF NEW.status = 'purged' THEN
    NEW.title := 'Removed';
    NEW.purged_at := now();
  ELSIF NEW.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'MEETING_INVALID_CHANGE' USING ERRCODE = 'EN112';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER meetings_check_change
  BEFORE UPDATE ON meetings.meetings
  FOR EACH ROW EXECUTE FUNCTION meetings.check_meeting_change();
--> statement-breakpoint

-- Who was in the room is fixed once notes exist, because someone added later has agreed to nothing.
CREATE FUNCTION meetings.check_participant_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  org uuid;
  meeting uuid;
  meeting_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    org := OLD.organization_id;
    meeting := OLD.meeting_id;
  ELSE
    org := NEW.organization_id;
    meeting := NEW.meeting_id;
  END IF;
  SELECT m.status INTO meeting_status
    FROM meetings.meetings m
   WHERE m.organization_id = org AND m.id = meeting
     FOR UPDATE;
  IF NOT FOUND OR meeting_status <> 'open' THEN
    RAISE EXCEPTION 'MEETING_NOT_OPEN' USING ERRCODE = 'EN112';
  END IF;
  IF EXISTS (
    SELECT 1 FROM meetings.notes n WHERE n.organization_id = org AND n.meeting_id = meeting
  ) THEN
    RAISE EXCEPTION 'MEETING_PARTICIPANTS_FROZEN' USING ERRCODE = 'EN112';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER participants_check_change
  BEFORE INSERT OR DELETE ON meetings.participants
  FOR EACH ROW EXECUTE FUNCTION meetings.check_participant_change();
--> statement-breakpoint

-- A member speaks for themselves, and nobody speaks for them. The organizer attests for someone outside, and
-- the record says so. A no after notes exist has to be a withdrawal, so that the content goes.
CREATE FUNCTION meetings.check_new_consent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  meeting record;
  person record;
BEGIN
  SELECT m.status, m.organizer_membership_id INTO meeting
    FROM meetings.meetings m
   WHERE m.organization_id = NEW.organization_id AND m.id = NEW.meeting_id
     FOR UPDATE;
  IF NOT FOUND OR meeting.status <> 'open' THEN
    RAISE EXCEPTION 'MEETING_NOT_OPEN' USING ERRCODE = 'EN112';
  END IF;
  SELECT p.kind, p.membership_id INTO person
    FROM meetings.participants p
   WHERE p.organization_id = NEW.organization_id
     AND p.meeting_id = NEW.meeting_id
     AND p.id = NEW.participant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONSENT_WRONG_SPEAKER' USING ERRCODE = 'EN110';
  END IF;
  IF NEW.basis = 'self' AND (person.kind <> 'member'
                             OR person.membership_id <> NEW.recorded_by_membership_id) THEN
    RAISE EXCEPTION 'CONSENT_WRONG_SPEAKER' USING ERRCODE = 'EN110';
  END IF;
  IF NEW.basis = 'attested' AND (person.kind <> 'external'
                                 OR meeting.organizer_membership_id <> NEW.recorded_by_membership_id) THEN
    RAISE EXCEPTION 'CONSENT_WRONG_SPEAKER' USING ERRCODE = 'EN110';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM meetings.settings s
     WHERE s.organization_id = NEW.organization_id
       AND s.enabled
       AND s.notice_ref = NEW.notice_ref
  ) THEN
    RAISE EXCEPTION 'CONSENT_NOTICE_NOT_CURRENT' USING ERRCODE = 'EN110';
  END IF;
  IF NEW.decision = 'declined' AND EXISTS (
    SELECT 1 FROM meetings.notes n
     WHERE n.organization_id = NEW.organization_id AND n.meeting_id = NEW.meeting_id
  ) THEN
    RAISE EXCEPTION 'CONSENT_USE_WITHDRAWAL' USING ERRCODE = 'EN110';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER consent_records_check_new
  BEFORE INSERT ON meetings.consent_records
  FOR EACH ROW EXECUTE FUNCTION meetings.check_new_consent();
--> statement-breakpoint

-- A withdrawal cannot commit with the content still there. Deferred, so the service does the purge in the
-- same transaction, and if it forgets, nothing commits at all (ADR-033 D5).
CREATE FUNCTION meetings.check_withdrawal_purged() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.decision = 'withdrawn' AND NOT EXISTS (
    SELECT 1 FROM meetings.meetings m
     WHERE m.organization_id = NEW.organization_id
       AND m.id = NEW.meeting_id
       AND m.status = 'purged'
  ) THEN
    RAISE EXCEPTION 'CONSENT_WITHDRAWN_NOT_PURGED' USING ERRCODE = 'EN110';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER consent_withdrawal_purges
  AFTER INSERT ON meetings.consent_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION meetings.check_withdrawal_purged();
--> statement-breakpoint

-- A named administrator of this organization, a connection that is really here, and never already revoked.
CREATE FUNCTION meetings.is_active_administrator(org uuid, membership uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM org.memberships m
     WHERE m.organization_id = org
       AND m.id = membership
       AND m.status = 'active'
       AND m.role IN ('owner', 'admin'))
$$;
--> statement-breakpoint
CREATE FUNCTION meetings.check_new_provider_approval() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT meetings.is_active_administrator(NEW.organization_id, NEW.approved_by_membership_id) THEN
    RAISE EXCEPTION 'PROVIDER_APPROVER_NOT_ADMIN' USING ERRCODE = 'EN111';
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'PROVIDER_INVALID_START' USING ERRCODE = 'EN111';
  END IF;
  IF NEW.kind = 'source' AND NOT EXISTS (
    SELECT 1 FROM integrations.connections c
     WHERE c.organization_id = NEW.organization_id
       AND NEW.target_ref = 'connection:' || c.id::text
  ) THEN
    RAISE EXCEPTION 'PROVIDER_TARGET_NOT_FOUND' USING ERRCODE = 'EN111';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER provider_approvals_check_new
  BEFORE INSERT ON meetings.provider_approvals
  FOR EACH ROW EXECUTE FUNCTION meetings.check_new_provider_approval();
--> statement-breakpoint
CREATE FUNCTION meetings.check_provider_revoke() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'PROVIDER_ALREADY_REVOKED' USING ERRCODE = 'EN111';
  END IF;
  IF NEW.revoked_at IS NOT NULL
     AND NOT meetings.is_active_administrator(NEW.organization_id, NEW.revoked_by_membership_id) THEN
    RAISE EXCEPTION 'PROVIDER_APPROVER_NOT_ADMIN' USING ERRCODE = 'EN111';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER provider_approvals_check_revoke
  BEFORE UPDATE ON meetings.provider_approvals
  FOR EACH ROW EXECUTE FUNCTION meetings.check_provider_revoke();
--> statement-breakpoint

-- Notes come in only once everyone has agreed. From a connector, they come in only from a connection an
-- administrator approved for this, and it has to be the one this meeting came from.
CREATE FUNCTION meetings.check_new_notes() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  meeting record;
BEGIN
  SELECT m.status, m.classification, m.source_kind, m.connection_id INTO meeting
    FROM meetings.meetings m
   WHERE m.organization_id = NEW.organization_id AND m.id = NEW.meeting_id
     FOR UPDATE;
  IF NOT FOUND OR meeting.status <> 'open' THEN
    RAISE EXCEPTION 'MEETING_NOT_OPEN' USING ERRCODE = 'EN112';
  END IF;
  IF NOT meetings.consent_complete(NEW.organization_id, NEW.meeting_id) THEN
    RAISE EXCEPTION 'CONSENT_INCOMPLETE' USING ERRCODE = 'EN110';
  END IF;
  IF NEW.classification <> meeting.classification
     OR NEW.source_kind <> meeting.source_kind
     OR NEW.body IS NULL
     OR NEW.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'NOTES_INVALID_START' USING ERRCODE = 'EN112';
  END IF;
  IF NEW.source_kind = 'connector' THEN
    IF NEW.source_approval_id IS NULL
       OR NOT meetings.provider_approved(NEW.organization_id, NEW.source_approval_id, 'source',
                                         'import_notes', NEW.classification)
       OR NOT EXISTS (
         SELECT 1 FROM meetings.provider_approvals a
          WHERE a.organization_id = NEW.organization_id
            AND a.id = NEW.source_approval_id
            AND a.target_ref = 'connection:' || meeting.connection_id::text) THEN
      RAISE EXCEPTION 'PROVIDER_NOT_APPROVED' USING ERRCODE = 'EN111';
    END IF;
  ELSIF NEW.source_approval_id IS NOT NULL THEN
    RAISE EXCEPTION 'NOTES_INVALID_START' USING ERRCODE = 'EN112';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER notes_check_new
  BEFORE INSERT ON meetings.notes
  FOR EACH ROW EXECUTE FUNCTION meetings.check_new_notes();
--> statement-breakpoint

-- The only change to stored text is its going. Shared by notes and summaries, which have the same two columns.
CREATE FUNCTION meetings.check_text_purge() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.body IS NULL OR NEW.body IS NOT NULL THEN
    RAISE EXCEPTION 'MEETING_TEXT_ONLY_PURGES' USING ERRCODE = 'EN112';
  END IF;
  NEW.purged_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER notes_check_purge
  BEFORE UPDATE ON meetings.notes
  FOR EACH ROW EXECUTE FUNCTION meetings.check_text_purge();
--> statement-breakpoint
CREATE TRIGGER summaries_check_purge
  BEFORE UPDATE ON meetings.summaries
  FOR EACH ROW EXECUTE FUNCTION meetings.check_text_purge();
--> statement-breakpoint

-- Everything that has to hold for these notes to reach this provider. The same check when a person asks and
-- again when the worker is about to, because either can change in between (ADR-033 D6).
CREATE FUNCTION meetings.check_derivation_allowed(
    org uuid, meeting uuid, notes uuid, approval uuid, wanted_purpose text
  ) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  found_meeting record;
  found_notes record;
  latest integer;
BEGIN
  SELECT m.status, m.classification INTO found_meeting
    FROM meetings.meetings m
   WHERE m.organization_id = org AND m.id = meeting
     FOR UPDATE;
  IF NOT FOUND OR found_meeting.status <> 'open' THEN
    RAISE EXCEPTION 'MEETING_NOT_OPEN' USING ERRCODE = 'EN112';
  END IF;
  IF NOT meetings.consent_complete(org, meeting) THEN
    RAISE EXCEPTION 'CONSENT_INCOMPLETE' USING ERRCODE = 'EN110';
  END IF;
  SELECT n.version, n.body IS NULL AS purged INTO found_notes
    FROM meetings.notes n
   WHERE n.organization_id = org AND n.meeting_id = meeting AND n.id = notes;
  SELECT max(n.version) INTO latest
    FROM meetings.notes n
   WHERE n.organization_id = org AND n.meeting_id = meeting;
  IF found_notes.version IS NULL OR found_notes.purged OR found_notes.version <> latest THEN
    RAISE EXCEPTION 'NOTES_NOT_CURRENT' USING ERRCODE = 'EN112';
  END IF;
  IF NOT meetings.provider_approved(org, approval, 'model', wanted_purpose,
                                    found_meeting.classification) THEN
    RAISE EXCEPTION 'PROVIDER_NOT_APPROVED' USING ERRCODE = 'EN111';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION meetings.check_new_derivation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status <> 'requested' OR NEW.version <> 1 OR NEW.temporal_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'DERIVATION_INVALID_START' USING ERRCODE = 'EN112';
  END IF;
  PERFORM meetings.check_derivation_allowed(NEW.organization_id, NEW.meeting_id, NEW.notes_id,
                                            NEW.provider_approval_id, NEW.purpose);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER derivation_runs_check_new
  BEFORE INSERT ON meetings.derivation_runs
  FOR EACH ROW EXECUTE FUNCTION meetings.check_new_derivation();
--> statement-breakpoint

-- The transitions match DERIVATION_TRANSITIONS in @ensemus/domain/meeting, and a test holds the two together.
CREATE FUNCTION meetings.check_derivation_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  allowed := CASE OLD.status
    WHEN 'requested' THEN NEW.status IN ('running', 'failed', 'refused', 'cancelled')
    WHEN 'running' THEN NEW.status IN ('completed', 'failed', 'refused')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'DERIVATION_INVALID_TRANSITION' USING ERRCODE = 'EN112';
  END IF;
  IF NEW.status = 'running' THEN
    PERFORM meetings.check_derivation_allowed(NEW.organization_id, NEW.meeting_id, NEW.notes_id,
                                              NEW.provider_approval_id, NEW.purpose);
  END IF;
  -- An answer that came back after someone said no is thrown away, not stored.
  IF NEW.status = 'completed'
     AND NOT meetings.consent_complete(NEW.organization_id, NEW.meeting_id) THEN
    RAISE EXCEPTION 'CONSENT_INCOMPLETE' USING ERRCODE = 'EN110';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER derivation_runs_check_change
  BEFORE UPDATE ON meetings.derivation_runs
  FOR EACH ROW EXECUTE FUNCTION meetings.check_derivation_change();
--> statement-breakpoint

-- What a model produced can only arrive during its own run, for what that run was for.
CREATE FUNCTION meetings.check_run_can_store(
    org uuid, meeting uuid, run uuid, wanted_purpose text, item_class text
  ) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  found_run record;
  found_class text;
BEGIN
  SELECT r.status, r.purpose INTO found_run
    FROM meetings.derivation_runs r
   WHERE r.organization_id = org AND r.meeting_id = meeting AND r.id = run;
  IF NOT FOUND OR found_run.status <> 'running' OR found_run.purpose <> wanted_purpose THEN
    RAISE EXCEPTION 'DERIVATION_NOT_RUNNING' USING ERRCODE = 'EN112';
  END IF;
  SELECT m.classification INTO found_class
    FROM meetings.meetings m
   WHERE m.organization_id = org AND m.id = meeting AND m.status = 'open';
  -- Whatever comes from these notes carries their class, and no less (secrets-and-egress §6).
  IF NOT FOUND OR found_class <> item_class THEN
    RAISE EXCEPTION 'DERIVED_CLASS_MISMATCH' USING ERRCODE = 'EN112';
  END IF;
  IF NOT meetings.consent_complete(org, meeting) THEN
    RAISE EXCEPTION 'CONSENT_INCOMPLETE' USING ERRCODE = 'EN110';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION meetings.check_new_summary() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.body IS NULL OR NEW.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'SUMMARY_INVALID_START' USING ERRCODE = 'EN112';
  END IF;
  PERFORM meetings.check_run_can_store(NEW.organization_id, NEW.meeting_id, NEW.run_id, 'summarize',
                                       NEW.classification);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER summaries_check_new
  BEFORE INSERT ON meetings.summaries
  FOR EACH ROW EXECUTE FUNCTION meetings.check_new_summary();
--> statement-breakpoint

-- A proposal starts as a proposal, with nobody's name on a decision and no work behind it (ADR-033 D7). There
-- is no column a workflow can fill in to skip a person.
CREATE FUNCTION meetings.check_new_item() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status <> 'proposed'
     OR NEW.decided_by_membership_id IS NOT NULL
     OR NEW.decided_at IS NOT NULL
     OR NEW.decision_reason IS NOT NULL
     OR NEW.work_unit_id IS NOT NULL
     OR NEW.purged_at IS NOT NULL
     OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'ITEM_INVALID_START' USING ERRCODE = 'EN113';
  END IF;
  PERFORM meetings.check_run_can_store(NEW.organization_id, NEW.meeting_id, NEW.run_id, 'extract_items',
                                       NEW.classification);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER proposed_items_check_new
  BEFORE INSERT ON meetings.proposed_items
  FOR EACH ROW EXECUTE FUNCTION meetings.check_new_item();
--> statement-breakpoint

-- The transitions match PROPOSED_ITEM_TRANSITIONS in @ensemus/domain/meeting. Accepting or rejecting takes a
-- named person who was in the room. Withdrawing is what a withdrawal of consent does, and names nobody.
CREATE FUNCTION meetings.check_item_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean;
  in_room boolean;
BEGIN
  -- Text can only go, whatever else happens, and going stamps the row.
  IF (NEW.title IS DISTINCT FROM OLD.title AND NEW.title IS NOT NULL)
     OR (NEW.detail IS DISTINCT FROM OLD.detail AND NEW.detail IS NOT NULL) THEN
    RAISE EXCEPTION 'ITEM_TEXT_ONLY_PURGES' USING ERRCODE = 'EN113';
  END IF;
  IF OLD.title IS NOT NULL AND NEW.title IS NULL THEN
    NEW.purged_at := now();
  END IF;

  IF NEW.status = OLD.status THEN
    -- A purge keeps what was decided and when, and the person's reason goes with the rest of the text.
    IF NEW.decided_by_membership_id IS DISTINCT FROM OLD.decided_by_membership_id
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.work_unit_id IS DISTINCT FROM OLD.work_unit_id
       OR (NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
           AND NEW.decision_reason IS NOT NULL) THEN
      RAISE EXCEPTION 'ITEM_DECISION_WRITTEN' USING ERRCODE = 'EN113';
    END IF;
    RETURN NEW;
  END IF;

  allowed := OLD.status = 'proposed' AND NEW.status IN ('accepted', 'rejected', 'withdrawn');
  IF NOT allowed THEN
    RAISE EXCEPTION 'ITEM_INVALID_TRANSITION' USING ERRCODE = 'EN113';
  END IF;

  IF NEW.status = 'withdrawn' THEN
    IF NEW.decided_by_membership_id IS NOT NULL
       OR NEW.work_unit_id IS NOT NULL
       OR NEW.title IS NOT NULL THEN
      RAISE EXCEPTION 'ITEM_INVALID_TRANSITION' USING ERRCODE = 'EN113';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.decided_by_membership_id IS NULL OR NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'ITEM_NEEDS_A_PERSON' USING ERRCODE = 'EN113';
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM meetings.meetings m
            WHERE m.organization_id = NEW.organization_id
              AND m.id = NEW.meeting_id
              AND m.status = 'open'
              AND m.organizer_membership_id = NEW.decided_by_membership_id)
      OR EXISTS (
           SELECT 1 FROM meetings.participants p
             JOIN meetings.meetings m
               ON m.organization_id = p.organization_id AND m.id = p.meeting_id
            WHERE p.organization_id = NEW.organization_id
              AND p.meeting_id = NEW.meeting_id
              AND p.membership_id = NEW.decided_by_membership_id
              AND m.status = 'open')
    INTO in_room;
  IF NOT in_room THEN
    RAISE EXCEPTION 'ITEM_NEEDS_A_PERSON' USING ERRCODE = 'EN113';
  END IF;
  IF NEW.status = 'accepted' AND NEW.kind = 'work' AND NEW.work_unit_id IS NULL THEN
    RAISE EXCEPTION 'ITEM_WORK_NOT_CREATED' USING ERRCODE = 'EN113';
  END IF;
  IF (NEW.kind = 'decision' OR NEW.status = 'rejected') AND NEW.work_unit_id IS NOT NULL THEN
    RAISE EXCEPTION 'ITEM_INVALID_TRANSITION' USING ERRCODE = 'EN113';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER proposed_items_check_change
  BEFORE UPDATE ON meetings.proposed_items
  FOR EACH ROW EXECUTE FUNCTION meetings.check_item_change();
--> statement-breakpoint

-- Reading notes from a source needs everyone's yes and an approved connection first, since reading them is
-- what the approval is for. The content itself is checked again when it is stored.
CREATE FUNCTION meetings.check_new_import() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  meeting record;
BEGIN
  IF NEW.status <> 'requested' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'IMPORT_INVALID_START' USING ERRCODE = 'EN112';
  END IF;
  SELECT m.status, m.classification, m.source_kind, m.connection_id INTO meeting
    FROM meetings.meetings m
   WHERE m.organization_id = NEW.organization_id AND m.id = NEW.meeting_id
     FOR UPDATE;
  IF NOT FOUND OR meeting.status <> 'open' OR meeting.source_kind <> 'connector' THEN
    RAISE EXCEPTION 'MEETING_NOT_OPEN' USING ERRCODE = 'EN112';
  END IF;
  IF NOT meetings.consent_complete(NEW.organization_id, NEW.meeting_id) THEN
    RAISE EXCEPTION 'CONSENT_INCOMPLETE' USING ERRCODE = 'EN110';
  END IF;
  IF NOT meetings.provider_approved(NEW.organization_id, NEW.source_approval_id, 'source',
                                    'import_notes', meeting.classification)
     OR NOT EXISTS (
       SELECT 1 FROM meetings.provider_approvals a
        WHERE a.organization_id = NEW.organization_id
          AND a.id = NEW.source_approval_id
          AND a.target_ref = 'connection:' || meeting.connection_id::text) THEN
    RAISE EXCEPTION 'PROVIDER_NOT_APPROVED' USING ERRCODE = 'EN111';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER import_requests_check_new
  BEFORE INSERT ON meetings.import_requests
  FOR EACH ROW EXECUTE FUNCTION meetings.check_new_import();
--> statement-breakpoint
CREATE FUNCTION meetings.check_import_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status <> OLD.status
     AND NOT (OLD.status = 'requested' AND NEW.status IN ('completed', 'failed', 'refused')) THEN
    RAISE EXCEPTION 'IMPORT_INVALID_TRANSITION' USING ERRCODE = 'EN112';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER import_requests_check_change
  BEFORE UPDATE ON meetings.import_requests
  FOR EACH ROW EXECUTE FUNCTION meetings.check_import_change();
