// Owned by the restore slice (OPS-02). See docs/06-delivery/m6-slices.md and ADR-030 D11. What brings a tenant
// back into agreement after PostgreSQL, Temporal and the object store have been restored from points that
// are never quite the same moment. It reports what it finds and changes only what is safe to change without
// a person: it sends nothing, and never decides what happened to something that may have gone out.
//
// There is no path from here to the connector queue. Nothing here starts a workflow, and it never moves an
// intent towards an attempt. The restore procedure keeps the connector worker stopped until this has been run
// and someone has reviewed what it reports. The code cannot enforce that (ADR-027 D2): a connector worker
// started early would act on whatever the restored database says is ready.
import { createHash } from 'node:crypto';
import {
  appendAudit,
  artifactLineage,
  artifacts,
  blobLifecycle,
  externalActionAttempts,
  externalActionReceipts,
  externalActions,
  organizationExports,
  organizations,
  tombstones,
  withTenantTx,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type { AttemptOutcome, ExternalActionStatus } from '@ensemus/domain/external-action';
import { knowledgeObjectKey } from '@ensemus/domain/knowledge';
import {
  AGGREGATE_EXTERNAL_ACTION,
  EXTERNAL_ACTION_UNKNOWN,
  externalActionTargetRef,
  NOTIFY_EXTERNAL_ACTION_UNKNOWN,
} from '@ensemus/domain/integration-events';
import { EXPORT_OBJECT_PREFIX, isArchivePath } from '@ensemus/domain/portability';
import {
  LEDGER_PREFIX,
  parseLedgerEntry,
  parseLedgerKey,
  ledgerRef,
} from '@ensemus/domain/tombstone-ledger';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { objectKey, type ObjectStore } from './artifacts';
import { AppError } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import {
  createObjectDeletionExecutor,
  createSqlObjectDeletionAuthority,
  type DeletionTarget,
} from './saas/object-deletion';
import type { ContributorReport, RestoreContributor, RunProbe } from './sovereign-ports';
import { missingRestoreContributors } from './restore-contributors';
import {
  reapplyTombstoneLedger,
  type LedgerReader,
  type ReapplyOptions,
  type ReapplyResult,
} from './tombstone-ledger';
import { failRun, listHeldRuns, loadChangeable, notify, type SweepCursor } from './work';

export type TenantRestoreReport = {
  organizationId: string;
  /**
   * Work holding a run Temporal has no open record of. Marked failed, the same as the upkeep does. In report
   * mode, how many would be.
   */
  runsClosed: number;
  /** Runs Temporal could not answer about. Reported, left alone, and counted as needing attention. */
  runsUnknown: number;
  /** Open work whose run was restored and is still going. Left alone. */
  runsOpen: number;
  /**
   * Intents a person has to look at, because something may have gone out: `sending`, `reconciling`,
   * `unknown`, or `ready` with an attempt behind them. Those whose attempts allow it were moved to `unknown`
   * first, and all stay here until a person has settled them. Never retried (ADR-027 D2).
   */
  actionsNeedingReview: number;
  /** Of those, how many this run moved to `unknown`. In report mode, how many it would. */
  actionsMovedToUnknown: number;
  /**
   * `ready` with no attempt recorded. Not counted as needing attention, since the only way forward is the
   * connector worker that has to stay stopped. If the backup is older than a send, the restored row looks
   * exactly like this, and starting that worker can send it again, so these are listed for whoever decides.
   */
  actionsReadyUnattempted: number;
  /** Bytes in the store with no row. Listed by key, in the operator's report, and not deleted by this. */
  unreferencedObjects: number;
  /** Rows whose bytes are gone or differ from their hash. Files cannot be read back, so a person looks. */
  artifactsMissingBytes: number;
  /** Rows whose bytes could not be read to check them. Not known to be fine, so a person looks. */
  bytesUnchecked: number;
  /** Steps that failed partway. Whatever they would have found is not in this report. */
  checksFailed: number;
  contributors: readonly ContributorReport[];
};

export type RestoreReport = {
  mode: 'report' | 'apply';
  /** In report mode these are what re-applying would do. Nothing has been done. */
  ledger: ReapplyResult;
  tenants: readonly TenantRestoreReport[];
  /** Objects filed under an organization this database does not know. Listed and not deleted. */
  objectsWithoutTenant: number;
  /**
   * A contributor's port has no way to ask it to change nothing, so report mode runs none of them. These
   * are the ones that did not run, and what they would have found is not in this report.
   */
  contributorsNotRun: readonly string[];
  /** Zero means nothing needs a person. The command's exit status comes from this. */
  needsAttention: number;
};

export type RestoreFindingCode =
  | 'RUN_CLOSED'
  | 'RUN_UNKNOWN'
  | 'ACTION_MOVED_TO_UNKNOWN'
  | 'ACTION_NEEDS_REVIEW'
  | 'ACTION_READY_UNATTEMPTED'
  | 'OBJECT_UNREFERENCED'
  | 'OBJECT_WITHOUT_TENANT'
  | 'BYTES_MISSING'
  | 'BYTES_DIFFER'
  | 'BYTES_UNCHECKED'
  | 'CHECK_FAILED'
  | 'CONTRIBUTOR_FAILED';

/** One thing an operator should see. IDs, codes and keys this product made, and never a name. */
export type RestoreFinding = {
  code: RestoreFindingCode;
  organizationId?: string;
  /** A work unit, an intent, a file or an export, by the code. */
  id?: string;
  status?: string;
  /** Only a key whose whole shape this product made. Any other key can hold anything, so it is not shown. */
  objectKey?: string;
  /** Which step, for `CHECK_FAILED` and `CONTRIBUTOR_FAILED`. Our own words. */
  step?: string;
};

type Reconcile = {
  /** Every tenant the database knows. Objects filed under any other are reported as without a tenant. */
  organizationIds: readonly string[];
  contextFor: (organizationId: string) => TenantContext;
  probeRun: RunProbe;
  contributors: readonly RestoreContributor[];
  mode: 'report' | 'apply';
  ledgerOptions?: ReapplyOptions;
  /** Called with each thing found, as it is found, so that a long list is not held in memory. */
  onFinding?: (finding: RestoreFinding) => void;
  /** Called with each ledger entry that could not be finished. Running again picks those up. */
  onLedgerFailed?: (error: unknown) => void;
};

/** What an intent's status and attempts say to do about it. */
export type IntentDecision = 'to_unknown' | 'review' | 'ready_unattempted' | 'none';

/**
 * Pure, so a unit test can reach every case. `to_unknown` is the only move there is, and only where the
 * trigger on `external_actions` would allow it as the attempts stand: it needs an attempt that ended with
 * no answer. An attempt still open is not one, and this does not write its outcome. A workflow that survived
 * the restore does that when the connector worker starts, through ADR-027's own path. So `sending` with an
 * open attempt is reported and stays as it is. It cannot lead to a second send, because the attempt trigger
 * refuses another while an open attempt exists.
 */
export function decideIntentAfterRestore(
  status: ExternalActionStatus,
  outcomes: readonly (AttemptOutcome | null)[],
): IntentDecision {
  switch (status) {
    case 'sending':
    case 'reconciling':
      return outcomes.includes('indeterminate') &&
        !outcomes.includes('accepted') &&
        !outcomes.includes(null)
        ? 'to_unknown'
        : 'review';
    case 'unknown':
      return 'review';
    case 'ready':
      return outcomes.length > 0 ? 'review' : 'ready_unattempted';
    case 'awaiting_approval':
    case 'sent':
    case 'failed':
    case 'cancelled':
      return 'none';
  }
}

const OPEN_INTENT_STATUSES: readonly ExternalActionStatus[] = [
  'ready',
  'sending',
  'reconciling',
  'unknown',
];

/**
 * What keeps the exit status honest. In report mode nothing has been applied, so whatever applying would do
 * is still waiting for someone to run it. A report that exits zero means there is nothing to do at all.
 */
export function countNeedsAttention(
  report: Pick<RestoreReport, 'mode' | 'ledger' | 'tenants' | 'objectsWithoutTenant'>,
): number {
  const { ledger, mode } = report;
  let total =
    ledger.failed +
    ledger.invalid +
    ledger.unconfirmed +
    report.objectsWithoutTenant +
    (mode === 'report'
      ? ledger.tombstonesAdded + ledger.artifactsRemoved + ledger.bytesRemoved
      : 0);
  for (const tenant of report.tenants) {
    total +=
      tenant.runsUnknown +
      tenant.actionsNeedingReview +
      tenant.unreferencedObjects +
      tenant.artifactsMissingBytes +
      tenant.bytesUnchecked +
      tenant.checksFailed +
      missingRestoreContributors(tenant.contributors) +
      tenant.contributors.reduce(
        (sum, contributor) =>
          sum +
          (Number.isSafeInteger(contributor.needsAttention)
            ? Math.max(0, contributor.needsAttention)
            : 0),
        0,
      ) +
      (mode === 'report' ? tenant.runsClosed : 0);
  }
  return total;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IS_UUID = new RegExp(`^${UUID}$`);
const ARTIFACT_KEY = new RegExp(`^${UUID}/artifacts/(${UUID})$`);
const EXPORT_KEY = new RegExp(`^${EXPORT_OBJECT_PREFIX}(${UUID})/(${UUID})/(.+)$`);

/** A key whose every part this product made. Anything else stays out of the report, and is still counted. */
function showableKey(key: string) {
  if (ARTIFACT_KEY.test(key)) return key;
  const part = EXPORT_KEY.exec(key);
  return part && isArchivePath(part[3] as string) ? key : undefined;
}

const withKey = (key: string) => {
  const shown = showableKey(key);
  return shown ? { objectKey: shown } : {};
};

/** Who an object says it belongs to, from its key alone, or null if it does not say. */
export function tenantOfObject(key: string): string | null {
  const exported = EXPORT_KEY.exec(key);
  if (exported) return exported[1] as string;
  const first = key.split('/', 1)[0] as string;
  return IS_UUID.test(first) ? first : null;
}

/** How many intents or rows one short transaction reads. Enough to be quick, few enough to stay short. */
const PAGE = 200;
/** Listing every held run, whichever step it is on. Later than anything a restored row can hold. */
const EVERY_HELD_RUN_MS = 24 * 60 * 60 * 1000;

const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');

/**
 * Counts what `reapplyTombstoneLedger` would do, without doing it, and by the same rule: a file whose row and
 * bytes both exist waits for a person unless it has been confirmed (ADR-026 D3). No transaction stays open
 * during a call to the store.
 */
async function inspectLedger(
  database: AppDatabase,
  store: ObjectStore & LedgerReader,
  contextFor: (organizationId: string) => TenantContext,
  options: ReapplyOptions,
  onFailed?: (error: unknown) => void,
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
        const { organizationId, targetType, targetId } = entry;
        const found = await withTenantTx(database, contextFor(organizationId), async (tx) => {
          const [organization] = await tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.id, organizationId));
          const [tombstone] = await tx
            .select({ id: tombstones.targetId })
            .from(tombstones)
            .where(and(eq(tombstones.targetType, targetType), eq(tombstones.targetId, targetId)));
          const [artifact] = await tx
            .select({ key: artifacts.objectKey })
            .from(artifacts)
            .where(eq(artifacts.id, targetId));
          return {
            known: Boolean(organization),
            tombstoned: Boolean(tombstone),
            artifactKey: artifact?.key ?? null,
          };
        });
        const bytesThere = await store.exists(
          found.artifactKey ?? objectKey(organizationId, targetId),
        );
        if (found.artifactKey && bytesThere && !options.confirmed?.has(ledgerRef(entry))) {
          result.unconfirmed += 1;
          options.onUnconfirmed?.(entry);
          continue;
        }
        if (!found.known) result.organizationsMissing += 1;
        if (found.known && !found.tombstoned) result.tombstonesAdded += 1;
        if (found.artifactKey) result.artifactsRemoved += 1;
        if (bytesThere) result.bytesRemoved += 1;
      } catch (error) {
        result.failed += 1;
        onFailed?.(error);
      }
    }
  }
  return result;
}

