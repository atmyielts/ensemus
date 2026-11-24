-- Reviewed security SQL (ADR-034 D6). Optional, and run by hand: once, by a superuser, only on a server
-- whose operator has chosen to run a marketplace, after migrations have reached 0651.
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d postgres -v marketplace_password="$(cat <secret file>)" \
--     -f provision-marketplace.sql
--
-- A runtime role with no CREATEROLE, SUPERUSER or BYPASSRLS, like every other (ADR-024 D4). Used only by
-- the marketplace operator command, never by the web tier or a worker. Nothing starts this automatically,
-- and first-boot provisioning does not create the role. Until someone runs this, the marketplace is empty.
CREATE ROLE ensemus_marketplace LOGIN PASSWORD :'marketplace_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE ensemus TO ensemus_marketplace;

\connect ensemus
-- As the owner, so the grants and policies are the same ones the migration would have made.
SET ROLE ensemus_migrator;
SELECT marketplace.grant_operator_role();
RESET ROLE;
