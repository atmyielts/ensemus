// The decisions behind PostgreSQL base backups, WAL archiving and the point-in-time drill, kept apart from
// anything that touches Docker, a database or a store, so tests/unit/pg-backup-rules.test.ts can show each one
// refusing. compose.backup.yaml, pg-backup-prune.mjs and pg-pitr-drill.mjs use them.
//
// Retention has no number here. LIFE-02 says numeric retention defaults come from legal sign-off, not code, so
// every count and age below is something an operator states, and leaving one out is a refusal.

/** What base-backup.sh names a backup: the UTC time it started, to the second. Sorting them sorts by time. */
export const BACKUP_ID = /^[0-9]{8}T[0-9]{6}Z$/;

/** A WAL segment, and the history and partial files archiving also writes. */
const WAL_SEGMENT = /^[0-9A-F]{24}$/;
const WAL_BACKUP_HISTORY = /^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$/;
const WAL_PARTIAL = /^[0-9A-F]{24}\.partial$/;
const WAL_TIMELINE_HISTORY = /^[0-9A-F]{8}\.history$/;

/** Where offsite.sh puts things in the backup bucket. pg-backup-prune.mjs reads and deletes only under these. */
export const OFFSITE_BASE_PREFIX = 'postgres/base/';
export const OFFSITE_WAL_PREFIX = 'postgres/wal/';

export const isBackupId = (value) => typeof value === 'string' && BACKUP_ID.test(value);

/** A whole number written plainly, with no sign, no leading zero, no exponent and no spaces. */
function wholeNumber(value, min, max, code) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value)) throw new Error(code);
  const number = Number(value);
  if (number < min || number > max) throw new Error(code);
  return number;
}

/**
 * How long the offsite copy keeps base backups. Both are required. A backup is kept when it is one of the
 * newest `keepCount`, or finished within `keepDays`; the newest is always kept, so no setting can leave none.
 */
export function parseRetentionPolicy(input) {
  return {
    keepCount: wholeNumber(input?.keepCount, 1, 10_000, 'BACKUP_KEEP_COUNT_REQUIRED'),
    keepDays: wholeNumber(input?.keepDays, 1, 36_500, 'BACKUP_KEEP_DAYS_REQUIRED'),
  };
}

/**
 * A base backup's metadata as base-backup.sh writes it beside its archive. Anything else is refused, and a
 * prune that meets one refuses whole, because deleting by a list it could not read is how backups get lost.
 */
export function parseBackupMetadata(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('BACKUP_METADATA_INVALID');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    value.kind !== 'ensemus-pg-base-backup-v1' ||
    !isBackupId(value.id) ||
    typeof value.startWal !== 'string' ||
    !WAL_SEGMENT.test(value.startWal) ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    typeof value.finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.finishedAt)) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1
  )
    throw new Error('BACKUP_METADATA_INVALID');
  return {
    id: value.id,
    startWal: value.startWal,
    sha256: value.sha256,
    finishedAt: value.finishedAt,
    bytes: value.bytes,
  };
}

/**
 * The part of a WAL file name that orders it, without the timeline, as pg_archivecleanup compares them.
 * `null` for a timeline history file, which is always kept, and for anything that is not WAL at all.
 */
export function walOrderKey(name) {
  if (WAL_SEGMENT.test(name) || WAL_BACKUP_HISTORY.test(name) || WAL_PARTIAL.test(name))
    return name.slice(8, 24);
  return null;
}

/**
 * Which base backups and WAL files in the offsite copy may go. `backups` is every parsed metadata entry;
 * `walNames` every file name under the WAL prefix. Nothing is planned when there is no backup at all, and a
 * WAL file is kept unless it orders before the oldest kept backup's start, so every kept backup can still be
 * brought forward to the end of the archive. A name that is not WAL is kept and counted, never deleted.
 */
