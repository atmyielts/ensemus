-- FLAGGED FOR HUMAN SECURITY REVIEW
-- PROPOSED SECURITY SQL (ADR-024 D4, ADR-027 D2, D5). Changes here need human review, never agent approval.
-- Not yet reviewed by a person. Error codes: EN571 a message that could not have been queued this way,
-- EN572 a message moving in a way @ensemus/domain/mail MAIL_TRANSITIONS does not allow, or by anyone but
-- the mail worker.
--
-- Who does what:
--   ensemus_auth    queues account mail (reset, verification, email change, password changed) and nothing else.
--   ensemus_app     queues an invitation it has just created, and, through the trigger on
--                   platform.notifications, one message per notification and per reminder. It reads its
--                   own preferences, and an unsubscribe link's one topic.
--   ensemus_mailer  the mail worker. It crosses tenants, like the dispatcher, but reads only what an email
--                   needs: a member's name and address, a company's name, whether a notification was read
--                   and whether an invitation is still open. It moves messages, writes digests, unsubscribe
--                   tokens and bounces, and prunes what has settled. It never reads a notification's
--                   target, or anything a notification points at.
--   ensemus_support a desk reply inserts, through a fixed definer, a notification for the person who opened
--                   the ticket.

-- === Forced RLS, as on every other table in these schemas. A test fails if one misses it.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform.account_mail_outbox','platform.mail_outbox','platform.mail_suppressions',
    'platform.mail_unsubscribe_tokens','org.notification_preferences'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- === How a message moves. The same arrows as MAIL_TRANSITIONS, and a test holds the two together. Only the
-- mail worker moves a message. What a message is, and for whom, is fixed once written. A sealed link and the
-- address it goes to are erased here when the message settles, whatever the worker asked for.
CREATE FUNCTION platform.check_mail_progress() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  moving constant text[] := ARRAY['status','attempts','next_attempt_at','claimed_at','last_code',
    'provider_status','message_id','sent_at','updated_at','recipient_sha256','digest_id','digest_due_at',
    'recipient_address','link_key_id','link_wrapped_key','link_iv','link_ciphertext','link_auth_tag'];
  jn jsonb;
  jo jsonb;
  allowed boolean;
