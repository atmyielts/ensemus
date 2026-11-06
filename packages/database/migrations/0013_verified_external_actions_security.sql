-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-027). Changes here need human review, never agent approval.

-- Forced RLS and the tenant policy on every table in the new schema. A test fails if one misses it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'integrations' LOOP
    EXECUTE format('ALTER TABLE integrations.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE integrations.%I FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format(
      'CREATE POLICY tenant_scoped ON integrations.%I TO ensemus_app '
      'USING (organization_id = app.current_organization_id()) '
      'WITH CHECK (organization_id = app.current_organization_id())',
      t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

-- Only the application role comes here. The dispatcher sees event metadata, and the secrets role sees
-- sealed values, and neither has any business with what is being sent or who said what.
GRANT USAGE ON SCHEMA integrations TO ensemus_app;
--> statement-breakpoint

-- Connections. The connector's type and the row's identity are fixed once written.
GRANT SELECT, INSERT ON integrations.connections TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (display_name, state, credential_secret_id, config, granted_scopes, version,
              last_error_code, last_error_at, updated_at, revoked_at)
  ON integrations.connections TO ensemus_app;
--> statement-breakpoint

-- What a sync found, and who the source says may see it.
GRANT SELECT, INSERT ON integrations.external_resources TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (external_version, display_name, content_sha256, classification, acl_state,
              seen_generation, deleted_at, updated_at)
  ON integrations.external_resources TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.external_resource_acl TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON integrations.sync_cursors TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (cursor, watermark, generation, full_sync_generation, state, lease_until,
              last_synced_at, last_error_code, updated_at)
  ON integrations.sync_cursors TO ensemus_app;
--> statement-breakpoint

-- An intent's payload, hash, target, tool, approval and key cannot be edited by any application code.
-- Changing a recipient has to make a new row, which needs a new approval (QA-007).
GRANT SELECT, INSERT ON integrations.external_actions TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, status_reason, external_id, version, updated_at, settled_at,
              resolved_by_membership_id, resolution, resolution_reason)
  ON integrations.external_actions TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON integrations.external_action_attempts TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (outcome, outcome_code, provider_status, external_id, finished_at)
  ON integrations.external_action_attempts TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON integrations.external_action_receipts TO ensemus_app;
--> statement-breakpoint

-- Webhooks. The token's hash is fixed: changing the address means a new endpoint.
GRANT SELECT, INSERT ON integrations.webhook_endpoints TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (signing_secret_id, previous_signing_secret_id, previous_secret_valid_until, state,
              max_body_bytes, rate_per_minute, max_bytes_per_minute, max_pending_bytes,
              timestamp_tolerance_seconds, window_started_at, window_deliveries, window_bytes,
              pending_bytes, updated_at)
  ON integrations.webhook_endpoints TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON integrations.webhook_deliveries TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (body, headers, state, reject_code, provider_event_id, processed_at)
  ON integrations.webhook_deliveries TO ensemus_app;
--> statement-breakpoint

-- A caller holding a webhook URL is nobody yet, so this finds exactly the one endpoint matching the
-- hash of their token, and nothing else. The same shape as an invitation link (0003).
CREATE FUNCTION app.current_webhook_token_hash() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.webhook_token_hash', true), '') $$;
--> statement-breakpoint
CREATE POLICY webhook_endpoints_by_token ON integrations.webhook_endpoints FOR SELECT TO ensemus_app
  USING (token_hash = app.current_webhook_token_hash());
--> statement-breakpoint

-- Records, kept as written, for everyone including the owner.
CREATE TRIGGER external_action_receipts_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON integrations.external_action_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER external_actions_keep
  BEFORE DELETE OR TRUNCATE ON integrations.external_actions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER external_action_attempts_keep
  BEFORE DELETE OR TRUNCATE ON integrations.external_action_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- A new intent starts where its approval says, and that approval has to be for exactly this effect on
-- this Work Unit. Nothing starts further along than that.
CREATE FUNCTION integrations.check_new_external_action() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE approval record;
BEGIN
  IF NEW.version <> 1 THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_INVALID_START' USING ERRCODE = 'EN003';
  END IF;
  IF NEW.requires_approval THEN
    IF NEW.status <> 'awaiting_approval' THEN
      RAISE EXCEPTION 'EXTERNAL_ACTION_INVALID_START' USING ERRCODE = 'EN003';
    END IF;
  ELSIF NEW.status <> 'ready' THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_INVALID_START' USING ERRCODE = 'EN003';
  END IF;
  IF NEW.approval_id IS NOT NULL THEN
    SELECT a.status, a.action_hash, a.work_unit_id INTO approval
      FROM work.approvals a
     WHERE a.organization_id = NEW.organization_id AND a.id = NEW.approval_id;
    IF NOT FOUND
       OR approval.status <> 'pending'
       OR approval.action_hash <> NEW.request_hash
       OR approval.work_unit_id <> NEW.work_unit_id THEN
      RAISE EXCEPTION 'EXTERNAL_ACTION_APPROVAL_MISMATCH' USING ERRCODE = 'EN004';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER external_actions_check_new
  BEFORE INSERT ON integrations.external_actions
  FOR EACH ROW EXECUTE FUNCTION integrations.check_new_external_action();
