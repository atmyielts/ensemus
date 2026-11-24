# Scheduled PostgreSQL backups and point-in-time recovery

**Status.** Written and unit tested on a machine without Docker. **Nothing here has run in a container yet.** `tests/stack/pg-backup.test.ts` is the first real run, and it is skipped unless `ENSEMUS_TEST_BACKUP_OVERLAY=1`. Until it has passed, treat this as a design with tests of its parts, not as a working backup. Backlog: `OPS-02` (backup and restore drill), `LIFE-02` (retention by configuration).

This is the Cloud path, and any operator who wants continuous backups can use it. Sovereign's sealed, offline backup sets ([sovereign/backup-and-restore.md](sovereign/backup-and-restore.md)) are unchanged and remain the way to move a deployment between machines. The two answer different questions: a sealed set is a portable copy of everything at one moment; this is a way to bring the database back to any second inside a window.

## What it does

`infrastructure/compose/compose.backup.yaml` is an overlay. Without it, nothing changes.

| Part | What it does |
| --- | --- |
| `postgres` (overridden) | `archive_mode=on`. Every finished WAL file goes through `postgres/backup/archive-wal.sh` into the `pg-wal-archive` volume: copied, flushed, then renamed, so a crash cannot leave a short file under the final name. A name already archived with different bytes is refused, and PostgreSQL keeps the file and asks again. `archive_timeout` closes a quiet segment after the number of seconds you set. |
| `pg-backup` | Every interval, one `pg_basebackup` with its own WAL streamed beside it, checked with `pg_verifybackup` against its SHA-256 manifest, packed, hashed, and only then given its name. Its metadata (`<id>.json`) is written last; a backup without one does not exist for anything that reads them. Then it keeps the newest backups you said to keep, and removes archived WAL that no kept backup needs **and** that a finished offsite copy already holds. Same pinned PostgreSQL image as the server. |
| `pg-backup-offsite` | Every interval, copies new WAL, then archives, then metadata, to a bucket of its own, with `rclone copy --immutable`. It never deletes, and it never replaces a file that differs. Only after a whole copy succeeds does it mark the time that copy started, which is what lets `pg-backup` let local WAL go. |
| `pg-drill`, `restore-reconcile-drill` (profile `drill`) | The drill's scratch server and the reconcile report against it. See [the drill](#the-drill). |
| `pg-backup-prune.mjs` | The only thing that deletes offsite backups, with your numbers, and only with `--apply`. |

Temporal's two databases are in the same PostgreSQL cluster, so a recovery brings Ensemus and Temporal back to the same instant. The object store is not part of this. A file deleted after the recovery point is kept out by the tombstone ledger and its re-apply ([ADR-026](../00-foundation/adr/ADR-026-tombstones-survive-restore.md)); a file added after it stays in the store with no row, and the reconcile report lists it.

## Every number is yours

`LIFE-02` and [the data lifecycle](../04-security/05-data-lifecycle.md) say numeric retention defaults come from legal and customer sign-off, not from code. So the overlay has none: Compose refuses to start until each of these is set. How often to back up and how much a quiet hour may lose are recovery-point decisions for the owner, and how long a recovery may take is a recovery-time decision. **The values in the last column are examples, to show the shape of a setting. They are not recommendations, and nothing has measured them.**

