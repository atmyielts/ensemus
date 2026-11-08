-- Reviewed security SQL. Run once by a superuser against a new server, using psql variables.
-- Runtime roles get no CREATEROLE, SUPERUSER or BYPASSRLS (ADR-024 D4).

CREATE ROLE ensemus_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ensemus_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ensemus_agent LOGIN PASSWORD :'agent_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS IN ROLE ensemus_app;
CREATE ROLE ensemus_auth LOGIN PASSWORD :'auth_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ensemus_dispatcher LOGIN PASSWORD :'dispatcher_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ensemus_secrets LOGIN PASSWORD :'secrets_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE temporal LOGIN PASSWORD :'temporal_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
-- ADR-032 D3. These three start unable to log in, so no credential for them exists until an operator
-- deliberately gives one. Nothing in the default install can act as the desk, the operator or the eraser.
CREATE ROLE ensemus_operator NOLOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ensemus_support NOLOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ensemus_eraser NOLOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS;

CREATE DATABASE ensemus OWNER ensemus_migrator;
CREATE DATABASE temporal OWNER temporal;
CREATE DATABASE temporal_visibility OWNER temporal;

REVOKE ALL ON DATABASE ensemus FROM PUBLIC;
REVOKE ALL ON DATABASE temporal FROM PUBLIC;
REVOKE ALL ON DATABASE temporal_visibility FROM PUBLIC;
GRANT CONNECT ON DATABASE ensemus TO ensemus_app, ensemus_agent, ensemus_auth, ensemus_dispatcher, ensemus_secrets;
GRANT CONNECT ON DATABASE ensemus TO ensemus_operator, ensemus_support, ensemus_eraser;

\connect ensemus
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
