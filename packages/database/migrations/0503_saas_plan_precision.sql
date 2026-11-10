-- Explicit approved currency precision. No legacy BYOM exponent is invented.
-- Security SQL requires human review before application. The journal is stitched by the integrator.
ALTER TABLE billing.plan_versions ADD COLUMN minor_unit_exponent integer;
--> statement-breakpoint
ALTER TABLE billing.plan_versions ADD CONSTRAINT plan_versions_precision
  CHECK (minor_unit_exponent IS NULL OR minor_unit_exponent BETWEEN 0 AND 4);
--> statement-breakpoint
-- The migration transaction holds this lock while temporarily allowing its owner to copy already
-- approved card precision. No runtime role gains a policy, and published terms remain immutable.
LOCK TABLE billing.plan_versions IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE POLICY precision_backfill_migrator ON billing.plan_versions TO ensemus_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY precision_backfill_migrator ON billing.rate_cards FOR SELECT TO ensemus_migrator USING (true);
--> statement-breakpoint
CREATE POLICY precision_backfill_migrator ON billing.plans FOR SELECT TO ensemus_migrator USING (true);
--> statement-breakpoint
ALTER TABLE billing.plan_versions DISABLE TRIGGER plan_versions_check_change;
--> statement-breakpoint
UPDATE billing.plan_versions v SET minor_unit_exponent = c.minor_unit_exponent
  FROM billing.rate_cards c, billing.plans p WHERE p.id = v.plan_id AND p.commercial_mode = 'cloud'
    AND c.id = v.rate_card_id AND c.currency = v.currency
    AND c.status IN ('approved','retired') AND v.minor_unit_exponent IS NULL;
--> statement-breakpoint
ALTER TABLE billing.plan_versions ENABLE TRIGGER plan_versions_check_change;
--> statement-breakpoint
DROP POLICY precision_backfill_migrator ON billing.plan_versions;
--> statement-breakpoint
DROP POLICY precision_backfill_migrator ON billing.rate_cards;
--> statement-breakpoint
DROP POLICY precision_backfill_migrator ON billing.plans;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION billing.check_plan_approval() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE plan_mode text;
DECLARE card record;
BEGIN
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    IF NEW.minor_unit_exponent IS NULL THEN
      RAISE EXCEPTION 'CURRENCY_PRECISION_REQUIRED' USING ERRCODE = 'EN801';
    END IF;
    SELECT p.commercial_mode INTO plan_mode FROM billing.plans p WHERE p.id = NEW.plan_id;
    IF plan_mode = 'byom' THEN
      IF NEW.included_microcredits IS NOT NULL OR NEW.rate_card_id IS NOT NULL OR NEW.overage_policy IS NOT NULL THEN
        RAISE EXCEPTION 'BYOM_PLAN_BILLS_NO_INFERENCE' USING ERRCODE = 'EN801';
      END IF;
    ELSE
      IF NEW.included_microcredits IS NULL OR NEW.rate_card_id IS NULL OR NEW.overage_policy IS NULL THEN
        RAISE EXCEPTION 'CLOUD_PLAN_NEEDS_RATE_CARD' USING ERRCODE = 'EN801';
      END IF;
      SELECT c.status,c.currency,c.minor_unit_exponent INTO card FROM billing.rate_cards c WHERE c.id=NEW.rate_card_id;
      IF card.status IS DISTINCT FROM 'approved' OR card.currency <> NEW.currency OR card.minor_unit_exponent <> NEW.minor_unit_exponent THEN
        RAISE EXCEPTION 'RATE_CARD_NOT_APPROVED' USING ERRCODE = 'EN801';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER plan_versions_check_approval ON billing.plan_versions;
--> statement-breakpoint
CREATE TRIGGER plan_versions_check_approval BEFORE INSERT OR UPDATE ON billing.plan_versions
  FOR EACH ROW EXECUTE FUNCTION billing.check_plan_approval();
--> statement-breakpoint
CREATE FUNCTION billing.check_invoice_precision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE precision_value integer;
BEGIN
  IF NEW.status='open' AND OLD.status='draft' THEN
    IF NEW.kind='subscription' THEN
      SELECT v.minor_unit_exponent INTO precision_value FROM billing.plan_versions v WHERE v.id=NEW.plan_version_id;
    ELSE
      SELECT c.minor_unit_exponent INTO precision_value FROM billing.rate_cards c WHERE c.id=NEW.rate_card_id;
    END IF;
    IF precision_value IS NULL OR mod(NEW.total_micros, (1000000::numeric / power(10::numeric,precision_value))::bigint) <> 0 THEN
      RAISE EXCEPTION 'CURRENCY_PRECISION_REQUIRED' USING ERRCODE = 'EN802';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_check_precision BEFORE UPDATE ON billing.invoices FOR EACH ROW EXECUTE FUNCTION billing.check_invoice_precision();
