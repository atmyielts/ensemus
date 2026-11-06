// What `node dist/organization-import.js` does, which is to read one archive into one new, empty organization
// (ADR-030 D8). The private key is read from the file named here, handed to the import and to nothing else.
// It prints counts, codes and IDs, and no names. It answers with its exit status: 0 when the import completed,
// with or without warnings to read, 1 when it failed, and 2 when it refused to start.
//   node dist/organization-import.js --organization <id> --import <id> --archive <file> --key-file <file>
//   node dist/organization-import.js --organization <id> --import <id> --interrupted
// --interrupted says a run stopped without a chance to say so, which leaves it `running`, and only a person can
// know that no process is still working on it.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  AppError,
  idSchema,
  markOrganizationImportInterrupted,
  runOrganizationImport,
  type ArchiveReader,
  type ImportRunDeps,
  type ImportRunResult,
  type PortabilitySection,
} from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { errorCode } from '@ensemus/telemetry';

const FAILED = 1;
const REFUSED = 2;

export type CommandIo = { out(line: string): void; err(line: string): void };

class Refused extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

type ParsedArguments =
  | { kind: 'interrupted'; organizationId: string; importId: string }
  | {
      kind: 'run';
      organizationId: string;
      importId: string;
      archivePath: string;
      keyPath: string;
    };

function readArguments(args: string[]): ParsedArguments {
  let values;
  try {
    values = parseArgs({
      args,
      options: {
        organization: { type: 'string' },
        import: { type: 'string' },
        archive: { type: 'string' },
        'key-file': { type: 'string' },
        interrupted: { type: 'boolean', default: false },
      },
    }).values;
  } catch {
    throw new Refused('NOT_AN_OPTION');
  }
  const organization = idSchema.safeParse(values.organization);
  const importId = idSchema.safeParse(values.import);
  if (!organization.success) throw new Refused('NOT_AN_ORGANIZATION');
  if (!importId.success) throw new Refused('NOT_AN_IMPORT');
  const common = { organizationId: organization.data, importId: importId.data };
  if (values.interrupted) {
    if (values.archive || values['key-file']) throw new Refused('INTERRUPTED_TAKES_NO_FILES');
    return { kind: 'interrupted', ...common };
  }
  if (!values.archive) throw new Refused('ARCHIVE_NOT_NAMED');
  if (!values['key-file']) throw new Refused('KEY_FILE_NOT_NAMED');
  return { kind: 'run', ...common, archivePath: values.archive, keyPath: values['key-file'] };
}

/** Reads the file an operator mounted. Its text is returned and goes nowhere from here but to the import. */
function readKeyFile(path: string) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Refused('KEY_FILE_UNREADABLE');
  }
}

/** Reads the archive from disk a piece at a time, so a large one is never held in memory. */
function openArchiveFile(path: string): ArchiveReader & { close(): void } {
  let descriptor: number;
  let totalBytes: number;
  try {
    descriptor = openSync(path, 'r');
    totalBytes = fstatSync(descriptor).size;
  } catch {
    throw new Refused('ARCHIVE_UNREADABLE');
  }
  return {
    totalBytes,
    readAt: async (offset, length) => {
      const bytes = Buffer.alloc(length);
      const read = readSync(descriptor, bytes, 0, length, offset);
      return read === length ? bytes : bytes.subarray(0, read);
    },
    close: () => closeSync(descriptor),
  };
}

export const exitCodeFor = (result: Pick<ImportRunResult, 'status'>) =>
  result.status === 'failed' ? FAILED : 0;

/** What an operator is told about a result. Every value here is a count, a code or a hash. */
function printResult(io: CommandIo, importId: string, result: ImportRunResult) {
  io.out(
    JSON.stringify({
      import_id: importId,
      status: result.status,
      failure_code: result.failureCode,
      applied: result.appliedCounts,
      warnings: result.warningCounts,
    }),
  );
  if (result.failureCode === 'WRONG_KEY') {
    io.err(
      result.archiveKeyId
        ? `This archive is sealed for the key named ${result.archiveKeyId}. Use the private key that matches it.\n`
        : 'The key file could not open this archive, and the archive does not say which key it is for.\n',
    );
  }
}

export type ImportCommandDeps = {
  database: AppDatabase;
  store: ImportRunDeps['store'] & ImportRunDeps['ledger'];
  sections: readonly PortabilitySection[];
  io: CommandIo;
  /** The real import, unless a test wants to see only what the command does around it. */
  run?: typeof runOrganizationImport;
};

export async function organizationImportCommand(
  args: string[],
  { database, store, sections, io, run = runOrganizationImport }: ImportCommandDeps,
): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = readArguments(args);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    io.err(`${JSON.stringify({ refused: error.reasonCode })}\n`);
    return REFUSED;
  }
  const context = createServiceContext(parsed.organizationId);
  try {
    if (parsed.kind === 'interrupted') {
      const view = await markOrganizationImportInterrupted(database, context, parsed.importId);
      io.out(JSON.stringify({ import_id: view.id, status: view.status }));
      return 0;
    }
    let key: string;
    let archive: ReturnType<typeof openArchiveFile>;
    try {
      key = readKeyFile(parsed.keyPath);
      archive = openArchiveFile(parsed.archivePath);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      io.err(`${JSON.stringify({ refused: error.reasonCode })}\n`);
      return REFUSED;
    }
    try {
      const result = await run(
        database,
        context,
        { importId: parsed.importId, archive, recipientPrivateKeyPem: key },
        { sections, ledger: store, store },
      );
      printResult(io, parsed.importId, result);
      return exitCodeFor(result);
    } finally {
      archive.close();
    }
  } catch (error) {
    // No such import, or one not in a state to run. Nothing has been read or changed.
    const code = error instanceof AppError ? error.code : errorCode(error);
    io.err(`${JSON.stringify({ refused: code })}\n`);
    return FAILED;
  }
}