type TenantStep = {
  database: AppDatabase;
  store: ObjectStore & LedgerReader;
  context: TenantContext;
  input: Reconcile;
  report: TenantRestoreReport;
  find: (finding: Omit<RestoreFinding, 'organizationId'>) => void;
};

/**
 * Asks about every held run and ends those that are over, through `failRun`, the function the upkeep uses, so
 * a person sees the same failed work with the same Try again. Not knowing is reported, and is never taken to
 * mean closed: Temporal being unreachable must not fail anyone's work.
 */
async function reconcileRuns({ database, context, input, report, find }: TenantStep) {
  const { organizationId } = context;
  const everyRun = new Date(Date.now() + EVERY_HELD_RUN_MS);
  let after: SweepCursor | undefined;
  do {
    const page: Awaited<ReturnType<typeof listHeldRuns>> = await listHeldRuns(
      database,
      context,
      everyRun,
      { after },
    );
    for (const { id, runId } of page.items) {
      if (!runId) continue;
      let state: Awaited<ReturnType<RunProbe>>;
      try {
        state = await input.probeRun({ organizationId, workUnitId: id, runId });
      } catch {
        state = 'unknown';
      }
      if (state === 'open') {
        report.runsOpen += 1;
      } else if (state === 'closed') {
        if (input.mode === 'report') {
          report.runsClosed += 1;
          find({ code: 'RUN_CLOSED', id });
          continue;
        }
        const failed = await withTenantTx(database, context, async (tx) => {
          const work = await loadChangeable(tx, context, id);
          // Rechecked under the lock: it may have moved on since the list was read.
          if (work.runId !== runId) return false;
          return (await failRun(tx, context, work)).status !== work.status;
        });
        if (failed) {
          report.runsClosed += 1;
          find({ code: 'RUN_CLOSED', id });
        }
      } else {
        report.runsUnknown += 1;
        find({ code: 'RUN_UNKNOWN', id });
      }
    }
    after = page.next ?? undefined;
  } while (after);
}

