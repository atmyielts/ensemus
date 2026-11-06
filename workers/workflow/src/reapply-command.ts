// What `node dist/reapply-ledger.js` does. It puts back every deletion the tombstone ledger knows about,
// and running it again changes nothing. It prints counts and IDs, no names, and answers with the exit
// status: 0 when nothing is left to do, 1 when something is, and 2 when it refused to start.
//   node dist/reapply-ledger.js [--confirm <entry>]... [--confirm-file <path>]... [--quarantine <entry or key>]...
// An <entry> is what this prints as ledgerEntry. --confirm says that a deletion it could not take on
// the ledger's word alone is real, and --confirm-file says the same of each entry a file lists.
// --quarantine says that it is not, and moves the object aside.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  quarantineLedgerObject,
  reapplyTombstoneLedger,
  type LedgerReader,
  type ObjectStore,
  type ReapplyResult,
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

function readArguments(args: string[]) {
  let values;
  try {
    values = parseArgs({
      args,
      options: {
        confirm: { type: 'string', multiple: true, default: [] },
        'confirm-file': { type: 'string', multiple: true, default: [] },
        quarantine: { type: 'string', multiple: true, default: [] },
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
  return { confirmed: new Set([...values.confirm, ...listed]), toQuarantine, listed };
}

export async function reapplyCommand(
  args: string[],
  { database, store }: { database: AppDatabase; store: ObjectStore & LedgerReader },
): Promise<number> {
  let parsed: ReturnType<typeof readArguments>;
  try {
    parsed = readArguments(args);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    log.error('tombstone_ledger.reapply_refused', { reasonCode: error.reasonCode });
    return REFUSED;
  }
  const { confirmed, toQuarantine, listed } = parsed;
  if (listed.length > 0) log.info('tombstone_ledger.confirm_file_read', { count: listed.length });

  for (const key of toQuarantine) {
    await quarantineLedgerObject(database, store, createServiceContext, key);
    log.warn('tombstone_ledger.entry_quarantined', { count: 1 });
  }
  const result = await reapplyTombstoneLedger(
    database,
    store,
    createServiceContext,
    (error) => log.warn('tombstone_ledger.entry_failed', { errorCode: errorCode(error) }),
    {
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
  return exitCodeFor(result);
}
