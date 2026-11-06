// What keeps a deleted file deleted after a database restore (LIFE-01, ADR-026). The tombstones table
// lives in the database it protects, so an older dump loses the ones written since. The ledger keeps a
// copy outside the database. This compares the two, refuses to serve while the database is behind, and
// puts back what a restore lost.
import {
  appendAudit,
  artifacts,
  artifactAclCatalog,
  artifactLineage,
  blobLifecycle,
  organizations,
  tombstones,
  withNewTenantTx,
  withTenantTx,
  workArtifacts,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  LEDGER_PREFIX,
  ledgerPrefixFor,
  ledgerRef,
  parseLedgerEntry,
  parseLedgerKey,
  quarantineKeyFor,
  type LedgerEntry,
} from '@ensemus/domain/tombstone-ledger';
import type { DerivedArtifactLifecycle } from './knowledge/artifact-provenance';
import { and, eq, inArray } from 'drizzle-orm';
import { objectKey, type ObjectStore } from './artifacts';
import { AppError } from './errors';
import { closeOutdatedReviews, loadChangeable } from './work';
import { reapplyKnowledgeSourceEntry } from './knowledge/purge';

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
export function countUnappliedTombstones(
  database: AppDatabase,
  store: Pick<LedgerReader, 'listPages'>,
  context: TenantContext,
): Promise<number> {
  return countMissing(store, {
    organizationId: context.organizationId,
    bound: (fn) => withTenantTx(database, context, fn),
  });
}

/** A tenant to check, and how to reach its rows with row-level security bound to it. */
type GateTenant = {
  organizationId: string;
  bound: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
};

