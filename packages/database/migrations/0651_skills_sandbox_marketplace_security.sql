-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-034). Changes here need human review, never agent approval.
-- ADR-034 marks this file for outside security review. It has not had one. Nothing here is real until it
-- has run against real roles, and in the build that wrote it, it has not run at all.

-- The foreign key Drizzle's types cannot follow, because the tables refer to each other in a circle.
ALTER TABLE skills.packages
  ADD CONSTRAINT skill_packages_listing_fk FOREIGN KEY (listing_id) REFERENCES marketplace.listings (id);
--> statement-breakpoint

-- Forced RLS and the tenant policy on every tenant table. A test fails if one misses it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname IN ('skills', 'sandbox')
       OR (schemaname = 'marketplace' AND tablename IN ('publishers', 'submissions', 'installations'))
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format(
      'CREATE POLICY tenant_scoped ON %I.%I TO ensemus_app '
      'USING (organization_id = app.current_organization_id()) '
      'WITH CHECK (organization_id = app.current_organization_id())',
      t.schemaname, t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

-- These two are global on purpose, so they get forced RLS with narrower policies. A tenant reads what is
-- listed, what it published, and what it installed, and only ever with a tenant bound. It writes neither.
ALTER TABLE marketplace.listings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE marketplace.listings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE marketplace.security_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE marketplace.security_reviews FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY listings_visible ON marketplace.listings FOR SELECT TO ensemus_app
  USING (
    app.current_organization_id() IS NOT NULL
    AND (
      state = 'listed'
      OR publisher_organization_id = app.current_organization_id()
      OR EXISTS (
        SELECT 1 FROM marketplace.installations i
         WHERE i.organization_id = app.current_organization_id() AND i.listing_id = listings.id
      )
    )
  );
--> statement-breakpoint
CREATE POLICY reviews_of_own_submissions ON marketplace.security_reviews FOR SELECT TO ensemus_app
  USING (submission_organization_id = app.current_organization_id());
--> statement-breakpoint

-- What the shared application role may do. The dispatcher and the secrets role get nothing here.
GRANT USAGE ON SCHEMA skills, sandbox, marketplace TO ensemus_app;
--> statement-breakpoint

-- A key is never edited, only revoked. Nobody can read a private key here, because none is ever stored.
GRANT SELECT, INSERT ON skills.trusted_signers TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, revoked_at, revoked_by_membership_id, version)
  ON skills.trusted_signers TO ensemus_app;
--> statement-breakpoint

-- Where a package came from is fixed.
GRANT SELECT, INSERT ON skills.packages TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (display_name, state, content_classification, owner_membership_id, version, updated_at)
  ON skills.packages TO ensemus_app;
--> statement-breakpoint

-- Where the bytes are, their hash and who uploaded them can never change, by any application code.
GRANT SELECT, INSERT ON skills.package_versions TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, semver, digest, manifest, execution_kind, license, max_classification,
              signer_key_id, signature, verified_at, published_by_membership_id, published_at,
              yanked_by_membership_id, yanked_at, reject_code, yank_code, version, updated_at)
  ON skills.package_versions TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON skills.test_runs TO ensemus_app;
--> statement-breakpoint

-- What a run was asked to do, its input and its policy, can never change.
GRANT SELECT, INSERT ON sandbox.runs TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, outcome_code, attempts, exit_code, wall_ms, cpu_ms, peak_memory_kb, stdout_bytes,
              stderr_bytes, output, output_sha256, isolation_probe_passed_at, runtime_name,
              runtime_version, cancel_requested_at, version, started_at, finished_at, updated_at)
  ON sandbox.runs TO ensemus_app;
--> statement-breakpoint

-- A publisher can name itself, and cannot lift its own suspension.
GRANT SELECT, INSERT ON marketplace.publishers TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (display_name, version, updated_at) ON marketplace.publishers TO ensemus_app;
--> statement-breakpoint

-- A publisher can only withdraw, or ask for a delisting. The trigger below holds that for state.
GRANT SELECT, INSERT ON marketplace.submissions TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, withdrawn_by_membership_id, delist_requested_at, version, updated_at)
  ON marketplace.submissions TO ensemus_app;
