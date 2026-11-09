// What `node dist/restore-reconcile.js` does, run after a restore and before anyone is let back in (ADR-030
// D11). Report mode is the default and changes nothing, the ledger included: it reads and counts.
//   node dist/restore-reconcile.js [--apply] [--confirm <entry>]... [--confirm-file <path>]... [--quarantine <entry or key>]...
//     [--requalify-organization <org>]... [--requalify-artifact <org>/<artifact>]...
//     [--requalify-archive <org>/<import>/<source artifact>]... [--requalify-source <org>/<source>]...
//     [--delete-raw-survivor <org>/<source>/<document>]... [--requalify-active-source <org>/<source>]...
//     [--record-active-source-closure <org>/<source>]...
// --confirm, --confirm-file, --quarantine, --requalify-* and --delete-raw-survivor mean what they mean to
// reapply-ledger.js (ADR-026 D3; 0543, 0545, 0547 and 0550 for the restore-debt re-proofs). A re-proof
// records something, so it needs --apply.
// --record-active-source-closure names one active source a restore left in raw debt that
// --requalify-active-source cannot re-prove, because an object of it is missing or changed (0551,
// FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person). Every catalogued object is read
// and hashed, or observed absent by the store, and the observation recorded, so the source can be
// closed and its ordinary purge can delete it. It never lets the source be written to. It needs
// --apply, and --requalify-organization for the same tenant in this run or an earlier one.
// It answers with the exit status: 0 when nothing needs a person, 1 when something does, 2 for a bad argument.
//
// It prints one line of JSON for each thing, with counts, IDs, codes and keys this product made, and no names.
// That goes to standard output and not through the logger, because the logger's fields are an allowlist of
// other things, and it refuses a slash in a value, which an object key has.
//
// It sends nothing and can start nothing. It holds a Temporal client only to read whether a run is open, and
// has no path to the connector queue. Keeping the connector worker stopped until this has been run and its
// report reviewed is the operator's job, and nothing here enforces it.
import { parseArgs } from 'node:util';
import {
  quarantineLedgerObject,
  reconcileAfterRestore,
  recordRawRestoreActiveSourceClosure,
  type LedgerReader,
  type ObjectStore,
  type ReapplyOptions,
  type RestoreContributor,
  type RestoreFinding,
  type RestoreReport,
  type RunProbe,
} from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { LEDGER_PREFIX, ledgerKeyFromRef, ledgerRef } from '@ensemus/domain/tombstone-ledger';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { WorkflowNotFoundError } from '@temporalio/client';
import {
  readConfirmFile,
  readRequalifications,
  REQUALIFY_OPTIONS,
  type RequalifyFunctions,
  requalificationLeftToDo,
  runRequalifications,
} from './reapply-command';

export const log = createLogger('restore-reconcile');

const NEEDS_ATTENTION = 1;
const REFUSED = 2;
const EXACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class Refused extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

/**
 * The same rules as reapply-ledger.js, and its reader of confirm files. An argument that is not exactly an
 * entry stops the command before it has changed anything. Moving an object aside is a change, so asking for
 * one without --apply is refused rather than quietly not done.
 */
