-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Only the opt-in operator login may progress review decisions. The old comparison named the web
-- role alone, so a newly separated worker or agent login could bypass its branch while inheriting
-- the same tenant-scoped write grants. No runtime login becomes an operator through inheritance.
CREATE OR REPLACE FUNCTION marketplace.check_submission_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean;
  decided boolean;
BEGIN
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'MARKETPLACE_SUBMISSION_STALE_WRITE' USING ERRCODE = 'ES001';
  END IF;
  IF NEW.delist_requested_at IS DISTINCT FROM OLD.delist_requested_at
     AND (OLD.delist_requested_at IS NOT NULL OR NEW.state <> 'approved') THEN
    RAISE EXCEPTION 'MARKETPLACE_DELIST_REQUEST_NOT_ALLOWED' USING ERRCODE = 'ES001';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  allowed := CASE OLD.state
    WHEN 'submitted' THEN NEW.state IN ('in_review', 'rejected', 'withdrawn')
    WHEN 'in_review' THEN NEW.state IN ('approved', 'rejected', 'withdrawn')
    WHEN 'approved' THEN NEW.state IN ('withdrawn')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'MARKETPLACE_SUBMISSION_INVALID_TRANSITION' USING ERRCODE = 'ES001';
  END IF;
  IF current_user <> 'ensemus_marketplace' AND NEW.state <> 'withdrawn' THEN
    RAISE EXCEPTION 'MARKETPLACE_DECISION_NOT_ALLOWED' USING ERRCODE = 'ES005';
  END IF;
  IF NEW.state = 'withdrawn' AND EXISTS (
    SELECT 1 FROM marketplace.listings l
     WHERE l.publisher_organization_id = NEW.organization_id AND l.submission_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_ALREADY_LISTED' USING ERRCODE = 'ES005';
  END IF;
  -- A decision needs the decision's record, of exactly these bytes, written first.
  IF NEW.state IN ('approved', 'rejected') THEN
    SELECT EXISTS (
      SELECT 1 FROM marketplace.security_reviews r
       WHERE r.submission_organization_id = NEW.organization_id
         AND r.submission_id = NEW.id
         AND r.digest = NEW.digest
         AND r.verdict = NEW.state
    ) INTO decided;
    IF NOT decided THEN
      RAISE EXCEPTION 'MARKETPLACE_DECISION_WITHOUT_REVIEW' USING ERRCODE = 'ES005';
    END IF;
  END IF;
  RETURN NEW;
END $$;
