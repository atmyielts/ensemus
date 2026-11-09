// What `node dist/reapply-ledger.js` does. It puts back every deletion the tombstone ledger knows about,
// and running it again changes nothing. It prints counts and IDs, no names, and answers with the exit
// status: 0 when nothing is left to do, 1 when something is, and 2 when it refused to start.
//   node dist/reapply-ledger.js [--confirm <entry>]... [--confirm-file <path>]... [--quarantine <entry or key>]...
//     [--requalify-organization <org>]... [--requalify-artifact <org>/<artifact>]...
//     [--requalify-archive <org>/<import>/<source artifact>]... [--requalify-source <org>/<source>]...
// An <entry> is what this prints as ledgerEntry. --confirm says that a deletion it could not take on
// the ledger's word alone is real, and --confirm-file says the same of each entry a file lists.
// --quarantine says that it is not, and moves the object aside. Each --requalify-* names one object a
// restore left in restore debt, for the service to re-prove once the restore was admitted (0543, 0545):
// it observes the object and records that observation; the deletion is still proven by the ordinary
// lifecycle (the generated-file one runs in the re-apply below).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  quarantineLedgerObject,
  reapplyTombstoneLedger,
  requalifyArchiveRestoreDebt,
  requalifyGeneratedRestoreDebt,
  requalifyRawRestoreOrganization,
  requalifyRawRestoreSource,
  type LedgerReader,
  type ObjectStore,
  type ReapplyOptions,
  type ReapplyResult,
  type RestoreRequalification,
} from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { LEDGER_PREFIX, ledgerKeyFromRef, ledgerRef } from '@ensemus/domain/tombstone-ledger';
import { createLogger, errorCode } from '@ensemus/telemetry';

export const log = createLogger('reapply-ledger');

const LEFT_TO_DO = 1;
const REFUSED = 2;

/** Stops the command before it has done anything, so a mistake cannot look like an entry dealt with. */
class Refused extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

/**
 * Whether anything is left for someone to do. A tenant stays refused while an entry is invalid or
 * unconfirmed, so a run that leaves one has not succeeded, whatever else it managed.
 */
export const exitCodeFor = (result: ReapplyResult) =>
  result.failed > 0 || result.invalid > 0 || result.unconfirmed > 0 ? LEFT_TO_DO : 0;

/**
 * The entries a file names, one to a line. Each line is an exact entry, spelled as this command prints
 * it, because the file stands for a person naming each one: that is all that stops a forged entry from
 * destroying a live file (ADR-026 D3). So there is no pattern and no way to say "all of this tenant".
 * One line that is anything else refuses the whole file, and so does a file that names nothing, which
 * is what a wrong path or an empty list looks like.
 */
export function readConfirmFile(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Refused('CONFIRM_FILE_UNREADABLE');
  }
  // Only what an editor can add without anyone meaning to: a final line ending, or a Windows one.
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new Refused('CONFIRM_FILE_EMPTY');
  for (const line of lines) if (!ledgerKeyFromRef(line)) throw new Refused('NOT_A_LEDGER_ENTRY');
  return lines;
}

/** One restored object or tenant an operator names for re-proof after an admitted restore (0543, 0545). */
export type RestoreRequalificationRequest =
  | { kind: 'artifact'; organizationId: string; artifactId: string }
  | { kind: 'archive'; organizationId: string; importId: string; sourceArtifactId: string }
  | { kind: 'source'; organizationId: string; sourceId: string }
  | { kind: 'organization'; organizationId: string };

/** The options that name them. Each names exactly one object by its IDs: never a pattern or a count. */
const exactObjects = () => ({
  type: 'string' as const,
  multiple: true as const,
  default: [] as string[],
});
export const REQUALIFY_OPTIONS = {
  'requalify-artifact': exactObjects(),
  'requalify-archive': exactObjects(),
  'requalify-source': exactObjects(),
  'requalify-organization': exactObjects(),
};