const INTENT_CODE = 'WORKER_INTERRUPTED';

/**
 * The move to `unknown` and what goes with it, all in one transaction under the row's lock. The same record
 * the connector worker leaves when it gets there first: a receipt, an event, an audit row and a word to the
 * people who answer for it. The receipt rests on `system`, since no provider was asked anything. The event
 * has no route to any queue. The dispatcher only starts work for `external_action.ready`.
 */
async function moveIntentToUnknown(
  tx: Tx,
  context: TenantContext,
  action: typeof externalActions.$inferSelect,
  attemptId: string,
) {
  const organizationId = context.organizationId;
  let version = action.version;
  // The trigger has no direct way from `sending`. It goes through `reconciling`, as ADR-027 D1 draws it.
  const steps: readonly ExternalActionStatus[] =
    action.status === 'sending' ? ['reconciling', 'unknown'] : ['unknown'];
  for (const status of steps) {
    version += 1;
    await tx
      .update(externalActions)
      .set({ status, statusReason: INTENT_CODE, version, updatedAt: new Date() })
      .where(eq(externalActions.id, action.id));
  }
  await tx.insert(externalActionReceipts).values({
    organizationId,
    externalActionId: action.id,
    attemptId,
    outcome: 'unknown',
    basis: 'system',
    code: INTENT_CODE,
    requestHash: action.requestHash,
  });
  await emit(tx, context, {
    eventType: EXTERNAL_ACTION_UNKNOWN,
    aggregateType: AGGREGATE_EXTERNAL_ACTION,
    aggregateId: action.id,
    aggregateVersion: version,
    classification: action.classification,
    payload: {
      external_action_id: action.id,
      work_unit_id: action.workUnitId,
      code: INTENT_CODE,
    },
  });
  await appendAudit(tx, {
    organizationId,
    actorType: 'system',
    action: 'external_action.unknown',
    targetRef: externalActionTargetRef(action.id),
    decision: 'allow',
    safeReason: 'RESTORE_RECONCILE',
  });
  const [work] = await tx
    .select({ ownerMembershipId: workUnits.ownerMembershipId })
    .from(workUnits)
    .where(eq(workUnits.id, action.workUnitId));
  await notify(
    tx,
    context,
    [work?.ownerMembershipId, action.createdByMembershipId],
    NOTIFY_EXTERNAL_ACTION_UNKNOWN,
    externalActionTargetRef(action.id),
  );
}

