-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Only native company administrators may hand off a meeting, and recovery grants no new room access.
-- Check the policy before acquiring a meeting row lock, matching the order used by the service.
CREATE FUNCTION meetings.authorize_organizer_handoff() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF app.current_interactive_session_id() IS NULL
    OR NOT app.interactive_privilege_allowed('meeting.manage') THEN
    RAISE EXCEPTION 'MEETING_ORGANIZER_HANDOFF_NOT_ALLOWED' USING ERRCODE='EN405';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION meetings.authorize_organizer_handoff() FROM PUBLIC;
CREATE TRIGGER meetings_organizer_handoff_authority
  BEFORE UPDATE OF organizer_membership_id ON meetings.meetings
  FOR EACH STATEMENT EXECUTE FUNCTION meetings.authorize_organizer_handoff();
--> statement-breakpoint
CREATE FUNCTION meetings.check_organizer_handoff() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.organizer_membership_id IS NOT DISTINCT FROM OLD.organizer_membership_id
    OR OLD.status <> 'open' OR NEW.version <> OLD.version + 1
    OR (to_jsonb(NEW) - ARRAY['organizer_membership_id','version','updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['organizer_membership_id','version','updated_at']) THEN
    RAISE EXCEPTION 'MEETING_ORGANIZER_HANDOFF_INVALID' USING ERRCODE='EN112';
  END IF;

  PERFORM 1 FROM org.memberships member
   WHERE member.organization_id=OLD.organization_id AND member.id=OLD.organizer_membership_id
     AND member.status='disabled' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_ORGANIZER_HANDOFF_INVALID' USING ERRCODE='EN112';
  END IF;

  PERFORM 1 FROM org.memberships member
   JOIN meetings.participants participant ON participant.organization_id=member.organization_id
     AND participant.membership_id=member.id
   WHERE member.organization_id=OLD.organization_id AND member.id=NEW.organizer_membership_id
     AND member.status='active' AND participant.meeting_id=OLD.id AND participant.kind='member'
   FOR SHARE OF member;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_ORGANIZER_HANDOFF_INVALID' USING ERRCODE='EN112';
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION meetings.check_organizer_handoff() FROM PUBLIC;
CREATE TRIGGER meetings_check_organizer_handoff
  BEFORE UPDATE OF organizer_membership_id ON meetings.meetings
  FOR EACH ROW EXECUTE FUNCTION meetings.check_organizer_handoff();