--> statement-breakpoint
GRANT SELECT ON marketplace.security_reviews, marketplace.listings TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON marketplace.installations TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, package_id, skill_version_id, removed_by_membership_id, failure_code, version,
              updated_at, removed_at)
  ON marketplace.installations TO ensemus_app;
--> statement-breakpoint

-- Records, kept as written, for everyone including the owner. A delete has no path in application code.
CREATE TRIGGER skill_test_runs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON skills.test_runs
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER marketplace_reviews_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON marketplace.security_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER trusted_signers_keep
  BEFORE DELETE OR TRUNCATE ON skills.trusted_signers
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER skill_versions_keep
  BEFORE DELETE OR TRUNCATE ON skills.package_versions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER sandbox_runs_keep
  BEFORE DELETE OR TRUNCATE ON sandbox.runs
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER marketplace_submissions_keep
  BEFORE DELETE OR TRUNCATE ON marketplace.submissions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER marketplace_listings_keep
  BEFORE DELETE OR TRUNCATE ON marketplace.listings
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER marketplace_installations_keep
  BEFORE DELETE OR TRUNCATE ON marketplace.installations
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- A revoked key stays revoked. Trusting it again would mean trusting everything it ever signed.
CREATE FUNCTION skills.check_signer_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.state = 'revoked' AND NEW.state <> 'revoked' THEN
    RAISE EXCEPTION 'SKILL_SIGNER_REVOKED_FOR_GOOD' USING ERRCODE = 'ES001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trusted_signers_check_change
  BEFORE UPDATE ON skills.trusted_signers
  FOR EACH ROW EXECUTE FUNCTION skills.check_signer_change();
--> statement-breakpoint

-- A new version starts at the start, knowing only its bytes. A tenant's own upload always names who did
-- it, because the two-person rule on publishing is only worth anything if that cannot be left blank.
CREATE FUNCTION skills.check_new_version() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE package_origin text;
BEGIN
  SELECT p.origin INTO package_origin
    FROM skills.packages p
   WHERE p.organization_id = NEW.organization_id AND p.id = NEW.package_id;
  IF package_origin = 'tenant' AND NEW.uploaded_by_membership_id IS NULL THEN
    RAISE EXCEPTION 'SKILL_VERSION_INVALID_START' USING ERRCODE = 'ES001';
  END IF;
  IF NEW.state <> 'uploaded' OR NEW.version <> 1
     OR NEW.semver IS NOT NULL OR NEW.digest IS NOT NULL OR NEW.manifest IS NOT NULL
     OR NEW.execution_kind IS NOT NULL OR NEW.license IS NOT NULL
     OR NEW.max_classification IS NOT NULL OR NEW.signer_key_id IS NOT NULL
     OR NEW.signature IS NOT NULL OR NEW.verified_at IS NOT NULL
     OR NEW.published_by_membership_id IS NOT NULL OR NEW.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'SKILL_VERSION_INVALID_START' USING ERRCODE = 'ES001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER skill_versions_check_new
  BEFORE INSERT ON skills.package_versions
  FOR EACH ROW EXECUTE FUNCTION skills.check_new_version();
--> statement-breakpoint

-- The state machine, and "signed, tested and versioned" as a rule of the table rather than of the code,
-- because the web and the worker share a role. The transitions match SKILL_VERSION_TRANSITIONS in
-- @ensemus/domain/skill, and a test holds the two together. Reasons are in ADR-034 D1.
CREATE FUNCTION skills.check_version_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean;
  pkg record;
  signer_ok boolean;
  tested boolean;