/** One intent, under its lock in apply mode, so a late answer from a worker cannot be written over. */
function settleIntent(
  { database, context, input }: TenantStep,
  id: string,
): Promise<{ decision: IntentDecision; status: string } | null> {
  return withTenantTx(database, context, async (tx) => {
    const query = tx.select().from(externalActions).where(eq(externalActions.id, id));
    const [action] = input.mode === 'apply' ? await query.for('update') : await query;
    if (!action) return null;
    const attempts = await tx
      .select({
        id: externalActionAttempts.id,
        attemptNo: externalActionAttempts.attemptNo,
        outcome: externalActionAttempts.outcome,
      })
      .from(externalActionAttempts)
      .where(eq(externalActionAttempts.externalActionId, id))
      .orderBy(asc(externalActionAttempts.attemptNo));
    const decision = decideIntentAfterRestore(
      action.status as ExternalActionStatus,
      attempts.map((attempt) => attempt.outcome as AttemptOutcome | null),
    );
    const attempt = attempts.findLast(({ outcome }) => outcome === 'indeterminate');
    if (decision !== 'to_unknown' || input.mode === 'report' || !attempt) {
      return { decision, status: action.status };
    }
    await moveIntentToUnknown(tx, context, action, attempt.id);
    return { decision, status: 'unknown' };
  });
}

/** Every intent that is not over, a page at a time, each settled in a transaction of its own. */
async function reconcileIntents(step: TenantStep) {
  const { database, context, report, find } = step;
  let after: string | undefined;
  for (;;) {
    const page = await withTenantTx(database, context, (tx) =>
      tx
        .select({ id: externalActions.id })
        .from(externalActions)
        .where(
          and(
            inArray(externalActions.status, [...OPEN_INTENT_STATUSES]),
            after ? gt(externalActions.id, after) : undefined,
          ),
        )
        .orderBy(asc(externalActions.id))
        .limit(PAGE),
    );
    for (const { id } of page) {
      const settled = await settleIntent(step, id);
      if (!settled) continue;
      const { decision, status } = settled;
      if (decision === 'ready_unattempted') {
        report.actionsReadyUnattempted += 1;
        find({ code: 'ACTION_READY_UNATTEMPTED', id, status });
        continue;
      }
      if (decision === 'none') continue;
      report.actionsNeedingReview += 1;
      if (decision === 'to_unknown') {
        report.actionsMovedToUnknown += 1;
        find({ code: 'ACTION_MOVED_TO_UNKNOWN', id, status });
      } else {
        find({ code: 'ACTION_NEEDS_REVIEW', id, status });
      }
    }
    const last = page.at(-1);
    if (page.length < PAGE || !last) return;
    after = last.id;
  }
}

/**
 * Compares the store with the rows, a page of keys at a time, and lists what has no row. Nothing is deleted:
 * uploads made after the backup end up here, and a person may want them. A row that says its bytes are on
 * their way is the upkeep's and is left to it. A `purged` row says the opposite of what the store shows, so
 * those bytes are as good as unreferenced.
 */
async function findUnreferencedArtifacts({ database, store, context, report, find }: TenantStep) {
  const prefix = `${context.organizationId}/artifacts/`;
  for await (const page of store.listPages(prefix)) {
    if (page.length === 0) continue;
    const referenced = await withTenantTx(database, context, async (tx) => {
      const rows = await tx
        .select({ key: artifacts.objectKey })
        .from(artifacts)
        .where(inArray(artifacts.objectKey, page));
      const pending = await tx
        .select({ key: blobLifecycle.objectKey })
        .from(blobLifecycle)
        .where(
          and(
            inArray(blobLifecycle.objectKey, page),
            inArray(blobLifecycle.state, ['uploading', 'deleting']),
          ),
        );
      return new Set([...rows, ...pending].map((row) => row.key));
    });
    for (const key of page) {
      if (referenced.has(key)) continue;
      report.unreferencedObjects += 1;
      const id = ARTIFACT_KEY.exec(key)?.[1];
      find({ code: 'OBJECT_UNREFERENCED', ...(id ? { id } : {}), ...withKey(key) });
    }
  }
}

/**
 * The same for archives. An export row newer than the database does not exist any more, so its bytes have
 * nothing pointing at them. One the database does know stays subject to `purgeExpiredExports`, and is left
 * to it, unless its row says it was purged, which means the store went back.
 */
async function findUnreferencedExports({ database, store, context, report, find }: TenantStep) {
  const prefix = `${EXPORT_OBJECT_PREFIX}${context.organizationId}/`;
  for await (const page of store.listPages(prefix)) {
    const exportIds = [
      ...new Set(page.flatMap((key) => EXPORT_KEY.exec(key)?.[2] ?? ([] as string[]))),
    ];
    const known =
      exportIds.length === 0
        ? new Set<string>()
        : await withTenantTx(database, context, async (tx) => {
            const rows = await tx
              .select({ id: organizationExports.id })
              .from(organizationExports)
              .where(
                and(
                  inArray(organizationExports.id, exportIds),
                  isNull(organizationExports.purgedAt),
                ),
              );
            return new Set(rows.map((row) => row.id));
          });
    for (const key of page) {
      const id = EXPORT_KEY.exec(key)?.[2];
      if (id && known.has(id)) continue;
      report.unreferencedObjects += 1;
      find({ code: 'OBJECT_UNREFERENCED', ...(id ? { id } : {}), ...withKey(key) });
    }
  }
}

