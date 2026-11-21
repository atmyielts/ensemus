#!/bin/sh
# Runs as a one-shot job, with only the mounted credentials needed for provisioning.
# Every file is idempotent and runs before every migration, so an install made before a role existed
# gets it, as provision.sql gives a new one. The migrator cannot create roles (ADR-028, ADR-032 D3).
set -eu
export PGPASSWORD="$(cat /run/secrets/db_superuser_password)"
psql -X -q -v ON_ERROR_STOP=1 --host postgres --username postgres --dbname ensemus \
  -v agent_password="$(cat /run/secrets/db_agent_password)" \
  -f /provision/upgrade-roles.sql
# ADR-039 D1: each worker's own login. 0700 refuses to run until these exist.
psql -X -q -v ON_ERROR_STOP=1 --host postgres --username postgres --dbname ensemus \
  -v worker_password="$(cat /run/secrets/db_worker_password)" \
  -v connector_password="$(cat /run/secrets/db_connector_password)" \
  -v knowledge_password="$(cat /run/secrets/db_knowledge_password)" \
  -f /provision/upgrade-roles-workers.sql
# ADR-032 D3: the operator, support and eraser roles. They cannot log in and get no password here.
psql -X -q -v ON_ERROR_STOP=1 --host postgres --username postgres --dbname ensemus \
  -f /provision/upgrade-roles-m8.sql