async function countMissing(store: Pick<LedgerReader, 'listPages'>, tenant: GateTenant) {
  let missing = 0;
  for await (const page of store.listPages(ledgerPrefixFor(tenant.organizationId))) {
    const named = page.flatMap((key) => parseLedgerKey(key) ?? []);
    if (named.length === 0) continue;
    const known = await tenant.bound((tx) =>
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
    const artifactsInPage = named
      .filter((entry) => entry.targetType === 'artifact')
      .map((entry) => entry.targetId);
    if (artifactsInPage.length) {
      const unresolved = await tenant.bound((tx) =>
        tx
          .select({ id: artifactLineage.artifactId })
          .from(artifactLineage)
          .where(
            and(
              inArray(artifactLineage.artifactId, artifactsInPage),
              eq(artifactLineage.restoreReapplyPending, true),
            ),
          ),
      );
      for (const row of unresolved) found.delete(`artifact/${row.id}`);
    }
    missing += named.filter((entry) => !found.has(`${entry.targetType}/${entry.targetId}`)).length;
  }
  return missing;
}

/** How long an answer of "all there" holds, which is the most a running web tier can lag a restore. */
const CLEAR_FOR_MS = 30_000;
/** Far shorter, so that people are let back in soon after the restore is finished. */
const CLOSED_FOR_MS = 2_000;
const MAX_REMEMBERED = 10_000;
/** The most anyone waits for a tenant's first check, when there is no answer yet to give them. */
const WAIT_FOR_CHECK_MS = 2_000;
/**
 * The most anyone waits for a later check, when there is an answer to give them. A check that takes
 * longer than this counts as slow, and the checks after it make nobody wait at all.
 */
const WAIT_FOR_RECHECK_MS = 500;

/**
 * Refuses a tenant's requests while its database is behind the ledger. It looks at the data, so it
 * needs nobody to remember anything: a restored database closes it, and re-applying the ledger opens
 * it. If the store cannot be asked it stays as it was, or open if this is the first time. A store
 * outage must not stop the rest of the product, and with the store down there are no bytes to serve.
 *
 * Requests wait for a check only while the store is quick and answering, which is what lets the first
 * request after an interval see a restore, however long the tenant was idle. Once a check has failed or
 * has taken longer than a moment, the next ones run behind the requests, which get the last answer
 * until one of those checks comes back quickly. So an outage or a slow store costs each tenant one wait
 * on each web replica and not one every interval. A check past its limit carries on behind them too,
 * so a slow store delays the answer without ever hiding a restore from it.
 */
export function createRestoreGate(options: {
  database: AppDatabase;
  store: Pick<LedgerReader, 'listPages'>;
  onCheckFailed?: (error: unknown) => void;
  onClosed?: (organizationId: string, missing: number) => void;
  now?: () => number;
  waitMs?: number;
  recheckWaitMs?: number;
}) {
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? WAIT_FOR_CHECK_MS;
  const recheckWaitMs = options.recheckWaitMs ?? WAIT_FOR_RECHECK_MS;
  const known = new Map<string, { closed: boolean; until: number; behind: boolean }>();
  const checking = new Map<string, Promise<boolean>>();

  const check = async (tenant: GateTenant) => {
    const before = known.get(tenant.organizationId)?.closed ?? false;
    let closed = before;
    let failed = false;
    // The real time, since `now` is what the intervals are measured on and a test can stop it.
    const started = performance.now();
    try {
      const missing = await countMissing(options.store, tenant);
      closed = missing > 0;
      if (closed) options.onClosed?.(tenant.organizationId, missing);
    } catch (error) {
      failed = true;
      options.onCheckFailed?.(error);
    }
    if (known.size >= MAX_REMEMBERED) known.clear();
    known.set(tenant.organizationId, {
      closed,
      behind: failed || performance.now() - started > recheckWaitMs,
      until: now() + (closed ? CLOSED_FOR_MS : CLEAR_FOR_MS),
    });
    return closed;
  };

  /** Runs a check. What this returns settles when it ends, or at the limit with the last answer. */
  const startCheck = (tenant: GateTenant, limitMs: number) => {
    const { organizationId } = tenant;
    const finished = check(tenant).finally(() => checking.delete(organizationId));
    const answer = new Promise<boolean>((resolve) => {
      const limit = setTimeout(() => {
        // Not a failure yet, since it may still answer. Requests are going ahead without it, though,
        // and that should not go unsaid.
        options.onCheckFailed?.(
          Object.assign(new Error('Still checking'), { code: 'CHECK_TIMEOUT' }),
        );
        resolve(known.get(organizationId)?.closed ?? false);
      }, limitMs);
      void finished.then((closed) => {
        clearTimeout(limit);
        resolve(closed);
      });
    });
    checking.set(organizationId, answer);
    return answer;
  };

  /** One check at a time for each tenant. Everyone asking meanwhile shares the same wait. */
  const isClosed = (tenant: GateTenant) => {
    const { organizationId } = tenant;
    const current = known.get(organizationId);
    if (current && current.until > now()) return Promise.resolve(current.closed);
    // Behind the requests nobody is waiting, and the limit only decides when that gets said.
    const running =
      checking.get(organizationId) ??
      startCheck(tenant, current && !current.behind ? recheckWaitMs : waitMs);
    return current?.behind ? Promise.resolve(current.closed) : running;
  };

  return {
    async assertServing(context: TenantContext) {
      const tenant: GateTenant = {
        organizationId: context.organizationId,
        bound: (fn) => withTenantTx(options.database, context, fn),
      };
      if (await isClosed(tenant)) throw new AppError('RESTORE_PENDING');
    },
    /**
     * The same, for someone about to join through an invitation, who has no membership to check yet.
     * The organization comes from the invitation's row, never from the request.
     */
    async assertServingInvited(organizationId: string, userId: string) {
      const tenant: GateTenant = {
        organizationId,
        bound: (fn) => withNewTenantTx(options.database, organizationId, userId, fn),
      };
      if (await isClosed(tenant)) throw new AppError('RESTORE_PENDING');
    },
  };
}

export type ReapplyResult = {
  /** Objects found in the ledger, all tenants together. */
  entries: number;
  tombstonesAdded: number;
  artifactsRemoved: number;
  /** Source tombstones restored; content cleanup continues through its durable purge workflow. */
  knowledgeSourcesClosed?: number;
  bytesRemoved: number;
  /** Entries for an organization this backup predates. There is nothing to protect but the bytes. */
  organizationsMissing: number;
  /** Objects that are not valid entries. Nothing is done for them, and the gate stays closed. */
  invalid: number;
  /**
   * Entries naming a file whose row and bytes both still exist. Nothing is done for them until an
   * operator confirms or quarantines each one, and the gate stays closed.
   */
  unconfirmed: number;
  /** Entries that could not be finished. Running this again picks them up. */
  failed: number;
};

export type ReapplyOptions = {
  /** Required to restore a generated-file deletion. It must prove old writers quiescent, honor
   * holds, erase metadata through the narrow 0208 function and verify actual byte removal. */
  derivedArtifacts?: DerivedArtifactLifecycle;
  /** Entries an operator has confirmed, by `ledgerRef`, for which a whole file may be destroyed. */
  confirmed?: ReadonlySet<string>;
  /** Called with each entry that is waiting for that decision, so the operator can be told which. */
  onUnconfirmed?: (entry: LedgerEntry) => void;
  /** Called with each object that is not a valid entry, with its key if the key names one. */
  onInvalid?: (named: Omit<LedgerEntry, 'deletedAt'> | null) => void;
};

/**
 * Whether this entry is asking to destroy a file that is still whole. The dispatcher's credential can
 * write any entry it likes, so an entry is not proof of a deletion (ADR-026 D3). Its own word is enough
 * when the bytes have gone, which is what a real deletion leaves behind, because then nothing can be
 * lost by believing it. A row with its bytes takes a person who knows that a restore really happened.
 */
async function isWholeFile(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  targetId: string,
) {
  const [artifact] = await withTenantTx(database, context, (tx) =>
    tx.select({ key: artifacts.objectKey }).from(artifacts).where(eq(artifacts.id, targetId)),
  );
  return artifact ? store.exists(artifact.key) : false;
}

/** One entry. Blocks access first, in one transaction, and only then touches any bytes. */
async function reapplyEntry(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  entry: LedgerEntry,
  result: ReapplyResult,
  options: ReapplyOptions,
) {
  const { organizationId, targetType, targetId } = entry;
  const generated = await withTenantTx(database, context, async (tx) => {
    const [header] = await tx
      .select()
      .from(artifactLineage)
      .where(eq(artifactLineage.artifactId, targetId));
    const [catalog] = await tx
      .select()
      .from(artifactAclCatalog)
      .where(eq(artifactAclCatalog.artifactId, targetId));
    return { header, catalog };
  });
  if (generated.header || (generated.catalog && generated.catalog.provenanceState !== 'ordinary')) {
    const header = generated.header;
    // A missing header is unknown provenance, never an ordinary upload or permission to guess.
    if (!header || header.objectKey !== objectKey(organizationId, targetId))
      throw new AppError('INVALID_STATE');
    const present = await store.exists(header.objectKey);
    if (generated.catalog?.alive && present && !options.confirmed?.has(ledgerRef(entry))) {
      result.unconfirmed++;
      options.onUnconfirmed?.(entry);
      return;
    }
    const blocked = await withTenantTx(database, context, async (tx) => {
      const [current] = await tx
        .select()
        .from(artifactLineage)
        .where(eq(artifactLineage.artifactId, targetId))
        .for('update');
      if (
        !current ||
        current.generation !== header.generation ||
        current.writeId !== header.writeId
      )
        throw new AppError('INVALID_STATE');
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
      // Publication removes the upload reservation. Restore must recreate the durable deletion
      // reservation before handing the object to its lifecycle; an UPDATE of a missing row proves
      // nothing. Preserve an existing positive purge receipt on repeated reapplication.
      await tx
        .insert(blobLifecycle)
        .values({
          organizationId,
          artifactId: targetId,
          objectKey: current.objectKey,
          state: 'deleting',
          purgeAfter: new Date(),
        })
        .onConflictDoUpdate({
          target: [blobLifecycle.organizationId, blobLifecycle.artifactId],
          set: { state: 'deleting', purgeAfter: new Date() },
          where: eq(blobLifecycle.state, 'uploading'),
        });
      // A normal tombstone may still have asynchronous cleanup. Only this newly restored ledger
      // entry acquires the stronger tenant-serving barrier, atomically with restoring its tombstone.
      await tx
        .update(artifactLineage)
        .set({
          state: 'blocked',
          restoreReapplyPending: current.restoreReapplyPending || added.length > 0,
        })
        .where(eq(artifactLineage.artifactId, targetId));
      return { header: current, added: added.length > 0 };
    });
    if (blocked.added) result.tombstonesAdded++;
    if (!options.derivedArtifacts) throw new AppError('INVALID_STATE');
    const erased = await options.derivedArtifacts.erase(context, {
      artifactId: targetId,
      workUnitId: header.workUnitId,
      objectKey: header.objectKey,
      artifactSha256: header.artifactSha256,
      writeId: header.writeId,
      generation: header.generation,
      writeState: header.writeState as 'active' | 'settled' | 'fenced' | 'unknown',
    });
    if (erased.state !== 'purged' || !erased.quiescent || (await store.exists(header.objectKey)))
      throw new AppError('INVALID_STATE');
    await withTenantTx(database, context, async (tx) => {
      const [current] = await tx
        .select()
        .from(artifactLineage)
        .where(eq(artifactLineage.artifactId, targetId))
        .for('update');
      const [catalog] = await tx
        .select()
        .from(artifactAclCatalog)
        .where(eq(artifactAclCatalog.artifactId, targetId));
      const [blob] = await tx
        .select()
        .from(blobLifecycle)
        .where(eq(blobLifecycle.artifactId, targetId));
      if (
        !current ||
        current.generation !== header.generation ||
        current.writeId !== header.writeId ||
        catalog?.alive ||
        blob?.state !== 'purged' ||
        !['settled', 'fenced'].includes(current.writeState)
      )
        throw new AppError('INVALID_STATE');
      await tx
        .update(artifactLineage)
        .set({
          physicalPurgedAt: current.physicalPurgedAt ?? new Date(),
          held: false,
          restoreReapplyPending: false,
        })
        .where(eq(artifactLineage.artifactId, targetId));
    });
    if (generated.catalog?.alive) result.artifactsRemoved++;
    if (present) result.bytesRemoved++;
    return;
  }
  if (
    !options.confirmed?.has(ledgerRef(entry)) &&
    (await isWholeFile(database, store, context, targetId))
  ) {
    result.unconfirmed += 1;
    options.onUnconfirmed?.(entry);
    return;
  }
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
      // A review open in the backup may cover this file. Unlike an ordinary deletion, that review can
      // be holding its work, because the backup can hold what a person was never able to do.
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
  options: ReapplyOptions = {},
): Promise<ReapplyResult> {
  const result: ReapplyResult = {
    entries: 0,
    tombstonesAdded: 0,
    artifactsRemoved: 0,
    bytesRemoved: 0,
    organizationsMissing: 0,
    invalid: 0,
    unconfirmed: 0,
    failed: 0,
  };
  for await (const page of store.listPages(LEDGER_PREFIX)) {
    for (const key of page) {
      result.entries += 1;
      try {
        const entry = parseLedgerEntry(key, (await store.get(key)).toString('utf8'));
        if (!entry) {
          result.invalid += 1;
          options.onInvalid?.(parseLedgerKey(key));
          continue;
        }
        if (entry.targetType === 'knowledge_source') {
          const before = result.tombstonesAdded;
          await reapplyKnowledgeSourceEntry(
            database,
            store,
            contextFor(entry.organizationId),
            entry,
            result,
            options,
          );
          result.knowledgeSourcesClosed =
            (result.knowledgeSourcesClosed ?? 0) + result.tombstonesAdded - before;
          continue;
        }
        await reapplyEntry(
          database,
          store,
          contextFor(entry.organizationId),
          entry,
          result,
          options,
        );
      } catch (error) {
        result.failed += 1;
        onFailed?.(error);
      }
    }
  }
  return result;
}

/**
 * Takes an object an operator has judged not to be a real deletion out of the ledger, and keeps it for
 * whoever investigates. The gate compares keys, so this is what opens a tenant closed by a forged or
 * damaged object. It is a judgement: if the entry was real, the deleted file stays back. So it is on
 * the record, for any organization this database knows.
 */
export async function quarantineLedgerObject(
  database: AppDatabase,
  store: ObjectStore,
  contextFor: (organizationId: string) => TenantContext,
  key: string,
) {
  if (!key.startsWith(LEDGER_PREFIX)) throw new AppError('INVALID_INPUT');
  await store.put(quarantineKeyFor(key), await store.get(key), 'application/json');
  await store.delete(key);
  if (await store.exists(key)) throw new Error('Object still present after delete');

  const named = parseLedgerKey(key);
  if (!named) return;
  await withTenantTx(database, contextFor(named.organizationId), async (tx) => {
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, named.organizationId));
    if (!organization) return;
    await appendAudit(tx, {
      organizationId: named.organizationId,
      actorType: 'system',
      action: 'tombstone_ledger.entry_quarantined',
      targetRef: `${named.targetType}:${named.targetId}`,
      decision: 'allow',
      safeReason: 'OPERATOR_QUARANTINE',
    });
  });
}
