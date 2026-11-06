-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-032). Changes here need human review, never agent approval.

-- The three new roles exist before this runs, because the migrator cannot create roles. They cannot log
-- in until an operator says so (ADR-032 D3). This stops with a clear message rather than half applying.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_roles
       WHERE rolname IN ('ensemus_operator','ensemus_support','ensemus_eraser')) <> 3 THEN
    RAISE EXCEPTION 'Run infrastructure/compose/postgres/upgrade-roles-m8.sql as a superuser first (ADR-032 D3)';
  END IF;
END $$;
--> statement-breakpoint

-- Forced RLS on every table in these schemas, tenant or global. A test fails if one misses it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename FROM pg_tables
     WHERE schemaname IN ('billing','lifecycle','support','operations')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.schemaname, t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

-- The tenant policy on every table with a tenant, except messages, which have their own below.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.table_schema, c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables b USING (table_schema, table_name)
     WHERE c.column_name = 'organization_id'
       AND b.table_type = 'BASE TABLE'
       AND c.table_schema IN ('billing','lifecycle','support')
       AND NOT (c.table_schema = 'support' AND c.table_name = 'ticket_messages')
  LOOP
    EXECUTE format(
      'CREATE POLICY tenant_scoped ON %I.%I TO ensemus_app '
      'USING (organization_id = app.current_organization_id()) '
      'WITH CHECK (organization_id = app.current_organization_id())',
      t.table_schema, t.table_name);
  END LOOP;
END $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA billing, lifecycle, support, operations TO ensemus_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO ensemus_operator, ensemus_support, ensemus_eraser;
--> statement-breakpoint
GRANT USAGE ON SCHEMA billing, support, operations, org TO ensemus_operator;
--> statement-breakpoint
GRANT USAGE ON SCHEMA support TO ensemus_support;
--> statement-breakpoint
GRANT USAGE ON SCHEMA lifecycle TO ensemus_eraser;
--> statement-breakpoint

-- === The price list and other published rules. Tenants read what is approved. Only the operator writes.
-- A draft is nobody's price, so it is invisible to the application.
GRANT SELECT ON billing.rate_cards, billing.rate_card_lines, billing.top_up_offers, billing.plans,
                billing.plan_versions, billing.collection_policies, billing.tax_treatments
  TO ensemus_app;
--> statement-breakpoint
CREATE POLICY published_read ON billing.rate_cards FOR SELECT TO ensemus_app USING (status <> 'draft');
--> statement-breakpoint
CREATE POLICY published_read ON billing.rate_card_lines FOR SELECT TO ensemus_app
  USING (EXISTS (SELECT 1 FROM billing.rate_cards c WHERE c.id = rate_card_id AND c.status <> 'draft'));
--> statement-breakpoint
CREATE POLICY published_read ON billing.top_up_offers FOR SELECT TO ensemus_app
  USING (EXISTS (SELECT 1 FROM billing.rate_cards c WHERE c.id = rate_card_id AND c.status <> 'draft'));
--> statement-breakpoint
CREATE POLICY published_read ON billing.plans FOR SELECT TO ensemus_app USING (true);
--> statement-breakpoint
CREATE POLICY published_read ON billing.plan_versions FOR SELECT TO ensemus_app USING (status <> 'draft');
--> statement-breakpoint
CREATE POLICY published_read ON billing.collection_policies FOR SELECT TO ensemus_app USING (status <> 'draft');
--> statement-breakpoint
CREATE POLICY published_read ON billing.tax_treatments FOR SELECT TO ensemus_app USING (status <> 'draft');
--> statement-breakpoint

GRANT SELECT, INSERT ON billing.rate_cards, billing.plans, billing.plan_versions,
                        billing.collection_policies, billing.tax_treatments,
                        billing.provider_bills, billing.operator_actions
  TO ensemus_operator;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON billing.rate_card_lines, billing.top_up_offers TO ensemus_operator;
