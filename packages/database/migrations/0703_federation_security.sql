-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-035 D1 to D4). Changes here need human review, never agent approval.
-- This is the one place in the product built to cross the boundary between tenants, so it stays small
-- enough to read whole. Every other tenant table, and every other role, is exactly as it was before it.

-- Forced RLS on every table in the new schema. A test fails if one misses it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'federation' LOOP
    EXECUTE format('ALTER TABLE federation.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE federation.%I FORCE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA federation TO ensemus_app;
--> statement-breakpoint

-- A person holding an invitation is not a party yet, so this finds exactly the one proposal matching the
-- hash of their token, and nothing else. The same shape as an invitation link (0003).
CREATE FUNCTION app.current_federation_token_hash() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.federation_token_hash', true), '') $$;
--> statement-breakpoint

-- The one grant a bridge transaction is working on. Only the narrow role's policies read this, so the
-- application role gains nothing by setting it.
CREATE FUNCTION app.current_federation_grant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.federation_grant_id', true), '')::uuid $$;
--> statement-breakpoint

-- The single test every crossing passes. An operator turning the deployment's switch off closes every
-- grant at once, with nothing to wait for. A grant past its date is closed before any sweep gets to it.
CREATE FUNCTION federation.grant_is_open(check_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (
             SELECT 1 FROM federation.grants g
              WHERE g.id = check_id AND g.status = 'active' AND g.expires_at > now()
           )
       AND COALESCE((SELECT p.cross_org_enabled FROM tenancy.deployment_profile p), false)
  $$;
--> statement-breakpoint

-- Puts ending a grant and carrying something across it in order. Without this a crossing could read an
-- open grant, the grant could end and be purged, and the crossing could then commit a row nobody removes.
CREATE FUNCTION federation.grant_lock_key(lock_id uuid) RETURNS bigint
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT hashtextextended(lock_id::text, 7236035) $$;
--> statement-breakpoint

-- What each purpose lets go in each direction. `forward` is from the sharing organization to the one that
-- receives, and `return` is back. Adding a purpose takes a reviewed migration, and no setting can widen
-- it. A test holds this the same as FEDERATION_PURPOSE_KINDS in @ensemus/domain/federation.
CREATE FUNCTION federation.kinds_for(purpose text, direction text) RETURNS text[]
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE purpose || '/' || direction
      WHEN 'delegated_work/forward' THEN ARRAY['work_summary','artifact']
      WHEN 'delegated_work/return' THEN ARRAY['status_update','artifact']
      WHEN 'document_review/forward' THEN ARRAY['artifact']
      WHEN 'document_review/return' THEN ARRAY['status_update']
      ELSE ARRAY[]::text[]
    END
  $$;
--> statement-breakpoint

CREATE FUNCTION federation.classification_rank(classification text) RETURNS integer
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE classification
      WHEN 'public' THEN 1
      WHEN 'internal' THEN 2
      WHEN 'confidential' THEN 3
      ELSE 99
    END
  $$;
--> statement-breakpoint

-- Only an active owner of an organization that has switched this on may agree to anything. The row lock
-- puts this in order with switching it off, whose check then sees what this transaction committed.
CREATE FUNCTION federation.assert_can_consent(org_id uuid, member_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT COALESCE((SELECT p.cross_org_enabled FROM tenancy.deployment_profile p), false) THEN
    RAISE EXCEPTION 'FEDERATION_NOT_AVAILABLE' USING ERRCODE = 'EN717';
  END IF;
  PERFORM 1 FROM federation.org_settings s
    WHERE s.organization_id = org_id AND s.enabled
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FEDERATION_DISABLED' USING ERRCODE = 'EN714';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM org.memberships m
     WHERE m.organization_id = org_id AND m.id = member_id
       AND m.status = 'active' AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'FEDERATION_NOT_AN_OWNER' USING ERRCODE = 'EN715';
  END IF;
END $$;
--> statement-breakpoint

-- --- org_settings: a tenant's own switch. No row means off, and off is what every tenant starts with.
GRANT SELECT, INSERT ON federation.org_settings TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (enabled, version, changed_by_membership_id, changed_at)
  ON federation.org_settings TO ensemus_app;
--> statement-breakpoint
CREATE POLICY tenant_scoped ON federation.org_settings TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

CREATE FUNCTION federation.check_settings() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.enabled AND NOT COALESCE((SELECT p.cross_org_enabled FROM tenancy.deployment_profile p), false) THEN
    RAISE EXCEPTION 'FEDERATION_NOT_AVAILABLE' USING ERRCODE = 'EN717';
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.version <> 1) OR (TG_OP = 'UPDATE' AND NEW.version <> OLD.version + 1) THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_VERSION' USING ERRCODE = 'EN718';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM org.memberships m
     WHERE m.organization_id = NEW.organization_id AND m.id = NEW.changed_by_membership_id
       AND m.status = 'active' AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'FEDERATION_NOT_AN_OWNER' USING ERRCODE = 'EN715';
  END IF;
  -- Off means no way across. Everything open is ended first, in the same transaction, so that each
  -- ending has its event, and its purge. This refuses a shortcut that would leave them standing.
  IF TG_OP = 'UPDATE' AND OLD.enabled AND NOT NEW.enabled AND EXISTS (
    SELECT 1 FROM federation.grants g
     WHERE (g.sharing_organization_id = NEW.organization_id
            OR g.receiving_organization_id = NEW.organization_id)
       AND g.status IN ('proposed','accepted','active')
  ) THEN
    RAISE EXCEPTION 'FEDERATION_OPEN_GRANTS' USING ERRCODE = 'EN719';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER org_settings_check
  BEFORE INSERT OR UPDATE ON federation.org_settings
  FOR EACH ROW EXECUTE FUNCTION federation.check_settings();
--> statement-breakpoint

-- --- grants: THE explicit grant table. One row, seen by both of its parties and by nobody else. It holds
-- the agreement and no content: what crosses is in the item tables below, which each side sees alone.
GRANT SELECT, INSERT ON federation.grants TO ensemus_app;
--> statement-breakpoint
-- The terms, their hash, the purpose, the dates, who proposed it and the token are fixed once written, so
-- what one side agreed to cannot change before the other side reads it.
GRANT UPDATE (receiving_organization_id, status, receiving_display_name,
              accepted_by_membership_id, accepted_terms_hash, accepted_at,
              confirmed_by_membership_id, confirmed_terms_hash, confirmed_at,
              ended_by_organization_id, ended_by_membership_id, end_reason, ended_at,
              version, updated_at)
  ON federation.grants TO ensemus_app;
--> statement-breakpoint
CREATE POLICY grants_party_read ON federation.grants FOR SELECT TO ensemus_app
  USING (sharing_organization_id = app.current_organization_id()
         OR receiving_organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY grants_invitation_read ON federation.grants FOR SELECT TO ensemus_app
  USING (status = 'proposed'
         AND token_hash = app.current_federation_token_hash()
         AND invitation_expires_at > now());
--> statement-breakpoint
CREATE POLICY grants_propose ON federation.grants FOR INSERT TO ensemus_app
  WITH CHECK (sharing_organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY grants_party_update ON federation.grants FOR UPDATE TO ensemus_app
  USING (sharing_organization_id = app.current_organization_id()
         OR receiving_organization_id = app.current_organization_id()
         OR (status = 'proposed'
             AND token_hash = app.current_federation_token_hash()
             AND invitation_expires_at > now()))
  WITH CHECK (sharing_organization_id = app.current_organization_id()
              OR receiving_organization_id = app.current_organization_id());
--> statement-breakpoint

CREATE FUNCTION federation.check_new_grant() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE bound uuid := app.current_organization_id();
BEGIN
  IF NEW.status <> 'proposed' OR NEW.version <> 1
     OR NEW.receiving_organization_id IS NOT NULL OR NEW.receiving_display_name IS NOT NULL
     OR NEW.accepted_by_membership_id IS NOT NULL OR NEW.accepted_terms_hash IS NOT NULL OR NEW.accepted_at IS NOT NULL
     OR NEW.confirmed_by_membership_id IS NOT NULL OR NEW.confirmed_terms_hash IS NOT NULL OR NEW.confirmed_at IS NOT NULL
     OR NEW.ended_by_organization_id IS NOT NULL OR NEW.ended_by_membership_id IS NOT NULL
     OR NEW.end_reason IS NOT NULL OR NEW.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_START' USING ERRCODE = 'EN710';
  END IF;
  IF bound IS NULL OR NEW.sharing_organization_id <> bound THEN
    RAISE EXCEPTION 'FEDERATION_NOT_A_PARTY' USING ERRCODE = 'EN711';
  END IF;
  PERFORM federation.assert_can_consent(bound, NEW.proposed_by_membership_id);
  -- The name the other side will read is the organization's real one, not one a request chose.
  IF NEW.sharing_display_name IS DISTINCT FROM (SELECT o.name FROM org.organizations o WHERE o.id = bound) THEN
    RAISE EXCEPTION 'FEDERATION_NAME_MISMATCH' USING ERRCODE = 'EN712';
  END IF;
  IF NEW.invitation_expires_at <= now() OR NEW.expires_at <= now() THEN
    RAISE EXCEPTION 'FEDERATION_EXPIRED' USING ERRCODE = 'EN713';
  END IF;
  -- The columns the policies read are the same thing the terms say, so a hash cannot cover one purpose
  -- while the row enforces another.
  IF NEW.terms->>'purpose' IS DISTINCT FROM NEW.purpose
     OR NEW.terms->>'max_classification' IS DISTINCT FROM NEW.max_classification THEN
    RAISE EXCEPTION 'FEDERATION_TERMS_MISMATCH' USING ERRCODE = 'EN720';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER grants_check_new
  BEFORE INSERT ON federation.grants
  FOR EACH ROW EXECUTE FUNCTION federation.check_new_grant();
--> statement-breakpoint

-- The grant's lifecycle, here as well as in code, because both sides reach this row through the same
-- role. The transitions match FEDERATION_GRANT_TRANSITIONS in @ensemus/domain/federation, and a test holds
-- them the same. Consent takes an owner of the right side, naming the exact terms. Ending one can be done
-- by either side at any time, and cannot be undone: sharing again takes a new grant and both consents.
CREATE FUNCTION federation.check_grant_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE bound uuid := app.current_organization_id();
BEGIN
  IF bound IS NULL THEN
    RAISE EXCEPTION 'FEDERATION_NOT_A_PARTY' USING ERRCODE = 'EN711';
  END IF;
  IF NOT (CASE OLD.status
    WHEN 'proposed' THEN NEW.status IN ('accepted','ended')
    WHEN 'accepted' THEN NEW.status IN ('active','ended')
    WHEN 'active' THEN NEW.status IN ('ended')
    ELSE false
  END) THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_VERSION' USING ERRCODE = 'EN718';
  END IF;

  IF NEW.status = 'accepted' THEN
    -- The token said which proposal. Who is accepting comes from the bound tenant and nowhere else.
    IF NEW.receiving_organization_id IS DISTINCT FROM bound OR bound = OLD.sharing_organization_id THEN
      RAISE EXCEPTION 'FEDERATION_NOT_A_PARTY' USING ERRCODE = 'EN711';
    END IF;
    IF OLD.invitation_expires_at <= now() THEN
      RAISE EXCEPTION 'FEDERATION_EXPIRED' USING ERRCODE = 'EN713';
    END IF;
    IF NEW.accepted_terms_hash IS DISTINCT FROM OLD.terms_hash THEN
      RAISE EXCEPTION 'FEDERATION_TERMS_MISMATCH' USING ERRCODE = 'EN720';
    END IF;
    IF NEW.receiving_display_name IS DISTINCT FROM (SELECT o.name FROM org.organizations o WHERE o.id = bound) THEN
      RAISE EXCEPTION 'FEDERATION_NAME_MISMATCH' USING ERRCODE = 'EN712';
    END IF;
    IF NEW.confirmed_by_membership_id IS NOT NULL OR NEW.confirmed_terms_hash IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
    END IF;
    PERFORM federation.assert_can_consent(bound, NEW.accepted_by_membership_id);
    RETURN NEW;
  END IF;

  -- From here on, only the two parties, and who they are no longer changes.
  IF bound <> OLD.sharing_organization_id AND bound IS DISTINCT FROM OLD.receiving_organization_id THEN
    RAISE EXCEPTION 'FEDERATION_NOT_A_PARTY' USING ERRCODE = 'EN711';
  END IF;
  IF NEW.receiving_organization_id IS DISTINCT FROM OLD.receiving_organization_id
     OR NEW.receiving_display_name IS DISTINCT FROM OLD.receiving_display_name
     OR NEW.accepted_by_membership_id IS DISTINCT FROM OLD.accepted_by_membership_id
     OR NEW.accepted_terms_hash IS DISTINCT FROM OLD.accepted_terms_hash
     OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
  END IF;

  IF NEW.status = 'active' THEN
    -- The third step: the sharing side has now seen who accepted, and says that is who it meant.
    IF bound <> OLD.sharing_organization_id THEN
      RAISE EXCEPTION 'FEDERATION_NOT_A_PARTY' USING ERRCODE = 'EN711';
    END IF;
    IF OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'FEDERATION_EXPIRED' USING ERRCODE = 'EN713';
    END IF;
    IF NEW.confirmed_terms_hash IS DISTINCT FROM OLD.terms_hash THEN
      RAISE EXCEPTION 'FEDERATION_TERMS_MISMATCH' USING ERRCODE = 'EN720';
    END IF;
    PERFORM federation.assert_can_consent(bound, NEW.confirmed_by_membership_id);
    RETURN NEW;
  END IF;

  -- Ended. Waits for any crossing in flight, and any crossing after this sees it closed.
  PERFORM pg_advisory_xact_lock(federation.grant_lock_key(OLD.id));
  IF NEW.confirmed_by_membership_id IS DISTINCT FROM OLD.confirmed_by_membership_id
     OR NEW.confirmed_terms_hash IS DISTINCT FROM OLD.confirmed_terms_hash
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
  END IF;
  IF NEW.ended_by_organization_id IS DISTINCT FROM bound THEN
    RAISE EXCEPTION 'FEDERATION_NOT_A_PARTY' USING ERRCODE = 'EN711';
  END IF;
  CASE NEW.end_reason
    WHEN 'expired' THEN
      -- Nobody decided this, so nobody is named, and it is only true once the date has passed.
      IF NEW.ended_by_membership_id IS NOT NULL
         OR NOT ((OLD.status = 'proposed' AND OLD.invitation_expires_at <= now()) OR OLD.expires_at <= now()) THEN
        RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
      END IF;
    WHEN 'cancelled' THEN
      IF OLD.status NOT IN ('proposed','accepted') OR bound <> OLD.sharing_organization_id THEN
        RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
      END IF;
    WHEN 'declined' THEN
      IF OLD.status <> 'accepted' OR bound IS DISTINCT FROM OLD.receiving_organization_id THEN
        RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
      END IF;
    WHEN 'revoked' THEN
      IF OLD.status <> 'active' THEN
        RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
      END IF;
    WHEN 'disabled' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
  END CASE;
  -- Stopping is easier than starting: an admin can end what only an owner could begin. `disabled` can also
  -- come from a worker with nobody behind it, because offboarding winds a tenant down that way, and ending
  -- something is the safe direction.
  IF NEW.end_reason NOT IN ('expired','disabled') OR NEW.ended_by_membership_id IS NOT NULL THEN
    IF NEW.end_reason <> 'expired' AND NOT EXISTS (
      SELECT 1 FROM org.memberships m
       WHERE m.organization_id = bound AND m.id = NEW.ended_by_membership_id
         AND m.status = 'active' AND m.role IN ('owner','admin')
    ) THEN
      RAISE EXCEPTION 'FEDERATION_NOT_AN_ADMIN' USING ERRCODE = 'EN721';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER grants_check_change
  BEFORE UPDATE ON federation.grants
  FOR EACH ROW EXECUTE FUNCTION federation.check_grant_change();
--> statement-breakpoint
CREATE TRIGGER grants_keep
  BEFORE DELETE OR TRUNCATE ON federation.grants
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- --- outbound_items: what one tenant has chosen to send, in its own tenant. A copy, written by a person,
-- holding only the fields a contract allows. The source record is never read across the boundary.
GRANT SELECT, INSERT, DELETE ON federation.outbound_items TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, withdrawn_at, version) ON federation.outbound_items TO ensemus_app;
--> statement-breakpoint
CREATE POLICY tenant_scoped ON federation.outbound_items TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

CREATE FUNCTION federation.check_new_outbound_item() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  parties record;
  direction text;
BEGIN
  IF NEW.state <> 'queued' OR NEW.version <> 1 OR NEW.delivered_at IS NOT NULL
     OR NEW.withdrawn_at IS NOT NULL OR NEW.refuse_code IS NOT NULL THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_START' USING ERRCODE = 'EN710';
  END IF;
  SELECT g.sharing_organization_id AS sharing, g.receiving_organization_id AS receiving,
         g.purpose, g.max_classification
    INTO parties
    FROM federation.grants g
   WHERE g.id = NEW.grant_id;
  IF NOT FOUND OR NOT federation.grant_is_open(NEW.grant_id) THEN
    RAISE EXCEPTION 'FEDERATION_GRANT_NOT_OPEN' USING ERRCODE = 'EN722';
  END IF;
  IF NEW.organization_id = parties.sharing THEN
    direction := 'forward';
  ELSIF NEW.organization_id = parties.receiving THEN
    direction := 'return';
  ELSE
    RAISE EXCEPTION 'FEDERATION_NOT_A_PARTY' USING ERRCODE = 'EN711';
  END IF;
  IF NOT (NEW.kind = ANY (federation.kinds_for(parties.purpose, direction))) THEN
    RAISE EXCEPTION 'FEDERATION_KIND_NOT_ALLOWED' USING ERRCODE = 'EN723';
  END IF;
  IF federation.classification_rank(NEW.classification) > federation.classification_rank(parties.max_classification) THEN
    RAISE EXCEPTION 'FEDERATION_CLASSIFICATION_TOO_HIGH' USING ERRCODE = 'EN724';
  END IF;
  -- Written by a person with the standing to send it. No agent and no service sends anything.
  IF NOT EXISTS (
    SELECT 1 FROM org.memberships m
     WHERE m.organization_id = NEW.organization_id AND m.id = NEW.created_by_membership_id
       AND m.status = 'active' AND m.role IN ('owner','admin')
  ) THEN
    RAISE EXCEPTION 'FEDERATION_NOT_AN_ADMIN' USING ERRCODE = 'EN721';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER outbound_items_check_new
  BEFORE INSERT ON federation.outbound_items
  FOR EACH ROW EXECUTE FUNCTION federation.check_new_outbound_item();
--> statement-breakpoint

-- Delivered and refused are the bridge's word, and withdrawn is the sender's. The transitions match
-- FEDERATION_ITEM_TRANSITIONS in @ensemus/domain/federation.
CREATE FUNCTION federation.check_outbound_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT (CASE OLD.state
    WHEN 'queued' THEN NEW.state IN ('delivered','refused','withdrawn')
    WHEN 'delivered' THEN NEW.state IN ('withdrawn')
    ELSE false
  END) THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_VERSION' USING ERRCODE = 'EN718';
  END IF;
  IF NEW.state IN ('delivered','refused') AND current_user <> 'ensemus_federation' THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
  END IF;
  IF NEW.state = 'withdrawn' AND current_user = 'ensemus_federation' THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER outbound_items_check_change
  BEFORE UPDATE ON federation.outbound_items
  FOR EACH ROW EXECUTE FUNCTION federation.check_outbound_change();
--> statement-breakpoint
-- A copy that was taken back goes, so a deleted source leaves nothing behind in a copy. Anything still queued
-- or delivered stays: it has to be withdrawn first, which is what tells the other side. The foreign key from
-- inbound_items holds it here until the receiver's copy has been purged.
CREATE FUNCTION federation.check_outbound_delete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.state NOT IN ('withdrawn','refused') THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER outbound_items_check_delete
  BEFORE DELETE ON federation.outbound_items
  FOR EACH ROW EXECUTE FUNCTION federation.check_outbound_delete();
--> statement-breakpoint
CREATE TRIGGER outbound_items_keep
  BEFORE TRUNCATE ON federation.outbound_items
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- --- inbound_items: what has arrived, in the receiving tenant. The application can read it only while
-- the grant is open, so revoking removes it from every page on commit, before the purge has run. It can
-- record what a person decided about it, and can never write one, so a tenant cannot forge an arrival.
GRANT SELECT ON federation.inbound_items TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (disposition, disposed_by_membership_id, disposed_at, linked_work_unit_id, version)
  ON federation.inbound_items TO ensemus_app;
--> statement-breakpoint
CREATE POLICY inbound_receiver_read ON federation.inbound_items FOR SELECT TO ensemus_app
  USING (organization_id = app.current_organization_id() AND federation.grant_is_open(grant_id));
--> statement-breakpoint
CREATE POLICY inbound_receiver_update ON federation.inbound_items FOR UPDATE TO ensemus_app
  USING (organization_id = app.current_organization_id() AND federation.grant_is_open(grant_id))
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

-- An arrival is an exact copy of a queued outbound row of this grant, going to the other party. The role
-- can do nothing else with this table's content: it cannot read a title or a body back.
CREATE FUNCTION federation.check_new_inbound_item() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  parties record;
  sent record;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(federation.grant_lock_key(NEW.grant_id));
  SELECT g.sharing_organization_id AS sharing, g.receiving_organization_id AS receiving
    INTO parties
    FROM federation.grants g
   WHERE g.id = NEW.grant_id;
  IF NOT FOUND OR NOT federation.grant_is_open(NEW.grant_id) THEN
    RAISE EXCEPTION 'FEDERATION_GRANT_NOT_OPEN' USING ERRCODE = 'EN722';
  END IF;
  IF NOT ((NEW.sender_organization_id = parties.sharing AND NEW.organization_id = parties.receiving)
          OR (NEW.sender_organization_id = parties.receiving AND NEW.organization_id = parties.sharing)) THEN
    RAISE EXCEPTION 'FEDERATION_NOT_A_PARTY' USING ERRCODE = 'EN711';
  END IF;
  SELECT o.kind, o.classification, o.title, o.body, o.content_sha256, o.file_sha256,
         o.file_size_bytes, o.file_mime_type, o.state
    INTO sent
    FROM federation.outbound_items o
   WHERE o.organization_id = NEW.sender_organization_id
     AND o.id = NEW.id
     AND o.grant_id = NEW.grant_id;
  IF NOT FOUND OR sent.state <> 'queued' THEN
    RAISE EXCEPTION 'FEDERATION_ITEM_MISMATCH' USING ERRCODE = 'EN725';
  END IF;
  IF NEW.kind IS DISTINCT FROM sent.kind
     OR NEW.classification IS DISTINCT FROM sent.classification
     OR NEW.title IS DISTINCT FROM sent.title
     OR NEW.body IS DISTINCT FROM sent.body
     OR NEW.content_sha256 IS DISTINCT FROM sent.content_sha256
     OR NEW.file_sha256 IS DISTINCT FROM sent.file_sha256
     OR NEW.file_size_bytes IS DISTINCT FROM sent.file_size_bytes
     OR NEW.file_mime_type IS DISTINCT FROM sent.file_mime_type THEN
    RAISE EXCEPTION 'FEDERATION_ITEM_MISMATCH' USING ERRCODE = 'EN725';
  END IF;
  IF NEW.disposition <> 'pending' OR NEW.version <> 1 OR NEW.disposed_by_membership_id IS NOT NULL
     OR NEW.disposed_at IS NOT NULL OR NEW.linked_work_unit_id IS NOT NULL THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_START' USING ERRCODE = 'EN710';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER inbound_items_check_new
  BEFORE INSERT ON federation.inbound_items
  FOR EACH ROW EXECUTE FUNCTION federation.check_new_inbound_item();
--> statement-breakpoint

-- A person's answer, once. Accepting makes nothing happen by itself: it can only point at a Work Unit a
-- person created in their own tenant.
CREATE FUNCTION federation.check_inbound_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT (CASE OLD.disposition
    WHEN 'pending' THEN NEW.disposition IN ('accepted','rejected')
    WHEN 'accepted' THEN NEW.disposition IN ('accepted')
    ELSE false
  END) THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE = 'EN716';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_VERSION' USING ERRCODE = 'EN718';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM org.memberships m
     WHERE m.organization_id = NEW.organization_id AND m.id = NEW.disposed_by_membership_id
       AND m.status = 'active' AND m.role IN ('owner','admin')
  ) THEN
    RAISE EXCEPTION 'FEDERATION_NOT_AN_ADMIN' USING ERRCODE = 'EN721';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER inbound_items_check_change
  BEFORE UPDATE ON federation.inbound_items
  FOR EACH ROW EXECUTE FUNCTION federation.check_inbound_change();
--> statement-breakpoint

-- --- crossings: everything that went over, and everything removed after, for both parties to read. It
-- holds a hash and a kind, and no content, and it is kept as written for everyone including the owner.
GRANT SELECT ON federation.crossings TO ensemus_app;
--> statement-breakpoint
CREATE POLICY crossings_party_read ON federation.crossings FOR SELECT TO ensemus_app
  USING (sender_organization_id = app.current_organization_id()
         OR receiver_organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE TRIGGER crossings_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON federation.crossings
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- --- the bridge role. `ensemus_federation` is the only role that writes to one tenant from another, and
-- it can see one grant per transaction. It has no business table, no secret and no person in reach: no
-- work, org, identity, platform, governance, secrets or integrations. It does not exist unless an operator
-- created it, because only a superuser can and the migrator cannot, so a deployment that never turned this
-- on has no role, no password and no worker that could cross (ADR-035 D2). So these grants and policies
-- wait inside this function. The migrate job calls it each time it runs, and it does nothing until the
-- role is there. It refuses a role anyone made stronger than the rules allow.
CREATE FUNCTION federation.apply_bridge_grants() RETURNS boolean
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ensemus_federation') THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'ensemus_federation'
       AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)
  ) THEN
    RAISE EXCEPTION 'FEDERATION_ROLE_TOO_STRONG' USING ERRCODE = 'EN726';
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ensemus_federation', current_database());
  GRANT USAGE ON SCHEMA app, federation, tenancy TO ensemus_federation;

  GRANT SELECT (cross_org_enabled) ON tenancy.deployment_profile TO ensemus_federation;
  GRANT SELECT (id, sharing_organization_id, receiving_organization_id, status, purpose,
                max_classification, expires_at)
    ON federation.grants TO ensemus_federation;
  GRANT SELECT ON federation.outbound_items TO ensemus_federation;
  GRANT UPDATE (state, refuse_code, delivered_at, version)
    ON federation.outbound_items TO ensemus_federation;
  GRANT INSERT, DELETE ON federation.inbound_items TO ensemus_federation;
  GRANT SELECT (organization_id, id, grant_id, kind, content_sha256, file_object_key)
    ON federation.inbound_items TO ensemus_federation;
  GRANT INSERT ON federation.crossings TO ensemus_federation;

  DROP POLICY IF EXISTS bridge_profile ON tenancy.deployment_profile;
  CREATE POLICY bridge_profile ON tenancy.deployment_profile FOR SELECT TO ensemus_federation
    USING (true);

  DROP POLICY IF EXISTS bridge_grant ON federation.grants;
  CREATE POLICY bridge_grant ON federation.grants FOR SELECT TO ensemus_federation
    USING (id = app.current_federation_grant_id());

  DROP POLICY IF EXISTS bridge_outbound_read ON federation.outbound_items;
  CREATE POLICY bridge_outbound_read ON federation.outbound_items FOR SELECT TO ensemus_federation
    USING (grant_id = app.current_federation_grant_id() AND federation.grant_is_open(grant_id));

  DROP POLICY IF EXISTS bridge_outbound_settle ON federation.outbound_items;
  CREATE POLICY bridge_outbound_settle ON federation.outbound_items FOR UPDATE TO ensemus_federation
    USING (grant_id = app.current_federation_grant_id() AND federation.grant_is_open(grant_id))
    WITH CHECK (grant_id = app.current_federation_grant_id());

  DROP POLICY IF EXISTS bridge_inbound_read ON federation.inbound_items;
  CREATE POLICY bridge_inbound_read ON federation.inbound_items FOR SELECT TO ensemus_federation
    USING (grant_id = app.current_federation_grant_id());

  DROP POLICY IF EXISTS bridge_inbound_deliver ON federation.inbound_items;
  CREATE POLICY bridge_inbound_deliver ON federation.inbound_items FOR INSERT TO ensemus_federation
    WITH CHECK (grant_id = app.current_federation_grant_id());

  DROP POLICY IF EXISTS bridge_inbound_purge ON federation.inbound_items;
  CREATE POLICY bridge_inbound_purge ON federation.inbound_items FOR DELETE TO ensemus_federation
    USING (grant_id = app.current_federation_grant_id());

  DROP POLICY IF EXISTS bridge_crossing ON federation.crossings;
  CREATE POLICY bridge_crossing ON federation.crossings FOR INSERT TO ensemus_federation
    WITH CHECK (
      grant_id = app.current_federation_grant_id()
      AND EXISTS (
        SELECT 1 FROM federation.grants g
         WHERE g.id = grant_id
           AND ((g.sharing_organization_id = sender_organization_id
                 AND g.receiving_organization_id = receiver_organization_id)
                OR (g.sharing_organization_id = receiver_organization_id
                    AND g.receiving_organization_id = sender_organization_id))
      )
    );
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION federation.apply_bridge_grants() FROM PUBLIC;
--> statement-breakpoint
SELECT federation.apply_bridge_grants();
