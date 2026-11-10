-- Idempotent role provisioning before tenant migrations (ADR-028 FD-4).
-- Proposed security SQL, to be reviewed before any real credential is stored.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ensemus_agent') THEN
    CREATE ROLE ensemus_agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE ensemus_app;
  END IF;
  IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication
      FROM pg_roles WHERE rolname = 'ensemus_agent') THEN
    RAISE EXCEPTION 'ROLE_UNSAFE: ensemus_agent has elevated role attributes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members membership
    JOIN pg_roles parent ON parent.oid = membership.roleid
    JOIN pg_roles child ON child.oid = membership.member
    WHERE child.rolname = 'ensemus_agent' AND parent.rolname <> 'ensemus_app'
  ) THEN
    RAISE EXCEPTION 'ROLE_UNSAFE: ensemus_agent has an unexpected parent role';
  END IF;
END $$;
ALTER ROLE ensemus_agent WITH LOGIN PASSWORD :'agent_password';
GRANT ensemus_app TO ensemus_agent;
GRANT CONNECT ON DATABASE ensemus TO ensemus_agent;