--> statement-breakpoint
GRANT UPDATE (status, effective_from, approved_by, approved_at, retired_at) ON billing.rate_cards TO ensemus_operator;
--> statement-breakpoint
GRANT UPDATE (status, approved_by, approved_at, retired_at) ON billing.plan_versions TO ensemus_operator;
--> statement-breakpoint
GRANT UPDATE (status, approved_by, approved_at, retired_at) ON billing.collection_policies TO ensemus_operator;
--> statement-breakpoint
GRANT UPDATE (status, approved_by, approved_at, retired_at) ON billing.tax_treatments TO ensemus_operator;
--> statement-breakpoint
GRANT UPDATE (status, ledger_cost_micros, difference_micros, reviewed_by, reviewed_at) ON billing.provider_bills TO ensemus_operator;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rate_cards','rate_card_lines','top_up_offers','plans','plan_versions',
                           'collection_policies','tax_treatments','provider_bills','operator_actions']
  LOOP
    EXECUTE format('CREATE POLICY operator_all ON billing.%I TO ensemus_operator USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- The operator's view across tenants: who is on what, and what they owe. Numbers, with no names, no
-- contact details and no work. These are column grants, so asking for anything else is refused.
GRANT SELECT (id, commercial_mode, lifecycle, created_at) ON org.organizations TO ensemus_operator;
--> statement-breakpoint
CREATE POLICY operator_read ON org.organizations FOR SELECT TO ensemus_operator USING (true);
--> statement-breakpoint
GRANT SELECT (organization_id, id, plan_version_id, status, current_period_start, current_period_end,
              cancel_at_period_end, collection_policy_id)
  ON billing.subscriptions TO ensemus_operator;
--> statement-breakpoint
CREATE POLICY operator_read ON billing.subscriptions FOR SELECT TO ensemus_operator USING (true);
--> statement-breakpoint
GRANT SELECT (organization_id, id, kind, status, currency, subtotal_micros, tax_micros, total_micros,
              plan_version_id, rate_card_id, issued_at, due_at, paid_at)
  ON billing.invoices TO ensemus_operator;
--> statement-breakpoint
CREATE POLICY operator_read ON billing.invoices FOR SELECT TO ensemus_operator USING (true);
--> statement-breakpoint
GRANT SELECT ON billing.standing_changes TO ensemus_operator;
--> statement-breakpoint
CREATE POLICY operator_read ON billing.standing_changes FOR SELECT TO ensemus_operator USING (true);
--> statement-breakpoint
GRANT SELECT (organization_id, id, invoice_id, collection_policy_id, status, step_no, next_step_at)
  ON billing.collection_cases TO ensemus_operator;
--> statement-breakpoint
CREATE POLICY operator_read ON billing.collection_cases FOR SELECT TO ensemus_operator USING (true);
--> statement-breakpoint

-- Reconciling a provider's bill means adding up every tenant's usage. M4's ledger holds IDs and counts,
-- no content. This only applies once that table exists, which it does after the final merge.
DO $$
BEGIN
  IF to_regclass('platform.usage_ledger') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA platform TO ensemus_operator;
    GRANT SELECT ON platform.usage_ledger TO ensemus_operator;
    CREATE POLICY operator_read ON platform.usage_ledger FOR SELECT TO ensemus_operator USING (true);
  END IF;
END $$;
--> statement-breakpoint

-- An approved price never changes, and neither does anything hanging off it. A correction is a new
-- version, so an old invoice can always say exactly which prices it used.
CREATE FUNCTION billing.check_published_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'PUBLISHED_RULES_IMMUTABLE' USING ERRCODE = 'EN801';
  END IF;
  IF OLD.status = 'approved' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'PUBLISHED_RULES_IMMUTABLE' USING ERRCODE = 'EN801';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'retired' THEN
    RAISE EXCEPTION 'PUBLISHED_RULES_IMMUTABLE' USING ERRCODE = 'EN801';
  END IF;
  IF OLD.status = 'approved' AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
                                  OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'PUBLISHED_RULES_IMMUTABLE' USING ERRCODE = 'EN801';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION billing.refuse_published_delete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'PUBLISHED_RULES_IMMUTABLE' USING ERRCODE = 'EN801'; END $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rate_cards','plan_versions','collection_policies','tax_treatments']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON billing.%I FOR EACH ROW EXECUTE FUNCTION billing.check_published_change()', t || '_check_change', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON billing.%I FOR EACH STATEMENT EXECUTE FUNCTION billing.refuse_published_delete()', t || '_keep', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- What a rate card holds can only change while it is a draft, and it cannot be approved empty.
CREATE FUNCTION billing.check_card_part() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE card_id uuid;
DECLARE card_status text;
BEGIN
  card_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.rate_card_id ELSE NEW.rate_card_id END;
  SELECT c.status INTO card_status FROM billing.rate_cards c WHERE c.id = card_id FOR SHARE;
  IF card_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'PUBLISHED_RULES_IMMUTABLE' USING ERRCODE = 'EN801';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER rate_card_lines_check BEFORE INSERT OR UPDATE OR DELETE ON billing.rate_card_lines
  FOR EACH ROW EXECUTE FUNCTION billing.check_card_part();
--> statement-breakpoint
CREATE TRIGGER top_up_offers_check BEFORE INSERT OR UPDATE OR DELETE ON billing.top_up_offers
  FOR EACH ROW EXECUTE FUNCTION billing.check_card_part();
--> statement-breakpoint
CREATE FUNCTION billing.check_card_approval() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status = 'draft'
     AND NOT EXISTS (SELECT 1 FROM billing.rate_card_lines l WHERE l.rate_card_id = NEW.id) THEN
    RAISE EXCEPTION 'RATE_CARD_EMPTY' USING ERRCODE = 'EN801';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER rate_cards_check_approval BEFORE UPDATE ON billing.rate_cards
  FOR EACH ROW EXECUTE FUNCTION billing.check_card_approval();
--> statement-breakpoint

-- A Cloud plan bills AI credits against an approved card. A BYOM plan bills none, ever: its customer
-- pays their model provider directly, so Ensemus cannot charge for that inference twice (QA-027).
CREATE FUNCTION billing.check_plan_approval() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE plan_mode text;
DECLARE card record;
BEGIN
  IF NEW.status = 'approved' AND OLD.status = 'draft' THEN
    SELECT p.commercial_mode INTO plan_mode FROM billing.plans p WHERE p.id = NEW.plan_id;
    IF plan_mode = 'byom' THEN
      IF NEW.included_microcredits IS NOT NULL OR NEW.rate_card_id IS NOT NULL OR NEW.overage_policy IS NOT NULL THEN
        RAISE EXCEPTION 'BYOM_PLAN_BILLS_NO_INFERENCE' USING ERRCODE = 'EN801';
      END IF;
    ELSE
      IF NEW.included_microcredits IS NULL OR NEW.rate_card_id IS NULL OR NEW.overage_policy IS NULL THEN
        RAISE EXCEPTION 'CLOUD_PLAN_NEEDS_RATE_CARD' USING ERRCODE = 'EN801';
      END IF;
      SELECT c.status, c.currency INTO card FROM billing.rate_cards c WHERE c.id = NEW.rate_card_id;
      IF card.status IS DISTINCT FROM 'approved' OR card.currency <> NEW.currency THEN
        RAISE EXCEPTION 'RATE_CARD_NOT_APPROVED' USING ERRCODE = 'EN801';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER plan_versions_check_approval BEFORE UPDATE ON billing.plan_versions
  FOR EACH ROW EXECUTE FUNCTION billing.check_plan_approval();
--> statement-breakpoint

-- === One tenant's billing, for the application role.
GRANT SELECT, INSERT ON billing.billing_accounts TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (billing_name, billing_email, country_code, region_code, postal_code, tax_id, processor,
              processor_customer_ref, customer_ref_hash, version, updated_at)
  ON billing.billing_accounts TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.subscriptions TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (plan_version_id, status, current_period_start, current_period_end, cancel_at_period_end,
              canceled_at, collection_policy_id, version, updated_at)
  ON billing.subscriptions TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.subscription_changes, billing.standing_changes, billing.credit_ledger,
                        billing.payment_events
  TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.billing_periods TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, closed_at) ON billing.billing_periods TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.credit_accounts TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (balance_microcredits, usage_cursor, version, updated_at) ON billing.credit_accounts TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.top_ups TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, invoice_id, version, updated_at) ON billing.top_ups TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.invoices TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (invoice_number, status, subtotal_micros, tax_micros, total_micros, tax_treatment_id,
              tax_ref, bill_to, issued_at, due_at, paid_at, voided_at, void_reason_code, version, updated_at)
  ON billing.invoices TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON billing.invoice_lines TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.payments TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, status_reason, processor_payment_ref, version, settled_at, updated_at)
  ON billing.payments TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.payment_attempts TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (outcome, outcome_code, processor_payment_ref, finished_at) ON billing.payment_attempts TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.payment_webhook_events TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, target_organization_id, processed_at) ON billing.payment_webhook_events TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON billing.collection_cases TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, step_no, next_step_at, resolved_at, version) ON billing.collection_cases TO ensemus_app;
