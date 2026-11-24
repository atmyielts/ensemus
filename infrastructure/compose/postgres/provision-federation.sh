#!/bin/sh
# Runs only for the optional federation profile.
set -eu
if [ "${ENSEMUS_CROSS_ORG_ENABLED:-false}" != true ]; then
  exit 0
fi
export PGPASSWORD="$(cat /run/secrets/db_superuser_password)"
export ENSEMUS_FEDERATION_DB_PASSWORD="$(cat /run/secrets/db_federation_password)"
test -n "$ENSEMUS_FEDERATION_DB_PASSWORD"
exec psql -X -q -v ON_ERROR_STOP=1 --host postgres --username postgres --dbname ensemus \
  -f /provision/provision-federation.sql