BEGIN
  IF TG_OP<>'UPDATE' OR TG_RELID NOT IN ('platform.mail_outbox'::regclass,'platform.account_mail_outbox'::regclass) THEN
    RAISE EXCEPTION 'MAIL_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF session_user<>'ensemus_mailer' OR current_user<>'ensemus_mailer' THEN
    RAISE EXCEPTION 'MAIL_PROGRESS_DENIED' USING ERRCODE='EN572';END IF;
  jn := to_jsonb(NEW);
  jo := to_jsonb(OLD);
  IF (jn - moving) IS DISTINCT FROM (jo - moving) THEN
    RAISE EXCEPTION 'MAIL_IDENTITY_IMMUTABLE' USING ERRCODE='EN572';END IF;
  -- An address is learned once, when a member's message is claimed, and a link or an address only ever goes.
  IF jo->>'recipient_sha256' IS NOT NULL AND jn->>'recipient_sha256' IS DISTINCT FROM jo->>'recipient_sha256' THEN
    RAISE EXCEPTION 'MAIL_IDENTITY_IMMUTABLE' USING ERRCODE='EN572';END IF;
  IF (NEW.recipient_address IS NOT NULL AND NEW.recipient_address IS DISTINCT FROM OLD.recipient_address)
    OR (NEW.link_ciphertext IS NOT NULL AND ROW(NEW.link_key_id,NEW.link_wrapped_key,NEW.link_iv,NEW.link_ciphertext,NEW.link_auth_tag)
      IS DISTINCT FROM ROW(OLD.link_key_id,OLD.link_wrapped_key,OLD.link_iv,OLD.link_ciphertext,OLD.link_auth_tag)) THEN
    RAISE EXCEPTION 'MAIL_IDENTITY_IMMUTABLE' USING ERRCODE='EN572';END IF;
  NEW.updated_at := now();

  IF NEW.status=OLD.status THEN
    IF ROW(NEW.attempts,NEW.next_attempt_at,NEW.claimed_at,NEW.last_code,NEW.provider_status,NEW.message_id,
           NEW.sent_at,NEW.recipient_sha256,jn->>'digest_id',jn->>'digest_due_at')
       IS DISTINCT FROM
       ROW(OLD.attempts,OLD.next_attempt_at,OLD.claimed_at,OLD.last_code,OLD.provider_status,OLD.message_id,
           OLD.sent_at,OLD.recipient_sha256,jo->>'digest_id',jo->>'digest_due_at') THEN
      RAISE EXCEPTION 'MAIL_INVALID_TRANSITION' USING ERRCODE='EN572';END IF;
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'queued' THEN NEW.status IN ('sending','held','suppressed','expired','skipped')
    WHEN 'sending' THEN NEW.status IN ('sent','queued','failed','bounced','unknown')
    WHEN 'held' THEN NEW.status IN ('digested','skipped')
    -- A late answer is believed (ADR-027 D2): a claim the worker gave up on can still have been accepted.
    WHEN 'unknown' THEN NEW.status='sent'
    ELSE false
  END;
  IF NOT allowed THEN RAISE EXCEPTION 'MAIL_INVALID_TRANSITION' USING ERRCODE='EN572';END IF;

  -- Each arrow, held to what it means. The database sets the times.
  IF NEW.status='sending' THEN
    -- The claim is committed before the relay is contacted, so a crash leaves a trace and never a resend.
    IF NEW.attempts<>OLD.attempts+1 OR OLD.next_attempt_at>now() OR now()>=OLD.send_before THEN
      RAISE EXCEPTION 'MAIL_INVALID_TRANSITION' USING ERRCODE='EN572';END IF;
    NEW.claimed_at := now();
    NEW.last_code := NULL;
    NEW.provider_status := NULL;
  ELSIF OLD.status='sending' AND NEW.status='queued' THEN
    -- Only a refusal before the commit point, with a wait, and a try left.
    IF NEW.attempts<>OLD.attempts OR NEW.attempts>=6 OR NEW.next_attempt_at<=now() OR NEW.last_code IS NULL THEN
      RAISE EXCEPTION 'MAIL_INVALID_TRANSITION' USING ERRCODE='EN572';END IF;
    NEW.claimed_at := NULL;
  ELSIF NEW.status='sent' THEN
    IF NEW.message_id IS NULL OR NEW.attempts<>OLD.attempts THEN
      RAISE EXCEPTION 'MAIL_INVALID_TRANSITION' USING ERRCODE='EN572';END IF;
    NEW.sent_at := now();
    NEW.last_code := 'ACCEPTED_BY_RELAY';
  ELSIF NEW.status='held' THEN
    IF jn->>'kind' IS DISTINCT FROM 'notification' OR (jn->>'digest_due_at') IS NULL
      OR (jn->>'digest_due_at')::timestamptz<=now() OR (jn->>'digest_due_at')::timestamptz>now()+interval '2 days' THEN
      RAISE EXCEPTION 'MAIL_INVALID_TRANSITION' USING ERRCODE='EN572';END IF;
  ELSIF NEW.status='digested' THEN
    IF (jn->>'digest_id') IS NULL OR NOT EXISTS (
      SELECT 1 FROM platform.mail_outbox d
       WHERE d.id=(jn->>'digest_id')::uuid AND d.kind='digest'
         AND d.organization_id=(jn->>'organization_id')::uuid
         AND d.recipient_membership_id=(jn->>'recipient_membership_id')::uuid) THEN
      RAISE EXCEPTION 'MAIL_INVALID_TRANSITION' USING ERRCODE='EN572';END IF;
  ELSIF NEW.status IN ('suppressed','expired','skipped','failed','bounced','unknown') THEN
    IF NEW.last_code IS NULL THEN RAISE EXCEPTION 'MAIL_INVALID_TRANSITION' USING ERRCODE='EN572';END IF;
    IF NEW.status='expired' AND now()<OLD.send_before THEN
      RAISE EXCEPTION 'MAIL_INVALID_TRANSITION' USING ERRCODE='EN572';END IF;
  END IF;
  IF NEW.status NOT IN ('sending','held','digested') AND (jn->>'digest_due_at') IS DISTINCT FROM (jo->>'digest_due_at') THEN
    RAISE EXCEPTION 'MAIL_INVALID_TRANSITION' USING ERRCODE='EN572';END IF;

  -- Settled: nothing left that could be used, or that names where it went.
  IF NEW.status NOT IN ('queued','sending','held') THEN
    NEW.recipient_address := NULL;
    NEW.link_key_id := NULL;
    NEW.link_wrapped_key := NULL;
    NEW.link_iv := NULL;
    NEW.link_ciphertext := NULL;
    NEW.link_auth_tag := NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.check_mail_progress() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER account_mail_outbox_check_progress BEFORE UPDATE ON platform.account_mail_outbox
  FOR EACH ROW EXECUTE FUNCTION platform.check_mail_progress();