--> statement-breakpoint

-- The state machine, here as well as in code, because the web and the worker share a role. The
-- transitions match EXTERNAL_ACTION_TRANSITIONS in @ensemus/domain/external-action, and a test holds
-- the two together. What each rule protects is in ADR-027 D1 and D2.
CREATE FUNCTION integrations.check_external_action_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean;
  approved boolean;
  person boolean;
  accepted boolean;
  known_not_sent boolean;
  all_not_sent boolean;
  open_attempt boolean;
  indeterminate boolean;
BEGIN
  person := NEW.resolved_by_membership_id IS NOT NULL;
  -- What a person found is set once, on the move out of unknown, and never rewritten.
  IF (NEW.resolution IS DISTINCT FROM OLD.resolution
      OR NEW.resolved_by_membership_id IS DISTINCT FROM OLD.resolved_by_membership_id
      OR NEW.resolution_reason IS DISTINCT FROM OLD.resolution_reason)
     AND OLD.status <> 'unknown' THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_RESOLUTION_NOT_ALLOWED' USING ERRCODE = 'EN003';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'awaiting_approval' THEN NEW.status IN ('ready', 'cancelled')
    WHEN 'ready' THEN NEW.status IN ('sending', 'failed', 'cancelled')
    WHEN 'sending' THEN NEW.status IN ('sent', 'failed', 'ready', 'reconciling')
    WHEN 'reconciling' THEN NEW.status IN ('sent', 'failed', 'ready', 'unknown')
    WHEN 'unknown' THEN NEW.status IN ('sent', 'failed')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_INVALID_TRANSITION' USING ERRCODE = 'EN003';
  END IF;

  -- Moving towards a send needs an approval that is approved, unexpired and for exactly this hash.
  IF NEW.status IN ('ready', 'sending') AND OLD.status IN ('awaiting_approval', 'ready')
     AND NEW.requires_approval THEN
    SELECT EXISTS (
      SELECT 1 FROM work.approvals a
       WHERE a.organization_id = NEW.organization_id
         AND a.id = NEW.approval_id
         AND a.status = 'approved'
         AND a.action_hash = NEW.request_hash
         AND a.expires_at > now()
    ) INTO approved;
    IF NOT approved THEN
      RAISE EXCEPTION 'EXTERNAL_ACTION_APPROVAL_MISMATCH' USING ERRCODE = 'EN004';
    END IF;
  END IF;

  SELECT
    coalesce(bool_or(x.outcome = 'accepted'), false),
    coalesce(bool_and(x.outcome IS NOT NULL AND x.outcome IN ('not_sent', 'rejected')), false),
    coalesce(bool_and(x.outcome IS NOT NULL AND x.outcome = 'not_sent'), true),
    coalesce(bool_or(x.outcome IS NULL), false),
    coalesce(bool_or(x.outcome = 'indeterminate'), false)
  INTO accepted, known_not_sent, all_not_sent, open_attempt, indeterminate
  FROM integrations.external_action_attempts x
  WHERE x.organization_id = NEW.organization_id AND x.external_action_id = NEW.id;

  -- Going to sending takes a recorded attempt, written first in the same transaction.
  IF NEW.status = 'sending' AND NOT open_attempt THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_NO_ATTEMPT' USING ERRCODE = 'EN005';
  END IF;

  -- Back to ready is another try, which is safe only if nothing so far can have reached the provider.
  IF NEW.status = 'ready' AND OLD.status IN ('sending', 'reconciling') AND NOT all_not_sent THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_ATTEMPT_MAY_HAVE_SENT' USING ERRCODE = 'EN005';
  END IF;

  -- Never reported as sent without the provider's word or a named person's.
  IF NEW.status = 'sent' AND NOT accepted
     AND NOT (OLD.status = 'unknown' AND person AND NEW.resolution = 'confirmed_sent') THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_SENT_WITHOUT_RECEIPT' USING ERRCODE = 'EN005';
  END IF;

  -- Never reported as failed while it could have been sent, unless a named person looked.
  IF NEW.status = 'failed' AND OLD.status <> 'ready' AND NOT known_not_sent
     AND NOT (OLD.status = 'unknown' AND person AND NEW.resolution = 'confirmed_not_sent') THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_FAILED_WITHOUT_RECEIPT' USING ERRCODE = 'EN005';
  END IF;
  IF NEW.status = 'failed' AND OLD.status = 'ready' AND NOT all_not_sent THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_FAILED_WITHOUT_RECEIPT' USING ERRCODE = 'EN005';
  END IF;

  -- Unknown means an attempt could have gone through and the provider could not say.
  IF NEW.status = 'unknown' AND NOT indeterminate THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_UNKNOWN_WITHOUT_ATTEMPT' USING ERRCODE = 'EN005';
  END IF;

  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER external_actions_check_change
  BEFORE UPDATE ON integrations.external_actions
  FOR EACH ROW EXECUTE FUNCTION integrations.check_external_action_change();