/** The service-only requalifications a run calls. Only a test replaces them. */
export type RequalifyFunctions = {
  artifact: typeof requalifyGeneratedRestoreDebt;
  archive: typeof requalifyArchiveRestoreDebt;
  source: typeof requalifyRawRestoreSource;
  organization: typeof requalifyRawRestoreOrganization;
};

const EXACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function exactIds(given: string, count: number): string[] {
  const parts = given.split('/');
  if (parts.length !== count || !parts.every((part) => EXACT_ID.test(part)))
    throw new Refused('NOT_A_RESTORE_OBJECT');
  return parts;
}

/**
 * Reads `--requalify-artifact <organization>/<artifact>`, `--requalify-archive
 * <organization>/<import>/<source artifact>`, `--requalify-source <organization>/<source>` and
 * `--requalify-organization <organization>`. Anything else refuses the whole command before it starts.
 */
export function readRequalifications(values: {
  [K in keyof typeof REQUALIFY_OPTIONS]: string[];
}): RestoreRequalificationRequest[] {
  return [
    ...values['requalify-organization'].map((given) => {
      const [organizationId] = exactIds(given, 1);
      return { kind: 'organization' as const, organizationId: organizationId! };
    }),
    ...values['requalify-artifact'].map((given) => {
      const [organizationId, artifactId] = exactIds(given, 2);
      return {
        kind: 'artifact' as const,
        organizationId: organizationId!,
        artifactId: artifactId!,
      };
    }),
    ...values['requalify-archive'].map((given) => {
      const [organizationId, importId, sourceArtifactId] = exactIds(given, 3);
      return {
        kind: 'archive' as const,
        organizationId: organizationId!,
        importId: importId!,
        sourceArtifactId: sourceArtifactId!,
      };
    }),
    ...values['requalify-source'].map((given) => {
      const [organizationId, sourceId] = exactIds(given, 2);
      return { kind: 'source' as const, organizationId: organizationId!, sourceId: sourceId! };
    }),
  ];
}

export type RequalificationOutcome = {
  request: RestoreRequalificationRequest;
  /** `requalified`, `present`, `unconfirmed`, or `refused` when SQL or the store refused it. */
  state: 'requalified' | 'present' | 'unconfirmed' | 'refused';
  observed?: 'present' | 'absent';
  documentIds?: readonly string[];
  errorCode?: string;
};

/**
 * Re-proves each named object through the application's service-only requalification, one at a time.
 * The organization marker goes first, since it is what lets new raw births be native again. Nothing is
 * deleted here: each proof only lets the ordinary lifecycle (the ledger re-apply that follows, or a
 * source's purge) prove the deletion itself. A refusal is reported and leaves its debt in place.
 */
export async function runRequalifications(
  database: AppDatabase,
  store: Pick<ObjectStore, 'isPhysicallyAbsent'>,
  requests: readonly RestoreRequalificationRequest[],
  deps: { requalify?: RequalifyFunctions } = {},
): Promise<RequalificationOutcome[]> {
  const requalify = deps.requalify ?? {
    artifact: requalifyGeneratedRestoreDebt,
    archive: requalifyArchiveRestoreDebt,
    source: requalifyRawRestoreSource,
    organization: requalifyRawRestoreOrganization,
  };
  const outcomes: RequalificationOutcome[] = [];
  for (const request of requests) {
    const context = createServiceContext(request.organizationId);
    try {
      if (request.kind === 'organization') {
        outcomes.push({ request, state: (await requalify.organization(database, context)).state });
        continue;
      }
      const answer: RestoreRequalification =
        request.kind === 'artifact'
          ? await requalify.artifact(database, store, context, request.artifactId)
          : request.kind === 'archive'
            ? await requalify.archive(database, store, context, {
                importId: request.importId,
                sourceArtifactId: request.sourceArtifactId,
              })
            : await requalify.source(database, store, context, request.sourceId);
      const outcome: RequalificationOutcome = { request, state: answer.state };
      if (answer.state === 'present') outcome.documentIds = answer.documentIds;
      else if (answer.state === 'requalified') outcome.observed = answer.observed;
      outcomes.push(outcome);
    } catch (error) {
      outcomes.push({ request, state: 'refused', errorCode: errorCode(error) });
    }
  }
  return outcomes;
}

