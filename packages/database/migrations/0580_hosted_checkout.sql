-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-032 D4a). Changes here need human review, never agent approval. Not yet
-- reviewed by a person. Hosted checkout: Paddle, Payme and Click take the customer's money on their own
-- pages and tell us. What this adds, and why:
-- 1. billing.checkout_sessions: one row per checkout, in the paying tenant. Its ID is the order reference
--    the provider sends back. The web tier may create one, open it with Paddle's link, or close one that no
--    provider transaction exists for. Every other move (reserved, paid, cancelled by the provider, refunded)
--    goes only through billing.apply_checkout_change, and only by spending an attestation.
-- 2. billing.checkout_attestations: a single-use, 60-second witness that the connector worker, holding the
--    secrets login, checked the provider's signature on one stored delivery (reusing 0512's reviewed
--    envelope check), or read Paddle's transaction itself. The web tier shares ensemus_app with the
--    worker, so without this a compromised web tier could mark a checkout paid.
-- 3. billing.checkout_replies: the protocol answer Payme or Click is waiting for, written in the same
--    transaction as the change it reports, and read by the web tier for that one delivery.
-- 4. billing.check_payment_change gains a checkout branch: a checkout row in `paid` or `refunded` is
--    evidence of success, and a payment with a checkout may fail or return to ready only once that
--    checkout is closed with nothing taken. Everything 0501 checked is checked exactly as before.
-- Error codes: EN860 a checkout row change refused; EN861 an attestation missing, spent, expired or not
-- matching; EN862 a payment change that would contradict its checkout.

