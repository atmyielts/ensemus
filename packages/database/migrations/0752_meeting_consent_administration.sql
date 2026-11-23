-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-033 D4/D5, ADR-031 D8). Human security review remains pending.
-- Meeting settings are an owner/admin action under current administrative MFA/SSO policy. Preserve
-- the installed native-session checks and add only the action name to that map.
DO $$
DECLARE definition text; changed text;
BEGIN
  definition:=pg_get_functiondef('app.interactive_privilege_allowed(text,uuid)'::regprocedure);
  changed:=replace(definition,'''connection.manage'',''skill.manage''','''connection.manage'',''skill.manage'',''meeting.manage''');
  IF changed=definition OR strpos(changed,'''meeting.manage''')=0 THEN
    RAISE EXCEPTION 'MEETING_ADMINISTRATION_MAP_UNEXPECTED' USING ERRCODE='55000';END IF;
  EXECUTE changed;
END $$;
--> statement-breakpoint
-- Switching off future meeting creation must not prevent a person from withdrawing consent. Keep
-- the participant/speaker, current-notice, exact-meeting lock and deferred atomic-purge checks.
DO $$
DECLARE definition text; changed text;
BEGIN
  definition:=pg_get_functiondef('meetings.check_new_consent()'::regprocedure);
  changed:=replace(definition,'AND s.enabled','AND (s.enabled OR NEW.decision = ''withdrawn'')');
  IF changed=definition OR (length(definition)-length(replace(definition,'AND s.enabled','')))/length('AND s.enabled')<>1 THEN
    RAISE EXCEPTION 'MEETING_CONSENT_CHECK_UNEXPECTED' USING ERRCODE='55000';END IF;
  EXECUTE changed;
END $$;