/** Whether an outcome leaves something for a person: anything but a recorded proof does. */
export const requalificationLeftToDo = (outcome: RequalificationOutcome) =>
  outcome.state !== 'requalified';

function readArguments(args: string[]) {
  let values;
  try {
    values = parseArgs({
      args,
      options: {
        confirm: { type: 'string', multiple: true, default: [] },
        'confirm-file': { type: 'string', multiple: true, default: [] },
        quarantine: { type: 'string', multiple: true, default: [] },
        ...REQUALIFY_OPTIONS,
      },
    }).values;
  } catch {
    throw new Refused('NOT_AN_OPTION');
  }
  for (const ref of values.confirm) {
    if (!ledgerKeyFromRef(ref)) throw new Refused('NOT_A_LEDGER_ENTRY');
  }
  const listed = values['confirm-file'].flatMap(readConfirmFile);
  // A key as well as a reference, because an object with no valid key has no reference to give.
  const toQuarantine = values.quarantine.map((given) => {
    const key = given.startsWith(LEDGER_PREFIX) ? given : ledgerKeyFromRef(given);
    if (!key) throw new Refused('NOT_A_LEDGER_ENTRY');
    return key;
  });
  const requalifications = readRequalifications(values);
  return {
    confirmed: new Set([...values.confirm, ...listed]),
    toQuarantine,
    listed,
    requalifications,
  };
}

export async function reapplyCommand(
  args: string[],
  {
    database,
    store,
    derivedArtifacts,
    requalify,
  }: {
    database: AppDatabase;
    store: ObjectStore & LedgerReader;
    /** The production generated-file lifecycle (0508). Without it a generated deletion stays failed. */
    derivedArtifacts?: ReapplyOptions['derivedArtifacts'];
    /** Only a test replaces this. */
    requalify?: RequalifyFunctions;
  },
): Promise<number> {
  let parsed: ReturnType<typeof readArguments>;
  try {
    parsed = readArguments(args);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    log.error('tombstone_ledger.reapply_refused', { reasonCode: error.reasonCode });
    return REFUSED;
  }
  const { confirmed, toQuarantine, listed, requalifications } = parsed;
  if (listed.length > 0) log.info('tombstone_ledger.confirm_file_read', { count: listed.length });

  for (const key of toQuarantine) {
    await quarantineLedgerObject(database, store, createServiceContext, key);
    log.warn('tombstone_ledger.entry_quarantined', { count: 1 });
  }
  const outcomes = await runRequalifications(
    database,
    store,
    requalifications,
    requalify ? { requalify } : {},
  );
  for (const outcome of outcomes)
    log[requalificationLeftToDo(outcome) ? 'warn' : 'info']('restore_debt.requalification', {
      organizationId: outcome.request.organizationId,
      reasonCode: `REQUALIFY_${outcome.request.kind.toUpperCase()}`,
      status: outcome.observed ? `${outcome.state}:${outcome.observed}` : outcome.state,
      ...(outcome.documentIds ? { count: outcome.documentIds.length } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    });
  const result = await reapplyTombstoneLedger(
    database,
    store,
    createServiceContext,
    (error) => log.warn('tombstone_ledger.entry_failed', { errorCode: errorCode(error) }),
    {
      ...(derivedArtifacts ? { derivedArtifacts } : {}),
      confirmed,
      onUnconfirmed: (entry) =>
        log.warn('tombstone_ledger.entry_unconfirmed', { ledgerEntry: ledgerRef(entry) }),
      // A key that names no entry can hold anything, so it stays out of the log. It is in the store.
      onInvalid: (named) =>
        log.warn(
          'tombstone_ledger.entry_invalid',
          named ? { ledgerEntry: ledgerRef(named) } : { count: 1 },
        ),
    },
  );
  log.info('tombstone_ledger.reapplied', result);
  return outcomes.some(requalificationLeftToDo) ? LEFT_TO_DO : exitCodeFor(result);
}
