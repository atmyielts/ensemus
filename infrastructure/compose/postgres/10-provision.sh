#!/bin/sh
# First-boot provisioning. Passwords come from mounted secrets and are never written to the image.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v migrator_password="$(cat /run/secrets/db_migrator_password)" \
  -v app_password="$(cat /run/secrets/db_app_password)" \
  -v agent_password="$(cat /run/secrets/db_agent_password)" \
  -v auth_password="$(cat /run/secrets/db_auth_password)" \
  -v dispatcher_password="$(cat /run/secrets/db_dispatcher_password)" \
  -v secrets_password="$(cat /run/secrets/db_secrets_password)" \
  -v temporal_password="$(cat /run/secrets/db_temporal_password)" \
  -f /provision/provision.sql