export function planPrune(backups, walNames, policy, now) {
  if (!Array.isArray(backups) || !Array.isArray(walNames)) throw new Error('PRUNE_INPUT_INVALID');
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) throw new Error('PRUNE_INPUT_INVALID');
  const ids = new Set();
  for (const backup of backups) {
    if (ids.has(backup.id)) throw new Error('BACKUP_METADATA_DUPLICATE');
    ids.add(backup.id);
  }
  if (!backups.length)
    return { keep: [], drop: [], dropWal: [], keptWal: walNames.length, unknown: 0 };
  const newestFirst = [...backups].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const cutoffMs = nowMs - policy.keepDays * 24 * 60 * 60 * 1000;
  const keep = [];
  const drop = [];
  newestFirst.forEach((backup, index) => {
    const recent = Date.parse(backup.finishedAt) >= cutoffMs;
    if (index === 0 || index < policy.keepCount || recent) keep.push(backup);
    else drop.push(backup);
  });
  const oldestKept = keep.reduce((a, b) =>
    walOrderKey(a.startWal) <= walOrderKey(b.startWal) ? a : b,
  );
  const floor = walOrderKey(oldestKept.startWal);
  const dropWal = [];
  let unknown = 0;
  for (const name of walNames) {
    const key = walOrderKey(name);
    if (key === null) {
      if (!WAL_TIMELINE_HISTORY.test(name)) unknown += 1;
      continue;
    }
    if (key < floor) dropWal.push(name);
  }
  return {
    keep: keep.map((b) => b.id),
    drop: drop.map((b) => b.id),
    dropWal,
    keptWal: walNames.length - dropWal.length,
    unknown,
  };
}

/** An instant the drill recovers to: UTC, to the second, written with a Z. Never in the future. */
export function parseTargetTime(value, now) {
  if (
    typeof value !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value)
  )
    throw new Error('DRILL_TARGET_TIME_INVALID');
  const ms = Date.parse(value);
  // Date.parse rolls 2026-02-30 forward, so the round trip has to give back what was written.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== value)
    throw new Error('DRILL_TARGET_TIME_INVALID');
  if (ms > now.getTime()) throw new Error('DRILL_TARGET_TIME_IN_FUTURE');
  return value;
}

/** The drill command's options. Every value is checked here, before anything runs. */
export function parseDrillOptions(values, now) {
  if (typeof values.record !== 'string' || !values.record) throw new Error('DRILL_RECORD_REQUIRED');
  const backupId = values['backup-id'] ?? 'latest';
  if (backupId !== 'latest' && !isBackupId(backupId)) throw new Error('DRILL_BACKUP_ID_INVALID');
  const source = values.source ?? 'local';
  if (source !== 'local' && source !== 'offsite') throw new Error('DRILL_SOURCE_INVALID');
  const targetTime =
    values['target-time'] === undefined ? null : parseTargetTime(values['target-time'], now);
  return {
    record: values.record,
    backupId,
    source,
    targetTime,
    reconcile: values['skip-reconcile'] !== true,
  };
}

/** The drill's own log events, the only lines from the scratch server that reach the record. */
const DRILL_EVENTS = new Set([
  'pg_drill.restored',
  'pg_drill.verified',
  'pg_drill.recovered',
  'pg_drill.check',
  'pg_drill.refused',
]);
const SAFE_VALUE = /^[A-Za-z0-9._:+-]{0,128}$/;

/**
 * Picks the drill's JSON lines out of a container log and keeps only short, machine-shaped values, so a server
 * message that quoted a row cannot reach the record. Anything else on a line is dropped and counted.
 */
export function drillEventsFrom(log) {
  const events = [];
  let dropped = 0;
  for (const line of String(log).split(/\r?\n/)) {
    const start = line.indexOf('{"event":"pg_drill.');
    if (start < 0) continue;
    let value;
    try {
      value = JSON.parse(line.slice(start));
    } catch {
      dropped += 1;
      continue;
    }
    if (!value || !DRILL_EVENTS.has(value.event)) {
      dropped += 1;
      continue;
    }
    const kept = {};
    for (const [key, field] of Object.entries(value)) {
      const safeKey = /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key);
      const safe =
        (typeof field === 'number' && Number.isFinite(field)) ||
        typeof field === 'boolean' ||
        (typeof field === 'string' && SAFE_VALUE.test(field));
      if (key === 'event' || (safeKey && safe)) kept[key] = field;
      else dropped += 1;
    }
    events.push(kept);
  }
  return { events, dropped };
}

/** What the record says about the checks: every check passed and recovery finished, or not. */
export function drillOutcome(events, targetTime) {
  const recovered = events.find((e) => e.event === 'pg_drill.recovered');
  const checks = events.filter((e) => e.event === 'pg_drill.check');
  const refused = events.some((e) => e.event === 'pg_drill.refused');
  const failed = checks.filter((e) => e.ok !== true).map((e) => e.name);
  let beyondTarget = false;
  if (
    targetTime &&
    recovered &&
    typeof recovered.lastReplayed === 'string' &&
    recovered.lastReplayed
  ) {
    beyondTarget = Date.parse(recovered.lastReplayed) > Date.parse(targetTime);
  }
  return {
    recovered: Boolean(recovered) && !refused,
    checks: checks.length,
    failed,
    beyondTarget,
    ok: Boolean(recovered) && !refused && checks.length > 0 && failed.length === 0 && !beyondTarget,
  };
}
