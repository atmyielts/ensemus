#!/bin/bash
# The scratch side of the point-in-time drill (pg-pitr-drill.mjs runs it as the `pg-drill` service). It restores
# one base backup into this container's own empty data folder, checks it against its SHA-256 and its manifest,
# replays archived WAL to the end of the archive or to a target time, promotes, and runs read-only checks. The
# live server, its volume and its archive are never written: the archive is mounted read-only, and archiving is
# off here, so the scratch server cannot add to it.
#
# Prints one JSON line per event, with counts, codes and times only. pg-pitr-drill.mjs keeps only those lines.
set -euo pipefail

say() { printf '%s\n' "$1"; }
refuse() {
  say "{\"event\":\"pg_drill.refused\",\"reasonCode\":\"$1\"}"
  exit 1
}

case ${ENSEMUS_DRILL_SOURCE:-local} in
  local) base_dir=/backups/base wal_dir=/wal-archive ;;
  offsite) base_dir=/drill-fetch/base wal_dir=/drill-fetch/wal ;;
  *) refuse ENSEMUS_DRILL_SOURCE_INVALID ;;
esac
id=${ENSEMUS_DRILL_BACKUP_ID:-latest}
if [ "$id" = latest ]; then
  id=$(find "$base_dir" -maxdepth 1 -name '*.json' -printf '%f\n' | sed 's/\.json$//' |
    grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort | tail -n 1 || true)
fi
[[ $id =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || refuse BACKUP_ID_INVALID
target=${ENSEMUS_DRILL_TARGET_TIME:-}
if [ -n "$target" ] && [[ ! $target =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  refuse ENSEMUS_DRILL_TARGET_TIME_INVALID
fi
timeout=${ENSEMUS_DRILL_RECOVERY_TIMEOUT_SECONDS:-3600}
[[ $timeout =~ ^[1-9][0-9]{0,5}$ ]] || refuse ENSEMUS_DRILL_RECOVERY_TIMEOUT_SECONDS_INVALID

meta="$base_dir/$id.json"
archive="$base_dir/$id.tar.gz"
[ -s "$meta" ] && [ -s "$archive" ] || refuse BACKUP_NOT_FOUND
expected=$(sed -n 's/.*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$meta")
[ ${#expected} -eq 64 ] || refuse METADATA_INVALID
[ "$(sha256sum "$archive" | cut -d' ' -f1)" = "$expected" ] || refuse ARCHIVE_CHECKSUM_MISMATCH

data=/drill-data/pgdata
[ ! -e "$data" ] || refuse SCRATCH_NOT_EMPTY
mkdir -p "$data"
tar -C "$data" -xzf "$archive"
chown -R postgres:postgres /drill-data
chmod 700 "$data"
say "{\"event\":\"pg_drill.restored\",\"backupId\":\"$id\"}"
# The manifest checks every file and the WAL the backup carries, before the server changes anything.
gosu postgres pg_verifybackup -q "$data" >/dev/null 2>&1 || refuse MANIFEST_VERIFY_FAILED
say '{"event":"pg_drill.verified"}'

{
  echo "restore_command = 'cp \"$wal_dir/%f\" \"%p\"'"
  echo "recovery_target_action = 'promote'"
  if [ -n "$target" ]; then echo "recovery_target_time = '$target'"; fi
} >>"$data/postgresql.auto.conf"
touch "$data/recovery.signal"
chown postgres:postgres "$data/postgresql.auto.conf" "$data/recovery.signal"

# The reconcile reaches it over the data network only when the drill holds it open for that.
listen=''
if [ "${ENSEMUS_DRILL_HOLD:-0}" = 1 ]; then listen='*'; fi
# Recovery requires at least the primary's lock capacity while it replays WAL.
gosu postgres postgres -D "$data" -c max_locks_per_transaction=256 -c archive_mode=off -c "listen_addresses=$listen" \
  -c unix_socket_directories=/var/run/postgresql >/dev/null 2>&1 &
server=$!

umask 077
export PGPASSFILE=/tmp/pgpass
if [ -r /run/secrets/db_superuser_password ]; then
  printf '*:*:*:postgres:%s\n' \
    "$(sed -e 's/\\/\\\\/g' -e 's/:/\\:/g' /run/secrets/db_superuser_password | head -n 1)" >"$PGPASSFILE"
  chown postgres "$PGPASSFILE"
fi
q() { gosu postgres env PGPASSFILE="$PGPASSFILE" psql -h /var/run/postgresql -U postgres -d "${2:-ensemus}" -XAtqc "$1"; }

started=$(date +%s)
until [ "$(q 'select pg_is_in_recovery()' postgres 2>/dev/null || true)" = f ]; do
  kill -0 "$server" 2>/dev/null || refuse SERVER_STOPPED_DURING_RECOVERY
  [ $(($(date +%s) - started)) -lt "$timeout" ] || refuse RECOVERY_TIMEOUT
  sleep 2
done
replayed=$(q "select coalesce(to_char(pg_last_xact_replay_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), '')" postgres)
say "{\"event\":\"pg_drill.recovered\",\"backupId\":\"$id\",\"seconds\":$(($(date +%s) - started)),\"lastReplayed\":\"$replayed\"}"

check() {
  local name=$1 value=$2 ok=$3
  [[ $value =~ ^[0-9]{1,18}$ ]] || { value=0; ok=false; }
  say "{\"event\":\"pg_drill.check\",\"name\":\"$name\",\"count\":$value,\"ok\":$ok}"
}
n=$(q "select count(*) from pg_database where datname in ('ensemus','temporal','temporal_visibility')" postgres || echo x)
check databases "$n" "$([ "$n" = 3 ] && echo true || echo false)"
n=$(q 'select count(*) from drizzle.__drizzle_migrations' || echo x)
check migrations "$n" "$([[ $n =~ ^[1-9][0-9]*$ ]] && echo true || echo false)"
n=$(q 'select count(*) from org.organizations' || echo x)
check organizations "$n" "$([[ $n =~ ^[0-9]+$ ]] && echo true || echo false)"
n=$(q 'select count(*) from platform.tombstones' || echo x)
check tombstones "$n" "$([[ $n =~ ^[0-9]+$ ]] && echo true || echo false)"
# Every index the planner may use is valid after replay. An invalid one would mean a build that never finished.
n=$(q 'select count(*) from pg_index where not indisvalid' || echo x)
check invalid_indexes "$n" "$([ "$n" = 0 ] && echo true || echo false)"

if [ "${ENSEMUS_DRILL_HOLD:-0}" = 1 ]; then
  # The health check reads this. pg-pitr-drill.mjs runs the reconcile report against it, then removes this
  # container and its data.
  touch /tmp/drill-ready
  wait "$server"
else
  gosu postgres pg_ctl -D "$data" stop -m fast >/dev/null
fi
