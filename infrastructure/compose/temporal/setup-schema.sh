#!/bin/sh
# One-shot job: creates or upgrades Temporal's schema (per Temporal's production guidance).
# Safe to re-run. The first step is quiet because it reports an error if version tables exist.
set -eu
SQL_PASSWORD="$(cat /run/secrets/db_temporal_password)"
export SQL_PASSWORD
tool() {
  temporal-sql-tool --plugin postgres12 --ep postgres -p 5432 -u temporal "$@"
}
for pair in temporal:temporal temporal_visibility:visibility; do
  db="${pair%%:*}"
  dir="${pair##*:}"
  tool --db "$db" --quiet setup-schema -v 0.0
  tool --db "$db" update-schema -d "/etc/temporal/schema/postgresql/v12/$dir/versioned"
done