CREATE SEQUENCE billing.checkout_click_prepare_seq AS bigint MINVALUE 1 NO CYCLE;
--> statement-breakpoint
CREATE TABLE billing.checkout_sessions (
 organization_id uuid NOT NULL REFERENCES org.organizations(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 payment_id uuid NOT NULL,
 invoice_id uuid NOT NULL,
 processor text NOT NULL,
 environment text NOT NULL,
 amount_micros bigint NOT NULL,
 currency text NOT NULL,
 minor_unit_exponent integer NOT NULL,
 amount_minor bigint NOT NULL,
 state text NOT NULL,
 order_route_sha256 text NOT NULL,
 txn_route_sha256 text,
 provider_txn_ref text,
 provider_aux_ref text,
 click_prepare_id bigint,
 checkout_url text,
 provider_time_ms bigint,
 created_ms bigint,
 performed_ms bigint,
 cancelled_ms bigint,
 cancel_reason integer,
 tax_minor bigint,
 requested_by_membership_id uuid NOT NULL,
 version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT checkout_sessions_pk PRIMARY KEY (organization_id, id),
 CONSTRAINT checkout_sessions_one_per_payment UNIQUE (organization_id, payment_id),
 CONSTRAINT checkout_sessions_order_route UNIQUE (order_route_sha256),
 CONSTRAINT checkout_sessions_payment FOREIGN KEY (organization_id, payment_id) REFERENCES billing.payments(organization_id, id),
 CONSTRAINT checkout_sessions_invoice FOREIGN KEY (organization_id, invoice_id) REFERENCES billing.invoices(organization_id, id),
 CONSTRAINT checkout_sessions_processor CHECK (processor IN ('paddle','payme','click')),
 CONSTRAINT checkout_sessions_environment CHECK (environment IN ('sandbox','live')),
 CONSTRAINT checkout_sessions_state CHECK (state IN ('opening','open','reserved','paid','cancelled','refunded')),
 CONSTRAINT checkout_sessions_money CHECK (amount_micros > 0 AND amount_minor > 0 AND currency ~ '^[A-Z]{3}$'
  AND minor_unit_exponent BETWEEN 0 AND 6 AND amount_minor * (10::bigint ^ (6 - minor_unit_exponent))::bigint = amount_micros),
 CONSTRAINT checkout_sessions_hashes CHECK (order_route_sha256 ~ '^[0-9a-f]{64}$' AND (txn_route_sha256 IS NULL OR txn_route_sha256 ~ '^[0-9a-f]{64}$')),
 CONSTRAINT checkout_sessions_refs CHECK ((provider_txn_ref IS NULL OR (length(provider_txn_ref) BETWEEN 1 AND 128 AND provider_txn_ref ~ '^[A-Za-z0-9_]+$'))
  AND (provider_aux_ref IS NULL OR length(provider_aux_ref) BETWEEN 1 AND 128)
  AND (checkout_url IS NULL OR (length(checkout_url) <= 2048 AND checkout_url ~ '^https://'))
  AND ((txn_route_sha256 IS NULL) = (provider_txn_ref IS NULL))),
 CONSTRAINT checkout_sessions_click CHECK ((processor = 'click') = (click_prepare_id IS NOT NULL)),
 CONSTRAINT checkout_sessions_open CHECK (state = 'opening' OR checkout_url IS NOT NULL OR state = 'cancelled'),
 CONSTRAINT checkout_sessions_tax CHECK (tax_minor IS NULL OR (processor = 'paddle' AND tax_minor >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX checkout_sessions_txn_route ON billing.checkout_sessions (txn_route_sha256) WHERE txn_route_sha256 IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX checkout_sessions_provider_ref ON billing.checkout_sessions (processor, provider_txn_ref) WHERE provider_txn_ref IS NOT NULL;
--> statement-breakpoint
CREATE INDEX checkout_sessions_statement ON billing.checkout_sessions (processor, provider_time_ms) WHERE provider_time_ms IS NOT NULL;
--> statement-breakpoint

-- In the deployment's own organization. Hashes, IDs and amounts only; never a body or a key. The delivery is
-- named, not referenced, for the same reason as the replies below.
CREATE TABLE billing.checkout_attestations (
 organization_id uuid NOT NULL REFERENCES org.organizations(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 token_sha256 text NOT NULL UNIQUE,
 source text NOT NULL,
 delivery_id uuid,
 processor text NOT NULL,
 action text NOT NULL,
 route_sha256 text,
 txn_ref text,
 amount_minor bigint,
 currency text,
 restore_generation uuid NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 consumed_organization_id uuid,
 consumed_session_id uuid,
 CONSTRAINT checkout_attestations_pk PRIMARY KEY (organization_id, id),
 CONSTRAINT checkout_attestations_source CHECK ((source = 'callback') = (delivery_id IS NOT NULL) AND source IN ('callback','lookup')),
 CONSTRAINT checkout_attestations_processor CHECK (processor IN ('paddle','payme','click')),
 CONSTRAINT checkout_attestations_action CHECK (action ~ '^(payme|click|paddle)\.[A-Za-z_]{1,40}$'),
 CONSTRAINT checkout_attestations_hashes CHECK (token_sha256 ~ '^[0-9a-f]{64}$' AND (route_sha256 IS NULL OR route_sha256 ~ '^[0-9a-f]{64}$')),
 CONSTRAINT checkout_attestations_window CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '60 seconds'),
 CONSTRAINT checkout_attestations_consumed CHECK ((consumed_at IS NULL) = (consumed_organization_id IS NULL))
);
--> statement-breakpoint

-- No foreign key to the delivery: M3's upkeep removes delivery rows after a week, and must not be stopped.
CREATE TABLE billing.checkout_replies (
 organization_id uuid NOT NULL REFERENCES org.organizations(id),
 delivery_id uuid NOT NULL,
 processor text NOT NULL,
 body text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT checkout_replies_pk PRIMARY KEY (organization_id, delivery_id),
 CONSTRAINT checkout_replies_processor CHECK (processor IN ('payme','click')),
 CONSTRAINT checkout_replies_size CHECK (octet_length(body) BETWEEN 2 AND 262144)
);
--> statement-breakpoint

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['checkout_sessions','checkout_attestations','checkout_replies'] LOOP
  EXECUTE format('ALTER TABLE billing.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE billing.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON billing.%I FROM PUBLIC, ensemus_app, ensemus_agent, ensemus_secrets, ensemus_eraser, ensemus_operator, ensemus_support', t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY tenant_scoped ON billing.checkout_sessions TO ensemus_app
 USING (organization_id = app.current_organization_id()) WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY tenant_scoped ON billing.checkout_replies TO ensemus_app
 USING (organization_id = app.current_organization_id()) WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint
-- Like a webhook token or a payment customer hash: binding the hash of one order or provider transaction
-- reveals that one row, from which the worker binds its tenant. Lint keeps the binding out of the web tier.
CREATE FUNCTION app.current_checkout_route() RETURNS text LANGUAGE sql STABLE
 AS $$ SELECT nullif(current_setting('app.checkout_route_sha256', true), '') $$;
--> statement-breakpoint
CREATE POLICY checkout_by_route ON billing.checkout_sessions FOR SELECT TO ensemus_app
 USING (order_route_sha256 = app.current_checkout_route() OR txn_route_sha256 = app.current_checkout_route());
--> statement-breakpoint
-- The fixed functions below run as their owner, which RLS also holds, so each names exactly what it reaches.
CREATE POLICY checkout_fixed ON billing.checkout_sessions TO ensemus_migrator
 USING (organization_id::text = current_setting('billing.checkout_org', true))
 WITH CHECK (organization_id::text = current_setting('billing.checkout_org', true));
--> statement-breakpoint
CREATE POLICY checkout_statement ON billing.checkout_sessions FOR SELECT TO ensemus_migrator
 USING (processor = 'payme' AND current_setting('billing.checkout_statement', true) = pg_current_xact_id()::text);
--> statement-breakpoint
CREATE POLICY checkout_fixed ON billing.checkout_attestations TO ensemus_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.checkout_sessions TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, checkout_url, provider_txn_ref, provider_aux_ref, version, updated_at) ON billing.checkout_sessions TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.checkout_replies TO ensemus_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE billing.checkout_click_prepare_seq TO ensemus_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_checkout_route() TO ensemus_app;
--> statement-breakpoint

CREATE FUNCTION billing.checkout_route(p_kind text, p_processor text, p_ref text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
 AS $$ SELECT encode(public.digest(convert_to(CASE p_kind WHEN 'order' THEN 'order:' || p_ref
  ELSE 'txn:' || p_processor || ':' || p_ref END, 'UTF8'), 'sha256'), 'hex') $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing.checkout_route(text, text, text) TO ensemus_app, ensemus_secrets;
--> statement-breakpoint

CREATE FUNCTION billing.guard_checkout_session() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE p record; i record; fixed boolean;
BEGIN
 IF TG_RELID <> 'billing.checkout_sessions'::regclass THEN RAISE EXCEPTION 'CHECKOUT_REFUSED' USING ERRCODE = 'EN860'; END IF;
 fixed := current_user = 'ensemus_migrator' AND current_setting('billing.checkout_apply', true) = pg_current_xact_id()::text;
 IF TG_OP = 'INSERT' THEN
  IF session_user <> 'ensemus_app' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
   OR NEW.version <> 1 OR NEW.provider_txn_ref IS NOT NULL OR NEW.provider_time_ms IS NOT NULL OR NEW.created_ms IS NOT NULL
   OR NEW.performed_ms IS NOT NULL OR NEW.cancelled_ms IS NOT NULL OR NEW.cancel_reason IS NOT NULL OR NEW.tax_minor IS NOT NULL
   OR NOT ((NEW.processor = 'paddle' AND NEW.state = 'opening' AND NEW.checkout_url IS NULL)
        OR (NEW.processor IN ('payme','click') AND NEW.state = 'open' AND NEW.checkout_url IS NOT NULL)) THEN
   RAISE EXCEPTION 'CHECKOUT_INVALID_START' USING ERRCODE = 'EN860'; END IF;
  SELECT x.status, x.processor, x.amount_micros, x.currency, x.invoice_id INTO p FROM billing.payments x
   WHERE x.organization_id = NEW.organization_id AND x.id = NEW.payment_id FOR UPDATE;
  SELECT x.status INTO i FROM billing.invoices x WHERE x.organization_id = NEW.organization_id AND x.id = NEW.invoice_id FOR SHARE;
  IF p.status IS DISTINCT FROM 'sending' OR p.processor IS DISTINCT FROM NEW.processor OR p.amount_micros IS DISTINCT FROM NEW.amount_micros
   OR p.currency IS DISTINCT FROM NEW.currency OR p.invoice_id IS DISTINCT FROM NEW.invoice_id OR i.status IS DISTINCT FROM 'open' THEN
   RAISE EXCEPTION 'CHECKOUT_DOES_NOT_MATCH_PAYMENT' USING ERRCODE = 'EN860'; END IF;
  NEW.order_route_sha256 := billing.checkout_route('order', NEW.processor, NEW.id::text);
  NEW.txn_route_sha256 := NULL;
  NEW.created_at := now(); NEW.updated_at := now();
  RETURN NEW;
 END IF;
 IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'CHECKOUT_REFUSED' USING ERRCODE = 'EN860'; END IF;
 IF ROW(NEW.organization_id, NEW.id, NEW.payment_id, NEW.invoice_id, NEW.processor, NEW.environment, NEW.amount_micros, NEW.currency,
        NEW.minor_unit_exponent, NEW.amount_minor, NEW.order_route_sha256, NEW.click_prepare_id, NEW.requested_by_membership_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.organization_id, OLD.id, OLD.payment_id, OLD.invoice_id, OLD.processor, OLD.environment, OLD.amount_micros, OLD.currency,
        OLD.minor_unit_exponent, OLD.amount_minor, OLD.order_route_sha256, OLD.click_prepare_id, OLD.requested_by_membership_id, OLD.created_at)
   OR NEW.version <> OLD.version + 1
   OR (OLD.provider_txn_ref IS NOT NULL AND NEW.provider_txn_ref IS DISTINCT FROM OLD.provider_txn_ref)
   OR (OLD.checkout_url IS NOT NULL AND NEW.checkout_url IS DISTINCT FROM OLD.checkout_url) THEN
  RAISE EXCEPTION 'CHECKOUT_IMMUTABLE' USING ERRCODE = 'EN860'; END IF;
 IF NOT fixed THEN
  -- What the web tier or the worker may do without a provider's word: open Paddle's link, or close a
  -- checkout that no provider transaction exists for, so nothing could have been paid through it.
  IF ROW(NEW.provider_time_ms, NEW.created_ms, NEW.performed_ms, NEW.cancelled_ms, NEW.cancel_reason, NEW.tax_minor)
      IS DISTINCT FROM ROW(OLD.provider_time_ms, OLD.created_ms, OLD.performed_ms, OLD.cancelled_ms, OLD.cancel_reason, OLD.tax_minor)
   OR NOT ((OLD.state = 'opening' AND NEW.state = 'open' AND NEW.processor = 'paddle' AND NEW.provider_txn_ref IS NOT NULL AND NEW.checkout_url IS NOT NULL)
        OR (OLD.state = 'opening' AND NEW.state = 'cancelled' AND NEW.provider_txn_ref IS NULL)
        OR (OLD.state = 'open' AND NEW.state = 'cancelled' AND OLD.processor IN ('payme','click') AND OLD.provider_txn_ref IS NULL AND NEW.provider_txn_ref IS NULL)) THEN
   RAISE EXCEPTION 'CHECKOUT_PROVIDER_WORD_REQUIRED' USING ERRCODE = 'EN860'; END IF;
 END IF;
 NEW.txn_route_sha256 := CASE WHEN NEW.provider_txn_ref IS NULL THEN NULL ELSE billing.checkout_route('txn', NEW.processor, NEW.provider_txn_ref) END;
 NEW.updated_at := now();
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing.guard_checkout_session() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER checkout_sessions_guard BEFORE INSERT OR UPDATE ON billing.checkout_sessions
 FOR EACH ROW EXECUTE FUNCTION billing.guard_checkout_session();
--> statement-breakpoint
CREATE TRIGGER checkout_sessions_keep BEFORE DELETE OR TRUNCATE ON billing.checkout_sessions
 FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER checkout_replies_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON billing.checkout_replies
 FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER checkout_attestations_keep BEFORE DELETE OR TRUNCATE ON billing.checkout_attestations
 FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- A provider call the connector worker verified. 0512's envelope check holds the stored delivery, its
-- endpoint, the active `payment_checkout_<provider>` connection and the signing secret it used, unchanged.
CREATE FUNCTION billing.attest_checkout_callback(p_delivery uuid, p_version text, p_endpoint uuid, p_connection uuid, p_signing uuid,
 p_processor text, p_body_sha text, p_request_digest text, p_action text, p_route text, p_txn_ref text, p_amount_minor bigint,
 p_currency text, p_restore uuid)
 RETURNS TABLE(token text, "expiresAt" timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE org_id uuid := app.current_organization_id(); issued timestamptz; expires timestamptz; opaque text;
BEGIN
 IF p_restore IS DISTINCT FROM app.current_auth_restore_generation() THEN
  RAISE EXCEPTION 'PAYMENT_RESTORE_GENERATION_CHANGED' USING ERRCODE = 'EN422'; END IF;
 IF session_user <> 'ensemus_secrets' OR org_id IS NULL OR p_processor IS NULL OR p_processor NOT IN ('paddle','payme','click')
  OR p_action IS NULL OR p_action !~ ('^' || p_processor || '\.[A-Za-z_]{1,40}$')
  OR (p_route IS NOT NULL AND p_route !~ '^[0-9a-f]{64}$') OR (p_txn_ref IS NOT NULL AND p_txn_ref !~ '^[A-Za-z0-9_]{1,128}$')
  OR (p_amount_minor IS NOT NULL AND p_amount_minor <= 0) OR (p_currency IS NOT NULL AND p_currency !~ '^[A-Z]{3}$') THEN
  RAISE EXCEPTION 'CHECKOUT_ATTESTATION_REFUSED' USING ERRCODE = 'EN861'; END IF;
 PERFORM billing.check_payment_webhook_envelope(p_delivery, p_version, p_endpoint, p_connection, p_signing,
  'checkout_' || p_processor, p_body_sha, p_request_digest);
 issued := clock_timestamp(); expires := issued + interval '60 seconds'; opaque := encode(public.gen_random_bytes(32), 'hex');
 INSERT INTO billing.checkout_attestations(organization_id, token_sha256, source, delivery_id, processor, action, route_sha256, txn_ref,
  amount_minor, currency, restore_generation, issued_at, expires_at)
 VALUES (org_id, encode(public.digest(opaque, 'sha256'), 'hex'), 'callback', p_delivery, p_processor, p_action, p_route, p_txn_ref,
  p_amount_minor, p_currency, p_restore, issued, expires);
 RETURN QUERY SELECT opaque, expires;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing.attest_checkout_callback(uuid, text, uuid, uuid, uuid, text, text, text, text, text, text, bigint, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing.attest_checkout_callback(uuid, text, uuid, uuid, uuid, text, text, text, text, text, text, bigint, text, uuid) TO ensemus_secrets;
--> statement-breakpoint

-- What Paddle's own transaction says, read by the connector worker for one open checkout.
CREATE FUNCTION billing.attest_checkout_lookup(p_session uuid, p_action text, p_txn_ref text, p_amount_minor bigint, p_currency text, p_restore uuid)
 RETURNS TABLE(token text, "expiresAt" timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE org_id uuid := app.current_organization_id(); prior text := current_setting('billing.checkout_org', true);
 s record; issued timestamptz; expires timestamptz; opaque text;
BEGIN
 IF p_restore IS DISTINCT FROM app.current_auth_restore_generation() THEN
  RAISE EXCEPTION 'PAYMENT_RESTORE_GENERATION_CHANGED' USING ERRCODE = 'EN422'; END IF;
 IF session_user <> 'ensemus_secrets' OR org_id IS NULL OR p_action NOT IN ('paddle.lookup_paid', 'paddle.lookup_cancelled')
  OR p_txn_ref IS NULL OR p_txn_ref !~ '^txn_[a-z0-9]{1,64}$' OR (p_amount_minor IS NOT NULL AND p_amount_minor <= 0)
  OR (p_currency IS NOT NULL AND p_currency !~ '^[A-Z]{3}$') THEN
  RAISE EXCEPTION 'CHECKOUT_ATTESTATION_REFUSED' USING ERRCODE = 'EN861'; END IF;
 PERFORM set_config('billing.checkout_org', org_id::text, true);
 SELECT x.processor, x.state, x.provider_txn_ref, x.order_route_sha256 INTO s FROM billing.checkout_sessions x
  WHERE x.organization_id = org_id AND x.id = p_session;
 IF s.processor IS DISTINCT FROM 'paddle' OR s.state IS DISTINCT FROM 'open' OR s.provider_txn_ref IS DISTINCT FROM p_txn_ref THEN
  RAISE EXCEPTION 'CHECKOUT_ATTESTATION_REFUSED' USING ERRCODE = 'EN861'; END IF;
 issued := clock_timestamp(); expires := issued + interval '60 seconds'; opaque := encode(public.gen_random_bytes(32), 'hex');
 INSERT INTO billing.checkout_attestations(organization_id, token_sha256, source, processor, action, route_sha256, txn_ref,
  amount_minor, currency, restore_generation, issued_at, expires_at)
 VALUES (org_id, encode(public.digest(opaque, 'sha256'), 'hex'), 'lookup', 'paddle', p_action, s.order_route_sha256, p_txn_ref,
  p_amount_minor, p_currency, p_restore, issued, expires);
 PERFORM set_config('billing.checkout_org', coalesce(prior, ''), true);
 RETURN QUERY SELECT opaque, expires;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.checkout_org', coalesce(prior, ''), true); RAISE;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing.attest_checkout_lookup(uuid, text, text, bigint, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing.attest_checkout_lookup(uuid, text, text, bigint, text, uuid) TO ensemus_secrets;
--> statement-breakpoint

-- The one way a provider's word moves a checkout. It spends one attestation on one allowed move of one row
-- in the caller's own tenant, and checks the move again whatever the caller decided.
CREATE FUNCTION billing.apply_checkout_change(p_token text, p_session uuid, p_action text, p_to text, p_txn_ref text,
 p_provider_time_ms bigint, p_at_ms bigint, p_reason integer, p_tax_minor bigint)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE org_id uuid := app.current_organization_id(); prior_org text := current_setting('billing.checkout_org', true);
 prior_apply text := current_setting('billing.checkout_apply', true); a record; s record; now_ms bigint; allowed boolean;
BEGIN
 IF session_user <> 'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR org_id IS NULL
  OR p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' OR p_at_ms IS NULL THEN
  RAISE EXCEPTION 'CHECKOUT_ATTESTATION_REQUIRED' USING ERRCODE = 'EN861'; END IF;
 now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
 IF abs(p_at_ms - now_ms) > 300000 THEN RAISE EXCEPTION 'CHECKOUT_TIME_REFUSED' USING ERRCODE = 'EN861'; END IF;
 SELECT x.* INTO a FROM billing.checkout_attestations x WHERE x.token_sha256 = encode(public.digest(p_token, 'sha256'), 'hex') FOR UPDATE;
 IF a.id IS NULL OR a.consumed_at IS NOT NULL OR a.expires_at <= clock_timestamp() OR a.action IS DISTINCT FROM p_action
  OR a.restore_generation IS DISTINCT FROM app.current_auth_restore_generation() THEN
  RAISE EXCEPTION 'CHECKOUT_ATTESTATION_REQUIRED' USING ERRCODE = 'EN861'; END IF;
 IF a.source = 'lookup' AND a.organization_id IS DISTINCT FROM org_id THEN
  RAISE EXCEPTION 'CHECKOUT_ATTESTATION_REQUIRED' USING ERRCODE = 'EN861'; END IF;
 PERFORM set_config('billing.checkout_org', org_id::text, true);
 SELECT x.* INTO s FROM billing.checkout_sessions x WHERE x.organization_id = org_id AND x.id = p_session FOR UPDATE;
 IF s.id IS NULL OR s.processor IS DISTINCT FROM a.processor
  OR a.route_sha256 IS NULL OR a.route_sha256 NOT IN (s.order_route_sha256, coalesce(s.txn_route_sha256, ''),
     billing.checkout_route('txn', s.processor, coalesce(p_txn_ref, '')))
  OR (a.amount_minor IS NOT NULL AND a.amount_minor IS DISTINCT FROM s.amount_minor)
  OR (a.currency IS NOT NULL AND a.currency IS DISTINCT FROM s.currency)
  OR (a.txn_ref IS NOT NULL AND a.txn_ref IS DISTINCT FROM coalesce(s.provider_txn_ref, p_txn_ref)) THEN
  RAISE EXCEPTION 'CHECKOUT_ATTESTATION_MISMATCH' USING ERRCODE = 'EN861'; END IF;
 allowed := CASE
  WHEN p_action = 'payme.CreateTransaction' THEN (s.state = 'open' AND p_to = 'reserved')
    OR (s.state = 'reserved' AND p_to = 'cancelled' AND p_reason = 4 AND p_at_ms - s.created_ms > 43200000)
  WHEN p_action = 'payme.PerformTransaction' THEN (s.state = 'reserved' AND p_to = 'paid')
    OR (s.state = 'reserved' AND p_to = 'cancelled' AND p_reason = 4 AND p_at_ms - s.created_ms > 43200000)
  WHEN p_action = 'payme.CancelTransaction' THEN (s.state = 'reserved' AND p_to = 'cancelled' AND p_reason IN (1,2,3,4,5,10))
    OR (s.state = 'paid' AND p_to = 'refunded' AND p_reason IN (1,2,3,4,5,10))
  WHEN p_action = 'click.prepare' THEN s.state = 'open' AND p_to = 'reserved'
  WHEN p_action = 'click.complete' THEN s.state = 'reserved' AND p_to IN ('paid','cancelled')
  WHEN p_action IN ('paddle.paid','paddle.lookup_paid') THEN s.state = 'open' AND p_to = 'paid'
   AND a.amount_minor IS NOT NULL AND a.currency IS NOT NULL
  WHEN p_action IN ('paddle.cancelled','paddle.lookup_cancelled') THEN s.state = 'open' AND p_to = 'cancelled'
  WHEN p_action = 'paddle.refunded' THEN s.state = 'paid' AND p_to = 'refunded'
  ELSE false END;
 IF allowed IS NOT TRUE OR (p_to = 'reserved' AND (p_txn_ref IS NULL OR a.txn_ref IS DISTINCT FROM p_txn_ref))
  OR (p_to <> 'reserved' AND (s.provider_txn_ref IS NULL OR a.txn_ref IS DISTINCT FROM s.provider_txn_ref))
  OR (p_tax_minor IS NOT NULL AND (s.processor <> 'paddle' OR p_to <> 'paid' OR p_tax_minor < 0 OR p_tax_minor > s.amount_minor)) THEN
  RAISE EXCEPTION 'CHECKOUT_MOVE_REFUSED' USING ERRCODE = 'EN860'; END IF;
 UPDATE billing.checkout_attestations SET consumed_at = clock_timestamp(), consumed_organization_id = org_id, consumed_session_id = s.id
  WHERE organization_id = a.organization_id AND id = a.id;
 PERFORM set_config('billing.checkout_apply', pg_current_xact_id()::text, true);
 UPDATE billing.checkout_sessions SET state = p_to, version = version + 1,
  provider_txn_ref = CASE WHEN p_to = 'reserved' THEN p_txn_ref ELSE provider_txn_ref END,
  provider_time_ms = CASE WHEN p_to = 'reserved' THEN p_provider_time_ms ELSE provider_time_ms END,
  created_ms = CASE WHEN p_to = 'reserved' THEN p_at_ms ELSE created_ms END,
  performed_ms = CASE WHEN p_to = 'paid' THEN p_at_ms ELSE performed_ms END,
  cancelled_ms = CASE WHEN p_to IN ('cancelled','refunded') THEN p_at_ms ELSE cancelled_ms END,
  cancel_reason = CASE WHEN p_to IN ('cancelled','refunded') THEN p_reason ELSE cancel_reason END,
  tax_minor = CASE WHEN p_to = 'paid' THEN p_tax_minor ELSE tax_minor END
  WHERE organization_id = org_id AND id = s.id;
 PERFORM set_config('billing.checkout_apply', coalesce(prior_apply, ''), true);
 PERFORM set_config('billing.checkout_org', coalesce(prior_org, ''), true);
 RETURN p_to;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('billing.checkout_apply', coalesce(prior_apply, ''), true);
 PERFORM set_config('billing.checkout_org', coalesce(prior_org, ''), true); RAISE;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing.apply_checkout_change(text, uuid, text, text, text, bigint, bigint, integer, bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing.apply_checkout_change(text, uuid, text, text, text, bigint, bigint, integer, bigint) TO ensemus_app;
--> statement-breakpoint

-- Payme's GetStatement asks for every Payme transaction in a time range, across tenants. Answered only for
-- an attested GetStatement call, with protocol columns and no name, address or invoice.
CREATE FUNCTION billing.checkout_payme_statement(p_token text, p_from bigint, p_to bigint)
 RETURNS TABLE(id uuid, provider_txn_ref text, provider_time_ms bigint, amount_minor bigint, created_ms bigint, performed_ms bigint,
  cancelled_ms bigint, cancel_reason integer, state text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a record; prior text := current_setting('billing.checkout_statement', true);
BEGIN
 IF session_user <> 'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$'
  OR p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
  RAISE EXCEPTION 'CHECKOUT_ATTESTATION_REQUIRED' USING ERRCODE = 'EN861'; END IF;
 SELECT x.* INTO a FROM billing.checkout_attestations x WHERE x.token_sha256 = encode(public.digest(p_token, 'sha256'), 'hex') FOR UPDATE;
 IF a.id IS NULL OR a.consumed_at IS NOT NULL OR a.expires_at <= clock_timestamp() OR a.action <> 'payme.GetStatement'
  OR a.source <> 'callback' OR a.organization_id IS DISTINCT FROM app.current_organization_id() THEN
  RAISE EXCEPTION 'CHECKOUT_ATTESTATION_REQUIRED' USING ERRCODE = 'EN861'; END IF;
 UPDATE billing.checkout_attestations SET consumed_at = clock_timestamp(), consumed_organization_id = a.organization_id
  WHERE organization_id = a.organization_id AND id = a.id;
 PERFORM set_config('billing.checkout_statement', pg_current_xact_id()::text, true);
 RETURN QUERY SELECT x.id, x.provider_txn_ref, x.provider_time_ms, x.amount_minor, x.created_ms, x.performed_ms, x.cancelled_ms,
  x.cancel_reason, x.state FROM billing.checkout_sessions x
  WHERE x.processor = 'payme' AND x.provider_txn_ref IS NOT NULL AND x.provider_time_ms BETWEEN p_from AND p_to
  ORDER BY x.provider_time_ms, x.id LIMIT 10000;
 PERFORM set_config('billing.checkout_statement', coalesce(prior, ''), true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.checkout_statement', coalesce(prior, ''), true); RAISE;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing.checkout_payme_statement(text, bigint, bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing.checkout_payme_statement(text, bigint, bigint) TO ensemus_app;
--> statement-breakpoint

-- 0501's rule, unchanged, with checkout evidence added (see item 4 above).
CREATE OR REPLACE FUNCTION billing.check_payment_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean;
  evidence boolean;
  checkout record;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := CASE OLD.status
    WHEN 'ready' THEN NEW.status IN ('sending','failed','cancelled')
    WHEN 'sending' THEN NEW.status IN ('succeeded','failed','ready','reconciling')
    WHEN 'reconciling' THEN NEW.status IN ('succeeded','failed','ready','unknown')
    WHEN 'unknown' THEN NEW.status IN ('succeeded','failed')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'PAYMENT_INVALID_TRANSITION' USING ERRCODE = 'EN803';
  END IF;

  SELECT c.state, c.amount_micros, c.currency, c.processor INTO checkout FROM billing.checkout_sessions c
   WHERE c.organization_id = NEW.organization_id AND c.payment_id = NEW.id;

  -- Nobody can say a payment worked without the processor having said so, through an attempt's answer,
  -- a reconcile lookup, a verified event, or a checkout the provider's attested word marked paid.
  IF NEW.status = 'succeeded' THEN
    SELECT EXISTS (
      SELECT 1 FROM billing.payment_attempts a
       WHERE a.organization_id = NEW.organization_id AND a.payment_id = NEW.id
         AND a.outcome = 'succeeded'
    ) OR EXISTS (
      SELECT 1 FROM billing.payment_events e
       WHERE e.organization_id = NEW.organization_id AND e.payment_id = NEW.id
         AND e.kind = 'payment_succeeded' AND e.amount_micros = NEW.amount_micros
    ) OR (checkout.state IN ('paid','refunded') AND checkout.amount_micros = NEW.amount_micros
          AND checkout.currency = NEW.currency AND checkout.processor = NEW.processor)
    INTO evidence;
    IF NOT evidence THEN
      RAISE EXCEPTION 'PAYMENT_NO_EVIDENCE' USING ERRCODE = 'EN803';
    END IF;
  END IF;

  -- A payment with a checkout ends only with that checkout: never failed while money could still move.
  IF checkout.state IS NOT NULL AND NEW.status IN ('failed','cancelled','ready','reconciling','unknown')
     AND (checkout.state <> 'cancelled' OR NEW.status <> 'failed') THEN
    RAISE EXCEPTION 'PAYMENT_CHECKOUT_STILL_OPEN' USING ERRCODE = 'EN862';
  END IF;

  -- Going back to ready is only ever for an attempt that definitely reached nobody.
  IF NEW.status = 'ready' AND EXISTS (
    SELECT 1 FROM billing.payment_attempts a
     WHERE a.organization_id = NEW.organization_id AND a.payment_id = NEW.id
       AND (a.outcome IS NULL OR a.outcome <> 'not_sent')
  ) THEN
    RAISE EXCEPTION 'PAYMENT_ATTEMPT_MAY_HAVE_CHARGED' USING ERRCODE = 'EN803';
  END IF;
  RETURN NEW;
END $$;
