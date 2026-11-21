#!/bin/sh
# Runs as a one-shot job, with only the mounted credentials needed for provisioning.
# Both files are idempotent and run before every migration, so an install made before a role existed
# gets it, as provision.sql gives a new one. The migrator cannot create roles (ADR-028, ADR-032 D3).
set -eu
export PGPASSWORD="$(cat /run/secrets/db_superuser_password)"
psql -X -q -v ON_ERROR_STOP=1 --host postgres --username postgres --dbname ensemus \
  -v agent_password="$(cat /run/secrets/db_agent_password)" \
  -f /provision/upgrade-roles.sql
# ADR-032 D3: the operator, support and eraser roles. They cannot log in and get no password here.
psql -X -q -v ON_ERROR_STOP=1 --host postgres --username postgres --dbname ensemus \
  -f /provision/upgrade-roles-m8.sql
# Platform email (0571): the mail worker's login, with its password from the mounted secret.
psql -X -q -v ON_ERROR_STOP=1 --host postgres --username postgres --dbname ensemus \
  -v mailer_password="$(cat /run/secrets/db_mailer_password)" \
  -f /provision/upgrade-roles-mail.sql
