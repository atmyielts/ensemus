-- Reviewed security SQL. Run once by a superuser against a new server, using psql variables.
-- Runtime roles get no CREATEROLE, SUPERUSER or BYPASSRLS (ADR-024 D4).

CREATE ROLE ensemus_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ensemus_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ensemus_agent LOGIN PASSWORD :'agent_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS IN ROLE ensemus_app;
CREATE ROLE ensemus_auth LOGIN PASSWORD :'auth_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ensemus_dispatcher LOGIN PASSWORD :'dispatcher_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ensemus_secrets LOGIN PASSWORD :'secrets_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE temporal LOGIN PASSWORD :'temporal_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;

CREATE DATABASE ensemus OWNER ensemus_migrator;
CREATE DATABASE temporal OWNER temporal;
CREATE DATABASE temporal_visibility OWNER temporal;

REVOKE ALL ON DATABASE ensemus FROM PUBLIC;
REVOKE ALL ON DATABASE temporal FROM PUBLIC;
REVOKE ALL ON DATABASE temporal_visibility FROM PUBLIC;
GRANT CONNECT ON DATABASE ensemus TO ensemus_app, ensemus_agent, ensemus_auth, ensemus_dispatcher, ensemus_secrets;

\connect ensemus
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
