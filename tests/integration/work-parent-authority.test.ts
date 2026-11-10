// 0411: actual Work/client metadata, real named viewers and byte-serving boundaries. Source until run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  addArtifact,
  createClient,
  createProject,
  createWorkUnit,
  getWorkDetail,
  getWorkUnit,
  listWorkUnits,
  readArtifact,
  setClientReaders,
  type ObjectStore,
} from '@ensemus/application';
import { createContextSource } from '@ensemus/application/ai-context-source';
import {
  clients,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  runInputObservations,
  withTenantTx,
  workUnits,
} from '@ensemus/database';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
} from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';
import pg from 'pg';

describe('Work follows its current project/client scope', () => {
  let app: ReturnType<typeof openAppDatabase>, agent: ReturnType<typeof openAgentTestDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app());
    agent = openAgentTestDatabase();
  });
  afterAll(async () => {
    await agent?.close();
    await app?.close();
  });
  async function fixture(classification: 'internal' | 'restricted' = 'restricted') {
    const f = await seedAiTenant(app.db);
    await withTenantTx(app.db, f.owner, (tx) =>
      tx
        .update(memberships)
        .set({ role: 'admin' })
        .where(eq(memberships.id, f.member.membershipId)),
    );
    const reader = await resolveTenantContext(app.db, f.member.userId, f.organizationId);
    const client = await createClient(app.db, f.owner, {
      displayName: 'Generated parent client',
      classification,
    });
    const project = await createProject(app.db, f.owner, {
      name: 'Generated parent project',
      clientId: client!.id,
    });
    await setClientReaders(app.db, f.owner, {
      clientId: client!.id,
      expectedVersion: 1,
      readerMembershipIds: [reader.membershipId],
    });
    const work = await createWorkUnit(app.db, reader, {
      title: 'PRIVATE_PARENT_WORK_CANARY',
      projectId: project!.id,
      classification: 'internal',
    });
    return { ...f, reader, client: client!, project: project!, work };
  }
  const scope = (context: Awaited<ReturnType<typeof seedAiTenant>>['owner'], id: string) =>
    withTenantTx(app.db, context, (tx) =>
      tx.execute<{
        classification: string | null;
        readable: boolean;
      }>(sql`select knowledge.work_scope_class(${id}::uuid) as classification,
      knowledge.can_read_work(${id}::uuid,${context.membershipId}::uuid) as readable`),
    );

  it('revokes ordinary body/list/direct-SQL/file serving even when the viewer remains Work owner and company admin', async () => {
    const f = await fixture(),
      objects = new Map<string, Buffer>();
    let gets = 0;
    const store: ObjectStore = {
      put: async (key, body) => {
        objects.set(key, body);
      },
      get: async (key) => {
        gets++;
        return objects.get(key)!;
      },
      exists: async (key) => objects.has(key),
      delete: async (key) => {
        objects.delete(key);
      },
    };
    const file = await addArtifact(app.db, store, f.reader, {
      workUnitId: f.work.id,
      name: 'Generated scoped file.txt',
      mimeType: 'text/plain',
      body: Buffer.from('PRIVATE_PARENT_FILE_CANARY'),
    });
    expect((await getWorkDetail(app.db, f.reader, f.work.id)).work.title).toBe(
      'PRIVATE_PARENT_WORK_CANARY',
    );
    expect((await scope(f.reader, f.work.id)).rows[0]).toEqual({
      classification: 'restricted',
      readable: true,
    });
    await setClientReaders(app.db, f.owner, {
      clientId: f.client.id,
      expectedVersion: 2,
      readerMembershipIds: [],
    });
    expect((await scope(f.reader, f.work.id)).rows[0]).toEqual({
      classification: 'restricted',
      readable: false,
    });
    await expect(getWorkUnit(app.db, f.reader, f.work.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await listWorkUnits(app.db, f.reader)).items.map((work) => work.id)).not.toContain(
      f.work.id,
    );
    expect(
      await withTenantTx(app.db, f.reader, (tx) =>
        tx.select().from(workUnits).where(eq(workUnits.id, f.work.id)),
      ),
    ).toEqual([]);
    await expect(
      readArtifact(app.db, store, f.reader, { workUnitId: f.work.id, artifactId: file.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(gets).toBe(0);
    expect((await getWorkUnit(app.db, f.owner, f.work.id)).id).toBe(f.work.id);
    await setClientReaders(app.db, f.owner, {
      clientId: f.client.id,
      expectedVersion: 3,
      readerMembershipIds: [f.reader.membershipId],
    });
    expect((await getWorkUnit(app.db, f.reader, f.work.id)).id).toBe(f.work.id);
  });

  it('closes actual agent Work/body reads after the prior named client grant is revoked', async () => {
    const f = await fixture(),
      version = await seedAgentVersion(app.db, f.owner),
      runId = await seedQueuedRun(app.db, f.reader, { workUnitId: f.work.id, version });
    const writer = await prepareRunInputContext(agent.db, f.organizationId, runId);
    await setClientReaders(app.db, f.owner, {
      clientId: f.client.id,
      expectedVersion: 2,
      readerMembershipIds: [],
    });
    let bodyReads = 0;
    const source = createContextSource({
      database: agent.db,
      readObject: async () => {
        bodyReads++;
        throw new Error('TEST_UNEXPECTED_BYTES');
      },
    });
    await expect(source.loadWork(writer, f.work.id)).rejects.toThrow();
    expect(bodyReads).toBe(0);
  });

  it('uses a raised current client class without rewriting the Work or historical observed hashes', async () => {
    const f = await fixture('internal');
    const version = await seedAgentVersion(app.db, f.owner),
      runId = await seedQueuedRun(app.db, f.reader, { workUnitId: f.work.id, version }),
      writer = await prepareRunInputContext(agent.db, f.organizationId, runId);
    const observations = () =>
      withTenantTx(agent.db, writer, (tx) =>
        tx
          .select()
          .from(runInputObservations)
          .where(eq(runInputObservations.runId, runId))
          .orderBy(
            runInputObservations.inputKind,
            runInputObservations.inputId,
            runInputObservations.inputSha256,
          ),
      );
    const before = await observations();
    expect(before.length).toBeGreaterThan(0);
    expect((await scope(f.reader, f.work.id)).rows[0]?.classification).toBe('internal');
    await withTenantTx(app.db, f.owner, (tx) =>
      tx.update(clients).set({ classification: 'restricted' }).where(eq(clients.id, f.client.id)),
    );
    // The actual stored Work is still internal; its effective scope now includes the client floor.
    expect((await getWorkUnit(app.db, f.owner, f.work.id)).classification).toBe('internal');
    expect((await scope(f.owner, f.work.id)).rows[0]).toEqual({
      classification: 'restricted',
      readable: true,
    });
    expect(await observations()).toEqual(before);
    await setClientReaders(app.db, f.owner, {
      clientId: f.client.id,
      expectedVersion: 2,
      readerMembershipIds: [],
    });
    expect((await scope(f.reader, f.work.id)).rows[0]?.readable).toBe(false);
  });

  it('returns no scope for foreign Work while preserving ordinary unparented Work', async () => {
    const f = await seedAiTenant(app.db),
      foreign = await seedAiTenant(app.db),
      work = await createWorkUnit(app.db, f.owner, { title: 'Generated unparented Work' });
    expect((await scope(f.owner, work.id)).rows[0]).toEqual({
      classification: 'internal',
      readable: true,
    });
    expect((await scope(foreign.owner, work.id)).rows[0]).toEqual({
      classification: null,
      readable: false,
    });
  });
  it('holds the actual current client grant behind the Work metadata admission lock', async () => {
    const f = await fixture(),
      observer = new pg.Client({ connectionString: urls.superuser() });
    await observer.connect();
    let revoking: ReturnType<typeof setClientReaders> | undefined;
    try {
      await withTenantTx(app.db, f.reader, async (tx) => {
        const lock = await tx.execute<{
          locked: boolean;
          pid: number;
        }>(sql`select knowledge.lock_structured_record('work_unit',${f.work.id}::uuid)
          as locked,pg_backend_pid() as pid`);
        expect(lock.rows[0]?.locked).toBe(true);
        revoking = setClientReaders(app.db, f.owner, {
          clientId: f.client.id,
          expectedVersion: 2,
          readerMembershipIds: [],
        });
        await expect
          .poll(
            async () => {
              const result = await observer.query<{ blocked: boolean }>(
                'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',
                [lock.rows[0]!.pid],
              );
              return result.rows[0]?.blocked;
            },
            { timeout: 5000, interval: 20 },
          )
          .toBe(true);
      });
      await revoking;
      expect((await scope(f.reader, f.work.id)).rows[0]?.readable).toBe(false);
    } finally {
      await revoking;
      await observer.end();
    }
  });
});
