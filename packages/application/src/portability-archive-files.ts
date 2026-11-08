// Archive bytes with unknown original input lineage are inert custody, never ordinary artifacts.
import { createHash } from 'node:crypto';
import {
  interactiveSessionOf,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type { CoreRecord } from '@ensemus/contracts/portability-records';
import { sql } from 'drizzle-orm';
import type { ObjectStore } from './artifacts';
import { AppError, pgCode } from './errors';
import { idSchema } from './ids';
import { queryRows } from './portability-sql';
import { withPortabilityScope } from './portability-scope';
import { RecordRefused } from './portability-sections-import';
import type { RestoreRecoveryPort } from './restore-contributors';

type ArtifactRecord = Extract<CoreRecord, { kind: 'artifact' }>;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const worker = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
};
const person = (context: TenantContext) => {
  if (context.actorType !== 'user' || !interactiveSessionOf(context))
    throw new AppError('NOT_FOUND');
};
const id = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
};
export class ArchiveFileStorageFailure extends Error {
  constructor(readonly code: 'STORE_UNAVAILABLE' | 'PART_CHANGED') {
    super(code);
  }
}
type Claim = {
  claimed: boolean;
  object_key: string;
  write_token: string;
  state: string;
  binary_sha256: string;
  size_bytes: string | number;
};
type ArchiveReadStore = { get(key: string, maxBytes?: number): Promise<Buffer> };

/** The actual parser hands over verified metadata AND its already hash-checked binary bytes. SQL
 * independently binds those bytes to0409's immutable part receipt before this function can put them.
 * An existing active/unknown writer is never retried, even when HEAD currently says nothing exists. */
export async function quarantineArchiveFile(
  database: AppDatabase,
  store: Pick<ObjectStore, 'put'> & ArchiveReadStore,
  context: TenantContext,
  input: {
    importId: string;
    sourcePart: { path: string; sha256: string };
    record: ArtifactRecord;
    bytes: Buffer;
  },
) {
  worker(context);
  const bindings = {
    'app.portability_import_id': id(input.importId),
    'app.portability_part_path': input.sourcePart.path,
    'app.portability_part_sha256': input.sourcePart.sha256,
  } as const;
  const inTx = <T>(run: (tx: Tx) => Promise<T>) =>
    withTenantTx(database, context, (tx) => withPortabilityScope(tx, bindings, run));
  const [claim] = await inTx((tx) =>
    queryRows<Claim>(
      tx,
      sql`select * from sovereign.begin_archive_file(${input.importId}::uuid,${JSON.stringify(input.record)}::jsonb,${input.bytes})`,
    ),
  );
  if (
    !claim ||
    claim.binary_sha256 !== input.record.sha256 ||
    Number(claim.size_bytes) !== input.bytes.length
  )
    throw new RecordRefused();
  let putFinished = false;
  try {
    if (claim.claimed) {
      try {
        await store.put(claim.object_key, input.bytes, 'application/octet-stream');
        putFinished = true;
      } catch {
        throw new ArchiveFileStorageFailure('STORE_UNAVAILABLE');
      }
    }
    let actual: Buffer;
    try {
      actual = await store.get(claim.object_key, input.record.size_bytes);
    } catch {
      throw new ArchiveFileStorageFailure('STORE_UNAVAILABLE');
    }
    if (actual.length !== input.record.size_bytes || hash(actual) !== input.record.sha256)
      throw new ArchiveFileStorageFailure('PART_CHANGED');
    if (claim.claimed) {
      const [finished] = await inTx((tx) =>
        queryRows<{ ready: boolean }>(
          tx,
          sql`select sovereign.finish_archive_file(${input.importId}::uuid,${input.record.id}::uuid,${claim.write_token}::uuid,${hash(actual)},${actual.length}) as ready`,
        ),
      );
      if (!finished?.ready) throw new RecordRefused();
    } else {
      const [ready] = await inTx((tx) =>
        queryRows<{ ready: boolean }>(
          tx,
          sql`select sovereign.archive_file_ready(${input.importId}::uuid,${JSON.stringify(input.record)}::jsonb) as ready`,
        ),
      );
      if (!ready?.ready) throw new RecordRefused();
    }
  } catch (error) {
    if (claim.claimed)
      await inTx((tx) =>
        tx.execute(
          putFinished
            ? sql`select sovereign.close_finished_archive_file(${input.importId}::uuid,${input.record.id}::uuid,${claim.write_token}::uuid)`
            : sql`select sovereign.unknown_archive_file(${input.importId}::uuid,${input.record.id}::uuid,${claim.write_token}::uuid)`,
        ),
      ).catch(() => undefined);
    // A failed mark is still a retained active writer, never permission to put the same key again.
    throw error;
  }
  return { sourceArtifactId: input.record.id, disposition: 'awaiting_human_review' as const };
}