export function readReconcileArguments(args: string[]) {
  let values;
  try {
    values = parseArgs({
      args,
      options: {
        apply: { type: 'boolean', default: false },
        confirm: { type: 'string', multiple: true, default: [] },
        'confirm-file': { type: 'string', multiple: true, default: [] },
        quarantine: { type: 'string', multiple: true, default: [] },
        'record-active-source-closure': { type: 'string', multiple: true, default: [] },
        ...REQUALIFY_OPTIONS,
      },
    }).values;
  } catch {
    throw new Refused('NOT_AN_OPTION');
  }
  const requalifications = readRequalifications(values);
  // Recording a proof is a change, so it is refused without --apply rather than quietly not done.
  if (requalifications.length > 0 && !values.apply) throw new Refused('REQUALIFY_NEEDS_APPLY');
  // One source by its two exact IDs: a tenant alone, a pattern or an object is refused.
  const closures = values['record-active-source-closure'].map((given) => {
    const parts = given.split('/');
    if (parts.length !== 2 || !parts.every((part) => EXACT_ID.test(part)))
      throw new Refused('NOT_A_RESTORE_OBJECT');
    return { organizationId: parts[0]!, sourceId: parts[1]! };
  });
  if (closures.length > 0 && !values.apply) throw new Refused('CLOSURE_NEEDS_APPLY');
  for (const ref of values.confirm) {
    if (!ledgerKeyFromRef(ref)) throw new Refused('NOT_A_LEDGER_ENTRY');
  }
  const listed = values['confirm-file'].flatMap((path) => readConfirmFile(path));
  // A key as well as a reference, because an object with no valid key has no reference to give.
  const toQuarantine = values.quarantine.map((given) => {
    const key = given.startsWith(LEDGER_PREFIX) ? given : ledgerKeyFromRef(given);
    if (!key) throw new Refused('NOT_A_LEDGER_ENTRY');
    return key;
  });
  if (toQuarantine.length > 0 && !values.apply) throw new Refused('QUARANTINE_NEEDS_APPLY');
  return {
    mode: values.apply ? ('apply' as const) : ('report' as const),
    confirmed: new Set([...values.confirm, ...listed]),
    toQuarantine,
    requalifications,
    closures,
  };
}

/** What one named active-source closure found, printed as one line. */
type ClosureOutcome = {
  organizationId: string;
  sourceId: string;
  state: 'recorded' | 'unchanged' | 'unconfirmed' | 'refused';
  documentIds?: readonly string[];
  errorCode?: string;
};

/** Both refusals carry a code: this file's, and the one reapply-command.ts throws from its file reader. */
function refusalCode(error: unknown) {
  const code = (error as { reasonCode?: unknown } | null)?.reasonCode;
  return typeof code === 'string' ? code : null;
}

/** The statuses Temporal gives a run that has ended. Anything it adds later is not assumed to be one. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TERMINATED',
  'TIMED_OUT',
  'CONTINUED_AS_NEW',
]);

/**
 * The same question main.ts asks for the upkeep, with one difference. The upkeep answers `open` when it cannot
 * tell, and asks again on its next sweep. There is no next sweep here, so not knowing is `unknown`, which is
 * reported and never treated as closed.
 */
export function createRunProbe(
  describe: (input: Parameters<RunProbe>[0]) => Promise<{ status: { name: string } }>,
): RunProbe {
  return async (input) => {
    try {
      const { status } = await describe(input);
      if (status.name === 'RUNNING') return 'open';
      return CLOSED_STATUSES.has(status.name) ? 'closed' : 'unknown';
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return 'closed';
      log.warn('restore_reconcile.probe_failed', { errorCode: errorCode(error) });
      return 'unknown';
    }
  };
}

export type ReconcileDeps = {
  database: AppDatabase;
  store: ObjectStore & LedgerReader;
  listOrganizations: () => Promise<readonly string[]>;
  probeRun: RunProbe;
  contributors: readonly RestoreContributor[];
  write?: (line: string) => void;
  /** Only a test replaces this, to look at what the command asks for without a database. */
  reconcile?: typeof reconcileAfterRestore;
  /** The same. */
  quarantine?: typeof quarantineLedgerObject;
  /** The production generated-file lifecycle (0508) the ledger re-apply needs for a generated file. */
  derivedArtifacts?: ReapplyOptions['derivedArtifacts'];
  /** Only a test replaces this. */
  requalify?: RequalifyFunctions;
  /** Only a test replaces this. */
  recordClosure?: typeof recordRawRestoreActiveSourceClosure;
};

const printFinding = (print: (fields: object) => void, finding: RestoreFinding) =>
  print({ event: 'restore_reconcile.finding', ...finding });

/** Prints the report. Everything in it is a count, an ID or a code. */
function printReport(print: (fields: object) => void, report: RestoreReport) {
  print({ event: 'restore_reconcile.ledger', mode: report.mode, ...report.ledger });
  for (const tenant of report.tenants) {
    print({ event: 'restore_reconcile.tenant', mode: report.mode, ...tenant });
  }
  print({
    event: 'restore_reconcile.finished',
    mode: report.mode,
    tenants: report.tenants.length,
    objectsWithoutTenant: report.objectsWithoutTenant,
    contributorsNotRun: report.contributorsNotRun,
    needsAttention: report.needsAttention,
  });
}

