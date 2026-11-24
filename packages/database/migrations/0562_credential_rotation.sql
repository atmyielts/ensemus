-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D5, ADR-038 D2). Changes here need human review, never agent approval.
-- Not yet reviewed by a person. Error code: EN124, a sealed value replaced in a way refresh-token rotation
-- does not need.

-- Microsoft returns a new refresh token on every refresh, and the old one stops working soon after, so the
-- connector worker has to keep the new one. 0561 refuses a new credential_secret_id from the service
-- context, so the credential is resealed in place under the same ID instead. The broker can already
-- rewrap a data key (key_id, wrapped_key); this lets it replace the value under a fresh data key too.
GRANT UPDATE (iv, ciphertext, auth_tag) ON secrets.sealed_secrets TO ensemus_secrets;
--> statement-breakpoint

-- Only a live connector credential, only by the broker, and only the seal itself changes. The tenant, ID
-- and purpose are in the AES-GCM additional data, so a value moved under another of them would not open
-- anyway, but the row must not move either: connections and audit find the secret by that pair. The IV
-- must change, so the same data key and IV can never seal two values. Key rotation alone (key_id and
-- wrapped_key) does not reach this trigger and keeps working as before.
CREATE FUNCTION secrets.guard_sealed_value_replacement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'secrets.sealed_secrets'::regclass OR TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'SEALED_VALUE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF (NEW.iv IS NOT DISTINCT FROM OLD.iv AND NEW.ciphertext IS NOT DISTINCT FROM OLD.ciphertext
    AND NEW.auth_tag IS NOT DISTINCT FROM OLD.auth_tag) THEN RETURN NEW;END IF;
  IF current_user<>'ensemus_secrets'
    OR OLD.purpose<>'connector_credential'
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.iv IS NOT DISTINCT FROM OLD.iv
    OR NEW.wrapped_key IS NOT DISTINCT FROM OLD.wrapped_key THEN
    RAISE EXCEPTION 'SEALED_VALUE_REPLACEMENT_REFUSED' USING ERRCODE='EN124';END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION secrets.guard_sealed_value_replacement() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER sealed_value_replacement_guard
  BEFORE UPDATE OF iv, ciphertext, auth_tag ON secrets.sealed_secrets
  FOR EACH ROW EXECUTE FUNCTION secrets.guard_sealed_value_replacement();