BEGIN
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'SKILL_VERSION_STALE_WRITE' USING ERRCODE = 'ES001';
  END IF;

  -- What was learned from the bundle is written once, on the way to verified, and never again.
  IF (NEW.semver IS DISTINCT FROM OLD.semver
      OR NEW.digest IS DISTINCT FROM OLD.digest
      OR NEW.manifest IS DISTINCT FROM OLD.manifest
      OR NEW.execution_kind IS DISTINCT FROM OLD.execution_kind
      OR NEW.license IS DISTINCT FROM OLD.license
      OR NEW.max_classification IS DISTINCT FROM OLD.max_classification
      OR NEW.signer_key_id IS DISTINCT FROM OLD.signer_key_id
      OR NEW.signature IS DISTINCT FROM OLD.signature)
     AND NOT (OLD.state = 'verifying' AND NEW.state = 'verified') THEN
    RAISE EXCEPTION 'SKILL_VERSION_IMMUTABLE' USING ERRCODE = 'ES002';
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.state
    WHEN 'uploaded' THEN NEW.state IN ('verifying', 'rejected')
    WHEN 'verifying' THEN NEW.state IN ('verified', 'rejected')
    WHEN 'verified' THEN NEW.state IN ('published', 'yanked')
    WHEN 'published' THEN NEW.state IN ('yanked')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'SKILL_VERSION_INVALID_TRANSITION' USING ERRCODE = 'ES001';
  END IF;

  IF NEW.state IN ('verified', 'published') THEN
    SELECT p.state, p.origin, p.listing_id INTO pkg
      FROM skills.packages p
     WHERE p.organization_id = NEW.organization_id AND p.id = NEW.package_id;

    -- Signed by a key this tenant trusts, or attested through a listing it can still see.
    IF pkg.origin = 'tenant' THEN
      SELECT EXISTS (
        SELECT 1 FROM skills.trusted_signers s
         WHERE s.organization_id = NEW.organization_id
           AND s.key_id = NEW.signer_key_id
           AND s.state = 'active'
      ) INTO signer_ok;
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM marketplace.listings l
         WHERE l.id = pkg.listing_id
           AND l.digest = NEW.digest
           AND l.signer_key_id = NEW.signer_key_id
           AND l.signature = NEW.signature
           AND coalesce(l.delist_mode, 'none') <> 'revoke'
      ) INTO signer_ok;
    END IF;
    IF NOT signer_ok THEN
      RAISE EXCEPTION 'SKILL_VERSION_SIGNER_NOT_TRUSTED' USING ERRCODE = 'ES003';
    END IF;

    -- Tested, on exactly these bytes, in the way this kind of package has to be.
    SELECT EXISTS (
      SELECT 1 FROM skills.test_runs r
       WHERE r.organization_id = NEW.organization_id
         AND r.skill_version_id = NEW.id
         AND r.digest = NEW.digest
         AND r.outcome = 'passed'
         AND r.mode = CASE NEW.execution_kind WHEN 'sandbox' THEN 'sandbox' ELSE 'contract' END
    ) INTO tested;
    IF NOT tested THEN
      RAISE EXCEPTION 'SKILL_VERSION_NOT_TESTED' USING ERRCODE = 'ES003';
    END IF;
  END IF;

  IF NEW.state = 'published' AND pkg.state <> 'active' THEN
    RAISE EXCEPTION 'SKILL_PACKAGE_NOT_ACTIVE' USING ERRCODE = 'ES003';
  END IF;

  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER skill_versions_check_change
  BEFORE UPDATE ON skills.package_versions
  FOR EACH ROW EXECUTE FUNCTION skills.check_version_change();
--> statement-breakpoint

