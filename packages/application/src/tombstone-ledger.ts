// What keeps a deleted file deleted after a database restore (LIFE-01, ADR-026). The tombstones table
// lives in the database it protects, so an older dump loses the ones written since. The ledger keeps a
// copy outside the database. This compares the two, refuses to serve while the database is behind, and
// puts back what a restore lost.
import {
  appendAudit,
  artifacts,
  blobLifecycle,
  organizations,
  tombstones,
  withTenantTx,
  workArtifacts,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import {
  LEDGER_PREFIX,
  ledgerPrefixFor,
  parseLedgerEntry,
  parseLedgerKey,
  type LedgerEntry,
} from '@ensemus/domain/tombstone-ledger';
import { and, eq, inArray } from 'drizzle-orm';
import { objectKey, type ObjectStore } from './artifacts';
import { AppError } from './errors';
import { closeOutdatedReviews, loadChangeable } from './work';

export interface LedgerReader {
  listPages(prefix: string): AsyncIterable<string[]>;
  get(key: string): Promise<Buffer>;
}

/**
 * How many of this tenant's ledger entries its database does not know about. A tombstone commits
 * before its entry can be written and is never removed, so in ordinary running the ledger can only be
 * behind the database. Any count above zero means the database went back in time. No transaction stays
 * open during a call to the store, and row-level security confines the check to this tenant.
 */
export async function countUnappliedTombstones(
  database: AppDatabase,
  store: Pick<LedgerReader, 'listPages'>,
  context: TenantContext,
): Promise<number> {
  let missing = 0;
  for await (const page of store.listPages(ledgerPrefixFor(context.organizationId))) {
    const named = page.flatMap((key) => parseLedgerKey(key) ?? []);
    if (named.length === 0) continue;
    const known = await withTenantTx(database, context, (tx) =>
      tx
        .select({ type: tombstones.targetType, id: tombstones.targetId })
        .from(tombstones)
        .where(
          inArray(
            tombstones.targetId,
            named.map((entry) => entry.targetId),
          ),
        ),
    );
    const found = new Set(known.map((row) => `${row.type}/${row.id}`));
    missing += named.filter((entry) => !found.has(`${entry.targetType}/${entry.targetId}`)).length;
  }
  return missing;
}

/** How long an answer of "all there" holds, which is the most a running web tier can lag a restore. */
const CLEAR_FOR_MS = 30_000;
/** Far shorter, so that people are let back in soon after the restore is finished. */
const CLOSED_FOR_MS = 2_000;
const MAX_REMEMBERED = 10_000;

/**
 * Refuses a tenant's requests while its database is behind the ledger. It looks at the data, so it
 * needs nobody to remember anything: a restored database closes it, and re-applying the ledger opens
 * it. If the store cannot be asked it stays as it was, or open if this is the first time. A store
 * outage must not stop the rest of the product, and with the store down there are no bytes to serve.
 */
export function createRestoreGate(options: {
  database: AppDatabase;
  store: Pick<LedgerReader, 'listPages'>;
  onCheckFailed?: (error: unknown) => void;
  onClosed?: (organizationId: string, missing: number) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const known = new Map<string, { closed: boolean; until: number }>();
  const checking = new Map<string, Promise<boolean>>();

  const check = async (context: TenantContext) => {
    const before = known.get(context.organizationId)?.closed ?? false;
    let closed = before;
    try {
      const missing = await countUnappliedTombstones(options.database, options.store, context);
      closed = missing > 0;
      if (closed) options.onClosed?.(context.organizationId, missing);
    } catch (error) {
      options.onCheckFailed?.(error);
    }
    if (known.size >= MAX_REMEMBERED) known.clear();
    known.set(context.organizationId, {
      closed,
      until: now() + (closed ? CLOSED_FOR_MS : CLEAR_FOR_MS),
    });
    return closed;
  };

  /** One check at a time for each tenant. Everyone asking meanwhile waits for the same answer. */
  const isClosed = (context: TenantContext) => {
    const organizationId = context.organizationId;
    const current = known.get(organizationId);
    if (current && current.until > now()) return Promise.resolve(current.closed);
    let running = checking.get(organizationId);
    if (!running) {
      running = check(context).finally(() => checking.delete(organizationId));
      checking.set(organizationId, running);
    }
    return running;
  };

  return {
    async assertServing(context: TenantContext) {
      if (await isClosed(context)) throw new AppError('RESTORE_PENDING');
    },
  };
}

export type ReapplyResult = {
  /** Objects found in the ledger, all tenants together. */
  entries: number;
  tombstonesAdded: number;
  artifactsRemoved: number;
  bytesRemoved: number;
  /** Entries for an organization this backup predates. There is nothing to protect but the bytes. */
  organizationsMissing: number;
  /** Objects that are not valid entries. Nothing is done for them, and the gate stays closed. */
  invalid: number;
  /** Entries that could not be finished. Running this again picks them up. */
  failed: number;
};

/** One entry. Blocks access first, in one transaction, and only then touches any bytes. */
async function reapplyEntry(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  entry: LedgerEntry,
  result: ReapplyResult,
) {
  const { organizationId, targetType, targetId } = entry;
  const applied = await withTenantTx(database, context, async (tx) => {
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!organization) return null;
    const added = await tx
      .insert(tombstones)
      .values({
        organizationId,
        targetType,
        targetId,
        reasonCode: 'USER_DELETED',
        createdAt: entry.deletedAt,
      })
      .onConflictDoNothing()
      .returning({ id: tombstones.targetId });
    const [artifact] = await tx
      .select({ key: artifacts.objectKey })
      .from(artifacts)
      .where(eq(artifacts.id, targetId));
    const key = artifact?.key ?? objectKey(organizationId, targetId);
    // Purged stays purged, so running this again writes nothing. An upload that was still in flight
    // when the backup was taken became this file, and its row now says what is really happening.
    await tx
      .insert(blobLifecycle)
      .values({
        organizationId,
        artifactId: targetId,
        objectKey: key,
        state: 'deleting',
        purgeAfter: new Date(),
      })
      .onConflictDoUpdate({
        target: [blobLifecycle.organizationId, blobLifecycle.artifactId],
        set: { state: 'deleting', purgeAfter: new Date() },
        where: eq(blobLifecycle.state, 'uploading'),
      });
    if (artifact) {
      const works = await tx
        .select({ id: workArtifacts.workUnitId })
        .from(workArtifacts)
        .where(eq(workArtifacts.artifactId, targetId));
      // Takes its links to work with it, through the foreign key.
      await tx.delete(artifacts).where(eq(artifacts.id, targetId));
      // A review open in the backup may cover this file, exactly as when it was first deleted.
      for (const { id } of works) {
        await closeOutdatedReviews(tx, context, await loadChangeable(tx, context, id));
      }
    }
    if (added.length > 0 || artifact) {
      await appendAudit(tx, {
        organizationId,
        actorType: 'system',
        action: 'artifact.deletion_reapplied',
        targetRef: `artifact:${targetId}`,
        decision: 'allow',
        safeReason: 'RESTORE_REAPPLY',
      });
    }
    return { key, tombstoneAdded: added.length > 0, artifactRemoved: Boolean(artifact) };
  });

  if (applied) {
    if (applied.tombstoneAdded) result.tombstonesAdded += 1;
    if (applied.artifactRemoved) result.artifactsRemoved += 1;
  } else {
    result.organizationsMissing += 1;
  }

  const key = applied?.key ?? objectKey(organizationId, targetId);
  if (await store.exists(key)) {
    await store.delete(key);
    if (await store.exists(key)) throw new Error('Object still present after delete');
    result.bytesRemoved += 1;
  }
  if (applied) {
    await withTenantTx(database, context, (tx) =>
      tx
        .update(blobLifecycle)
        .set({ state: 'purged', purgedAt: new Date() })
        .where(and(eq(blobLifecycle.artifactId, targetId), eq(blobLifecycle.state, 'deleting'))),
    );
  }
}

/**
 * Puts back every deletion the ledger knows about (the restore procedure in the runbook). Safe to run
 * as often as needed: an entry already applied changes nothing. One entry failing leaves its row
 * saying the bytes still have to go, so the upkeep sweep or the next run can finish it.
 */
export async function reapplyTombstoneLedger(
  database: AppDatabase,
  store: ObjectStore & LedgerReader,
  contextFor: (organizationId: string) => TenantContext,
  onFailed?: (error: unknown) => void,
): Promise<ReapplyResult> {
  const result: ReapplyResult = {
    entries: 0,
    tombstonesAdded: 0,
    artifactsRemoved: 0,
    bytesRemoved: 0,
    organizationsMissing: 0,
    invalid: 0,
    failed: 0,
  };
  for await (const page of store.listPages(LEDGER_PREFIX)) {
    for (const key of page) {
      result.entries += 1;
      try {
        const entry = parseLedgerEntry(key, (await store.get(key)).toString('utf8'));
        if (!entry) {
          result.invalid += 1;
          continue;
        }
        await reapplyEntry(database, store, contextFor(entry.organizationId), entry, result);
      } catch (error) {
        result.failed += 1;
        onFailed?.(error);
      }
    }
  }
  return result;
}
