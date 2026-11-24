-- Idempotent role provisioning before tenant migrations (ADR-039 D1). Proposed security SQL, to be reviewed
-- before any real credential is stored. Each worker logs in as itself, as ensemus_agent does: a member of
-- ensemus_app and nothing else, with no attribute beyond LOGIN. 0700 refuses to run until these exist, and
-- checks the same things again. Running this again changes nothing but the passwords, to the mounted ones.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ensemus_worker', 'ensemus_connector', 'ensemus_knowledge'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION INHERIT IN ROLE ensemus_app',
        r);
    END IF;
    IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication OR NOT rolinherit
        FROM pg_roles WHERE rolname = r) THEN
      RAISE EXCEPTION 'ROLE_UNSAFE: % has elevated role attributes', r;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_auth_members membership
      JOIN pg_roles parent ON parent.oid = membership.roleid
      JOIN pg_roles child ON child.oid = membership.member
      WHERE child.rolname = r AND parent.rolname <> 'ensemus_app'
    ) THEN
      RAISE EXCEPTION 'ROLE_UNSAFE: % has an unexpected parent role', r;
    END IF;
  END LOOP;
END $$;
ALTER ROLE ensemus_worker WITH LOGIN PASSWORD :'worker_password';
ALTER ROLE ensemus_connector WITH LOGIN PASSWORD :'connector_password';
ALTER ROLE ensemus_knowledge WITH LOGIN PASSWORD :'knowledge_password';
GRANT ensemus_app TO ensemus_worker, ensemus_connector, ensemus_knowledge;
GRANT CONNECT ON DATABASE ensemus TO ensemus_worker, ensemus_connector, ensemus_knowledge;