| Setting | Meaning | Bounds | Example only |
| --- | --- | --- | --- |
| `ENSEMUS_BACKUP_INTERVAL_SECONDS` | Time between base backups | 3600 to 2678400 | `86400` |
| `ENSEMUS_BACKUP_LOCAL_KEEP` | Base backups kept on the volume | 1 to 365 | `3` |
| `ENSEMUS_BACKUP_ARCHIVE_TIMEOUT_SECONDS` | Longest a quiet WAL segment stays open; bounds what a quiet period can lose | PostgreSQL's | `300` |
| `ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS` | Time between offsite copies; keep it well under the archive timeout and the backup interval | 60 to 86400 | `120` |
| `--keep-count`, `--keep-days` (prune) | Offsite: keep a backup that is one of the newest N, or finished within D days. The newest is always kept | 1 or more | `14`, `35` |
| `ENSEMUS_BACKUP_OFFSITE` | `on` (default) waits for the offsite copy before letting local WAL go; `off` does not wait | `on`, `off` | |
| `ENSEMUS_BACKUP_BUCKET`, `ENSEMUS_BACKUP_OBJECT_ENDPOINT` | Where the offsite copy goes | | `ensemus-backups`, `http://objects:8333` |

With those examples, the point-in-time window offsite is about 35 days, and what a failure could lose is the WAL not yet copied: up to the archive timeout plus the copy interval, or more if the copy is failing. Those are arithmetic on examples, not promises. Set your own from what the contracts say, then drill them.

A setting that is missing, malformed or out of bounds stops the job before it connects to anything, and its message names the setting and never the value.

## Turning it on

1. **A bucket and a credential of its own.** Make the bucket once (for example `ensemus-backups`). Give the backup sidecar an identity that can read, write and list that bucket and nothing else: it needs no right to create or delete a bucket, and none on the application's bucket. On the bundled SeaweedFS, that is one more identity in `objects_identity.json` with `Read:ensemus-backups`, `Write:ensemus-backups` and `List:ensemus-backups`. Put its keys in `.local/secrets/objects_backup_access_key` and `objects_backup_secret_key`, or your orchestrator's secret store. Where your store has versioning or object lock, turn it on for this bucket: the sidecar's credential can write, so it could overwrite, and only the store can stop that. With versioning on, retention is the store's lifecycle rules' job, and `pg-backup-prune.mjs` refuses to delete (its delete proves physical absence, which a versioned bucket cannot give).
2. **The rclone image** is pinned by digest in `compose.backup.yaml` (rclone 1.75.2), like every other image, and `pnpm check:pins` holds it there. To move it, pull and review the release, then change the digest in the file. rclone is MIT-licensed; it runs only in this sidecar and is not part of any shipped image.
3. **The settings** above, in the environment or an env file.
4. **Start:**

   ```sh
   docker compose -f compose.yaml -f compose.backup.yaml up -d
   ```

   `postgres` restarts with archiving on. `pg-backup` takes its first backup at once, then every interval. Watch for `pg_backup.completed`, `pg_offsite.shipped`, and any `pg_backup.failed`, `pg_offsite.failed` or `pg_archive.refused`. Also watch `pg_stat_archiver.failed_count` and the age of `last_archived_time`: archiving that stops leaves WAL piling up in the server's own `pg_wal` until its disk fills.

5. **Drill it** before relying on it, and after every change to any of this.

**Connections.** `pg-backup` shares the server's network namespace and connects to `127.0.0.1` as the superuser, with the password from `db_superuser_password` in a private file in its own tmpfs. That needs the server's `pg_hba.conf` to admit a replication connection from `127.0.0.1`, which the official image's first boot writes. If yours does not, add one for the superuser from `127.0.0.1` only.

## Retention offsite

```sh
node infrastructure/scripts/pg-backup-prune.mjs --keep-count <n> --keep-days <d> \
  --object-endpoint <url> --object-access-key-file <file> --object-secret-key-file <file> \
  [--bucket ensemus-backups] [--apply]
```

Without `--apply` it prints the plan and changes nothing. The credential here is an operator's with delete on the backup bucket; schedule it with your own scheduler. It refuses whole if any metadata file cannot be read, and a backup goes metadata first. WAL goes only when it orders before the oldest kept backup's start, so every kept backup can still be replayed to the end of the archive. A backup kept past retention because it is the newest is kept on purpose: deleting the only backup is never what a retention rule means.