--> statement-breakpoint
CREATE TRIGGER mail_outbox_check_progress BEFORE UPDATE ON platform.mail_outbox
  FOR EACH ROW EXECUTE FUNCTION platform.check_mail_progress();
--> statement-breakpoint

-- === Account mail. Only the auth role queues it, for a person who exists, to that person's own address,
-- or, to prove a new one, to an address that is not theirs yet. Over the limit for an address, the message
-- is kept as suppressed rather than refused, so the person asking gets the same answer either way and
-- nobody learns which addresses have accounts. A reset for someone with no password (company sign-in only)
-- is suppressed the same way.
CREATE FUNCTION platform.check_new_account_mail() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  owner_address text;
  recent integer;
  code text;
BEGIN
  IF TG_RELID<>'platform.account_mail_outbox'::regclass OR TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'MAIL_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF session_user<>'ensemus_auth' OR current_user<>'ensemus_auth' THEN
    RAISE EXCEPTION 'MAIL_INVALID_START' USING ERRCODE='EN571';END IF;
  IF NEW.status<>'queued' OR NEW.attempts<>0 OR NEW.claimed_at IS NOT NULL OR NEW.last_code IS NOT NULL
    OR NEW.provider_status IS NOT NULL OR NEW.message_id IS NOT NULL OR NEW.sent_at IS NOT NULL
    OR NEW.recipient_address IS NULL THEN
    RAISE EXCEPTION 'MAIL_INVALID_START' USING ERRCODE='EN571';END IF;
  NEW.created_at := now();
  NEW.updated_at := now();
  NEW.next_attempt_at := now();
  NEW.send_before := now() + CASE NEW.kind WHEN 'password_reset' THEN interval '30 minutes' ELSE interval '24 hours' END;
  NEW.recipient_address := lower(btrim(NEW.recipient_address));
  NEW.recipient_sha256 := encode(sha256(convert_to(NEW.recipient_address,'UTF8')),'hex');

  SELECT lower(u.email) INTO owner_address FROM identity.users u WHERE u.id=NEW.recipient_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'MAIL_INVALID_START' USING ERRCODE='EN571';END IF;
  IF (NEW.kind='email_change_verify') = (owner_address=NEW.recipient_address) THEN
    RAISE EXCEPTION 'MAIL_INVALID_START' USING ERRCODE='EN571';END IF;
  IF (NEW.kind='password_changed') <> (NEW.link_ciphertext IS NULL) THEN
    RAISE EXCEPTION 'MAIL_INVALID_START' USING ERRCODE='EN571';END IF;

  -- One queue at a time per address, so two requests at once cannot both slip under the limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('account_mail:'||NEW.recipient_sha256, 0));
  IF NEW.kind='password_reset' AND NOT EXISTS (
    SELECT 1 FROM identity.accounts a WHERE a.user_id=NEW.recipient_user_id AND a.provider_id='credential') THEN
    code := 'NO_PASSWORD_ACCOUNT';
  ELSE
    SELECT count(*) INTO recent FROM platform.account_mail_outbox m
     WHERE m.recipient_sha256=NEW.recipient_sha256 AND m.created_at>now()-interval '1 hour'
       AND m.status<>'suppressed';
    IF recent>=5 THEN code := 'RATE_LIMITED';END IF;
  END IF;
  IF code IS NOT NULL THEN
    NEW.status := 'suppressed';
    NEW.last_code := code;
    NEW.recipient_address := NULL;
    NEW.link_key_id := NULL;
    NEW.link_wrapped_key := NULL;
    NEW.link_iv := NULL;
    NEW.link_ciphertext := NULL;
    NEW.link_auth_tag := NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.check_new_account_mail() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER account_mail_outbox_check_new BEFORE INSERT ON platform.account_mail_outbox
  FOR EACH ROW EXECUTE FUNCTION platform.check_new_account_mail();