--> statement-breakpoint

-- A processor's event names its customer, and the tenant comes from our own row, never from the event.
-- This finds the one account matching the hash, the same shape as an invitation link (0003) and a
-- webhook token (0013). Only `withPaymentCustomerTx` binds it, and the web tier cannot import that.
CREATE FUNCTION app.current_payment_customer_hash() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.payment_customer_hash', true), '') $$;
--> statement-breakpoint
CREATE POLICY billing_accounts_by_customer ON billing.billing_accounts FOR SELECT TO ensemus_app
  USING (customer_ref_hash = app.current_payment_customer_hash());
--> statement-breakpoint

-- Records, kept as written, for everyone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscription_changes','standing_changes','credit_ledger','payment_events','operator_actions']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON billing.%I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change()', t || '_append_only', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- The balance is whatever the ledger adds up to, and this is the only thing that moves it, so the two
-- cannot differ. The balance may go below zero: usage that already happened cannot be un-happened, and
-- M4 over-counts a lost call on purpose. Going negative stops the next run, and bills nobody.
CREATE FUNCTION billing.apply_credit_entry() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE top_up_status text;
BEGIN
  IF NEW.kind = 'top_up' THEN
    SELECT t.status INTO top_up_status FROM billing.top_ups t
     WHERE t.organization_id = NEW.organization_id AND t.id = NEW.top_up_id;
    IF top_up_status IS DISTINCT FROM 'paid' THEN
      RAISE EXCEPTION 'TOP_UP_NOT_PAID' USING ERRCODE = 'EN802';
    END IF;
  END IF;
  INSERT INTO billing.credit_accounts AS a (organization_id, balance_microcredits)
    VALUES (NEW.organization_id, NEW.amount_microcredits)
    ON CONFLICT (organization_id) DO UPDATE
      SET balance_microcredits = a.balance_microcredits + EXCLUDED.balance_microcredits,
          version = a.version + 1,
          updated_at = now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER credit_ledger_apply AFTER INSERT ON billing.credit_ledger
  FOR EACH ROW EXECUTE FUNCTION billing.apply_credit_entry();
--> statement-breakpoint

-- A top-up is one person's decision to pay one exact price. The price cannot drift and a ledger entry
-- cannot come first. The column grants above already keep the amount and hash from being edited.
CREATE FUNCTION billing.check_top_up_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE allowed boolean;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := CASE OLD.status
    WHEN 'requested' THEN NEW.status IN ('invoiced','cancelled','failed')
    WHEN 'invoiced' THEN NEW.status IN ('paid','failed','cancelled')
    WHEN 'paid' THEN NEW.status = 'credited'
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'TOP_UP_INVALID_TRANSITION' USING ERRCODE = 'EN802';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER top_ups_check_change BEFORE UPDATE ON billing.top_ups
  FOR EACH ROW EXECUTE FUNCTION billing.check_top_up_change();
--> statement-breakpoint

-- === Invoices. A draft can change. Once open, the money on it cannot. The code refuses to bill without
-- an approved rate card, and so does this, because an invoice is the one thing that must never be wrong.
CREATE FUNCTION billing.check_invoice_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean;
  line_total bigint;
  tax_total bigint;
  card_status text;
  plan_status text;
