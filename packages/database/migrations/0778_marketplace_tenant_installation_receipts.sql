-- FLAGGED FOR HUMAN SECURITY REVIEW
-- A marketplace copy reserves its tenant object before the first PUT. Its receipt uses
-- the same cleanup, restore-generation and offboarding machinery as interactive uploads.
ALTER TABLE skills.bundle_uploads
  ALTER COLUMN package_id DROP NOT NULL,
  ADD COLUMN marketplace_copy boolean NOT NULL DEFAULT false,
  ADD COLUMN copy_material_generation uuid,
  ADD COLUMN copy_auth_generation uuid,
  ADD CONSTRAINT skill_upload_marketplace_target CHECK (
    (marketplace_copy AND copy_material_generation IS NOT NULL AND copy_auth_generation IS NOT NULL
      AND (package_id IS NULL OR package_id=id)
      AND (state<>'attached' OR package_id IS NOT NULL))
    OR (NOT marketplace_copy AND package_id IS NOT NULL
      AND copy_material_generation IS NULL AND copy_auth_generation IS NULL)
  );
GRANT INSERT (marketplace_copy), UPDATE (package_id) ON skills.bundle_uploads TO ensemus_worker;
CREATE POLICY skill_upload_marketplace_worker ON skills.bundle_uploads TO ensemus_worker
  USING (session_user='ensemus_worker' AND current_user=session_user
    AND organization_id=app.current_organization_id() AND app.current_actor_type()='service'
    AND marketplace_copy)
  WITH CHECK (session_user='ensemus_worker' AND current_user=session_user
    AND organization_id=app.current_organization_id() AND app.current_actor_type()='service'
    AND marketplace_copy);
GRANT SELECT ON marketplace.listing_object_reservations TO ensemus_worker;
CREATE POLICY reservation_marketplace_install_worker ON marketplace.listing_object_reservations
  FOR SELECT TO ensemus_worker
  USING (session_user='ensemus_worker' AND current_user=session_user AND app.current_actor_type()='service'
    AND EXISTS (SELECT 1 FROM marketplace.installations i JOIN marketplace.listings l ON l.id=i.listing_id
      WHERE i.organization_id=app.current_organization_id() AND i.state='installing'
        AND l.digest=listing_object_reservations.digest));
CREATE POLICY review_marketplace_install_worker ON marketplace.security_reviews
  FOR SELECT TO ensemus_worker
  USING (session_user='ensemus_worker' AND current_user=session_user AND app.current_actor_type()='service'
    AND EXISTS (SELECT 1 FROM marketplace.installations i JOIN marketplace.listings l ON l.id=i.listing_id
      WHERE i.organization_id=app.current_organization_id() AND i.state='installing'
        AND l.review_id=security_reviews.id));
--> statement-breakpoint
-- The operator and buyers share the listing lock but keep separate database roles.
-- Callers re-read state after taking the lock. No buyer needs listing UPDATE privileges.
CREATE FUNCTION marketplace.lock_install_listing(p_listing uuid) RETURNS void
LANGUAGE sql SET search_path=pg_catalog AS $function$
  SELECT pg_advisory_xact_lock(hashtextextended('marketplace_listing:'||p_listing::text,0))