--> statement-breakpoint

-- === Tenant mail. A notification's message is queued only by the trigger on platform.notifications below,
-- which is the only way to be inside a trigger with the marker for that very notification set. An
-- invitation is queued only in the transaction that created it, by the person who did, to the address it
-- names. A digest is the worker's alone.
CREATE FUNCTION platform.check_new_tenant_mail() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  invite record;
  recent integer;
  recent_address integer;
BEGIN
  IF TG_RELID<>'platform.mail_outbox'::regclass OR TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'MAIL_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF NEW.status<>'queued' OR NEW.attempts<>0 OR NEW.claimed_at IS NOT NULL OR NEW.last_code IS NOT NULL
    OR NEW.provider_status IS NOT NULL OR NEW.message_id IS NOT NULL OR NEW.sent_at IS NOT NULL
    OR NEW.digest_id IS NOT NULL OR NEW.digest_due_at IS NOT NULL OR NEW.recipient_sha256 IS NOT NULL
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'MAIL_INVALID_START' USING ERRCODE='EN571';END IF;
  NEW.created_at := now();
  NEW.updated_at := now();
  NEW.next_attempt_at := greatest(now(), least(coalesce(NEW.next_attempt_at, now()), now()+interval '1 hour'));
  NEW.send_before := now() + CASE NEW.kind WHEN 'invitation' THEN interval '7 days'
    WHEN 'notification' THEN interval '3 days' ELSE interval '2 days' END;

  IF NEW.kind='notification' THEN
    IF pg_trigger_depth()<2
      OR current_setting('mail.notification_enqueue', true) IS DISTINCT FROM NEW.organization_id::text||':'||NEW.notification_id::text
      OR NEW.recipient_address IS NOT NULL OR NEW.link_ciphertext IS NOT NULL OR NEW.invitation_id IS NOT NULL THEN
      RAISE EXCEPTION 'MAIL_INVALID_START' USING ERRCODE='EN571';END IF;
  ELSIF NEW.kind='invitation' THEN
    IF session_user<>'ensemus_app' OR current_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'user'
      OR NEW.recipient_address IS NULL OR NEW.link_ciphertext IS NULL OR NEW.notification_id IS NOT NULL THEN
      RAISE EXCEPTION 'MAIL_INVALID_START' USING ERRCODE='EN571';END IF;
    SELECT i.email, i.invited_by_membership_id, i.accepted_at, i.revoked_at, i.expires_at, i.created_at INTO invite
      FROM org.invitations i WHERE i.organization_id=NEW.organization_id AND i.id=NEW.invitation_id;
    IF NOT FOUND OR invite.accepted_at IS NOT NULL OR invite.revoked_at IS NOT NULL OR invite.expires_at<=now()
      OR invite.created_at<>now() OR invite.invited_by_membership_id IS DISTINCT FROM app.current_membership_id()
      OR lower(invite.email)<>lower(btrim(NEW.recipient_address)) THEN
      RAISE EXCEPTION 'MAIL_INVALID_START' USING ERRCODE='EN571';END IF;
    NEW.recipient_address := lower(btrim(NEW.recipient_address));
    NEW.recipient_sha256 := encode(sha256(convert_to(NEW.recipient_address,'UTF8')),'hex');
    PERFORM pg_advisory_xact_lock(hashtextextended('tenant_invitation_mail:'||NEW.organization_id::text, 0));
    SELECT count(*), count(*) FILTER (WHERE m.recipient_sha256=NEW.recipient_sha256) INTO recent, recent_address
      FROM platform.mail_outbox m
     WHERE m.organization_id=NEW.organization_id AND m.kind='invitation'
       AND m.created_at>now()-interval '1 hour' AND m.status<>'suppressed';
    IF recent>=50 OR recent_address>=3 THEN
      NEW.status := 'suppressed';
      NEW.last_code := 'RATE_LIMITED';
      NEW.recipient_address := NULL;
      NEW.link_key_id := NULL;
      NEW.link_wrapped_key := NULL;
      NEW.link_iv := NULL;
      NEW.link_ciphertext := NULL;
      NEW.link_auth_tag := NULL;
    END IF;
  ELSIF NEW.kind='digest' THEN
    IF session_user<>'ensemus_mailer' OR current_user<>'ensemus_mailer'
      OR NEW.recipient_address IS NOT NULL OR NEW.link_ciphertext IS NOT NULL
      OR NEW.notification_id IS NOT NULL OR NEW.invitation_id IS NOT NULL OR NEW.reminder_number IS NOT NULL
      OR NEW.notification_kind IS NOT NULL OR NEW.recipient_membership_id IS NULL
      OR NEW.target_ref IS NULL OR NEW.target_ref !~ '^topic:(approvals|answers|billing|support|activity)$' THEN
      RAISE EXCEPTION 'MAIL_INVALID_START' USING ERRCODE='EN571';END IF;
  ELSE
    RAISE EXCEPTION 'MAIL_INVALID_START' USING ERRCODE='EN571';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.check_new_tenant_mail() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER mail_outbox_check_new BEFORE INSERT ON platform.mail_outbox
  FOR EACH ROW EXECUTE FUNCTION platform.check_new_tenant_mail();