/**
 * Every row against its bytes. It has to read each one to compare hashes, so it holds one file at a time, and
 * no transaction stays open while it does. A row pointing outside its own tenant's folder is reported and
 * never read: a restored row is no reason to open another tenant's file.
 */
async function checkArtifactBytes({ database, store, context, report, find }: TenantStep) {
  const ownFolder = `${context.organizationId}/artifacts/`;
  let after: string | undefined;
  for (;;) {
    const rows = await withTenantTx(database, context, (tx) =>
      tx
        .select({ id: artifacts.id, key: artifacts.objectKey, sha256: artifacts.sha256 })
        .from(artifacts)
        .where(after ? gt(artifacts.id, after) : undefined)
        .orderBy(asc(artifacts.id))
        .limit(PAGE),
    );
    for (const { id, key, sha256: expected } of rows) {
      if (!key.startsWith(ownFolder)) {
        report.artifactsMissingBytes += 1;
        find({ code: 'BYTES_DIFFER', id });
        continue;
      }
      try {
        if (!(await store.exists(key))) {
          report.artifactsMissingBytes += 1;
          find({ code: 'BYTES_MISSING', id });
        } else if (sha256(await store.get(key)) !== expected) {
          report.artifactsMissingBytes += 1;
          find({ code: 'BYTES_DIFFER', id });
        }
      } catch {
        report.bytesUnchecked += 1;
        find({ code: 'BYTES_UNCHECKED', id });
      }
    }
    const last = rows.at(-1);
    if (rows.length < PAGE || !last) return;
    after = last.id;
  }
}

/** Runs one step, so that one failing costs its own findings and not the rest of the report. */
async function runStep(step: TenantStep, name: string, run: (step: TenantStep) => Promise<void>) {
  try {
    await run(step);
  } catch {
    step.report.checksFailed += 1;
    step.find({ code: 'CHECK_FAILED', step: name });
  }
}

async function runContributors(step: TenantStep): Promise<ContributorReport[]> {
  const { database, context, input, find } = step;
  const reports: ContributorReport[] = [];
  for (const contributor of input.contributors) {
    try {
      const report = await contributor.reconcile(database, context);
      if (
        report.name !== contributor.name ||
        [report.checked, report.changed, report.needsAttention].some(
          (value) => !Number.isSafeInteger(value) || value < 0,
        )
      )
        throw new Error('RESTORE_PROOF_INVALID');
      reports.push(report);
    } catch {
      find({ code: 'CONTRIBUTOR_FAILED', step: contributor.name });
      reports.push({ name: contributor.name, checked: 0, changed: 0, needsAttention: 1 });
    }
  }
  return reports;
}

/** Bytes filed under a tenant this database does not have, as a backup older than that tenant leaves. */
async function findObjectsWithoutTenant(
  store: LedgerReader,
  organizationIds: readonly string[],
  onFinding: (finding: RestoreFinding) => void,
) {
  const known = new Set(organizationIds);
  let count = 0;
  try {
    for await (const page of store.listPages('')) {
      for (const key of page) {
        const owner = tenantOfObject(key);
        if (owner === null || known.has(owner)) continue;
        count += 1;
        onFinding({ code: 'OBJECT_WITHOUT_TENANT', organizationId: owner, ...withKey(key) });
      }
    }
  } catch {
    // The tenants' reports are done by now, and an operator should not lose them to this.
    count += 1;
    onFinding({ code: 'CHECK_FAILED', step: 'objects_without_tenant' });
  }
  return count;
}

/**
 * Runs in order, because each step depends on the last: first re-apply the tombstone ledger across all tenants
 * (`reapplyTombstoneLedger`), so nothing below reads a deleted file. Then, for each tenant, runs, intents,
 * bytes and the contributors. Safe to run again. `report` makes it change nothing, so an operator can look
 * before letting it act.
 *
 * If the ledger cannot be read at all this throws, and nothing after it has happened. Anything else that
 * fails is counted, and the rest still runs, because an operator partway through a restore needs to see as
 * much as can be seen.
 */
export async function reconcileAfterRestore(
  database: AppDatabase,
  store: ObjectStore & LedgerReader,
  input: Reconcile,
): Promise<RestoreReport> {
  const contributorInventory = input.contributors.map(({ name }) => ({
    name,
    checked: 0,
    changed: 0,
    needsAttention: 0,
  }));
  if (missingRestoreContributors(contributorInventory) > 0)
    throw new Error('RESTORE_CONTRIBUTOR_INVENTORY_INCOMPLETE');
  const { contextFor, mode } = input;
  const ledgerOptions = input.ledgerOptions ?? {};
  const onFinding = input.onFinding ?? (() => undefined);
  const ledger =
    mode === 'apply'
      ? await reapplyTombstoneLedger(
          database,
          store,
          contextFor,
          input.onLedgerFailed,
          ledgerOptions,
        )
      : await inspectLedger(database, store, contextFor, ledgerOptions, input.onLedgerFailed);

  const tenants: TenantRestoreReport[] = [];
  for (const organizationId of input.organizationIds) {
    const report: TenantRestoreReport = {
      organizationId,
      runsClosed: 0,
      runsUnknown: 0,
      runsOpen: 0,
      actionsNeedingReview: 0,
      actionsMovedToUnknown: 0,
      actionsReadyUnattempted: 0,
      unreferencedObjects: 0,
      artifactsMissingBytes: 0,
      bytesUnchecked: 0,
      checksFailed: 0,
      contributors: [],
    };
    const step: TenantStep = {
      database,
      store,
      context: contextFor(organizationId),
      input,
      report,
      find: (finding) => onFinding({ organizationId, ...finding }),
    };
    await runStep(step, 'runs', reconcileRuns);
    await runStep(step, 'intents', reconcileIntents);
    await runStep(step, 'unreferenced_artifacts', findUnreferencedArtifacts);
    await runStep(step, 'unreferenced_exports', findUnreferencedExports);
    await runStep(step, 'artifact_bytes', checkArtifactBytes);
    if (mode === 'apply') report.contributors = await runContributors(step);
    tenants.push(report);
  }

  const objectsWithoutTenant = await findObjectsWithoutTenant(
    store,
    input.organizationIds,
    onFinding,
  );
  const partial = { mode, ledger, tenants, objectsWithoutTenant };
  return {
    ...partial,
    contributorsNotRun: mode === 'report' ? input.contributors.map(({ name }) => name) : [],
    needsAttention: countNeedsAttention(partial),
  };
}

