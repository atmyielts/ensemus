// COMM-05, ADR-030 D7: two attempts at the same export step, against real PostgreSQL and real roles, with an
// object store in memory. Temporal may run a step again while an earlier attempt is still alive, so a step
// that has fallen behind must write nothing and answer where things stand (`StaleAttempt` in
// portability-export.ts). The interleaving here is fixed by a hook, never by timing: the first attempt is
// held after it has read the export and the file's bytes, outside any transaction, the second attempt runs
// the same step to its commit, and only then is the first let go.
//
// Generated values only: `@example.invalid` people, generated keys, and file text made up here.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addArtifact,
  beginExport,
  createWorkUnit,
  exportNextBatch,
  requestOrganizationExport,
  SOURCE_PORTABILITY_SECTIONS,
  type ExportDeps,
  type ObjectStore,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  organizationExportParts,
  organizationExports,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  artifactPartPath,
  EXPORT_OBJECT_PREFIX,
  exportObjectKey,
} from '@ensemus/domain/portability';
import { and, eq } from 'drizzle-orm';
import { nativeSovereignContext, testRecipient } from '../helpers/sovereign';
import { urls } from '../helpers/stack';

const deps: ExportDeps = {
  sections: SOURCE_PORTABILITY_SECTIONS,
  sourceRelease: 'test-release',
  retentionHours: 24,
};

/** The bytes both attempts share, as one bucket would hold them. */
class MemoryStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error('missing');
    return body;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  exportKeys() {
    return [...this.objects.keys()].filter((key) => key.startsWith(EXPORT_OBJECT_PREFIX));
  }
}

/** A hook one attempt waits on: `arrived` once it is there, and it goes on only after `release`. */
function hold() {
  let arrive = () => undefined as void;
  let release = () => undefined as void;
  const arrived = new Promise<void>((done) => {
    arrive = done;
  });
  const released = new Promise<void>((done) => {
    release = done;
  });
  return { arrived, released, arrive: () => arrive(), release: () => release() };
}

/**
 * One attempt's view of the shared store. It records the puts this attempt made, so a test can tell which
 * attempt wrote, and with `held` it stops after reading `heldKey` until released.
 */
function attemptStore(
  shared: MemoryStore,
  options: { heldKey?: string; held?: ReturnType<typeof hold> } = {},
) {
  const puts: string[] = [];
  const store: ObjectStore = {
    put: async (key, body) => {
      puts.push(key);
      await shared.put(key, body);
    },
    get: async (key) => {
      const body = await shared.get(key);
      if (options.held && key === options.heldKey) {
        options.held.arrive();
        await options.held.released;
      }
      return body;
    },
    delete: (key) => shared.delete(key),
    exists: (key) => shared.exists(key),
  };
  return { store, puts };
}