$function$;
REVOKE ALL ON FUNCTION marketplace.lock_install_listing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marketplace.lock_install_listing(uuid) TO ensemus_app;
CREATE FUNCTION marketplace.lock_delist_installation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('marketplace_listing:'||OLD.id::text,0));
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION marketplace.lock_delist_installation() FROM PUBLIC;
CREATE TRIGGER marketplace_listings_lock_installation BEFORE UPDATE ON marketplace.listings
FOR EACH ROW EXECUTE FUNCTION marketplace.lock_delist_installation();
--> statement-breakpoint
CREATE FUNCTION marketplace.guard_installation_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR current_user<>session_user THEN
    RAISE EXCEPTION 'MARKETPLACE_INSTALL_ACTOR_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' OR NEW.state='removed' THEN
    IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'user'
      OR NOT EXISTS (SELECT 1 FROM org.memberships m WHERE m.organization_id=NEW.organization_id
        AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id()
        AND m.status='active' AND m.role IN ('owner','admin') FOR SHARE) THEN
      RAISE EXCEPTION 'MARKETPLACE_INSTALL_ACTOR_REQUIRED' USING ERRCODE='42501';
    END IF;
  ELSIF session_user<>'ensemus_worker' OR app.current_actor_type() IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'MARKETPLACE_INSTALL_WORKER_REQUIRED' USING ERRCODE='42501';
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id()
      OR NEW.removed_by_membership_id IS NOT NULL OR NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'MARKETPLACE_INSTALL_ACTOR_REQUIRED' USING ERRCODE='42501';
    END IF;
    PERFORM marketplace.lock_install_listing(NEW.listing_id);
    IF NOT EXISTS (SELECT 1 FROM marketplace.listings l WHERE l.id=NEW.listing_id AND l.state='listed') THEN
      RAISE EXCEPTION 'MARKETPLACE_LISTING_NOT_AVAILABLE' USING ERRCODE='ES005';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.version<>OLD.version+1
    OR ROW(NEW.organization_id,NEW.id,NEW.listing_id,NEW.requested_by_membership_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.listing_id,OLD.requested_by_membership_id,OLD.created_at) THEN
    RAISE EXCEPTION 'MARKETPLACE_INSTALLATION_RECEIPT_IMMUTABLE' USING ERRCODE='ES002';
  END IF;

  IF NEW.state='removed' THEN
    IF OLD.state<>'installed' OR NEW.removed_by_membership_id IS DISTINCT FROM app.current_membership_id()
      OR NOT EXISTS (SELECT 1 FROM skills.packages p JOIN skills.package_versions v
        ON v.organization_id=p.organization_id AND v.package_id=p.id
        WHERE p.organization_id=NEW.organization_id AND p.id=OLD.package_id AND p.state='disabled'
          AND v.id=OLD.skill_version_id AND v.state='yanked') THEN
      RAISE EXCEPTION 'MARKETPLACE_REMOVAL_NOT_PROVEN' USING ERRCODE='ES001';
    END IF;
    IF app.interactive_privilege_allowed('skill.manage') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';
    END IF;
    NEW.removed_at := statement_timestamp();
  ELSIF NEW.removed_at IS DISTINCT FROM OLD.removed_at
    OR NEW.removed_by_membership_id IS DISTINCT FROM OLD.removed_by_membership_id THEN
    RAISE EXCEPTION 'MARKETPLACE_INSTALLATION_RECEIPT_IMMUTABLE' USING ERRCODE='ES002';
  END IF;

  IF ROW(NEW.package_id,NEW.skill_version_id) IS DISTINCT FROM ROW(OLD.package_id,OLD.skill_version_id)
    AND (OLD.state<>'installing' OR NEW.state<>'installing' OR OLD.package_id IS NOT NULL
      OR NEW.package_id IS DISTINCT FROM NEW.id OR NEW.skill_version_id IS DISTINCT FROM NEW.id
      OR NOT EXISTS (SELECT 1 FROM skills.bundle_uploads r JOIN skills.package_versions v
        ON v.organization_id=r.organization_id AND v.id=r.id AND v.package_id=r.package_id
        WHERE r.organization_id=NEW.organization_id AND r.id=NEW.id
          AND r.marketplace_copy AND r.state='attached' AND v.state='uploaded')) THEN
    RAISE EXCEPTION 'MARKETPLACE_COPY_NOT_PROVEN' USING ERRCODE='ES004';
  END IF;

  IF NEW.state='installed' OR (OLD.state='installing' AND NEW.state='installing') THEN
    PERFORM marketplace.lock_install_listing(NEW.listing_id);
    IF NOT EXISTS (SELECT 1 FROM marketplace.listings l WHERE l.id=NEW.listing_id AND l.state='listed') THEN
      RAISE EXCEPTION 'MARKETPLACE_LISTING_NOT_AVAILABLE' USING ERRCODE='ES005';
    END IF;
  END IF;
  IF NEW.state='installed' AND (OLD.state<>'installing' OR NOT EXISTS (
    SELECT 1 FROM skills.bundle_uploads r JOIN skills.package_versions v
      ON v.organization_id=r.organization_id AND v.id=r.id AND v.package_id=r.package_id
    JOIN skills.packages p ON p.organization_id=v.organization_id AND p.id=v.package_id
    JOIN marketplace.listings l ON l.id=p.listing_id
    WHERE r.organization_id=NEW.organization_id AND r.id=NEW.id AND r.marketplace_copy AND r.state='attached'
      AND r.put_material_generation=ai.current_material_restore_generation()
      AND r.put_auth_generation=app.current_auth_restore_generation()
      AND p.id=NEW.package_id AND p.state='active' AND l.id=NEW.listing_id
      AND v.id=NEW.skill_version_id AND v.state='verified' AND v.digest=l.digest
      AND v.signer_key_id=l.signer_key_id AND v.signature=l.signature
  )) THEN
    RAISE EXCEPTION 'MARKETPLACE_COPY_NOT_VERIFIED' USING ERRCODE='ES004';
  END IF;
  IF NEW.state='failed' AND NEW.package_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM skills.packages p WHERE p.organization_id=NEW.organization_id
      AND p.id=NEW.package_id AND p.state='disabled'
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_FAILED_PACKAGE_ACTIVE' USING ERRCODE='ES001';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION marketplace.guard_installation_authority() FROM PUBLIC;
CREATE TRIGGER marketplace_installations_authority BEFORE INSERT OR UPDATE ON marketplace.installations
FOR EACH ROW EXECUTE FUNCTION marketplace.guard_installation_authority();
--> statement-breakpoint
CREATE FUNCTION marketplace.lock_installation_for_copy(p_id uuid)
RETURNS marketplace.installations
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE installation marketplace.installations%ROWTYPE;
BEGIN
  IF session_user<>'ensemus_worker' OR current_user<>session_user
    OR app.current_actor_type() IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'MARKETPLACE_INSTALL_WORKER_REQUIRED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO installation FROM marketplace.installations i
    WHERE i.organization_id=app.current_organization_id() AND i.id=p_id AND i.state='installing' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_INSTALLATION_INACTIVE' USING ERRCODE='ES001';
  END IF;
  PERFORM marketplace.lock_install_listing(installation.listing_id);
  IF NOT EXISTS (SELECT 1 FROM marketplace.listings l WHERE l.id=installation.listing_id AND l.state='listed') THEN
    RAISE EXCEPTION 'MARKETPLACE_LISTING_NOT_AVAILABLE' USING ERRCODE='ES005';
  END IF;
  RETURN installation;
