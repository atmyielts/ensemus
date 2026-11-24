-- FLAGGED FOR HUMAN SECURITY REVIEW
-- A public listing names a shared manifest-digest key. Reserve the exact signed bundle bytes before
-- a PUT so an uncertain response cannot let a different key-holder's signature replace that object.
CREATE TABLE marketplace.listing_object_reservations (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  bundle_sha256 text NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608)
);
ALTER TABLE marketplace.listing_object_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace.listing_object_reservations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON marketplace.listing_object_reservations FROM PUBLIC;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text := pg_get_functiondef('marketplace.grant_operator_role()'::regprocedure);
  anchor constant text := 'GRANT SELECT, INSERT ON marketplace.listings TO ensemus_marketplace;';
BEGIN
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
    RAISE EXCEPTION 'MARKETPLACE_OPERATOR_GRANT_CHANGED' USING ERRCODE='EN850';
  END IF;
  EXECUTE replace(definition,anchor,anchor||$operator$
  GRANT SELECT, INSERT ON marketplace.listing_object_reservations TO ensemus_marketplace;
  DROP POLICY IF EXISTS reservation_operator_read ON marketplace.listing_object_reservations;
  DROP POLICY IF EXISTS reservation_operator_insert ON marketplace.listing_object_reservations;
  CREATE POLICY reservation_operator_read ON marketplace.listing_object_reservations FOR SELECT TO ensemus_marketplace
    USING (session_user='ensemus_marketplace' AND current_user=session_user);
  CREATE POLICY reservation_operator_insert ON marketplace.listing_object_reservations FOR INSERT TO ensemus_marketplace
    WITH CHECK (session_user='ensemus_marketplace' AND current_user=session_user);
  $operator$);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ensemus_marketplace') THEN
    PERFORM marketplace.grant_operator_role();
  END IF;
END $migration$;
--> statement-breakpoint
CREATE FUNCTION marketplace.require_listing_object_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF session_user<>'ensemus_marketplace' OR current_user<>session_user
    OR TG_RELID<>'marketplace.listings'::regclass OR TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'MARKETPLACE_OPERATOR_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF NEW.object_key IS DISTINCT FROM 'marketplace/'||NEW.digest
    OR NOT EXISTS (SELECT 1 FROM marketplace.listing_object_reservations r
      WHERE r.digest=NEW.digest AND r.size_bytes=NEW.size_bytes) THEN
    RAISE EXCEPTION 'MARKETPLACE_OBJECT_NOT_RESERVED' USING ERRCODE='ES005';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION marketplace.require_listing_object_reservation() FROM PUBLIC;
CREATE TRIGGER marketplace_object_reservation_required
  BEFORE INSERT ON marketplace.listings
  FOR EACH ROW EXECUTE FUNCTION marketplace.require_listing_object_reservation();