-- A new run starts queued, for a version that can run, with data that version may be given. The data
-- class check on the table already refuses restricted.
CREATE FUNCTION sandbox.check_new_run() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE v record;
BEGIN
  IF NEW.status <> 'queued' OR NEW.version <> 1 OR NEW.attempts <> 0 OR NEW.output IS NOT NULL
     OR NEW.outcome_code IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'SANDBOX_RUN_INVALID_START' USING ERRCODE = 'ES001';
  END IF;
  SELECT pv.state, pv.digest, pv.execution_kind, pv.max_classification, p.state AS package_state
    INTO v
    FROM skills.package_versions pv
    JOIN skills.packages p ON p.organization_id = pv.organization_id AND p.id = pv.package_id
   WHERE pv.organization_id = NEW.organization_id AND pv.id = NEW.skill_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SANDBOX_RUN_SKILL_NOT_USABLE' USING ERRCODE = 'ES003';
  END IF;
  -- A version's own tests run while it is being verified, before it has a digest on its row.
  IF NEW.purpose = 'skill_test' THEN
    IF v.state <> 'verifying' THEN
      RAISE EXCEPTION 'SANDBOX_RUN_SKILL_NOT_USABLE' USING ERRCODE = 'ES003';
    END IF;
    RETURN NEW;
  END IF;
  -- Someone may try a verified version by hand before publishing it. Nothing else runs unpublished.
  IF NOT (v.state = 'published' OR (NEW.purpose = 'operator_test' AND v.state = 'verified'))
     OR v.package_state <> 'active'
     OR v.execution_kind <> 'sandbox'
     OR v.digest <> NEW.digest THEN
    RAISE EXCEPTION 'SANDBOX_RUN_SKILL_NOT_USABLE' USING ERRCODE = 'ES003';
  END IF;
  IF array_position(ARRAY['public', 'internal', 'confidential'], NEW.classification)
     > array_position(ARRAY['public', 'internal', 'confidential'], v.max_classification) THEN
    RAISE EXCEPTION 'SANDBOX_RUN_CLASSIFICATION_NOT_ALLOWED' USING ERRCODE = 'ES003';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sandbox_runs_check_new
  BEFORE INSERT ON sandbox.runs
  FOR EACH ROW EXECUTE FUNCTION sandbox.check_new_run();
--> statement-breakpoint

-- The state machine. The transitions match SANDBOX_RUN_TRANSITIONS in @ensemus/domain/sandbox.
CREATE FUNCTION sandbox.check_run_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE allowed boolean;
BEGIN
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'SANDBOX_RUN_STALE_WRITE' USING ERRCODE = 'ES001';
  END IF;
  -- Output exists only for a job that exited cleanly and whose output passed its schema.
  IF NEW.output IS NOT NULL AND NEW.status <> 'succeeded' THEN
    RAISE EXCEPTION 'SANDBOX_RUN_OUTPUT_NOT_ALLOWED' USING ERRCODE = 'ES002';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  allowed := CASE OLD.status
    WHEN 'queued' THEN NEW.status IN ('running', 'denied', 'cancelled', 'runner_unavailable')
    WHEN 'running' THEN NEW.status IN ('succeeded', 'failed', 'timed_out', 'memory_exceeded', 'output_exceeded', 'cancelled', 'runner_unavailable', 'queued')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'SANDBOX_RUN_INVALID_TRANSITION' USING ERRCODE = 'ES001';
  END IF;
  -- Going to a runner counts, every time, and a run cannot start without a probe having passed for it.
  IF NEW.status = 'running' AND
     (NEW.attempts <> OLD.attempts + 1 OR NEW.isolation_probe_passed_at IS NULL) THEN
    RAISE EXCEPTION 'SANDBOX_RUN_NOT_CLEARED_TO_START' USING ERRCODE = 'ES003';
  END IF;
  IF NEW.status NOT IN ('queued', 'running')
     AND (NEW.outcome_code IS NULL OR NEW.finished_at IS NULL) THEN
    RAISE EXCEPTION 'SANDBOX_RUN_SETTLED_WITHOUT_OUTCOME' USING ERRCODE = 'ES002';
  END IF;
  IF NEW.status = 'succeeded' AND (NEW.output IS NULL OR NEW.exit_code IS DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'SANDBOX_RUN_SUCCESS_WITHOUT_OUTPUT' USING ERRCODE = 'ES002';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sandbox_runs_check_change
  BEFORE UPDATE ON sandbox.runs
  FOR EACH ROW EXECUTE FUNCTION sandbox.check_run_change();
--> statement-breakpoint

-- A submission's copy is held equal to the version it names. Someone else's marketplace package cannot
-- be re-published as your own, and only a package marked public can leave its tenant (ADR-034 D5).
CREATE FUNCTION marketplace.check_new_submission() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v record;
  publisher_ok boolean;
  signer_ok boolean;
BEGIN
  IF NEW.state <> 'submitted' OR NEW.version <> 1 OR NEW.decided_at IS NOT NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_SUBMISSION_INVALID_START' USING ERRCODE = 'ES001';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM marketplace.publishers pub
     WHERE pub.id = NEW.publisher_id
       AND pub.organization_id = NEW.organization_id
       AND pub.state = 'active'
  ) INTO publisher_ok;
  IF NOT publisher_ok THEN
    RAISE EXCEPTION 'MARKETPLACE_PUBLISHER_NOT_ACTIVE' USING ERRCODE = 'ES005';
  END IF;
  SELECT pv.state, pv.semver, pv.digest, pv.manifest, pv.signer_key_id, pv.signature,
         pv.bundle_object_key, pv.size_bytes, p.id AS package_id, p.name, p.origin,
         p.state AS package_state, p.content_classification
    INTO v
    FROM skills.package_versions pv
    JOIN skills.packages p ON p.organization_id = pv.organization_id AND p.id = pv.package_id
   WHERE pv.organization_id = NEW.organization_id AND pv.id = NEW.skill_version_id;
  IF NOT FOUND
     OR v.state NOT IN ('verified', 'published')
     OR v.package_state <> 'active'
     OR v.origin <> 'tenant'
     OR v.content_classification <> 'public' THEN
    RAISE EXCEPTION 'MARKETPLACE_VERSION_NOT_SUBMITTABLE' USING ERRCODE = 'ES005';
  END IF;
  IF NEW.package_id <> v.package_id OR NEW.name <> v.name OR NEW.semver <> v.semver
     OR NEW.digest <> v.digest OR NEW.manifest <> v.manifest
     OR NEW.signer_key_id <> v.signer_key_id OR NEW.signature <> v.signature
     OR NEW.bundle_object_key <> v.bundle_object_key OR NEW.size_bytes <> v.size_bytes THEN
    RAISE EXCEPTION 'MARKETPLACE_SUBMISSION_COPY_MISMATCH' USING ERRCODE = 'ES004';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM skills.trusted_signers s
     WHERE s.organization_id = NEW.organization_id
       AND s.key_id = NEW.signer_key_id
       AND s.public_key = NEW.signer_public_key
       AND s.state = 'active'
  ) INTO signer_ok;
  IF NOT signer_ok THEN
    RAISE EXCEPTION 'MARKETPLACE_SUBMISSION_COPY_MISMATCH' USING ERRCODE = 'ES004';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER marketplace_submissions_check_new
  BEFORE INSERT ON marketplace.submissions
  FOR EACH ROW EXECUTE FUNCTION marketplace.check_new_submission();