describe('two attempts at the same export step', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  const db = () => app.db;
  const recipient = testRecipient();

  let owner: TenantContext;
  let shared: MemoryStore;
  let fileId: string;
  let fileKey: string;
  let exportId: string;

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });

  afterAll(async () => {
    await app.close();
    await auth.end();
  });

  async function newOrg(): Promise<TenantContext> {
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      'owner',
      `owner-${randomUUID()}@example.invalid`,
    ]);
    const { organizationId } = await createOrganization(db(), {
      userId,
      name: 'Race Ltd',
      commercialMode: 'sovereign',
    });
    return nativeSovereignContext(db(), userId, organizationId);
  }

  const worker = () => createServiceContext(owner.organizationId);

  const exportRow = async () => {
    const [row] = await withTenantTx(db(), owner, (tx) =>
      tx
        .select()
        .from(organizationExports)
        .where(
          and(
            eq(organizationExports.organizationId, owner.organizationId),
            eq(organizationExports.id, exportId),
          ),
        ),
    );
    if (!row) throw new Error('TEST_EXPORT_MISSING');
    return row;
  };

  const partRows = () =>
    withTenantTx(db(), owner, (tx) =>
      tx
        .select()
        .from(organizationExportParts)
        .where(eq(organizationExportParts.exportId, exportId))
        .orderBy(organizationExportParts.path),
    );

  /** Everything about the row that a step may change. */
  const stateOf = (row: Awaited<ReturnType<typeof exportRow>>) => ({
    status: row.status,
    version: row.version,
    progress: row.progress,
    partCount: row.partCount,
    recordCount: row.recordCount,
    archiveBytes: row.archiveBytes,
    failureCode: row.failureCode,
    tombstonesThrough: row.tombstonesThrough,
    updatedAt: row.updatedAt,
  });

  const stageOf = (row: Awaited<ReturnType<typeof exportRow>>) =>
    (row.progress as { stage?: unknown }).stage;

  beforeEach(async () => {
    owner = await newOrg();
    shared = new MemoryStore();
    const unit = (await createWorkUnit(db(), owner, { title: 'Has a file' })) as { id: string };
    fileId = (
      await addArtifact(db(), shared, owner, {
        workUnitId: unit.id,
        name: 'kept.txt',
        mimeType: 'text/plain',
        body: Buffer.from(`bytes of kept.txt ${randomUUID()}`),
      })
    ).id;
    fileKey = `${owner.organizationId}/artifacts/${fileId}`;
    exportId = (
      await requestOrganizationExport(db(), owner, {
        recipientPublicKey: recipient.publicKeyBase64,
        sourceRelease: 'test-release',
      })
    ).id;
    expect((await beginExport(db(), worker(), { exportId }, deps)).state).toBe('continue');
    // Every section page first, one step at a time as the workflow takes them, up to the file's bytes.
    // The bound is generous: each joined reader takes at least one step, and the loop stops at the stage.
    for (let i = 0; i < 500 && stageOf(await exportRow()) !== 'files'; i += 1) {
      expect((await exportNextBatch(db(), shared, worker(), { exportId }, deps)).state).toBe(
        'continue',
      );
    }
    const row = await exportRow();
    expect(stageOf(row)).toBe('files');
    expect(row.progress).toMatchObject({ fileAfter: null, pendingPaths: [] });
  });

  it('stops the attempt that fell behind before it writes, answers where things stand, and moves nothing', async () => {
    const held = hold();
    const late = attemptStore(shared, { heldKey: fileKey, held });
    const first = attemptStore(shared);
    const before = await exportRow();
    const partsBefore = await partRows();

    // The late attempt reads the row, then the file's bytes, and waits there with no transaction open.
    const lateStep = exportNextBatch(db(), late.store, worker(), { exportId }, deps);
    await Promise.race([
      held.arrived,
      lateStep.then(() => {
        throw new Error('TEST_LATE_ATTEMPT_NOT_HELD');
      }),
    ]);

    // Meanwhile another attempt at the same step takes the same file to its commit.
    const firstStep = await exportNextBatch(db(), first.store, worker(), { exportId }, deps);
    const won = await exportRow();
    expect(first.puts).toEqual([
      exportObjectKey(owner.organizationId, exportId, artifactPartPath(fileId)),
    ]);
    expect(won.version).toBe(before.version + 1);
    expect(won.partCount).toBe(before.partCount + 1);
    expect(won.progress).toMatchObject({ stage: 'files', fileAfter: fileId, pendingPaths: [] });
    expect(firstStep).toEqual({
      state: 'continue',
      parts: won.partCount,
      records: won.recordCount,
    });
    const partsWon = await partRows();
    expect(partsWon).toHaveLength(partsBefore.length + 1);
    expect(partsWon.map((part) => part.path)).toContain(artifactPartPath(fileId));

    // Let go, the late attempt finds the row moved on under its lock (notePending) and stops there:
    // `StaleAttempt`, caught by runPiece, which answers with where things now stand.
    held.release();
    const answer = await lateStep;
    expect(answer).toEqual({ state: 'continue', parts: won.partCount, records: won.recordCount });

    // It wrote no bytes and no part row, noted no path, and the row is exactly as the winner left it.
    expect(late.puts).toEqual([]);
    expect(await partRows()).toEqual(partsWon);
    expect(stateOf(await exportRow())).toEqual(stateOf(won));
    expect(shared.exportKeys().sort()).toEqual(partsWon.map((part) => part.objectKey).sort());
  });

  it('lets the same held attempt write its part when nothing raced it, so the hold alone stops nothing', async () => {
    const held = hold();
    const only = attemptStore(shared, { heldKey: fileKey, held });
    const before = await exportRow();

    const step = exportNextBatch(db(), only.store, worker(), { exportId }, deps);
    await held.arrived;
    held.release();
    const answer = await step;

    const after = await exportRow();
    expect(only.puts).toHaveLength(1);
    expect(after.version).toBe(before.version + 1);
    expect(after.progress).toMatchObject({ stage: 'files', fileAfter: fileId, pendingPaths: [] });
    expect(answer).toEqual({
      state: 'continue',
      parts: after.partCount,
      records: after.recordCount,
    });
    expect((await partRows()).map((part) => part.path)).toContain(artifactPartPath(fileId));
  });
});
