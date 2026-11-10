-- Reviewed security SQL (ADR-032 D3). For a server provisioned before M8: provision.sql runs only on an
-- empty data directory, and the migrator cannot create roles, so a superuser runs this once before the
-- M8 migrations. Running it again changes nothing. No role here can log in, and no password is set.
--   psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres -f upgrade-roles-m8.sql
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ensemus_operator', 'ensemus_support', 'ensemus_eraser'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS', r);
    END IF;
  END LOOP;
END $$;

GRANT CONNECT ON DATABASE ensemus TO ensemus_operator, ensemus_support, ensemus_eraser;