--> statement-breakpoint

-- The state machine. The transitions match SUBMISSION_TRANSITIONS in @ensemus/domain/marketplace. A
-- publisher can only ever withdraw, and cannot withdraw what is listed: delisting is how that ends.
CREATE FUNCTION marketplace.check_submission_change() RETURNS trigger
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
  IF current_user = 'ensemus_app' AND NEW.state <> 'withdrawn' THEN
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
--> statement-breakpoint
CREATE TRIGGER marketplace_submissions_check_change
  BEFORE UPDATE ON marketplace.submissions
  FOR EACH ROW EXECUTE FUNCTION marketplace.check_submission_change();
--> statement-breakpoint

-- A review is of exactly what was submitted, and whoever signed a package cannot also be who reviewed it.
CREATE FUNCTION marketplace.check_new_review() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE s record;
BEGIN
  SELECT sub.state, sub.digest, sub.signer_key_id INTO s
    FROM marketplace.submissions sub
   WHERE sub.organization_id = NEW.submission_organization_id AND sub.id = NEW.submission_id;
  IF NOT FOUND OR s.state NOT IN ('submitted', 'in_review') THEN
    RAISE EXCEPTION 'MARKETPLACE_REVIEW_NOT_OPEN' USING ERRCODE = 'ES005';
  END IF;
  IF NEW.digest <> s.digest OR NEW.signer_key_id <> s.signer_key_id THEN
    RAISE EXCEPTION 'MARKETPLACE_REVIEW_COPY_MISMATCH' USING ERRCODE = 'ES004';
  END IF;
  IF NEW.reviewer_key_id = NEW.signer_key_id THEN
    RAISE EXCEPTION 'MARKETPLACE_REVIEW_BY_SIGNER' USING ERRCODE = 'ES005';
  END IF;
  IF NEW.verdict = 'approved' AND (
    cardinality(NEW.finding_codes) > 0
    OR EXISTS (
      SELECT 1 FROM jsonb_each_text(NEW.checks) c WHERE c.value NOT IN ('pass', 'not_applicable')
    )
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.checks)) < 7
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_REVIEW_CANNOT_APPROVE' USING ERRCODE = 'ES005';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER marketplace_reviews_check_new
  BEFORE INSERT ON marketplace.security_reviews
  FOR EACH ROW EXECUTE FUNCTION marketplace.check_new_review();