export async function restoreReconcileCommand(
  args: string[],
  deps: ReconcileDeps,
): Promise<number> {
  const write = deps.write ?? ((line: string) => void process.stdout.write(line));
  const print = (fields: object) => write(`${JSON.stringify(fields)}\n`);

  let parsed: ReturnType<typeof readReconcileArguments>;
  try {
    parsed = readReconcileArguments(args);
  } catch (error) {
    const reasonCode = refusalCode(error);
    if (reasonCode === null) throw error;
    log.error('restore_reconcile.refused', { reasonCode });
    return REFUSED;
  }
  const { mode, confirmed, toQuarantine, requalifications, closures } = parsed;
  const reconcile = deps.reconcile ?? reconcileAfterRestore;
  const quarantine = deps.quarantine ?? quarantineLedgerObject;

  // Said on every run, because nothing else stops a connector worker being started too early.
  print({
    event: 'restore_reconcile.reminder',
    reasonCode: 'CONNECTOR_WORKER_STAYS_STOPPED_UNTIL_REVIEWED',
    enforcedByCode: false,
  });
  try {
    for (const key of toQuarantine) {
      await quarantine(deps.database, deps.store, createServiceContext, key);
      print({ event: 'restore_reconcile.entry_quarantined', count: 1 });
    }
    // Before the ledger, so a re-proven generated file is deleted by the re-apply in this same run.
    const outcomes = await runRequalifications(
      deps.database,
      deps.store,
      requalifications,
      deps.requalify ? { requalify: deps.requalify } : {},
    );
    for (const { request, ...outcome } of outcomes)
      print({ event: 'restore_reconcile.requalification', ...request, ...outcome });
    // After the organization marker above, which 0551 requires requalified first. One at a time; a
    // refusal is reported and leaves that source in debt.
    const recordClosure = deps.recordClosure ?? recordRawRestoreActiveSourceClosure;
    const closed: ClosureOutcome[] = [];
    for (const named of closures) {
      let outcome: ClosureOutcome;
      try {
        const answer = await recordClosure(
          deps.database,
          deps.store,
          createServiceContext(named.organizationId),
          named.sourceId,
        );
        outcome = { ...named, state: answer.state };
        if (answer.state === 'recorded') outcome.documentIds = answer.absentDocumentIds;
      } catch (error) {
        outcome = { ...named, state: 'refused', errorCode: errorCode(error) };
      }
      closed.push(outcome);
      print({ event: 'restore_reconcile.active_source_closure', ...outcome });
    }
    const organizationIds = await deps.listOrganizations();
    const report = await reconcile(deps.database, deps.store, {
      organizationIds,
      contextFor: createServiceContext,
      probeRun: deps.probeRun,
      contributors: deps.contributors,
      mode,
      ledgerOptions: {
        ...(mode === 'apply' && deps.derivedArtifacts
          ? { derivedArtifacts: deps.derivedArtifacts }
          : {}),
        confirmed,
        onUnconfirmed: (entry) =>
          print({ event: 'restore_reconcile.entry_unconfirmed', ledgerEntry: ledgerRef(entry) }),
        // A key that names no entry can hold anything, so it stays out of this. It is in the store.
        onInvalid: (named) =>
          print({
            event: 'restore_reconcile.entry_invalid',
            ...(named ? { ledgerEntry: ledgerRef(named) } : { count: 1 }),
          }),
      },
      onFinding: (finding) => printFinding(print, finding),
      onLedgerFailed: (error) =>
        log.warn('restore_reconcile.entry_failed', { errorCode: errorCode(error) }),
    });
    printReport(print, report);
    return report.needsAttention > 0 ||
      outcomes.some(requalificationLeftToDo) ||
      closed.some((outcome) => outcome.state !== 'recorded')
      ? NEEDS_ATTENTION
      : 0;
  } catch (error) {
    log.error('restore_reconcile.failed', { errorCode: errorCode(error) });
    return NEEDS_ATTENTION;
  }
}