BEGIN
  IF OLD.status <> 'draft'
     AND (NEW.subtotal_micros <> OLD.subtotal_micros OR NEW.tax_micros <> OLD.tax_micros
          OR NEW.total_micros <> OLD.total_micros OR NEW.bill_to IS DISTINCT FROM OLD.bill_to
          OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
          OR NEW.tax_treatment_id IS DISTINCT FROM OLD.tax_treatment_id
          OR NEW.tax_ref IS DISTINCT FROM OLD.tax_ref
          OR NEW.issued_at IS DISTINCT FROM OLD.issued_at) THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE' USING ERRCODE = 'EN802';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := CASE OLD.status
    WHEN 'draft' THEN NEW.status IN ('open','void')
    WHEN 'open' THEN NEW.status IN ('paid','void','uncollectible')
    WHEN 'uncollectible' THEN NEW.status IN ('paid','void')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'INVOICE_INVALID_TRANSITION' USING ERRCODE = 'EN802';
  END IF;

  IF NEW.status = 'open' THEN
    -- A rate card that has since retired still priced this period honestly. A draft priced nothing.
    IF NEW.kind = 'subscription' THEN
      SELECT v.status INTO plan_status FROM billing.plan_versions v WHERE v.id = NEW.plan_version_id;
      IF plan_status IS NULL OR plan_status = 'draft' THEN
        RAISE EXCEPTION 'RATE_CARD_NOT_APPROVED' USING ERRCODE = 'EN802';
      END IF;
    END IF;
    IF NEW.rate_card_id IS NOT NULL THEN
      SELECT c.status INTO card_status FROM billing.rate_cards c WHERE c.id = NEW.rate_card_id;
      IF card_status IS NULL OR card_status = 'draft' THEN
        RAISE EXCEPTION 'RATE_CARD_NOT_APPROVED' USING ERRCODE = 'EN802';
      END IF;
    ELSIF NEW.kind = 'top_up' OR EXISTS (
      SELECT 1 FROM billing.invoice_lines l
       WHERE l.organization_id = NEW.organization_id AND l.invoice_id = NEW.id AND l.kind = 'usage'
    ) THEN
      RAISE EXCEPTION 'RATE_CARD_NOT_APPROVED' USING ERRCODE = 'EN802';
    END IF;
    IF NEW.tax_treatment_id IS NULL OR NEW.invoice_number IS NULL OR NEW.issued_at IS NULL
       OR NEW.due_at IS NULL OR NEW.bill_to IS NULL THEN
      RAISE EXCEPTION 'INVOICE_INCOMPLETE' USING ERRCODE = 'EN802';
    END IF;
    SELECT coalesce(sum(l.amount_micros) FILTER (WHERE l.kind <> 'tax'), 0),
           coalesce(sum(l.amount_micros) FILTER (WHERE l.kind = 'tax'), 0)
      INTO line_total, tax_total
      FROM billing.invoice_lines l
     WHERE l.organization_id = NEW.organization_id AND l.invoice_id = NEW.id;
    IF line_total <> NEW.subtotal_micros OR tax_total <> NEW.tax_micros THEN
      RAISE EXCEPTION 'INVOICE_LINES_DO_NOT_ADD_UP' USING ERRCODE = 'EN802';
    END IF;
  END IF;

  -- Marked paid only on a payment that succeeded, for all of it.
  IF NEW.status = 'paid' AND NEW.total_micros > 0 AND NOT EXISTS (
    SELECT 1 FROM billing.payments p
     WHERE p.organization_id = NEW.organization_id AND p.invoice_id = NEW.id
       AND p.status = 'succeeded' AND p.amount_micros = NEW.total_micros
  ) THEN
    RAISE EXCEPTION 'INVOICE_NOT_PAID' USING ERRCODE = 'EN802';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_check_change BEFORE UPDATE ON billing.invoices
  FOR EACH ROW EXECUTE FUNCTION billing.check_invoice_change();
--> statement-breakpoint
CREATE TRIGGER invoices_keep BEFORE DELETE OR TRUNCATE ON billing.invoices
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION billing.check_invoice_line() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE invoice_status text;
DECLARE owner_org uuid;
DECLARE owner_invoice uuid;
BEGIN
  owner_org := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  owner_invoice := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  SELECT i.status INTO invoice_status FROM billing.invoices i
   WHERE i.organization_id = owner_org AND i.id = owner_invoice FOR SHARE;
  IF invoice_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE' USING ERRCODE = 'EN802';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_check BEFORE INSERT OR UPDATE OR DELETE ON billing.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION billing.check_invoice_line();
--> statement-breakpoint

-- === Payments. The same rule as ADR-027 D2: an attempt is committed before anything leaves, and another
-- is refused while an earlier one could have charged. Charging someone twice is the failure this stops.
CREATE FUNCTION billing.check_new_payment() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE invoice record;
BEGIN
  IF NEW.status <> 'ready' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'PAYMENT_INVALID_START' USING ERRCODE = 'EN803';
  END IF;
  SELECT i.status, i.total_micros, i.currency INTO invoice FROM billing.invoices i
   WHERE i.organization_id = NEW.organization_id AND i.id = NEW.invoice_id FOR SHARE;
  IF invoice.status IS DISTINCT FROM 'open'
     OR invoice.total_micros <> NEW.amount_micros OR invoice.currency <> NEW.currency THEN
    RAISE EXCEPTION 'PAYMENT_DOES_NOT_MATCH_INVOICE' USING ERRCODE = 'EN803';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payments_check_new BEFORE INSERT ON billing.payments
  FOR EACH ROW EXECUTE FUNCTION billing.check_new_payment();
--> statement-breakpoint
CREATE FUNCTION billing.check_payment_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean;
  evidence boolean;
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

  -- Nobody can say a payment worked without the processor having said so, through an attempt's answer,
  -- a reconcile lookup or a verified event.
  IF NEW.status = 'succeeded' THEN
    SELECT EXISTS (
      SELECT 1 FROM billing.payment_attempts a
       WHERE a.organization_id = NEW.organization_id AND a.payment_id = NEW.id
         AND a.outcome = 'succeeded'
    ) OR EXISTS (
      SELECT 1 FROM billing.payment_events e
       WHERE e.organization_id = NEW.organization_id AND e.payment_id = NEW.id
         AND e.kind = 'payment_succeeded' AND e.amount_micros = NEW.amount_micros
    ) INTO evidence;
    IF NOT evidence THEN
      RAISE EXCEPTION 'PAYMENT_NO_EVIDENCE' USING ERRCODE = 'EN803';
    END IF;
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
--> statement-breakpoint
CREATE TRIGGER payments_check_change BEFORE UPDATE ON billing.payments
  FOR EACH ROW EXECUTE FUNCTION billing.check_payment_change();
--> statement-breakpoint
CREATE TRIGGER payments_keep BEFORE DELETE OR TRUNCATE ON billing.payments
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION billing.check_new_payment_attempt() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  payment record;
  may_have_charged boolean;
  last_number integer;