END $function$;
REVOKE ALL ON FUNCTION marketplace.lock_installation_for_copy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marketplace.lock_installation_for_copy(uuid) TO ensemus_worker;
--> statement-breakpoint
ALTER POLICY skill_upload_tenant ON skills.bundle_uploads
  USING (organization_id=app.current_organization_id() AND app.current_actor_type()='user' AND NOT marketplace_copy)
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_type()='user' AND NOT marketplace_copy);
CREATE FUNCTION skills.check_marketplace_bundle_upload(
  operation text, prior skills.bundle_uploads, receipt skills.bundle_uploads
) RETURNS skills.bundle_uploads
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE installation marketplace.installations%ROWTYPE;
BEGIN
  IF session_user<>'ensemus_worker' OR current_user<>session_user
    OR app.current_actor_type() IS DISTINCT FROM 'service'
    OR receipt.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'MARKETPLACE_COPY_WORKER_REQUIRED' USING ERRCODE='42501';
  END IF;

  IF operation='INSERT' THEN
    installation := marketplace.lock_installation_for_copy(receipt.id);
    IF receipt.package_id IS NOT NULL OR receipt.state<>'writing' OR receipt.put_finished_at IS NOT NULL
      OR receipt.membership_id IS DISTINCT FROM installation.requested_by_membership_id
      OR NOT EXISTS (SELECT 1 FROM marketplace.listings l JOIN marketplace.listing_object_reservations r
        ON r.digest=l.digest AND r.size_bytes=l.size_bytes
        WHERE l.id=installation.listing_id AND r.bundle_sha256=receipt.bundle_sha256
          AND r.size_bytes=receipt.size_bytes) THEN
      RAISE EXCEPTION 'MARKETPLACE_COPY_NOT_RESERVED' USING ERRCODE='ES004';
    END IF;
    receipt.copy_material_generation := ai.current_material_restore_generation();
    receipt.copy_auth_generation := app.current_auth_restore_generation();
  ELSIF receipt.put_finished_at IS DISTINCT FROM prior.put_finished_at THEN
    -- Record completion even after delisting so erasure can account for the object.
    IF prior.state<>'writing' OR prior.put_finished_at IS NOT NULL OR receipt.put_finished_at IS NULL
      OR prior.copy_material_generation IS DISTINCT FROM ai.current_material_restore_generation()
      OR prior.copy_auth_generation IS DISTINCT FROM app.current_auth_restore_generation()
      OR (to_jsonb(receipt)-'put_finished_at') IS DISTINCT FROM (to_jsonb(prior)-'put_finished_at') THEN
      RAISE EXCEPTION 'MARKETPLACE_COPY_RECEIPT_INVALID' USING ERRCODE='ES004';
    END IF;
    receipt.put_finished_at := clock_timestamp();
    receipt.put_material_generation := ai.current_material_restore_generation();
    receipt.put_auth_generation := app.current_auth_restore_generation();
  ELSE
    installation := marketplace.lock_installation_for_copy(receipt.id);
    IF prior.state<>'writing' OR receipt.state<>'attached' OR receipt.package_id IS DISTINCT FROM receipt.id
      OR (to_jsonb(receipt)-'state'-'package_id') IS DISTINCT FROM (to_jsonb(prior)-'state'-'package_id')
      OR NOT EXISTS (SELECT 1 FROM skills.package_versions v
        WHERE v.organization_id=receipt.organization_id AND v.id=receipt.id AND v.package_id=receipt.id
          AND v.uploaded_by_membership_id IS NULL AND v.state='uploaded'
          AND v.bundle_sha256=receipt.bundle_sha256 AND v.size_bytes=receipt.size_bytes
          AND v.bundle_object_key=receipt.organization_id::text||'/skills/'||receipt.id::text) THEN
      RAISE EXCEPTION 'MARKETPLACE_COPY_ATTACHMENT_INVALID' USING ERRCODE='ES004';
    END IF;
  END IF;
  RETURN receipt;
