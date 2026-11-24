-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Provisioned only by the opt-in job. Migration installs the scoped object grants afterwards.
\getenv federation_password ENSEMUS_FEDERATION_DB_PASSWORD
BEGIN;
-- Provisioning and password rotation use the same lock even when started twice.
SELECT pg_advisory_xact_lock(7236035);
DO $$
DECLARE bridge pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO bridge FROM pg_roles WHERE rolname = 'ensemus_federation';
  IF NOT FOUND THEN
    CREATE ROLE ensemus_federation LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ELSIF bridge.rolsuper OR bridge.rolcreatedb OR bridge.rolcreaterole OR bridge.rolreplication OR bridge.rolbypassrls
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=bridge.oid OR roleid=bridge.oid) THEN
    RAISE EXCEPTION 'FEDERATION_ROLE_TOO_STRONG' USING ERRCODE='EN726';
  END IF;
END $$;
ALTER ROLE ensemus_federation WITH LOGIN NOINHERIT PASSWORD :'federation_password';
COMMIT;