--> statement-breakpoint

-- "Signature and security review required before listing", as a rule of the table. A row cannot exist
-- here unless an approved review of exactly this digest, signer and attestation does. The signatures
-- themselves are checked in code when this is written and again on every install, by keys held outside
-- the database, so this is the second lock and not the only one (ADR-034 D5).
CREATE FUNCTION marketplace.check_new_listing() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  r record;
  s record;
  publisher_ok boolean;
BEGIN
  IF NEW.state <> 'listed' OR NEW.version <> 1 OR NEW.delist_mode IS NOT NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_LISTING_INVALID_START' USING ERRCODE = 'ES001';
  END IF;
  SELECT rev.verdict, rev.digest, rev.signer_key_id, rev.reviewer_key_id, rev.attestation_signature,
         rev.submission_organization_id, rev.submission_id
    INTO r
    FROM marketplace.security_reviews rev
   WHERE rev.id = NEW.review_id;
  IF NOT FOUND OR r.verdict <> 'approved'
     OR r.digest <> NEW.digest
     OR r.signer_key_id <> NEW.signer_key_id
     OR r.reviewer_key_id <> NEW.reviewer_key_id
     OR r.attestation_signature <> NEW.attestation_signature
     OR r.submission_organization_id <> NEW.publisher_organization_id
     OR r.submission_id <> NEW.submission_id THEN
    RAISE EXCEPTION 'MARKETPLACE_LISTING_WITHOUT_REVIEW' USING ERRCODE = 'ES005';
  END IF;
  SELECT sub.state, sub.digest, sub.name, sub.semver, sub.manifest, sub.signer_key_id,
         sub.signer_public_key, sub.signature, sub.publisher_id, sub.size_bytes
    INTO s
    FROM marketplace.submissions sub
   WHERE sub.organization_id = NEW.publisher_organization_id AND sub.id = NEW.submission_id;
  IF NOT FOUND OR s.state <> 'approved' THEN
    RAISE EXCEPTION 'MARKETPLACE_LISTING_WITHOUT_REVIEW' USING ERRCODE = 'ES005';
  END IF;
  IF s.digest <> NEW.digest OR s.name <> NEW.name OR s.semver <> NEW.semver
     OR s.manifest <> NEW.manifest OR s.signer_key_id <> NEW.signer_key_id
     OR s.signer_public_key <> NEW.signer_public_key OR s.signature <> NEW.signature
     OR s.publisher_id <> NEW.publisher_id OR s.size_bytes <> NEW.size_bytes THEN
    RAISE EXCEPTION 'MARKETPLACE_LISTING_COPY_MISMATCH' USING ERRCODE = 'ES004';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM marketplace.publishers p WHERE p.id = NEW.publisher_id AND p.state = 'active'
  ) INTO publisher_ok;
  IF NOT publisher_ok THEN
    RAISE EXCEPTION 'MARKETPLACE_PUBLISHER_NOT_ACTIVE' USING ERRCODE = 'ES005';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER marketplace_listings_check_new
  BEFORE INSERT ON marketplace.listings
  FOR EACH ROW EXECUTE FUNCTION marketplace.check_new_listing();
--> statement-breakpoint

-- A listing only goes one way. Stopping new installs can harden into revoking, and neither can be undone.
-- Listing it again means a new version and a new review.
CREATE FUNCTION marketplace.check_listing_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'MARKETPLACE_LISTING_STALE_WRITE' USING ERRCODE = 'ES001';
  END IF;
  IF OLD.state = 'delisted' AND NEW.state <> 'delisted' THEN
    RAISE EXCEPTION 'MARKETPLACE_LISTING_INVALID_TRANSITION' USING ERRCODE = 'ES001';
  END IF;
  IF OLD.delist_mode = 'revoke' AND NEW.delist_mode IS DISTINCT FROM 'revoke' THEN
    RAISE EXCEPTION 'MARKETPLACE_LISTING_INVALID_TRANSITION' USING ERRCODE = 'ES001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER marketplace_listings_check_change
  BEFORE UPDATE ON marketplace.listings
  FOR EACH ROW EXECUTE FUNCTION marketplace.check_listing_change();