export type ImportedArchiveFileView = {
  sourceArtifactId: string;
  name: string | null;
  mimeType: string | null;
  sizeBytes: number;
  classification: string | null;
  state: 'writing' | 'unknown' | 'quarantined' | 'closing' | 'purged';
  reviewable: boolean;
  createdAt: Date;
};
export async function listImportedArchiveFiles(
  database: AppDatabase,
  context: TenantContext,
  input: { importId: string; after?: string; limit?: number },
) {
  person(context);
  const importId = id(input.importId),
    after = input.after ? id(input.after) : null,
    limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout','2000ms',true)`);
    const rows = await queryRows<{
      source_artifact_id: string;
      name: string | null;
      mime_type: string | null;
      size_bytes: string | number;
      classification: string | null;
      state: ImportedArchiveFileView['state'];
      reviewable: boolean;
      created_at: Date;
    }>(
      tx,
      sql`select * from sovereign.archive_file_list(${importId}::uuid,${after}::uuid,${limit})`,
    );
    return rows.map((row) => ({
      sourceArtifactId: row.source_artifact_id,
      name: row.name,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      classification: row.classification,
      state: row.state,
      reviewable: row.reviewable,
      createdAt: row.created_at,
    }));
  });
}
export async function readImportedArchiveFile(
  database: AppDatabase,
  store: ArchiveReadStore,
  context: TenantContext,
  input: { importId: string; sourceArtifactId: string },
) {
  person(context);
  const importId = id(input.importId),
    source = id(input.sourceArtifactId);
  type Read = {
    object_key: string;
    binary_sha256: string;
    size_bytes: string | number;
    name: string;
    mime_type: string;
  };
  const read = async () => {
    try {
      return await withTenantTx(database, context, async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout','2000ms',true)`);
        return queryRows<Read>(
          tx,
          sql`select * from sovereign.archive_file_read(${importId}::uuid,${source}::uuid)`,
        );
      });
    } catch (error) {
      if (['57014', '55P03'].includes(pgCode(error) ?? '')) throw new AppError('NOT_FOUND');
      throw error;
    }
  };
  const [first] = await read();
  if (!first) throw new AppError('NOT_FOUND');
  let bytes: Buffer;
  try {
    bytes = await store.get(first.object_key, Number(first.size_bytes));
  } catch {
    throw new AppError('NOT_FOUND');
  }
  if (bytes.length !== Number(first.size_bytes) || hash(bytes) !== first.binary_sha256)
    throw new AppError('NOT_FOUND');
  const [last] = await read();
  if (
    !last ||
    last.object_key !== first.object_key ||
    last.binary_sha256 !== first.binary_sha256 ||
    Number(last.size_bytes) !== bytes.length
  )
    throw new AppError('NOT_FOUND');
  return { bytes, name: last.name, mimeType: last.mime_type, sha256: last.binary_sha256 };
}

/** This is the actual hold-aware lifecycle authority, not a model assertion or an optional empty
 * success. The adapter must prove all old puts quiescent before deleting the exact key. */
export interface ArchiveQuarantineLifecycle {
  erase(
    context: TenantContext,
    input: {
      importId: string;
      sourceArtifactId: string;
      objectKey: string;
      sha256: string;
      writeToken: string;
      writeState: 'active' | 'settled' | 'fenced';
    },
  ): Promise<{ state: 'purged'; quiescent: true } | { state: 'held' | 'unconfirmed' }>;
}
export type ArchiveFilePurgeResult = {
  removed: number;
  remaining: number;
  held: number;
  confirmed: boolean;
};
export function createImportedArchivePurge(deps: {
  database: AppDatabase;
  store: Pick<ObjectStore, 'exists'>;
  lifecycle?: ArchiveQuarantineLifecycle;
}) {
  const counts = async (tx: Tx) => {
    const [row] = await queryRows<{ removed: number; remaining: number; held: number }>(
      tx,
      sql`select * from sovereign.archive_file_counts()`,
    );
    if (!row) throw new AppError('INVALID_STATE');
    return row;
  };
  const purge = async (
    context: TenantContext,
    sourceId: string | null,
    limit: number,
    record?: { kind: 'work_unit' | 'project' | 'client' | 'object_record'; id: string },
  ): Promise<ArchiveFilePurgeResult> => {
    worker(context);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('INVALID_INPUT');
    const files = await withTenantTx(deps.database, context, (tx) =>
      queryRows<{
        import_id: string;
        source_artifact_id: string;
        object_key: string;
        binary_sha256: string;
        write_token: string;
        write_state: 'active' | 'settled' | 'fenced';
        state: string;
      }>(
        tx,
        record
          ? sql`select * from sovereign.archive_file_record_inventory(${record.kind},${record.id}::uuid,${limit})`
          : sql`select * from sovereign.archive_file_inventory(${sourceId}::uuid,${limit})`,
      ),
    );
    for (const file of files) {
      if (!deps.lifecycle) continue;
      try {
        const proof = await deps.lifecycle.erase(context, {
          importId: file.import_id,
          sourceArtifactId: file.source_artifact_id,
          objectKey: file.object_key,
          sha256: file.binary_sha256,
          writeToken: file.write_token,
          writeState: file.write_state,
        });
        const held = proof.state === 'held',
          quiescent = proof.state === 'purged' && proof.quiescent;
        const absent = quiescent && !(await deps.store.exists(file.object_key));
        await withTenantTx(deps.database, context, (tx) =>
          tx.execute(
            sql`select sovereign.archive_file_cleanup_receipt(${file.import_id}::uuid,${file.source_artifact_id}::uuid,${file.write_token}::uuid,${quiescent},${absent},${held})`,
          ),
        );
      } catch {
        /* The durable row/token remains incomplete, including after a lost callback. */
      }
    }
    const result = await withTenantTx(deps.database, context, counts);
    return {
      ...result,
      confirmed: !!deps.lifecycle && result.remaining === 0 && result.held === 0,
    };
  };
  return {
    purgeSource: (context: TenantContext, input: { sourceId: string; limit: number }) =>
      purge(context, id(input.sourceId), input.limit),
    purgeTenant: (context: TenantContext, input: { limit: number }) =>
      purge(context, null, input.limit),
    purgeRecord: (
      context: TenantContext,
      input: {
        kind: 'work_unit' | 'project' | 'client' | 'object_record';
        id: string;
        limit: number;
      },
    ) => purge(context, null, input.limit, { kind: input.kind, id: id(input.id) }),
    confirmInTx: async (tx: Tx, context: TenantContext, _input: { sourceId: string }) => {
      worker(context);
      const result = await counts(tx);
      return { remaining: result.remaining };
    },
    confirmRecordInTx: async (
      tx: Tx,
      context: TenantContext,
      _input: { kind: 'work_unit' | 'project' | 'client' | 'object_record'; id: string },
    ) => {
      worker(context);
      const result = await counts(tx);
      return { remaining: result.remaining };
    },
    countInTx: async (tx: Tx, context: TenantContext) => {
      worker(context);
      return counts(tx);
    },
  };
}

