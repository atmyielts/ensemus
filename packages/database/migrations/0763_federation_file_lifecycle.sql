-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (EXP-07, ADR-035 D3/D4). Human security review remains pending.
-- The sender's copy record retains authority through revocation and until both keys are proved absent.
ALTER TABLE federation.outbound_items
  ADD COLUMN copy_receiver_organization_id uuid,
  ADD COLUMN copy_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN inbound_delete_state text NOT NULL DEFAULT 'pending',
  ADD COLUMN outbound_delete_state text NOT NULL DEFAULT 'pending',
  ADD CONSTRAINT outbound_items_receiver_copy_key UNIQUE (copy_receiver_organization_id, id),
  ADD CONSTRAINT outbound_items_copy_verification CHECK (
    NOT copy_verified OR copy_receiver_organization_id IS NOT NULL
  ),
  ADD CONSTRAINT outbound_items_delete_states CHECK (
    inbound_delete_state IN ('pending','admitted','proved')
    AND outbound_delete_state IN ('pending','admitted','proved')
  );
--> statement-breakpoint
GRANT UPDATE (copy_receiver_organization_id, copy_verified, inbound_delete_state, outbound_delete_state)
  ON federation.outbound_items TO ensemus_worker;
--> statement-breakpoint
CREATE FUNCTION federation.check_new_copy_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.copy_receiver_organization_id IS NOT NULL OR NEW.copy_verified
    OR NEW.inbound_delete_state <> 'pending' OR NEW.outbound_delete_state <> 'pending' THEN
    RAISE EXCEPTION 'FEDERATION_COPY_LIFECYCLE_INVALID' USING ERRCODE='EN727';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION federation.check_new_copy_lifecycle() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER outbound_items_check_new_copy_lifecycle
  BEFORE INSERT ON federation.outbound_items
  FOR EACH ROW EXECUTE FUNCTION federation.check_new_copy_lifecycle();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION federation.check_outbound_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE receiver uuid;
BEGIN
  IF ROW(NEW.copy_receiver_organization_id,NEW.copy_verified,NEW.inbound_delete_state,NEW.outbound_delete_state)
    IS DISTINCT FROM
    ROW(OLD.copy_receiver_organization_id,OLD.copy_verified,OLD.inbound_delete_state,OLD.outbound_delete_state) THEN
    IF current_user <> 'ensemus_worker' OR session_user <> current_user
      OR app.current_actor_type() IS DISTINCT FROM 'service'
      OR app.current_organization_id() IS DISTINCT FROM OLD.organization_id
      OR OLD.kind <> 'artifact' OR OLD.file_object_key IS NULL
      OR ROW(NEW.state,NEW.refuse_code,NEW.delivered_at,NEW.withdrawn_at,NEW.version)
        IS DISTINCT FROM ROW(OLD.state,OLD.refuse_code,OLD.delivered_at,OLD.withdrawn_at,OLD.version) THEN
      RAISE EXCEPTION 'FEDERATION_COPY_WORKER_REQUIRED' USING ERRCODE='42501';
    END IF;

    IF NEW.copy_receiver_organization_id IS DISTINCT FROM OLD.copy_receiver_organization_id THEN
      SELECT CASE
               WHEN g.sharing_organization_id=OLD.organization_id THEN g.receiving_organization_id
               WHEN g.receiving_organization_id=OLD.organization_id THEN g.sharing_organization_id
             END INTO receiver
        FROM federation.grants g
       WHERE g.id=OLD.grant_id AND g.expires_at>clock_timestamp();
      IF OLD.copy_receiver_organization_id IS NOT NULL OR receiver IS NULL
        OR NEW.copy_receiver_organization_id IS DISTINCT FROM receiver
        OR OLD.state <> 'queued' OR NOT federation.grant_is_open(OLD.grant_id)
        OR NEW.copy_verified OR NEW.inbound_delete_state <> 'pending'
        OR NEW.outbound_delete_state <> 'pending' THEN
        RAISE EXCEPTION 'FEDERATION_COPY_LIFECYCLE_INVALID' USING ERRCODE='EN727';
      END IF;
    ELSIF NEW.copy_verified IS DISTINCT FROM OLD.copy_verified THEN
      IF OLD.copy_receiver_organization_id IS NULL OR NOT NEW.copy_verified
        OR NEW.inbound_delete_state <> OLD.inbound_delete_state
        OR NEW.outbound_delete_state <> OLD.outbound_delete_state THEN
        RAISE EXCEPTION 'FEDERATION_COPY_LIFECYCLE_INVALID' USING ERRCODE='EN727';
      END IF;
    ELSE
      IF OLD.state NOT IN ('withdrawn','refused')
        OR (OLD.copy_receiver_organization_id IS NOT NULL AND NOT OLD.copy_verified)
        OR (NEW.inbound_delete_state <> OLD.inbound_delete_state AND
            NEW.outbound_delete_state <> OLD.outbound_delete_state)
        OR (NEW.inbound_delete_state <> OLD.inbound_delete_state
            AND OLD.copy_receiver_organization_id IS NULL
            AND (OLD.delivered_at IS NOT NULL OR NEW.inbound_delete_state <> 'proved'))
        OR (NEW.inbound_delete_state <> OLD.inbound_delete_state AND NOT (
            OLD.inbound_delete_state='pending' OR
            (OLD.inbound_delete_state='admitted' AND NEW.inbound_delete_state='proved')))
        OR (NEW.outbound_delete_state <> OLD.outbound_delete_state AND NOT (
            OLD.outbound_delete_state='pending' OR
            (OLD.outbound_delete_state='admitted' AND NEW.outbound_delete_state='proved'))) THEN
        RAISE EXCEPTION 'FEDERATION_COPY_LIFECYCLE_INVALID' USING ERRCODE='EN727';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (CASE OLD.state
    WHEN 'queued' THEN NEW.state IN ('delivered','refused','withdrawn')
    WHEN 'delivered' THEN NEW.state IN ('withdrawn')
    ELSE false
  END) THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE='EN716';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_VERSION' USING ERRCODE='EN718';
  END IF;
  IF NEW.state IN ('delivered','refused') AND current_user <> 'ensemus_federation' THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE='EN716';
  END IF;
  IF NEW.state='withdrawn' AND current_user='ensemus_federation' THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE='EN716';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION federation.check_outbound_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.state NOT IN ('withdrawn','refused') THEN
    RAISE EXCEPTION 'FEDERATION_INVALID_TRANSITION' USING ERRCODE='EN716';
  END IF;
  IF OLD.file_object_key IS NOT NULL AND (
    OLD.inbound_delete_state <> 'proved' OR OLD.outbound_delete_state <> 'proved'
  ) THEN
    RAISE EXCEPTION 'FEDERATION_FILE_DELETE_UNPROVEN' USING ERRCODE='EN728';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE FUNCTION federation.check_inbound_copy_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.kind='artifact' AND NOT EXISTS (
    SELECT 1 FROM federation.outbound_items o
     WHERE o.organization_id=NEW.sender_organization_id AND o.id=NEW.id
       AND o.grant_id=NEW.grant_id AND o.copy_receiver_organization_id=NEW.organization_id
       AND o.copy_verified
  ) THEN
    RAISE EXCEPTION 'FEDERATION_FILE_PROOF_REQUIRED' USING ERRCODE='EN727';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION federation.check_inbound_copy_receipt() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER inbound_items_check_verified_file
  BEFORE INSERT ON federation.inbound_items
  FOR EACH ROW EXECUTE FUNCTION federation.check_inbound_copy_receipt();