BEGIN
  SELECT p.status, p.idempotency_key INTO payment FROM billing.payments p
   WHERE p.organization_id = NEW.organization_id AND p.id = NEW.payment_id FOR UPDATE;
  IF NOT FOUND OR payment.status <> 'ready' THEN
    RAISE EXCEPTION 'PAYMENT_NOT_READY' USING ERRCODE = 'EN803';
  END IF;
  IF NEW.idempotency_key <> payment.idempotency_key THEN
    RAISE EXCEPTION 'PAYMENT_KEY_MISMATCH' USING ERRCODE = 'EN803';
  END IF;
  SELECT coalesce(bool_or(a.outcome IS NULL OR a.outcome <> 'not_sent'), false),
         coalesce(max(a.attempt_no), 0)
    INTO may_have_charged, last_number
    FROM billing.payment_attempts a
   WHERE a.organization_id = NEW.organization_id AND a.payment_id = NEW.payment_id;
  IF may_have_charged THEN
    RAISE EXCEPTION 'PAYMENT_ATTEMPT_MAY_HAVE_CHARGED' USING ERRCODE = 'EN803';
  END IF;
  IF NEW.attempt_no <> last_number + 1 THEN
    RAISE EXCEPTION 'PAYMENT_ATTEMPT_OUT_OF_ORDER' USING ERRCODE = 'EN803';
  END IF;
  IF NEW.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_ATTEMPT_ALREADY_ANSWERED' USING ERRCODE = 'EN803';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payment_attempts_check_new BEFORE INSERT ON billing.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION billing.check_new_payment_attempt();
--> statement-breakpoint
CREATE FUNCTION billing.check_payment_attempt_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.outcome IS DISTINCT FROM OLD.outcome AND OLD.outcome IS NOT NULL
     AND (OLD.outcome <> 'indeterminate' OR NEW.outcome IS NULL) THEN
    RAISE EXCEPTION 'PAYMENT_OUTCOME_WRITTEN' USING ERRCODE = 'EN803';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payment_attempts_check_change BEFORE UPDATE ON billing.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION billing.check_payment_attempt_change();
--> statement-breakpoint
CREATE TRIGGER payment_attempts_keep BEFORE DELETE OR TRUNCATE ON billing.payment_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- === A tenant's standing. Changing it leaves a record first, in the same transaction, or it does not
-- happen. Once a tenant is gone nothing brings it back, and it only goes by way of a finished erasure.
CREATE FUNCTION billing.check_lifecycle_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.lifecycle = OLD.lifecycle THEN RETURN NEW; END IF;
  IF OLD.lifecycle = 'deleted' THEN
    RAISE EXCEPTION 'TENANT_LIFECYCLE_INVALID' USING ERRCODE = 'EN807';
  END IF;
  IF NEW.lifecycle = 'deleted' AND NOT EXISTS (
    SELECT 1 FROM lifecycle.offboardings o
     WHERE o.organization_id = NEW.id AND o.state IN ('verified','reported')
  ) THEN
    RAISE EXCEPTION 'TENANT_LIFECYCLE_INVALID' USING ERRCODE = 'EN807';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM billing.standing_changes s
     WHERE s.organization_id = NEW.id
       AND s.from_lifecycle = OLD.lifecycle AND s.to_lifecycle = NEW.lifecycle
       AND s.occurred_at = now()
  ) THEN
    RAISE EXCEPTION 'TENANT_LIFECYCLE_UNRECORDED' USING ERRCODE = 'EN807';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organizations_check_lifecycle BEFORE UPDATE ON org.organizations
  FOR EACH ROW EXECUTE FUNCTION billing.check_lifecycle_change();
--> statement-breakpoint

-- === Retention, for the application role. A rule is never edited: changing one supersedes it.
GRANT SELECT, INSERT ON lifecycle.retention_rules TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (superseded_at) ON lifecycle.retention_rules TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON lifecycle.retention_runs TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (examined, removed, held, outcome_code, finished_at) ON lifecycle.retention_runs TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON lifecycle.legal_holds, lifecycle.legal_hold_scopes TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, released_by_membership_id, released_at, release_reason_code, version)
  ON lifecycle.legal_holds TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON lifecycle.offboardings TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, export_offered_at, export_ref, transition_ends_at, connections_revoked_at,
              work_ended_at, actions_settled_at, erasure_started_at, erasure_finished_at, report,
              reported_at, cancelled_at, cancel_reason_code, version, updated_at)
  ON lifecycle.offboardings TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON lifecycle.erasure_log TO ensemus_app;
--> statement-breakpoint
CREATE TRIGGER erasure_log_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.erasure_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER legal_hold_scopes_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.legal_hold_scopes
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER legal_holds_keep BEFORE DELETE OR TRUNCATE ON lifecycle.legal_holds
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION lifecycle.check_retention_rule() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'RETENTION_RULE_SUPERSEDED' USING ERRCODE = 'EN804';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER retention_rules_check_change BEFORE UPDATE ON lifecycle.retention_rules
  FOR EACH ROW EXECUTE FUNCTION lifecycle.check_retention_rule();
--> statement-breakpoint

-- A hold, once released, stays released. A new matter is a new hold, so the record of each stays true.
CREATE FUNCTION lifecycle.check_legal_hold_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'released' THEN
    RAISE EXCEPTION 'LEGAL_HOLD_RELEASED' USING ERRCODE = 'EN804';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER legal_holds_check_change BEFORE UPDATE ON lifecycle.legal_holds
  FOR EACH ROW EXECUTE FUNCTION lifecycle.check_legal_hold_change();
--> statement-breakpoint