/**
 * What re-proving one restored object found (0543, ADR-026). `requalified` records the proof for the
 * current material restore generation. `present` names raw objects whose bytes survived the restore:
 * nothing is recorded and that source stays unconfirmed. `unconfirmed` means the store cannot certify
 * physical absence, or could not be asked, so nothing was observed and nothing is recorded.
 */
export type RestoreRequalification =
  | { state: 'requalified'; observed: 'present' | 'absent' }
  | { state: 'present'; documentIds: readonly string[] }
  | { state: 'unconfirmed' };

type AbsenceStore = Pick<ObjectStore, 'isPhysicallyAbsent'>;

function requireRestoreService(context: TenantContext, id: string) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  if (!IS_UUID.test(id)) throw new AppError('INVALID_INPUT');
}

/**
 * The store's own physical-absence answer, never a HEAD: a versioned store may keep old bytes that a
 * HEAD does not see. `null` means the store cannot certify absence, or could not be asked, which proves
 * nothing either way. Restore requalification and the ledger's already-applied check share this.
 */
export async function observePhysicalAbsence(
  store: AbsenceStore,
  key: string,
): Promise<boolean | null> {
  if (!store.isPhysicallyAbsent) return null;
  try {
    return (await store.isPhysicallyAbsent(key)) === true;
  } catch {
    return null;
  }
}

/**
 * Re-proves one generated file whose restored deletion left 0508 restore debt, once the restore was
 * admitted (0422). The object is observed in the store, then one service-only SQL call records that
 * observation for this object and its exact writer in the current generation. It deletes nothing: the
 * ordinary lifecycle (`reapplyTombstoneLedger` with its `derivedArtifacts` binding) then proves the
 * deletion itself, and only that clears the restore-pending header. Running it again changes nothing.
 */
export async function requalifyGeneratedRestoreDebt(
  database: AppDatabase,
  store: AbsenceStore,
  context: TenantContext,
  artifactId: string,
): Promise<RestoreRequalification> {
  requireRestoreService(context, artifactId);
  const [header] = await withTenantTx(database, context, (tx) =>
    tx
      .select({ objectKey: artifactLineage.objectKey })
      .from(artifactLineage)
      .where(eq(artifactLineage.artifactId, artifactId)),
  );
  if (!header) return { state: 'unconfirmed' };
  const absent = await observePhysicalAbsence(store, header.objectKey);
  if (absent === null) return { state: 'unconfirmed' };
  const observed = absent ? 'absent' : 'present';
  await withTenantTx(database, context, (tx) =>
    tx.execute(
      sql`select lifecycle.requalify_object_restore_debt(${artifactId}::uuid,${observed}) as state`,
    ),
  );
  return { state: 'requalified', observed };
}

/**
 * Re-proves one closed source whose raw inventory a restore left as 0516 restore debt, once the
 * restore was admitted (0422). Every raw object the inventory names is observed in the store. Only
 * when each is physically absent does one service-only SQL call record the proof, naming exactly
 * those objects, and the source's purge job can then complete under 0516's own guard. A surviving
 * object is reported and nothing is recorded: `deleteRawRestoreSurvivor` deletes it, one object at
 * a time (0547). Running it again changes nothing.
 */
export async function requalifyRawRestoreSource(
  database: AppDatabase,
  store: AbsenceStore,
  context: TenantContext,
  sourceId: string,
): Promise<RestoreRequalification> {
  requireRestoreService(context, sourceId);
  const documents = await withTenantTx(database, context, async (tx) => {
    const result = await tx.execute<{ documents: string[] | null }>(
      sql`select lifecycle.raw_restore_requalification_documents(${sourceId}::uuid)::text[] as documents`,
    );
    return result.rows[0]?.documents ?? null;
  });
  if (!documents || documents.some((id) => !IS_UUID.test(id))) return { state: 'unconfirmed' };
  const present: string[] = [];
  for (const documentId of documents) {
    const absent = await observePhysicalAbsence(
      store,
      knowledgeObjectKey(context.organizationId, documentId),
    );
    if (absent === null) return { state: 'unconfirmed' };
    if (!absent) present.push(documentId);
  }
  if (present.length > 0) return { state: 'present', documentIds: present };
  // The exact set the inventory named, each one observed absent above. Never a pattern or a count.
  const observedAbsent =
    documents.length === 0
      ? sql`'{}'::uuid[]`
      : sql`ARRAY[${sql.join(
          documents.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]::uuid[]`;
  await withTenantTx(database, context, (tx) =>
    tx.execute(
      sql`select lifecycle.requalify_raw_restore_source(${sourceId}::uuid,${observedAbsent}) as state`,
    ),
  );
  return { state: 'requalified', observed: 'absent' };
}