END $function$;
REVOKE ALL ON FUNCTION skills.check_marketplace_bundle_upload(text,skills.bundle_uploads,skills.bundle_uploads) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION skills.check_marketplace_bundle_upload(text,skills.bundle_uploads,skills.bundle_uploads) TO ensemus_worker;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text := pg_get_functiondef('skills.check_bundle_upload()'::regprocedure);
  anchor constant text := '  IF session_user<>''ensemus_app'' OR current_user<>session_user';
BEGIN
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
    RAISE EXCEPTION 'SKILL_UPLOAD_TRIGGER_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,anchor,$code$
  IF NEW.marketplace_copy THEN
    RETURN skills.check_marketplace_bundle_upload(TG_OP,OLD,NEW);
  END IF;
$code$||anchor);
END $migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle.skill_version_matches_upload(r skills.bundle_uploads, v skills.package_versions)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
  SELECT r.state='attached' AND v.organization_id=r.organization_id AND v.id=r.id AND v.package_id=r.package_id
    AND v.uploaded_by_membership_id IS NOT DISTINCT FROM
      (CASE WHEN r.marketplace_copy THEN NULL::uuid ELSE r.membership_id END)
    AND v.bundle_sha256=r.bundle_sha256 AND v.size_bytes=r.size_bytes
    AND v.bundle_object_key=r.organization_id::text||'/skills/'||r.id::text
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION skills.guard_bundle_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE
  reservation skills.bundle_uploads%ROWTYPE;
  installation marketplace.installations%ROWTYPE;
  target skills.packages%ROWTYPE;
