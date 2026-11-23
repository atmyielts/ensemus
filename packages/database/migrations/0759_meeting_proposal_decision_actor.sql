-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (EXP-03, ADR-033 D7). Human security review remains pending.
CREATE FUNCTION meetings.guard_proposal_decision_actor() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  room_class text;
BEGIN
  IF app.is_web_login() IS DISTINCT FROM true
    OR app.current_interactive_session_id() IS NULL
    OR NEW.decided_by_membership_id IS DISTINCT FROM app.current_membership_id()
    OR NOT EXISTS (
      SELECT 1 FROM org.memberships m
      WHERE m.organization_id=NEW.organization_id AND m.id=NEW.decided_by_membership_id
        AND m.user_id=app.current_user_id() AND m.status='active'
    ) OR NEW.version IS DISTINCT FROM OLD.version+1 THEN
    RAISE EXCEPTION 'ITEM_NEEDS_A_PERSON' USING ERRCODE='EN113';
  END IF;

  -- Normal service decisions lock the room first. A direct row update must not
  -- hold up withdrawal while waiting for that lock in the opposite order.
  SELECT m.classification INTO room_class FROM meetings.meetings m
    WHERE m.organization_id=NEW.organization_id AND m.id=NEW.meeting_id AND m.status='open'
    FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND OR NOT meetings.consent_complete(NEW.organization_id, NEW.meeting_id) THEN
    RAISE EXCEPTION 'ITEM_MEETING_NOT_OPEN_AND_CONSENTED' USING ERRCODE='EN113';
  END IF;

  IF NEW.status='accepted' AND NEW.kind='work' AND NOT EXISTS (
    SELECT 1 FROM work.work_units w
    WHERE w.organization_id=NEW.organization_id AND w.id=NEW.work_unit_id
      AND w.classification=room_class AND w.created_by_membership_id=NEW.decided_by_membership_id
  ) THEN
    RAISE EXCEPTION 'ITEM_WORK_NOT_CREATED' USING ERRCODE='EN113';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION meetings.guard_proposal_decision_actor() FROM PUBLIC;
CREATE TRIGGER proposed_items_guard_decision_actor
  BEFORE UPDATE ON meetings.proposed_items
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('accepted','rejected'))
  EXECUTE FUNCTION meetings.guard_proposal_decision_actor();