/**
 * What deleting one raw object that survived a restore found (0547). `deleted` means its deletion
 * was proven, and carries what re-proving its source then found: `requalified` once every object of
 * the source is absent, `present` while others survive. `held` and `unconfirmed` deleted nothing
 * that was proven, and the source stays in debt.
 */
export type RawRestoreSurvivorDeletion =
  | { state: 'deleted'; source: RestoreRequalification }
  | { state: 'held' }
  | { state: 'unconfirmed' };

/** The store capabilities the survivor deletion uses: the single capability-backed DELETE and the
 * physical-absence check. Never a plain delete or a HEAD. */
export type RawRestoreSurvivorStore = Pick<
  ObjectStore,
  'isPhysicallyAbsent' | 'deleteForPurge' | 'assertPurgeCapability'
>;

/** 0547's exact target, as SQL returns it and as begin_object_deletion compares it, key for key. */
const survivorTarget = z.strictObject({
  kind: z.literal('raw_restore_survivor'),
  sourceId: idSchema,
  sourceVersion: z.string().regex(/^[1-9][0-9]*$/),
  purgeJobId: idSchema,
  documentId: idSchema,
  writeId: idSchema,
  generation: z.int().nonnegative(),
  priorMaterialRestoreGeneration: idSchema,
  materialRestoreGeneration: idSchema,
  authRestoreGeneration: idSchema,
});

const refuseUnadmitted = async (): Promise<never> => {
  throw new AppError('OBJECT_DELETE_UNCONFIRMED');
};

/**
 * Deletes one raw Knowledge object whose bytes survived an admitted restore, named by its source and
 * document IDs (0547, ADR-026 D3a). FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person.
 *
 * There is no pattern and no source-wide or tenant-wide form, the same as `requalifyRawRestoreSource`.
 * SQL names the exact target only for a closed source whose inventory a restore left in debt, every
 * writer concluded and no live header. The deletion then goes through the existing object-deletion
 * lifecycle unchanged (`createObjectDeletionExecutor`): admission with the hold check, one
 * capability-backed DELETE, the terminal outcome, an independent physical-absence check, and only
 * then the SQL proof. Only after that proof is the source re-proven through 0543's own per-source
 * proof, which retires its restore debt for this generation once every object is absent. An unknown
 * or unproven deletion leaves an unresolved claim, which keeps the source unconfirmed.
 */
export async function deleteRawRestoreSurvivor(
  database: AppDatabase,
  store: RawRestoreSurvivorStore,
  context: TenantContext,
  input: { sourceId: string; documentId: string },
): Promise<RawRestoreSurvivorDeletion> {
  requireRestoreService(context, input.sourceId);
  requireRestoreService(context, input.documentId);
  const found = await withTenantTx(database, context, async (tx) => {
    const result = await tx.execute<{ target: unknown }>(
      sql`select lifecycle.raw_restore_survivor_delete_target(${input.sourceId}::uuid,${input.documentId}::uuid) as target`,
    );
    return result.rows.length === 1 ? result.rows[0]?.target : undefined;
  });
  const target = survivorTarget.safeParse(found);
  if (
    !target.success ||
    target.data.sourceId !== input.sourceId ||
    target.data.documentId !== input.documentId
  )
    return { state: 'unconfirmed' };
  const erase = createObjectDeletionExecutor({
    authority: createSqlObjectDeletionAuthority(database),
    store: {
      // The executor never calls these: only the capability-backed purge and the absence check.
      delete: refuseUnadmitted,
      exists: refuseUnadmitted,
      ...(store.deleteForPurge ? { deleteForPurge: store.deleteForPurge.bind(store) } : {}),
      ...(store.isPhysicallyAbsent
        ? { isPhysicallyAbsent: store.isPhysicallyAbsent.bind(store) }
        : {}),
      ...(store.assertPurgeCapability
        ? { assertPurgeCapability: store.assertPurgeCapability.bind(store) }
        : {}),
    },
  });
  // The executor hands the target to lifecycle.begin_object_deletion as it is: DeletionTarget's
  // 'raw_restore_survivor' variant (0547), with exactly the keys parsed above, and SQL checks every
  // key of it again against the target it names itself.
  const survivor: DeletionTarget = target.data;
  const result = await erase(context, survivor);
  if (result.state !== 'purged') return { state: result.state };
  return {
    state: 'deleted',
    source: await requalifyRawRestoreSource(database, store, context, input.sourceId),
  };
}

/**
 * Re-proves one imported archive file whose restored row left 0508 archive restore debt (0545), the
 * archive counterpart of `requalifyGeneratedRestoreDebt`. The quarantine object is observed, and one
 * service-only SQL call records the observation for that file and its exact writer token in the
 * current generation. It deletes nothing: the archive quarantine lifecycle proves the deletion. A file
 * observed present stays owed (object_delete_counts) until that deletion is proven.
 */