--> statement-breakpoint

-- An install starts from something on offer. The transitions match INSTALLATION_TRANSITIONS.
CREATE FUNCTION marketplace.check_new_installation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.state <> 'requested' OR NEW.version <> 1 OR NEW.package_id IS NOT NULL
     OR NEW.skill_version_id IS NOT NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_INSTALLATION_INVALID_START' USING ERRCODE = 'ES001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM marketplace.listings l WHERE l.id = NEW.listing_id AND l.state = 'listed'
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_LISTING_NOT_AVAILABLE' USING ERRCODE = 'ES005';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER marketplace_installations_check_new
  BEFORE INSERT ON marketplace.installations
  FOR EACH ROW EXECUTE FUNCTION marketplace.check_new_installation();
--> statement-breakpoint
CREATE FUNCTION marketplace.check_installation_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE allowed boolean;
BEGIN
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'MARKETPLACE_INSTALLATION_STALE_WRITE' USING ERRCODE = 'ES001';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  allowed := CASE OLD.state
    WHEN 'requested' THEN NEW.state IN ('installing', 'failed')
    WHEN 'installing' THEN NEW.state IN ('installed', 'failed')
    WHEN 'installed' THEN NEW.state IN ('removed')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'MARKETPLACE_INSTALLATION_INVALID_TRANSITION' USING ERRCODE = 'ES001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER marketplace_installations_check_change
  BEFORE UPDATE ON marketplace.installations
  FOR EACH ROW EXECUTE FUNCTION marketplace.check_installation_change();
--> statement-breakpoint

-- The operator role is opt-in, and this migration does not need it to exist. Migrations run with no
-- CREATEROLE and a server is provisioned once, so an existing server has no such role until someone runs
-- infrastructure/compose/postgres/provision-marketplace.sql. With no role, nobody can write a review or a
-- listing, the marketplace stays empty, and every other feature is unaffected (ADR-034 D6).
CREATE FUNCTION marketplace.grant_operator_role() RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  GRANT USAGE ON SCHEMA marketplace TO ensemus_marketplace;
  GRANT SELECT ON marketplace.publishers TO ensemus_marketplace;
  GRANT UPDATE (state, version, updated_at) ON marketplace.publishers TO ensemus_marketplace;
  GRANT SELECT ON marketplace.submissions TO ensemus_marketplace;
  GRANT UPDATE (state, decided_at, version, updated_at) ON marketplace.submissions TO ensemus_marketplace;
  GRANT SELECT, INSERT ON marketplace.security_reviews TO ensemus_marketplace;
  GRANT SELECT, INSERT ON marketplace.listings TO ensemus_marketplace;
  GRANT UPDATE (state, delist_mode, delist_code, delisted_at, version)
    ON marketplace.listings TO ensemus_marketplace;
  DROP POLICY IF EXISTS operator_all ON marketplace.publishers;
  DROP POLICY IF EXISTS operator_all ON marketplace.submissions;
  DROP POLICY IF EXISTS operator_all ON marketplace.security_reviews;
  DROP POLICY IF EXISTS operator_all ON marketplace.listings;
  CREATE POLICY operator_all ON marketplace.publishers TO ensemus_marketplace
    USING (true) WITH CHECK (true);
  CREATE POLICY operator_all ON marketplace.submissions TO ensemus_marketplace
    USING (true) WITH CHECK (true);
  CREATE POLICY operator_all ON marketplace.security_reviews TO ensemus_marketplace
    USING (true) WITH CHECK (true);
  CREATE POLICY operator_all ON marketplace.listings TO ensemus_marketplace
    USING (true) WITH CHECK (true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION marketplace.grant_operator_role() FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ensemus_marketplace') THEN
    PERFORM marketplace.grant_operator_role();
  END IF;
END $$;
