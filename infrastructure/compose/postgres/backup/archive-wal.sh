#!/bin/sh
# PostgreSQL's archive_command under compose.backup.yaml: archive-wal.sh <%p> <%f>. It copies one finished WAL
# file into the archive volume, and exits non-zero on any doubt, because PostgreSQL then keeps the file and asks
# again, while an exit 0 for a file that is not safely archived loses it for good.
#
# A name already in the archive is accepted only if the bytes are the same: PostgreSQL may ask twice after a
# crash, and a different file under the same name means two servers share one archive, which must stop here.
set -eu
archive=${ENSEMUS_WAL_ARCHIVE_DIR:-/wal-archive}
source_path=$1
name=$2
case $name in
  '' | */* | .*) echo '{"event":"pg_archive.refused","reasonCode":"NAME_INVALID"}' >&2; exit 1 ;;
esac
target="$archive/$name"
if [ -e "$target" ]; then
  if cmp -s "$source_path" "$target"; then exit 0; fi
  echo '{"event":"pg_archive.refused","reasonCode":"DIFFERENT_FILE_ALREADY_ARCHIVED"}' >&2
  exit 1
fi
partial="$archive/.$name.partial"
rm -f "$partial"
cp "$source_path" "$partial"
# Flushed before the rename, so a crash cannot leave a short file under the final name.
sync "$partial" 2>/dev/null || sync
mv "$partial" "$target"
# The offsite copy keeps a file only once a copy that started after the file appeared has finished, and it
# tells by modification time. cp gave the time the copy started, so set it to now, after the rename.
touch "$target"
