// Owned by the diagnostics slice (SOV-06). See docs/06-delivery/m6-slices.md and ADR-030 D12. The operator's
// command: `node dist/diagnostics-export.js collect --out <dir>`, then `seal --report <file> --recipient <key>
// --approved-by <name>`. It writes files on this machine, and sends nothing anywhere.
// diagnostics-command.ts is the command. All this file does is open the connections it asks about, each of
// which is only there to answer "does this respond". The secrets that open them go no further than that.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@ensemus/config';
import { loadSovereignConfig } from '@ensemus/config/sovereign';
import { openDispatcherDatabase } from '@ensemus/database/dispatcher';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { TEMPORAL_CHANNEL_ARGS } from '@ensemus/workflows/constants';
import { Connection } from '@temporalio/client';
import {
  diagnosticsCommand,
  readDatabaseFacts,
  readReleaseFacts,
  type DiagnosticSources,
  type ShippedMigration,
} from './diagnostics-command';

const log = createLogger('diagnostics');
const here = path.dirname(fileURLToPath(import.meta.url));
const SHORT_WAIT_MS = 5_000;
/** The ledger's prefix is all this identity reaches. An object nobody writes is enough to get an answer. */
const PROBE_KEY = 'tombstone-ledger/diagnostics-reachability-probe';

async function temporalReachable() {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
    channelArgs: TEMPORAL_CHANNEL_ARGS,
    connectTimeout: SHORT_WAIT_MS,
  });
  await connection.close();
  return true;
}

async function objectStoreReachable() {
  const store = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_LEDGER_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_LEDGER_SECRET_KEY'),
    requestTimeoutMs: SHORT_WAIT_MS,
    maxAttempts: 1,
  });
  try {
    await store.exists(PROBE_KEY);
    return true;
  } catch (error) {
    // Refusing this identity is still an answer, and this only asks whether something is there to answer.
    const answered = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
    if (answered?.httpStatusCode) return true;
    throw error;
  }
}

async function shippedMigrations(): Promise<readonly ShippedMigration[]> {
  const journal = JSON.parse(
    await readFile(path.join(here, '..', 'migrations', 'meta', '_journal.json'), 'utf8'),
  ) as { entries: readonly ShippedMigration[] };
  return journal.entries.map(({ tag, when }) => ({ tag, when }));
}

let closeDatabase: (() => Promise<void>) | undefined;

const sources: DiagnosticSources = {
  database: async () => {
    const { db, close } = openDispatcherDatabase(readSecret('DATABASE_URL_DISPATCHER'));
    closeDatabase = close;
    return readDatabaseFacts(db);
  },
  temporalReachable,
  objectStoreReachable,
  release: async () => {
    const { release, bundleManifestFile, trustRootFile } = loadSovereignConfig();
    return readReleaseFacts({ release, bundleManifestFile, trustRootFile, log });
  },
  shippedMigrations,
};

async function main() {
  const status = await diagnosticsCommand(process.argv.slice(2), {
    sources: async () => sources,
    env: process.env,
    now: () => new Date(),
    log,
    say: (line) => process.stdout.write(`${line}\n`),
  });
  await closeDatabase?.();
  process.exit(status);
}

main().catch((error: unknown) => {
  log.error('diagnostics.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