/** Actual storage audit, including keys whose old SQL receipt says purged. Restoring older object
 * bytes invalidates that historical receipt and blocks serving; it never replays a put or a send. */
export const archiveQuarantinePrefix = (organizationId: string) =>
  `${id(organizationId)}/archive-quarantine/`;
export function createArchiveQuarantineRecovery(
  store: ArchiveReadStore &
    Pick<ObjectStore, 'exists'> & { listPages(prefix: string): AsyncIterable<readonly string[]> },
): RestoreRecoveryPort {
  return {
    reconcile: async (database, context) => {
      worker(context);
      let checked = 0,
        changed = 0,
        needsAttention = 0;
      let after: { importId: string; sourceArtifactId: string } | null = null;
      for (;;) {
        const page = await withTenantTx(database, context, (tx) =>
          queryRows<{
            import_id: string;
            source_artifact_id: string;
            object_key: string;
            binary_sha256: string;
            size_bytes: number | string;
            write_token: string;
            state: string;
            write_state: string;
          }>(
            tx,
            sql`select * from sovereign.archive_file_restore_page(${after?.importId ?? null}::uuid,${after?.sourceArtifactId ?? null}::uuid,100)`,
          ),
        );
        for (const row of page) {
          checked += 1;
          let bad = false;
          try {
            if (row.state === 'purged') bad = await store.exists(row.object_key);
            else if (row.state === 'quarantined') {
              const bytes = await store.get(row.object_key, Number(row.size_bytes));
              bad = bytes.length !== Number(row.size_bytes) || hash(bytes) !== row.binary_sha256;
            } else needsAttention += 1;
          } catch {
            bad = true;
          }
          if (bad) {
            needsAttention += 1;
            const [result] = await withTenantTx(database, context, (tx) =>
              queryRows<{ changed: boolean }>(
                tx,
                sql`select sovereign.block_restored_archive_file(${row.import_id}::uuid,${row.source_artifact_id}::uuid,${row.write_token}::uuid) as changed`,
              ),
            );
            if (result?.changed) changed += 1;
          }
        }
        const last = page.at(-1);
        if (page.length < 100 || !last) break;
        after = { importId: last.import_id, sourceArtifactId: last.source_artifact_id };
      }
      // A PostgreSQL restore can predate a pending header while storage is newer. Such objects have
      // unknown writers and are never silently discarded or certified absent from this table alone.
      const prefix = archiveQuarantinePrefix(context.organizationId);
      for await (const page of store.listPages(prefix)) {
        for (let start = 0; start < page.length; start += 1000) {
          const keys = page.slice(start, start + 1000),
            known = await withTenantTx(database, context, (tx) =>
              queryRows<{ archive_known_file_keys: string }>(
                tx,
                sql`select * from sovereign.archive_known_file_keys(${sql.param(keys)}::text[])`,
              ),
            );
          const present = new Set(known.map((row) => row.archive_known_file_keys));
          needsAttention += keys.filter(
            (key) => !key.startsWith(prefix) || !present.has(key),
          ).length;
        }
      }
      return { checked, changed, needsAttention };
    },
  };
}