**What retention does not do.** A backup holds what the database held when it was taken, deleted rows included, until it expires (`LIFE-02`, [the data lifecycle](../04-security/05-data-lifecycle.md)). Recovering an old backup does not bring deleted files back into the product, because the tombstone ledger is outside the database, but the rows are in the backup until the backup goes. Erasure wording has to allow for this window.

## The drill

```sh
node infrastructure/scripts/pg-pitr-drill.mjs --record <new file> \
  [--backup-id <id>|latest] [--target-time 2026-11-11T06:30:00Z] [--source local|offsite] \
  [--compose-file compose.yaml --compose-file compose.backup.yaml] [--skip-reconcile]
```

It runs beside the live stack and only ever reads the live server's volume and archive:

1. With `--source offsite`, copies the backup and the archived WAL back from the bucket into a scratch volume, so it proves the offsite copy and not just the local one.
2. Starts `pg-drill`: restores the backup into its own empty data folder, checks the archive's SHA-256 and `pg_verifybackup`'s manifest, replays archived WAL to the end or to `--target-time`, and promotes. Archiving is off on the scratch server, so it cannot add to the archive.
3. Runs read-only checks there: the three databases exist, migrations are recorded, organisations and tombstones can be counted, and no index is invalid.
4. Runs `restore-reconcile`'s report against the scratch copy: in `restore-reconcile-drill`, `postgres` resolves to `pg-drill`, so the same URL secrets reach the copy and never the live server. The report reads and counts and changes nothing, the ledger included, and the drill never passes it an argument. It does read the live object store and ask the live Temporal whether runs are open, which is what tells you what a real recovery to that point would leave to decide.
5. Removes the scratch server and its data, and writes the record: each step's time, the checks, the reconcile's exit status and the size of its report, never a row, a name or the report's content. `operator` is empty: who ran it, and that it was someone other than the author, is for that person to add.

Exit 0: recovered, every check passed and the reconcile needed nobody. 1: anything else, and the record says what. 2: refused before anything ran. The record states times; it judges nothing against one.

## Recovering a live deployment to a point in time

**Not yet drilled, and one step is open.** The procedure is the drill's restore followed by the restore steps in [sovereign/backup-and-restore.md](sovereign/backup-and-restore.md#restore-in-this-order), from "invokes actual migrator begin" on: authentication stays fenced until an independent review is acknowledged (0422), Temporal is started alone, the reconcile report is read and decided on, and the connector worker starts last. **Open:** `auth-restore.js begin` takes a Sovereign backup ID and a sealed manifest hash. Whether a base backup's ID and SHA-256 are accepted in their place, and whether they should be, has not been checked; that is a decision for the security owner. Until it is made, a database recovered this way must not admit anyone.

1. Stop every reader and worker, as that page says, and keep the connector worker stopped.
2. Restore into a new volume with the drill's script, with `ENSEMUS_DRILL_HOLD=0` so the scratch server stops once promoted and checked, and the result stays: `docker compose --profile drill run --rm -e ENSEMUS_DRILL_HOLD=0 -e ENSEMUS_DRILL_TARGET_TIME=<t> -v pg-restored:/drill-data pg-drill`.
3. Stop `postgres`. Keep its old volume; do not delete it. Copy `pgdata/` from `pg-restored` into a fresh volume for `postgres`, owned by `postgres`, mode 700, and point the service at it.
4. Start `postgres` alone, then continue from the begin step on that page.

## What this does not cover

- **No run in a container yet.** See the status above.
- **The server's own disk.** If archiving fails, WAL stays in `pg_wal` and the server stops when the disk is full. Alert on `pg_stat_archiver` before that.
- **A second server.** One archive per server: two servers writing one archive is refused file by file, and is a misconfiguration.
- **Encryption at rest of the backups** is the store's and the volume's. The archives are not sealed the way a Sovereign set is.
- **RPO and RTO.** Owner decisions, for each commercial mode and contract. The drill record is the evidence to decide them with.