--> statement-breakpoint

-- === One message per notification, and one per reminder, queued in the same transaction, so a
-- notification can never exist without its email being considered. Runs as whoever wrote the notification.
-- The message waits a minute: if the person reads it in Ensemus first, it is not mailed (the worker checks).
-- A notification shaped in a way the mail table refuses is still a notification: its email is dropped, and
-- the product's own work goes on.
CREATE FUNCTION platform.enqueue_notification_mail() RETURNS trigger
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
    ON CONFLICT (idempotency_key) DO NOTHING;
  EXCEPTION WHEN check_violation OR string_data_right_truncation THEN
    NULL;
  END;
  PERFORM set_config('mail.notification_enqueue', '', true);
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.enqueue_notification_mail() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER notifications_enqueue_mail AFTER INSERT ON platform.notifications
  FOR EACH ROW EXECUTE FUNCTION platform.enqueue_notification_mail();
--> statement-breakpoint
CREATE TRIGGER notifications_enqueue_reminder_mail AFTER UPDATE OF reminders_sent ON platform.notifications
  FOR EACH ROW WHEN (NEW.reminders_sent > OLD.reminders_sent)
  EXECUTE FUNCTION platform.enqueue_notification_mail();
--> statement-breakpoint

-- === Support replies. The desk works as ensemus_support, which reaches nothing outside support (0501), so a
-- reply cannot write a notification itself. Only the desk can write a message whose author is support
-- (0501's desk_write and customer_write), so this trigger fires for desk replies alone, and writes exactly
-- one kind of notification, for the person who opened that ticket, in the tenant the desk already bound.
-- The marker it sets names the one ticket, and the policies below let the definer read that ticket and
-- write that notification and its email, and nothing else.
CREATE FUNCTION support.notify_ticket_reply() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE opener uuid;
BEGIN
  IF TG_RELID<>'support.ticket_messages'::regclass OR TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'MAIL_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF NEW.author_kind<>'support' THEN RETURN NULL;END IF;
  PERFORM set_config('mail.ticket_reply_notice', NEW.ticket_id::text, true);
  SELECT t.opened_by_membership_id INTO opener FROM support.tickets t
   WHERE t.organization_id=NEW.organization_id AND t.id=NEW.ticket_id;
  IF FOUND THEN
    INSERT INTO platform.notifications (organization_id, recipient_membership_id, kind, target_ref)
    VALUES (NEW.organization_id, opener, 'ticket.replied', 'ticket:'||NEW.ticket_id::text);
  END IF;
  PERFORM set_config('mail.ticket_reply_notice', '', true);
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION support.notify_ticket_reply() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER ticket_messages_notify_reply AFTER INSERT ON support.ticket_messages
  FOR EACH ROW WHEN (NEW.author_kind = 'support')
  EXECUTE FUNCTION support.notify_ticket_reply();
--> statement-breakpoint
CREATE POLICY ticket_reply_read ON support.tickets FOR SELECT TO ensemus_migrator
  USING (id::text = current_setting('mail.ticket_reply_notice', true)
    AND organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY ticket_reply_notice ON platform.notifications FOR INSERT TO ensemus_migrator
  WITH CHECK (kind = 'ticket.replied'
    AND target_ref = 'ticket:'||current_setting('mail.ticket_reply_notice', true)
    AND organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY ticket_reply_mail ON platform.mail_outbox FOR INSERT TO ensemus_migrator
  WITH CHECK (kind = 'notification' AND notification_kind = 'ticket.replied'
    AND target_ref = 'ticket:'||current_setting('mail.ticket_reply_notice', true)
    AND organization_id = app.current_organization_id());
--> statement-breakpoint

-- === The auth role: queue account mail, count its own recent mail for the limit, and clear a bounce once
-- the address is proven again.
GRANT USAGE ON SCHEMA platform TO ensemus_auth;
--> statement-breakpoint
-- The ID is the caller's, because the sealed link is bound to it.
GRANT INSERT (id, kind, idempotency_key, recipient_user_id, recipient_address, link_key_id, link_wrapped_key,
  link_iv, link_ciphertext, link_auth_tag) ON platform.account_mail_outbox TO ensemus_auth;
--> statement-breakpoint
-- The key too, for the arbiter of ON CONFLICT DO NOTHING.
GRANT SELECT (idempotency_key, recipient_sha256, created_at, status) ON platform.account_mail_outbox TO ensemus_auth;
--> statement-breakpoint
CREATE POLICY account_mail_queue ON platform.account_mail_outbox FOR INSERT TO ensemus_auth WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY account_mail_limit ON platform.account_mail_outbox FOR SELECT TO ensemus_auth USING (true);
--> statement-breakpoint
GRANT SELECT (address_sha256), DELETE ON platform.mail_suppressions TO ensemus_auth;
--> statement-breakpoint
CREATE POLICY suppression_cleared ON platform.mail_suppressions FOR SELECT TO ensemus_auth USING (true);
--> statement-breakpoint
CREATE POLICY suppression_clear ON platform.mail_suppressions FOR DELETE TO ensemus_auth USING (true);
--> statement-breakpoint

-- === The application role: queue an invitation, see its own tenant's mail state (never a link or an
-- address), and the notification trigger's inserts. An agent inherits these, and the guard above leaves
-- it only notification mail. Columns that move are the worker's.
GRANT INSERT (id, organization_id, kind, idempotency_key, recipient_membership_id, recipient_address,
  notification_id, notification_kind, target_ref, reminder_number, invitation_id, link_key_id,
  link_wrapped_key, link_iv, link_ciphertext, link_auth_tag, send_before, next_attempt_at)
  ON platform.mail_outbox TO ensemus_app;
--> statement-breakpoint
GRANT SELECT (id, organization_id, kind, idempotency_key, recipient_membership_id, recipient_sha256, invitation_id,
  notification_id, status, last_code, created_at, sent_at) ON platform.mail_outbox TO ensemus_app;
--> statement-breakpoint
CREATE POLICY tenant_scoped ON platform.mail_outbox TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

-- One's own preferences, as a person (never an agent or a service). An unsubscribe link reaches exactly
-- one topic of one person, and can only turn it off.
GRANT SELECT, INSERT, DELETE ON org.notification_preferences TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (delivery, updated_at) ON org.notification_preferences TO ensemus_app;
--> statement-breakpoint
CREATE POLICY own_preferences ON org.notification_preferences TO ensemus_app
  USING (organization_id = app.current_organization_id() AND membership_id = app.current_membership_id()
    AND app.current_actor_type() = 'user')
  WITH CHECK (organization_id = app.current_organization_id() AND membership_id = app.current_membership_id()
    AND app.current_actor_type() = 'user');
--> statement-breakpoint
CREATE POLICY unsubscribe_preference ON org.notification_preferences TO ensemus_app
  USING (EXISTS (SELECT 1 FROM platform.mail_unsubscribe_tokens t
    WHERE t.token_sha256 = current_setting('app.mail_unsubscribe_token', true)
      AND t.organization_id = notification_preferences.organization_id
      AND t.membership_id = notification_preferences.membership_id
      AND t.topic = notification_preferences.topic))
  WITH CHECK (delivery = 'off' AND organization_id = app.current_organization_id()
    AND EXISTS (SELECT 1 FROM platform.mail_unsubscribe_tokens t
    WHERE t.token_sha256 = current_setting('app.mail_unsubscribe_token', true)
      AND t.organization_id = notification_preferences.organization_id
      AND t.membership_id = notification_preferences.membership_id
      AND t.topic = notification_preferences.topic));
--> statement-breakpoint
CREATE POLICY agent_none ON org.notification_preferences AS RESTRICTIVE TO ensemus_agent
  USING (false) WITH CHECK (false);
--> statement-breakpoint
GRANT SELECT, UPDATE (used_at) ON platform.mail_unsubscribe_tokens TO ensemus_app;
--> statement-breakpoint
CREATE POLICY unsubscribe_by_token ON platform.mail_unsubscribe_tokens TO ensemus_app
  USING (token_sha256 = current_setting('app.mail_unsubscribe_token', true) AND expires_at > now())
  WITH CHECK (token_sha256 = current_setting('app.mail_unsubscribe_token', true));
--> statement-breakpoint
CREATE POLICY agent_none ON platform.mail_unsubscribe_tokens AS RESTRICTIVE TO ensemus_agent
  USING (false) WITH CHECK (false);
--> statement-breakpoint

-- === The mail worker.
GRANT USAGE ON SCHEMA app, platform, org, identity TO ensemus_mailer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assert_restore_admitted(), app.current_auth_restore_generation() TO ensemus_mailer;
--> statement-breakpoint
GRANT SELECT, DELETE ON platform.account_mail_outbox, platform.mail_outbox TO ensemus_mailer;
--> statement-breakpoint
GRANT UPDATE (status, attempts, next_attempt_at, claimed_at, last_code, provider_status, message_id, sent_at,
  recipient_sha256) ON platform.account_mail_outbox TO ensemus_mailer;
--> statement-breakpoint
GRANT UPDATE (status, attempts, next_attempt_at, claimed_at, last_code, provider_status, message_id, sent_at,
  recipient_sha256, digest_id, digest_due_at) ON platform.mail_outbox TO ensemus_mailer;
--> statement-breakpoint
-- A digest names its member and its topic, and nothing else.
GRANT INSERT (organization_id, kind, idempotency_key, recipient_membership_id, target_ref, send_before,
  next_attempt_at) ON platform.mail_outbox TO ensemus_mailer;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.mail_suppressions TO ensemus_mailer;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON platform.mail_unsubscribe_tokens TO ensemus_mailer;
--> statement-breakpoint
GRANT SELECT ON org.notification_preferences TO ensemus_mailer;
--> statement-breakpoint
GRANT SELECT (organization_id, id, user_id, status) ON org.memberships TO ensemus_mailer;
--> statement-breakpoint
GRANT SELECT (id, name, lifecycle) ON org.organizations TO ensemus_mailer;
--> statement-breakpoint
GRANT SELECT (id, name, email, email_verified) ON identity.users TO ensemus_mailer;
--> statement-breakpoint
GRANT SELECT (organization_id, id, recipient_membership_id, read_at) ON platform.notifications TO ensemus_mailer;
--> statement-breakpoint
GRANT SELECT (organization_id, id, email, invited_by_membership_id, expires_at, accepted_at, revoked_at)
  ON org.invitations TO ensemus_mailer;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  -- Reads across tenants, as the dispatcher's do. Writes are narrower, below.
  FOREACH t IN ARRAY ARRAY['platform.account_mail_outbox','platform.mail_outbox','platform.mail_suppressions',
    'platform.mail_unsubscribe_tokens','org.notification_preferences','org.memberships','org.organizations',
    'identity.users','platform.notifications','org.invitations'] LOOP
    EXECUTE format('CREATE POLICY mail_delivery_read ON %s FOR SELECT TO ensemus_mailer USING (true)', t);
    -- Nothing moves while restore review is pending (ADR-026, 0422), whichever query a bug might write.
    EXECUTE format('CREATE POLICY auth_restore_mailer ON %s AS RESTRICTIVE TO ensemus_mailer '
      'USING (app.current_auth_restore_generation() IS NOT NULL) '
      'WITH CHECK (app.current_auth_restore_generation() IS NOT NULL)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY mail_progress ON platform.account_mail_outbox FOR UPDATE TO ensemus_mailer USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY mail_progress ON platform.mail_outbox FOR UPDATE TO ensemus_mailer USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY mail_digest ON platform.mail_outbox FOR INSERT TO ensemus_mailer
  WITH CHECK (kind = 'digest' AND organization_id = app.current_organization_id());
--> statement-breakpoint
-- Settled messages are kept thirty days, for anyone asking what happened, and then go.
CREATE POLICY mail_prune ON platform.account_mail_outbox FOR DELETE TO ensemus_mailer
  USING (status NOT IN ('queued','sending') AND updated_at < now() - interval '30 days');
--> statement-breakpoint
CREATE POLICY mail_prune ON platform.mail_outbox FOR DELETE TO ensemus_mailer
  USING (status NOT IN ('queued','sending','held') AND updated_at < now() - interval '30 days');
--> statement-breakpoint
CREATE POLICY mail_bounce ON platform.mail_suppressions FOR INSERT TO ensemus_mailer
  WITH CHECK (reason = 'RECIPIENT_REFUSED');
--> statement-breakpoint
CREATE POLICY mail_unsubscribe_issue ON platform.mail_unsubscribe_tokens FOR INSERT TO ensemus_mailer
  WITH CHECK (organization_id = app.current_organization_id() AND used_at IS NULL);
--> statement-breakpoint
CREATE POLICY mail_unsubscribe_prune ON platform.mail_unsubscribe_tokens FOR DELETE TO ensemus_mailer
  USING (expires_at < now());
--> statement-breakpoint

-- === Tenant content: the eraser reaches the three new tenant tables (0501), the counts-only erasure
-- projection knows them and fences their birth while a tenant is erasing (0518), and restore admission
-- covers that reach (0422), exactly as 0561 and 0563 did for theirs. Account mail has no tenant and is
-- pruned by the worker instead.
SELECT lifecycle.extend_eraser_reach();
--> statement-breakpoint
DO $$
DECLARE
  definition text;
  header constant text := 'CREATE OR REPLACE FUNCTION lifecycle.install_erasure_count_projection(';
  org_anchor constant text := '''org.memberships'',';
  org_widened constant text := '''org.memberships'',''org.notification_preferences'',';
  platform_anchor constant text := '''platform.inbox_events'',';
  platform_widened constant text := '''platform.inbox_events'',''platform.mail_outbox'',''platform.mail_unsubscribe_tokens'',';
BEGIN
  definition := pg_get_functiondef('lifecycle.install_erasure_count_projection()'::regprocedure);
  IF strpos(definition, header)<>1
    OR (length(definition)-length(replace(definition, org_anchor, '')))/length(org_anchor)<>1
    OR (length(definition)-length(replace(definition, platform_anchor, '')))/length(platform_anchor)<>1
    OR strpos(definition, '''org.notification_preferences''')<>0
    OR strpos(definition, '''platform.mail_outbox''')<>0
    OR strpos(definition, '''platform.mail_unsubscribe_tokens''')<>0 THEN
    RAISE EXCEPTION 'ERASURE_INVENTORY_DEFINITION_CHANGED' USING ERRCODE='EN850';END IF;
  EXECUTE replace(replace(definition, org_anchor, org_widened), platform_anchor, platform_widened);
END $$;
--> statement-breakpoint
SELECT lifecycle.install_erasure_count_projection();
--> statement-breakpoint
SELECT identity.extend_auth_restore_admission();
