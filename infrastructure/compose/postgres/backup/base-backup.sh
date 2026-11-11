#!/bin/bash
# Scheduled base backups under compose.backup.yaml. Every interval: one pg_basebackup with its own WAL, checked
# with pg_verifybackup, packed with its SHA-256, and only then given its final name. Then it removes local
# backups beyond the number to keep, and the archived WAL that no kept backup needs and that the offsite copy
# already holds.
#
# Every number is the operator's (LIFE-02: numeric retention defaults come from legal sign-off, not code). A
# setting that is missing or malformed stops this before it connects to anything, and the error names the
# setting, never the value. With ENSEMUS_BACKUP_ONCE=1 it takes one backup and exits, for a drill or a test.
#
# It prints one JSON line per event: IDs, counts, sizes and codes. Nothing from inside the database.
set -euo pipefail

base_dir=${ENSEMUS_BACKUP_DIR:-/backups}
wal_dir=${ENSEMUS_WAL_ARCHIVE_DIR:-/wal-archive}

say() { printf '%s\n' "$1"; }
refuse() {
  say "{\"event\":\"pg_backup.refused\",\"reasonCode\":\"$1\"}" >&2
  exit 1
}

# Whole numbers, no sign, no leading zero, by pattern so no length of digits can upset the shell.
whole() {
  case $1 in
    '' | 0* | *[!0123456789]*) return 1 ;;
  esac
  [ ${#1} -le 9 ] || return 1
  [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]
}

interval=${ENSEMUS_BACKUP_INTERVAL_SECONDS-}
keep=${ENSEMUS_BACKUP_LOCAL_KEEP-}
offsite=${ENSEMUS_BACKUP_OFFSITE-}
whole "$interval" 3600 2678400 || refuse ENSEMUS_BACKUP_INTERVAL_SECONDS_INVALID
whole "$keep" 1 365 || refuse ENSEMUS_BACKUP_LOCAL_KEEP_INVALID
case $offsite in
  on | off) ;;
  *) refuse ENSEMUS_BACKUP_OFFSITE_INVALID ;;
esac

password_file=${ENSEMUS_BACKUP_PASSWORD_FILE:-/run/secrets/db_superuser_password}
[ -r "$password_file" ] || refuse PASSWORD_FILE_UNREADABLE
umask 077
# pgpass needs a backslash and a colon escaped. The file lives in this container's tmpfs and nowhere else.
export PGPASSFILE=/tmp/pgpass
printf '%s:%s:*:%s:%s\n' "${PGHOST:-127.0.0.1}" "${PGPORT:-5432}" "${PGUSER:-postgres}" \
  "$(sed -e 's/\\/\\\\/g' -e 's/:/\\:/g' "$password_file" | head -n 1)" >"$PGPASSFILE"

mkdir -p "$base_dir/base" "$base_dir/work" "$base_dir/state"

