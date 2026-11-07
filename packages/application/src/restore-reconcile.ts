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
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { objectKey, type ObjectStore } from './artifacts';
import { emit } from './events';
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