-- Whether something is under a hold that existed at `at`. A deletion that came before the hold is a past
-- fact, so a restore can still re-apply it from the tombstone ledger (ADR-026, ADR-032 D6).
CREATE FUNCTION lifecycle.target_is_held(p_org uuid, p_type text, p_id uuid, p_at timestamptz)
  RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  WITH targets AS (
    SELECT 'organization'::text AS scope_type, NULL::uuid AS scope_id
    UNION ALL SELECT p_type, p_id
    UNION ALL
    SELECT 'work_unit', wa.work_unit_id
      FROM work.work_artifacts wa
     WHERE p_type = 'artifact' AND wa.organization_id = p_org AND wa.artifact_id = p_id
    UNION ALL
    SELECT 'project', w.project_id
      FROM work.work_artifacts wa
      JOIN work.work_units w ON w.organization_id = wa.organization_id AND w.id = wa.work_unit_id
     WHERE p_type = 'artifact' AND wa.organization_id = p_org AND wa.artifact_id = p_id
       AND w.project_id IS NOT NULL
    UNION ALL
    SELECT 'client', p.client_id
      FROM work.work_artifacts wa
      JOIN work.work_units w ON w.organization_id = wa.organization_id AND w.id = wa.work_unit_id
      JOIN work.projects p ON p.organization_id = w.organization_id AND p.id = w.project_id
     WHERE p_type = 'artifact' AND wa.organization_id = p_org AND wa.artifact_id = p_id
       AND p.client_id IS NOT NULL
    UNION ALL
    SELECT 'client', p.client_id
      FROM work.projects p
     WHERE p_type = 'project' AND p.organization_id = p_org AND p.id = p_id
       AND p.client_id IS NOT NULL
  )
  SELECT EXISTS (
    SELECT 1
      FROM lifecycle.legal_holds h
      JOIN lifecycle.legal_hold_scopes s
        ON s.organization_id = h.organization_id AND s.hold_id = h.id
      JOIN targets t
        ON t.scope_type = s.scope_type AND t.scope_id IS NOT DISTINCT FROM s.scope_id
     WHERE h.organization_id = p_org AND h.status = 'active' AND h.placed_at <= p_at
  )
$$;
--> statement-breakpoint

-- Below the application, so every way of deleting something meets it, including ones not written yet.
-- The tombstone is the first thing every deletion writes (LIFE-01), so that is where this stands.
CREATE FUNCTION lifecycle.refuse_held_tombstone() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF lifecycle.target_is_held(NEW.organization_id, NEW.target_type, NEW.target_id, NEW.created_at) THEN
    RAISE EXCEPTION 'LEGAL_HOLD_ACTIVE' USING ERRCODE = 'EN804';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER tombstones_refuse_held BEFORE INSERT ON platform.tombstones
  FOR EACH ROW EXECUTE FUNCTION lifecycle.refuse_held_tombstone();
--> statement-breakpoint

-- Rows that can be deleted directly. The eraser has its own, stricter check in its policy below, and
-- cannot read the tables this looks in, so it does not come through here.
CREATE FUNCTION lifecycle.refuse_held_delete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE deleted_before timestamptz;
BEGIN
  IF current_user = 'ensemus_eraser' THEN RETURN OLD; END IF;
  SELECT t.created_at INTO deleted_before FROM platform.tombstones t
   WHERE t.organization_id = OLD.organization_id AND t.target_type = TG_ARGV[0] AND t.target_id = OLD.id;
  IF lifecycle.target_is_held(OLD.organization_id, TG_ARGV[0], OLD.id, coalesce(deleted_before, now())) THEN
    RAISE EXCEPTION 'LEGAL_HOLD_ACTIVE' USING ERRCODE = 'EN804';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER artifacts_refuse_held BEFORE DELETE ON work.artifacts
  FOR EACH ROW EXECUTE FUNCTION lifecycle.refuse_held_delete('artifact');
--> statement-breakpoint
CREATE TRIGGER clients_refuse_held BEFORE DELETE ON work.clients
  FOR EACH ROW EXECUTE FUNCTION lifecycle.refuse_held_delete('client');
--> statement-breakpoint
CREATE TRIGGER projects_refuse_held BEFORE DELETE ON work.projects
  FOR EACH ROW EXECUTE FUNCTION lifecycle.refuse_held_delete('project');
--> statement-breakpoint

-- === Offboarding. The last step cannot be undone, so nothing reaches it by accident, and a hold anywhere
-- in the tenant stops it until a person releases that hold (ADR-032 D7).
CREATE FUNCTION lifecycle.check_offboarding_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE allowed boolean;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  allowed := CASE OLD.state
    WHEN 'requested' THEN NEW.state IN ('export_offered','cancelled')
    WHEN 'export_offered' THEN NEW.state IN ('in_transition','cancelled')
    WHEN 'in_transition' THEN NEW.state IN ('winding_down','cancelled')
    WHEN 'winding_down' THEN NEW.state IN ('ready_for_erasure','cancelled')
    WHEN 'ready_for_erasure' THEN NEW.state IN ('erasing','cancelled')
    WHEN 'erasing' THEN NEW.state = 'verified'
    WHEN 'verified' THEN NEW.state = 'reported'
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'OFFBOARDING_INVALID_TRANSITION' USING ERRCODE = 'EN805';
  END IF;
  IF NEW.state = 'erasing' THEN
    IF OLD.export_offered_at IS NULL OR OLD.connections_revoked_at IS NULL
       OR OLD.work_ended_at IS NULL OR OLD.actions_settled_at IS NULL THEN
      RAISE EXCEPTION 'OFFBOARDING_STEPS_INCOMPLETE' USING ERRCODE = 'EN805';
    END IF;
    IF OLD.transition_ends_at IS NULL OR OLD.transition_ends_at > now() THEN
      RAISE EXCEPTION 'OFFBOARDING_TRANSITION_NOT_OVER' USING ERRCODE = 'EN805';
    END IF;
    IF EXISTS (
      SELECT 1 FROM lifecycle.legal_holds h
       WHERE h.organization_id = NEW.organization_id AND h.status = 'active'
    ) THEN
      RAISE EXCEPTION 'LEGAL_HOLD_ACTIVE' USING ERRCODE = 'EN804';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER offboardings_check_change BEFORE UPDATE ON lifecycle.offboardings
  FOR EACH ROW EXECUTE FUNCTION lifecycle.check_offboarding_change();
