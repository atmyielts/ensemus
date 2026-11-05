#!/bin/sh
# Reads the database password from a mounted secret, then hands over to the image's own startup.
set -eu
POSTGRES_PWD="$(cat /run/secrets/db_temporal_password)"
export POSTGRES_PWD
exec /etc/temporal/entrypoint.sh autosetup
