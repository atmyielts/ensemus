#!/bin/sh
# Runs as a one-shot job, with only the two mounted credentials needed for provisioning.
set -eu
export PGPASSWORD="$(cat /run/secrets/db_superuser_password)"
psql -X -q -v ON_ERROR_STOP=1 --host postgres --username postgres --dbname ensemus \
  -v agent_password="$(cat /run/secrets/db_agent_password)" \
  -f /provision/upgrade-roles.sql