--> statement-breakpoint
CREATE TRIGGER offboardings_keep BEFORE DELETE OR TRUNCATE ON lifecycle.offboardings
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- A hold placed after erasing starts has to stop it too, so hold rows and state are read per row.
CREATE FUNCTION lifecycle.erasure_open(p_org uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  SELECT EXISTS (
           SELECT 1 FROM lifecycle.offboardings o
            WHERE o.organization_id = p_org AND o.state = 'erasing'
         )
     AND NOT EXISTS (
           SELECT 1 FROM lifecycle.legal_holds h
            WHERE h.organization_id = p_org AND h.status = 'active'
         )
$$;
--> statement-breakpoint
GRANT SELECT (organization_id, state) ON lifecycle.offboardings TO ensemus_eraser;
--> statement-breakpoint
GRANT SELECT (organization_id, status) ON lifecycle.legal_holds TO ensemus_eraser;
--> statement-breakpoint
CREATE POLICY eraser_read ON lifecycle.offboardings FOR SELECT TO ensemus_eraser
  USING (organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY eraser_read ON lifecycle.legal_holds FOR SELECT TO ensemus_eraser
  USING (organization_id = app.current_organization_id());
--> statement-breakpoint

-- What the eraser reaches: every tenant table holding customer content, in whatever schemas exist when
-- this runs, which is why this milestone's migrations come last. It can delete and count, and can read
-- only the tenant column, so it never sees what it removes. Billing records, audit, tombstones, events
-- and the erasure log stay: they are the retained exceptions the report names (LIFE-04). A test compares
-- this set with every tenant table, so a table added later cannot go unnoticed.
CREATE FUNCTION lifecycle.retained_table(p_schema text, p_table text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $$
  SELECT p_schema IN ('identity','app','billing','governance','lifecycle','operations','public','drizzle')
      OR (p_schema = 'platform' AND p_table NOT IN ('notifications','idempotency_keys'))
      OR (p_schema = 'support' AND p_table IN ('coverage_schedules','break_glass_requests','break_glass_log'))
$$;
--> statement-breakpoint
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT DISTINCT c.table_schema, c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables b USING (table_schema, table_name)
     WHERE c.column_name = 'organization_id'
       AND b.table_type = 'BASE TABLE'
       AND c.table_schema NOT LIKE 'pg\_%'
       AND c.table_schema <> 'information_schema'
       AND NOT lifecycle.retained_table(c.table_schema::text, c.table_name::text)
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO ensemus_eraser', t.table_schema);
    EXECUTE format('GRANT SELECT (organization_id), DELETE ON %I.%I TO ensemus_eraser', t.table_schema, t.table_name);
    EXECUTE format(
      'CREATE POLICY eraser_delete ON %I.%I TO ensemus_eraser '
      'USING (organization_id = app.current_organization_id() AND lifecycle.erasure_open(organization_id))',
      t.table_schema, t.table_name);
  END LOOP;
END $$;
--> statement-breakpoint

-- The one change to an existing rule. Append-only tables refuse every role but this one, because a
-- finished erasure has to reach them too. The grants above decide which tables that is, and audit has
-- its own function, which this leaves alone.
CREATE OR REPLACE FUNCTION app.reject_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF current_user = 'ensemus_eraser' AND TG_OP = 'DELETE' THEN RETURN NULL; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
--> statement-breakpoint

-- === Support. The application role is the customer's side. `ensemus_support` is the desk's, and reaches
-- nothing else in the database, which is what "no default access to content" rests on (OPS-22, OPS-24).
GRANT SELECT ON support.coverage_schedules TO ensemus_app, ensemus_support;
--> statement-breakpoint
CREATE POLICY published_read ON support.coverage_schedules FOR SELECT TO ensemus_app, ensemus_support
  USING (status = 'approved');
--> statement-breakpoint
GRANT SELECT, INSERT ON support.coverage_schedules TO ensemus_operator;
--> statement-breakpoint
GRANT UPDATE (status, approved_by, approved_at, retired_at) ON support.coverage_schedules TO ensemus_operator;
--> statement-breakpoint
CREATE POLICY operator_all ON support.coverage_schedules TO ensemus_operator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER coverage_schedules_check_change BEFORE UPDATE ON support.coverage_schedules
  FOR EACH ROW EXECUTE FUNCTION billing.check_published_change();
--> statement-breakpoint
GRANT SELECT, INSERT ON support.tickets TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, resolved_at, version, updated_at) ON support.tickets TO ensemus_app;
--> statement-breakpoint
GRANT SELECT ON support.tickets TO ensemus_support;
--> statement-breakpoint
GRANT UPDATE (status, first_response_at, resolved_at, version, updated_at) ON support.tickets TO ensemus_support;
--> statement-breakpoint
CREATE POLICY desk_read ON support.tickets TO ensemus_support USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT ON support.ticket_messages TO ensemus_app, ensemus_support;
--> statement-breakpoint
CREATE POLICY customer_read ON support.ticket_messages FOR SELECT TO ensemus_app
  USING (organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY customer_write ON support.ticket_messages FOR INSERT TO ensemus_app
  WITH CHECK (organization_id = app.current_organization_id() AND author_kind = 'customer');
--> statement-breakpoint
CREATE POLICY desk_read ON support.ticket_messages FOR SELECT TO ensemus_support USING (true);
--> statement-breakpoint
CREATE POLICY desk_write ON support.ticket_messages FOR INSERT TO ensemus_support
  WITH CHECK (author_kind = 'support');
--> statement-breakpoint
CREATE TRIGGER ticket_messages_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON support.ticket_messages
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- Break-glass: a record of who asked, who agreed and until when. M8 gives no way to use it. No role gets
-- a read path to customer content from this, and adding one is a reviewed change of its own (ADR-032 D8).
GRANT SELECT ON support.break_glass_requests, support.break_glass_log TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, customer_authorizer_membership_id, customer_authorized_at, authorized_from,
              expires_at, closed_at, closed_by, version)
  ON support.break_glass_requests TO ensemus_app;
--> statement-breakpoint
GRANT INSERT ON support.break_glass_log TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON support.break_glass_requests, support.break_glass_log TO ensemus_support;
--> statement-breakpoint
CREATE POLICY desk_read ON support.break_glass_requests FOR SELECT TO ensemus_support USING (true);
--> statement-breakpoint
CREATE POLICY desk_request ON support.break_glass_requests FOR INSERT TO ensemus_support
  WITH CHECK (state = 'requested' AND operator_authorizer IS NULL AND customer_authorizer_membership_id IS NULL
              AND authorized_from IS NULL AND expires_at IS NULL);
--> statement-breakpoint
CREATE POLICY desk_read ON support.break_glass_log FOR SELECT TO ensemus_support USING (true);
--> statement-breakpoint
CREATE POLICY desk_write ON support.break_glass_log FOR INSERT TO ensemus_support WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT ON support.break_glass_requests, support.break_glass_log TO ensemus_operator;
--> statement-breakpoint
GRANT UPDATE (state, operator_authorizer, operator_authorized_at, authorized_from, expires_at, closed_at,
              closed_by, version)
  ON support.break_glass_requests TO ensemus_operator;
--> statement-breakpoint
GRANT INSERT ON support.break_glass_log TO ensemus_operator;
--> statement-breakpoint
CREATE POLICY operator_all ON support.break_glass_requests TO ensemus_operator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY operator_all ON support.break_glass_log TO ensemus_operator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER break_glass_log_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON support.break_glass_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER break_glass_requests_keep BEFORE DELETE OR TRUNCATE ON support.break_glass_requests
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION support.check_break_glass_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE allowed boolean;
BEGIN
  IF NEW.state = OLD.state THEN
    -- Each authorizer signs once, and only while it is still a request. Nothing else moves at all.
    IF OLD.state <> 'requested'
       AND (NEW.operator_authorizer IS DISTINCT FROM OLD.operator_authorizer
            OR NEW.customer_authorizer_membership_id IS DISTINCT FROM OLD.customer_authorizer_membership_id
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
            OR NEW.authorized_from IS DISTINCT FROM OLD.authorized_from) THEN
      RAISE EXCEPTION 'BREAK_GLASS_IMMUTABLE' USING ERRCODE = 'EN806';
    END IF;
    RETURN NEW;
  END IF;
  allowed := CASE OLD.state
    WHEN 'requested' THEN NEW.state IN ('authorized','denied','expired')
    WHEN 'authorized' THEN NEW.state IN ('revoked','expired')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'BREAK_GLASS_INVALID_TRANSITION' USING ERRCODE = 'EN806';
  END IF;
  IF NEW.state = 'authorized' THEN
    IF NEW.operator_authorizer IS NULL OR NEW.operator_authorizer = NEW.requested_by
       OR NEW.operator_authorized_at IS NULL
       OR NEW.customer_authorizer_membership_id IS NULL OR NEW.customer_authorized_at IS NULL THEN
      RAISE EXCEPTION 'BREAK_GLASS_NEEDS_TWO_AUTHORIZERS' USING ERRCODE = 'EN806';
    END IF;
    IF NEW.authorized_from IS NULL OR NEW.expires_at IS NULL
       OR NEW.expires_at > NEW.authorized_from + make_interval(mins => NEW.requested_minutes) THEN
      RAISE EXCEPTION 'BREAK_GLASS_NEEDS_TIME_LIMIT' USING ERRCODE = 'EN806';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER break_glass_requests_check_change BEFORE UPDATE ON support.break_glass_requests
  FOR EACH ROW EXECUTE FUNCTION support.check_break_glass_change();
--> statement-breakpoint

-- === Incidents. The public can see what was published about the service, and nothing else, with no tenant
-- bound. A drill is never published (the check on the table). Reports of vulnerabilities are operator-only.
GRANT SELECT (id, severity, state, origin, provider_kind, public_title, started_at, resolved_at, updated_at)
  ON operations.incidents TO ensemus_app;
--> statement-breakpoint
CREATE POLICY published_read ON operations.incidents FOR SELECT TO ensemus_app USING (published);
--> statement-breakpoint
GRANT SELECT ON operations.incident_updates TO ensemus_app;
--> statement-breakpoint
CREATE POLICY published_read ON operations.incident_updates FOR SELECT TO ensemus_app
  USING (EXISTS (SELECT 1 FROM operations.incidents i WHERE i.id = incident_id AND i.published));
--> statement-breakpoint
GRANT SELECT, INSERT ON operations.incidents, operations.incident_updates, operations.drills,
                        operations.vulnerability_reports
  TO ensemus_operator;
--> statement-breakpoint
GRANT UPDATE (severity, state, origin, provider_kind, public_title, published, commander_ref,
              security_lead_ref, infrastructure_lead_ref, communications_ref, legal_ref, postmortem_ref,
              resolved_at, version, updated_at)
  ON operations.incidents TO ensemus_operator;
--> statement-breakpoint
GRANT UPDATE (roles, evidence_ref, outcome, finished_at) ON operations.drills TO ensemus_operator;
--> statement-breakpoint
GRANT UPDATE (severity, state, fixed_in_ref, acknowledged_at, disclosed_at, version, updated_at)
  ON operations.vulnerability_reports TO ensemus_operator;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['incidents','incident_updates','drills','vulnerability_reports']
  LOOP
    EXECUTE format('CREATE POLICY operator_all ON operations.%I TO ensemus_operator USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER incident_updates_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON operations.incident_updates
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