BEGIN
  SELECT * INTO target FROM skills.packages p WHERE p.organization_id=NEW.organization_id AND p.id=NEW.package_id;
  IF target.origin='marketplace' THEN
    installation := marketplace.lock_installation_for_copy(NEW.id);
  END IF;
  SELECT * INTO reservation FROM skills.bundle_uploads r
    WHERE r.organization_id=NEW.organization_id AND r.id=NEW.id FOR UPDATE;
  IF target.origin='marketplace' THEN
    IF NOT FOUND OR NOT reservation.marketplace_copy OR reservation.state<>'writing'
      OR reservation.package_id IS NOT NULL OR reservation.put_finished_at IS NULL
      OR reservation.put_material_generation IS DISTINCT FROM ai.current_material_restore_generation()
      OR reservation.put_auth_generation IS DISTINCT FROM app.current_auth_restore_generation()
      OR NEW.package_id IS DISTINCT FROM NEW.id OR target.listing_id IS DISTINCT FROM installation.listing_id
      OR NEW.uploaded_by_membership_id IS NOT NULL
      OR reservation.bundle_sha256<>NEW.bundle_sha256 OR reservation.size_bytes<>NEW.size_bytes
      OR NEW.bundle_object_key<>NEW.organization_id::text||'/skills/'||NEW.id::text THEN
      RAISE EXCEPTION 'MARKETPLACE_COPY_NOT_PROVEN' USING ERRCODE='ES004';
    END IF;
  ELSIF FOUND AND (reservation.marketplace_copy OR reservation.state<>'writing' OR reservation.package_id<>NEW.package_id
    OR reservation.membership_id IS DISTINCT FROM NEW.uploaded_by_membership_id
    OR reservation.bundle_sha256<>NEW.bundle_sha256 OR reservation.size_bytes<>NEW.size_bytes
    OR NEW.bundle_object_key<>NEW.organization_id::text||'/skills/'||NEW.id::text) THEN
    RAISE EXCEPTION 'SKILL_UPLOAD_FENCED' USING ERRCODE='ES001';
  END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE FUNCTION skills.guard_marketplace_package() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE installation marketplace.installations%ROWTYPE;
BEGIN
  IF NEW.origin<>'marketplace' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.content_classification IS DISTINCT FROM OLD.content_classification
      OR NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id
      OR (OLD.state='disabled' AND NEW.state<>'disabled') THEN
      RAISE EXCEPTION 'MARKETPLACE_PACKAGE_RECEIPT_IMMUTABLE' USING ERRCODE='ES002';
    END IF;
    RETURN NEW;
  END IF;
  installation := marketplace.lock_installation_for_copy(NEW.id);
  IF NEW.listing_id IS DISTINCT FROM installation.listing_id OR NEW.content_classification<>'public'
    OR NEW.state<>'active' OR NEW.version<>1 OR NEW.owner_membership_id IS NOT NULL
    OR NEW.created_by_membership_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM marketplace.listings l JOIN skills.bundle_uploads r
        ON r.organization_id=NEW.organization_id AND r.id=NEW.id AND r.marketplace_copy
      WHERE l.id=NEW.listing_id AND l.name=NEW.name AND l.display_name=NEW.display_name
        AND r.state='writing' AND r.put_finished_at IS NOT NULL
        AND r.put_material_generation=ai.current_material_restore_generation()
        AND r.put_auth_generation=app.current_auth_restore_generation()
    ) THEN
    RAISE EXCEPTION 'MARKETPLACE_COPY_NOT_PROVEN' USING ERRCODE='ES004';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION skills.guard_marketplace_package() FROM PUBLIC;
CREATE TRIGGER skill_packages_guard_marketplace BEFORE INSERT OR UPDATE ON skills.packages
FOR EACH ROW EXECUTE FUNCTION skills.guard_marketplace_package();
--> statement-breakpoint
CREATE FUNCTION skills.guard_marketplace_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE source marketplace.listings%ROWTYPE;
BEGIN
  IF NEW.state<>'published' OR OLD.state='published' THEN RETURN NEW; END IF;
  SELECT l.* INTO source FROM skills.packages p JOIN marketplace.listings l ON l.id=p.listing_id
    WHERE p.organization_id=NEW.organization_id AND p.id=NEW.package_id AND p.origin='marketplace';
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM marketplace.lock_install_listing(source.id);
  IF NOT EXISTS (
    SELECT 1 FROM marketplace.installations i JOIN marketplace.listings l ON l.id=i.listing_id
    WHERE i.organization_id=NEW.organization_id AND i.package_id=NEW.package_id AND i.skill_version_id=NEW.id
      AND i.listing_id=source.id AND i.state='installed' AND l.delist_mode IS DISTINCT FROM 'revoke'
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_COPY_NOT_VERIFIED' USING ERRCODE='ES004';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION skills.guard_marketplace_publication() FROM PUBLIC;
CREATE TRIGGER skill_versions_guard_marketplace_publication BEFORE UPDATE OF state ON skills.package_versions
FOR EACH ROW EXECUTE FUNCTION skills.guard_marketplace_publication();