--> statement-breakpoint

-- The boundary (ADR-027 D2). An attempt row is the claim to contact the provider. It locks its intent,
-- so two workers cannot pass this together, and it is refused unless the intent is ready and every
-- earlier attempt definitely did not send. So at most one attempt that could have sent ever exists,
-- whatever a retry, a replay, a crashed worker or a bug in application code does.
CREATE FUNCTION integrations.check_new_attempt() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  action record;
  earlier_may_have_sent boolean;
  last_number integer;
BEGIN
  SELECT a.status, a.request_hash, a.idempotency_key INTO action
    FROM integrations.external_actions a
   WHERE a.organization_id = NEW.organization_id AND a.id = NEW.external_action_id
     FOR UPDATE;
  IF NOT FOUND OR action.status <> 'ready' THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_NOT_READY' USING ERRCODE = 'EN005';
  END IF;
  IF NEW.request_hash <> action.request_hash OR NEW.idempotency_key <> action.idempotency_key THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_APPROVAL_MISMATCH' USING ERRCODE = 'EN004';
  END IF;
  SELECT
    coalesce(bool_or(x.outcome IS NULL OR x.outcome <> 'not_sent'), false),
    coalesce(max(x.attempt_no), 0)
  INTO earlier_may_have_sent, last_number
  FROM integrations.external_action_attempts x
  WHERE x.organization_id = NEW.organization_id AND x.external_action_id = NEW.external_action_id;
  IF earlier_may_have_sent THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_ATTEMPT_MAY_HAVE_SENT' USING ERRCODE = 'EN005';
  END IF;
  IF NEW.attempt_no <> last_number + 1 THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_ATTEMPT_OUT_OF_ORDER' USING ERRCODE = 'EN005';
  END IF;
  IF NEW.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_ATTEMPT_ALREADY_FINISHED' USING ERRCODE = 'EN005';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER external_action_attempts_check_new
  BEFORE INSERT ON integrations.external_action_attempts
  FOR EACH ROW EXECUTE FUNCTION integrations.check_new_attempt();
--> statement-breakpoint

-- An outcome is written once. The one exception is indeterminate, which later evidence may settle.
CREATE FUNCTION integrations.check_attempt_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.outcome IS DISTINCT FROM OLD.outcome
     AND OLD.outcome IS NOT NULL
     AND (OLD.outcome <> 'indeterminate' OR NEW.outcome IS NULL) THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_OUTCOME_WRITTEN' USING ERRCODE = 'EN005';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER external_action_attempts_check_change
  BEFORE UPDATE ON integrations.external_action_attempts
  FOR EACH ROW EXECUTE FUNCTION integrations.check_attempt_change();
--> statement-breakpoint

-- Lets one webhook delivery in, or says no, in one atomic update per endpoint. The window, the byte
-- budget and the backlog are all checked in the same row, so replicas cannot race past a limit.
CREATE FUNCTION integrations.admit_webhook_delivery(p_endpoint_id uuid, p_bytes integer)
  RETURNS boolean
  LANGUAGE plpgsql
  AS $$
DECLARE admitted uuid;
BEGIN
  IF p_bytes < 0 THEN
    RETURN false;
  END IF;
  UPDATE integrations.webhook_endpoints e SET
    window_started_at = CASE WHEN now() - e.window_started_at >= interval '1 minute'
                             THEN now() ELSE e.window_started_at END,
    window_deliveries = CASE WHEN now() - e.window_started_at >= interval '1 minute'
                             THEN 1 ELSE e.window_deliveries + 1 END,
    window_bytes = CASE WHEN now() - e.window_started_at >= interval '1 minute'
                        THEN p_bytes ELSE e.window_bytes + p_bytes END,
    pending_bytes = e.pending_bytes + p_bytes
  WHERE e.organization_id = app.current_organization_id()
    AND e.id = p_endpoint_id
    AND e.state = 'active'
    AND p_bytes <= e.max_body_bytes
    AND e.pending_bytes + p_bytes <= e.max_pending_bytes
    AND (now() - e.window_started_at >= interval '1 minute'
         OR (e.window_deliveries + 1 <= e.rate_per_minute
             AND e.window_bytes + p_bytes <= e.max_bytes_per_minute))
  RETURNING e.id INTO admitted;
  RETURN admitted IS NOT NULL;
END $$;
--> statement-breakpoint
-- Gives the bytes back when a delivery's body has gone.
CREATE FUNCTION integrations.release_webhook_bytes(p_endpoint_id uuid, p_bytes integer)
  RETURNS void
  LANGUAGE sql
  AS $$
  UPDATE integrations.webhook_endpoints e
     SET pending_bytes = greatest(0, e.pending_bytes - greatest(0, p_bytes))
   WHERE e.organization_id = app.current_organization_id() AND e.id = p_endpoint_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.admit_webhook_delivery(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.release_webhook_bytes(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION integrations.admit_webhook_delivery(uuid, integer) TO ensemus_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION integrations.release_webhook_bytes(uuid, integer) TO ensemus_app;