export async function requalifyArchiveRestoreDebt(
  database: AppDatabase,
  store: AbsenceStore,
  context: TenantContext,
  input: { importId: string; sourceArtifactId: string },
): Promise<RestoreRequalification> {
  requireRestoreService(context, input.importId);
  requireRestoreService(context, input.sourceArtifactId);
  const key = await withTenantTx(database, context, async (tx) => {
    const result = await tx.execute<{ key: string | null }>(
      sql`select lifecycle.archive_restore_requalification_key(${input.importId}::uuid,${input.sourceArtifactId}::uuid) as key`,
    );
    return result.rows[0]?.key ?? null;
  });
  if (!key || !key.startsWith(`${context.organizationId}/archive-quarantine/`))
    return { state: 'unconfirmed' };
  const absent = await observePhysicalAbsence(store, key);
  if (absent === null) return { state: 'unconfirmed' };
  const observed = absent ? 'absent' : 'present';
  await withTenantTx(database, context, (tx) =>
    tx.execute(
      sql`select lifecycle.requalify_archive_restore_debt(${input.importId}::uuid,${input.sourceArtifactId}::uuid,${observed}) as state`,
    ),
  );
  return { state: 'requalified', observed };
}

/**
 * What re-proving one active source a restore left in raw debt found (0549). `requalified` records
 * the proof for the current material restore generation. `missing` names catalogued objects the store
 * itself reports physically absent: nothing is recorded and the source stays in debt. `unconfirmed`
 * means the source is not one this path covers, or the store could not be read or cannot certify
 * absence, so nothing was observed and nothing is recorded.
 */
export type ActiveSourceRequalification =
  | { state: 'requalified'; observed: 'present' }
  | { state: 'missing'; documentIds: readonly string[] }
  | { state: 'unconfirmed' };

/** The store reads the active-source re-proof uses: the bytes, and the physical-absence check. */
export type ActiveSourceRequalificationStore = Pick<ObjectStore, 'isPhysicallyAbsent'> &
  Partial<Pick<ObjectStore, 'get'>>;

/**
 * Re-proves one ACTIVE source whose raw inventory a restore rotation left as 0516 restore debt,
 * although it was never sealed or closed (0549, check finding 6). FLAGGED FOR HUMAN SECURITY REVIEW,
 * not yet reviewed by a person. Without it the source can never be revoked or deleted (0516's guard
 * refuses its inventory's move), and no new version of it can be written.
 *
 * Needs the restore admitted (0422) and the tenant's raw marker requalified first
 * (`requalifyRawRestoreOrganization`, 0545). Every catalogued object of an earlier generation is read
 * from the store and hashed; one service-only SQL call then records the observation, and SQL refuses
 * unless each one matches its catalog row and live header exactly, every writer of the source
 * concluded and no deletion claim on its objects is unresolved. It writes and deletes nothing. A
 * requalified source can be closed, and a new version of it written natively; its older objects are
 * never written again, and their purge after a closure stays owed (0549's header). Running it again
 * changes nothing.
 */
export async function requalifyRawRestoreActiveSource(
  database: AppDatabase,
  store: ActiveSourceRequalificationStore,
  context: TenantContext,
  sourceId: string,
): Promise<ActiveSourceRequalification> {
  requireRestoreService(context, sourceId);
  const documents = await withTenantTx(database, context, async (tx) => {
    const result = await tx.execute<{ documents: string[] | null }>(
      sql`select lifecycle.raw_active_restore_requalification_documents(${sourceId}::uuid)::text[] as documents`,
    );
    return result.rows[0]?.documents ?? null;
  });
  if (!documents || documents.some((id) => !IS_UUID.test(id)) || !store.get)
    return { state: 'unconfirmed' };
  const observed: { documentId: string; sha256: string; size: number }[] = [];
  const missing: string[] = [];
  for (const documentId of documents) {
    const key = knowledgeObjectKey(context.organizationId, documentId);
    let bytes: Buffer;
    try {
      bytes = await store.get(key);
    } catch {
      // A read that failed is not absence: only the store's own physical-absence check says so.
      if ((await observePhysicalAbsence(store, key)) === true) {
        missing.push(documentId);
        continue;
      }
      return { state: 'unconfirmed' };
    }
    observed.push({
      documentId,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    });
  }
  if (missing.length > 0) return { state: 'missing', documentIds: missing };
  // The exact set SQL named, each read above. Never a pattern or a count.
  const list = <T>(values: readonly T[], cast: 'uuid' | 'text' | 'bigint') =>
    values.length === 0
      ? sql.raw(`'{}'::${cast}[]`)
      : sql`ARRAY[${sql.join(
          values.map((value) => sql`${value}::${sql.raw(cast)}`),
          sql`, `,
        )}]::${sql.raw(cast)}[]`;
  await withTenantTx(database, context, (tx) =>
    tx.execute(
      sql`select lifecycle.requalify_raw_restore_active_source(${sourceId}::uuid,${list(
        observed.map((o) => o.documentId),
        'uuid',
      )},${list(
        observed.map((o) => o.sha256),
        'text',
      )},${list(
        observed.map((o) => o.size),
        'bigint',
      )}) as state`,
    ),
  );
  return { state: 'requalified', observed: 'present' };
}

/**
 * Re-admits native raw Knowledge births for one tenant after an admitted restore (0545). A restore
 * rotation leaves the organization's raw inventory marker as restore debt, which refuses every native
 * raw upload and the raw erasure witness for ever. This records, for the current generation only,
 * that new births follow the native protocol again. It proves nothing about any older object: each
 * source a restore left in debt keeps its own debt until `requalifyRawRestoreSource` proves it.
 */
export async function requalifyRawRestoreOrganization(
  database: AppDatabase,
  context: TenantContext,
): Promise<{ state: 'requalified' }> {
  requireRestoreService(context, context.organizationId);
  await withTenantTx(database, context, (tx) =>
    tx.execute(sql`select lifecycle.requalify_raw_restore_org() as state`),
  );
  return { state: 'requalified' };
}