take_backup() {
  local id work archive started bytes sha start_wal
  id=$(date -u +%Y%m%dT%H%M%SZ)
  work="$base_dir/work/$id"
  archive="$base_dir/base/$id.tar.gz"
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  rm -rf "$work"
  # Its own WAL streamed beside it, so each backup restores on its own even if the archive is lost.
  if ! pg_basebackup -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" -U "${PGUSER:-postgres}" \
    -D "$work" -Fp -X stream -c fast --manifest-checksums=SHA256 -l "ensemus-$id" -w >/dev/null 2>&1; then
    rm -rf "$work"
    say "{\"event\":\"pg_backup.failed\",\"id\":\"$id\",\"reasonCode\":\"BASEBACKUP_FAILED\"}" >&2
    return 1
  fi
  if ! pg_verifybackup -q "$work" >/dev/null 2>&1; then
    rm -rf "$work"
    say "{\"event\":\"pg_backup.failed\",\"id\":\"$id\",\"reasonCode\":\"VERIFY_FAILED\"}" >&2
    return 1
  fi
  # START WAL LOCATION: 0/2000028 (file 000000010000000000000002)
  start_wal=$(sed -n 's/^START WAL LOCATION: .* (file \([0-9A-F]\{24\}\))$/\1/p' "$work/backup_label")
  if [ ${#start_wal} -ne 24 ]; then
    rm -rf "$work"
    say "{\"event\":\"pg_backup.failed\",\"id\":\"$id\",\"reasonCode\":\"LABEL_UNREADABLE\"}" >&2
    return 1
  fi
  tar -C "$work" -czf "$archive.partial" .
  sync "$archive.partial" 2>/dev/null || sync
  sha=$(sha256sum "$archive.partial" | cut -d' ' -f1)
  bytes=$(stat -c %s "$archive.partial")
  mv "$archive.partial" "$archive"
  rm -rf "$work"
  # The metadata is written last, and a backup without it does not exist for anything that reads them.
  printf '{"kind":"ensemus-pg-base-backup-v1","id":"%s","startWal":"%s","sha256":"%s","bytes":%s,"startedAt":"%s","finishedAt":"%s"}\n' \
    "$id" "$start_wal" "$sha" "$bytes" "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"$base_dir/base/$id.json.partial"
  mv "$base_dir/base/$id.json.partial" "$base_dir/base/$id.json"
  say "{\"event\":\"pg_backup.completed\",\"id\":\"$id\",\"bytes\":$bytes,\"startWal\":\"$start_wal\"}"
}

prune_local() {
  local ids count drop oldest floor marker removed name key
  mapfile -t ids < <(find "$base_dir/base" -maxdepth 1 -name '*.json' -printf '%f\n' | sed 's/\.json$//' |
    grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort)
  count=${#ids[@]}
  [ "$count" -gt 0 ] || return 0
  drop=$((count - keep))
  for ((i = 0; i < drop; i++)); do
    # Metadata first, so a half-removed backup is never taken for a whole one.
    rm -f "$base_dir/base/${ids[$i]}.json" "$base_dir/base/${ids[$i]}.tar.gz"
    say "{\"event\":\"pg_backup.pruned\",\"id\":\"${ids[$i]}\"}"
  done
  [ "$drop" -gt 0 ] || drop=0
  oldest=${ids[$drop]}
  floor=$(sed -n 's/.*"startWal":"\([0-9A-F]\{24\}\)".*/\1/p' "$base_dir/base/$oldest.json")
  [ ${#floor} -eq 24 ] || return 0
  marker="$base_dir/state/offsite-shipped-through"
  if [ "$offsite" = on ] && [ ! -e "$marker" ]; then
    say '{"event":"pg_backup.wal_kept","reasonCode":"OFFSITE_NOT_YET_COPIED"}'
    return 0
  fi
  removed=0
  while IFS= read -r name; do
    case $name in
      [0-9A-F]*) ;;
      *) continue ;;
    esac
    if [[ ! $name =~ ^[0-9A-F]{24}(\.[0-9A-F]{8}\.backup|\.partial)?$ ]]; then continue; fi
    key=${name:8:16}
    [[ $key < ${floor:8:16} ]] || continue
    # Only what a finished offsite copy that started after the file appeared has taken.
    if [ "$offsite" = on ] && [ "$wal_dir/$name" -nt "$marker" ]; then continue; fi
    rm -f "$wal_dir/$name"
    removed=$((removed + 1))
  done < <(find "$wal_dir" -maxdepth 1 -type f -printf '%f\n')
  say "{\"event\":\"pg_backup.wal_pruned\",\"count\":$removed}"
}

while :; do
  # In a subshell with -e of its own: called from an `if`, bash would ignore -e inside the function, and a
  # failed tar would be packed and named as if it had worked.
  set +e
  (
    set -e
    take_backup
  )
  taken=$?
  set -e
  if [ "$taken" -eq 0 ]; then prune_local; else
    rm -f "$base_dir"/base/*.partial
    say '{"event":"pg_backup.failed","reasonCode":"BACKUP_STEP_FAILED"}' >&2
  fi
  if [ "${ENSEMUS_BACKUP_ONCE:-}" = 1 ]; then
    # One backup was asked for, so a failed one is a failed run.
    find "$base_dir/base" -maxdepth 1 -name '*.json' -newer "$PGPASSFILE" | grep -q . || exit 1
    exit 0
  fi
  sleep "$interval"
done
