-- FLAGGED FOR HUMAN SECURITY REVIEW
-- A targeted ON CONFLICT arbiter requires a SELECT policy, which the support reply definer must
-- not have on tenant mail. Ignore duplicate keys without reading existing mail rows. No grant
-- or RLS policy is broadened; inserts still pass the existing notification-depth and ticket guards.
CREATE OR REPLACE FUNCTION platform.enqueue_notification_mail() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE reminder integer;
BEGIN
  IF TG_RELID<>'platform.notifications'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'MAIL_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.reminders_sent<=OLD.reminders_sent THEN RETURN NULL;END IF;
    reminder := NEW.reminders_sent;
  END IF;
  PERFORM set_config('mail.notification_enqueue', NEW.organization_id::text||':'||NEW.id::text, true);
  BEGIN
    INSERT INTO platform.mail_outbox (organization_id, kind, idempotency_key, recipient_membership_id,
      notification_id, notification_kind, target_ref, reminder_number, send_before, next_attempt_at)
    VALUES (NEW.organization_id, 'notification',
      'notification:'||NEW.organization_id::text||':'||NEW.id::text||coalesce(':reminder:'||reminder::text, ''),
      NEW.recipient_membership_id, NEW.id, NEW.kind, NEW.target_ref, reminder,
      now()+interval '3 days', now()+interval '1 minute')
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN check_violation OR string_data_right_truncation THEN
    NULL;
  END;
  PERFORM set_config('mail.notification_enqueue', '', true);
  RETURN NULL;
END $$;
