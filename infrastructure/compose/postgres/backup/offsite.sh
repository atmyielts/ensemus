#!/bin/sh
# The offsite copy under compose.backup.yaml, run in the rclone image an operator pins by digest.
#   offsite.sh ship          copies new WAL and finished base backups to the backup bucket, every interval
#   offsite.sh fetch <id>    copies one base backup and the archived WAL back into /drill-fetch, for the drill
#
# It only ever adds. Nothing here deletes from the bucket: --immutable refuses to replace a file that differs,
# and age-based removal is pg-backup-prune.mjs's, with its own tested rules and the operator's own numbers.
# The bucket and its credential are the backup's alone (objects_backup_*), so the application's credential
# can neither read nor remove a backup, and this one can reach nothing of the application's.
set -eu
backups=${ENSEMUS_BACKUP_DIR:-/backups}
wal=${ENSEMUS_WAL_ARCHIVE_DIR:-/wal-archive}
fetched=${ENSEMUS_DRILL_FETCH_DIR:-/drill-fetch}

say() { printf '%s\n' "$1"; }
refuse() {
  say "{\"event\":\"pg_offsite.refused\",\"reasonCode\":\"$1\"}" >&2
  exit 1
}

bucket=${ENSEMUS_BACKUP_BUCKET-}
endpoint=${ENSEMUS_BACKUP_OBJECT_ENDPOINT-}
case $bucket in
  '' | *[!a-z0-9.-]*) refuse ENSEMUS_BACKUP_BUCKET_INVALID ;;
esac
case $endpoint in
  http://* | https://*) ;;
  *) refuse ENSEMUS_BACKUP_OBJECT_ENDPOINT_INVALID ;;
esac
key_file=${ENSEMUS_BACKUP_ACCESS_KEY_FILE:-/run/secrets/objects_backup_access_key}
secret_file=${ENSEMUS_BACKUP_SECRET_KEY_FILE:-/run/secrets/objects_backup_secret_key}
[ -r "$key_file" ] && [ -r "$secret_file" ] || refuse CREDENTIAL_FILE_UNREADABLE

# rclone reads a remote from the environment. The key never reaches a command line.
export RCLONE_CONFIG_OFFSITE_TYPE=s3
export RCLONE_CONFIG_OFFSITE_PROVIDER=Other
export RCLONE_CONFIG_OFFSITE_ENDPOINT="$endpoint"
export RCLONE_CONFIG_OFFSITE_FORCE_PATH_STYLE=true
# The bucket is made once by the operator. This credential may write and list it, and needs no right to create
# or delete a bucket, so rclone is told not to try.
export RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true
# No config file: everything is above.
export RCLONE_CONFIG=/tmp/rclone.conf
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=$(head -n 1 "$key_file")
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=$(head -n 1 "$secret_file")
export RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY
# No periodic statistics in the log. rclone calls nothing but the remote it is given.
export RCLONE_STATS=0

remote="offsite:$bucket"
quiet() { rclone "$@" --log-level ERROR >/dev/null 2>&1; }

ship_once() {
  marker_new=$backups/state/offsite-ship-started
  touch "$marker_new" || return 1
  # WAL, then each archive, then its metadata last: a backup listed in the bucket has its bytes there.
  quiet copy "$wal" "$remote/postgres/wal" --immutable --exclude '.*' || return 1
  quiet copy "$backups/base" "$remote/postgres/base" --immutable --include '*.tar.gz' || return 1
  quiet copy "$backups/base" "$remote/postgres/base" --immutable --include '*.json' || return 1
  # Everything that existed when this copy started is now offsite, so base-backup.sh may let it go locally.
  mv "$marker_new" "$backups/state/offsite-shipped-through" || return 1
  say '{"event":"pg_offsite.shipped"}'
}

case ${1-} in
  ship)
    interval=${ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS-}
    case $interval in
      '' | 0* | *[!0123456789]*) refuse ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS_INVALID ;;
    esac
    [ ${#interval} -le 6 ] && [ "$interval" -ge 60 ] && [ "$interval" -le 86400 ] ||
      refuse ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS_INVALID
    while :; do
      if ! ship_once; then
        say '{"event":"pg_offsite.failed","reasonCode":"COPY_FAILED"}' >&2
        if [ "${ENSEMUS_BACKUP_ONCE:-}" = 1 ]; then exit 1; fi
      fi
      if [ "${ENSEMUS_BACKUP_ONCE:-}" = 1 ]; then exit 0; fi
      sleep "$interval"
    done
    ;;
  fetch)
    id=${2-}
    if [ "$id" = latest ]; then
      id=$(rclone lsf "$remote/postgres/base" --include '*.json' --log-level ERROR | sed 's/\.json$//' |
        grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort | tail -n 1)
    fi
    echo "$id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z$' || refuse BACKUP_ID_INVALID
    rm -rf "$fetched/base" "$fetched/wal"
    mkdir -p "$fetched/base" "$fetched/wal"
    quiet copy "$remote/postgres/base" "$fetched/base" --include "$id.tar.gz" --include "$id.json" ||
      refuse FETCH_FAILED
    [ -s "$fetched/base/$id.json" ] && [ -s "$fetched/base/$id.tar.gz" ] || refuse BACKUP_NOT_FOUND
    quiet copy "$remote/postgres/wal" "$fetched/wal" || refuse FETCH_FAILED
    # The scratch server runs as postgres (999 in the PostgreSQL image) and reads these.
    chown -R 999:999 "$fetched"
    say "{\"event\":\"pg_offsite.fetched\",\"id\":\"$id\"}"
    ;;
  *) refuse MODE_INVALID ;;
esac
