-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Proposed security SQL (0571, platform email). Idempotent, and run before every migration by
-- upgrade-roles.sh, so a new install and an old one both get the role before 0571 grants it anything.
-- The mail worker's login: no elevated attribute, no parent role, and nothing granted here but CONNECT.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ensemus_mailer') THEN
    CREATE ROLE ensemus_mailer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication
      FROM pg_roles WHERE rolname = 'ensemus_mailer') THEN
    RAISE EXCEPTION 'ROLE_UNSAFE: ensemus_mailer has elevated role attributes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members membership
    JOIN pg_roles child ON child.oid = membership.member
    WHERE child.rolname = 'ensemus_mailer'
  ) THEN
    RAISE EXCEPTION 'ROLE_UNSAFE: ensemus_mailer is a member of another role';
  END IF;
END $$;
ALTER ROLE ensemus_mailer WITH LOGIN PASSWORD :'mailer_password';
GRANT CONNECT ON DATABASE ensemus TO ensemus_mailer;
