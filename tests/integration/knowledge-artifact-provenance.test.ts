// 0208: actual app/service roles, real SQL RLS/triggers. Synthetic inventory/lifecycle adapters model
// explicit boundaries; no model quality, provider fence or production legal-hold claim is made here.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  addArtifact,
  createWorkUnit,
  readArtifact,
  purgeDueBlobs,
  assignContributor,
  unassign,
  type ObjectStore,
} from '@ensemus/application';
import {
  artifactAclCatalog,
  artifactLineage,
  artifactLineageInputs,
  artifactLineageRecords,
  artifactLineageSources,
  agentRuns,
  clientReaders,
  clients,
  projects,
  structuredRecordCatalog,
  structuredWorkAssignments,
  artifacts,
  blobLifecycle,
  knowledgeEvidenceItems,
  knowledgeEvidencePackages,
  knowledgeSourceGrants,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  workArtifacts,
  workUnits,
  tombstones,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { withRunLookupTx } from '@ensemus/database/agent';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedAgentVersion,
} from '../helpers/ai/fixtures';
import { nativeMfaOwner } from '../helpers/knowledge-native';
import {
  recordArtifactCitations,
  checkArtifactGrounding,
  decideArtifact,
  getArtifactVerification,
} from '@ensemus/application/knowledge/verification';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import {
  addGeneratedArtifact,
  createArtifactProvenance,
  createDerivedArtifactPurge,
  eraseDerivedArtifactMetadata,
  type ArtifactExecution,
  type ArtifactInputInventory,
  type DerivedArtifactLifecycle,
  type StructuredArtifactInput,
} from '../../packages/application/src/knowledge/artifact-provenance';
import { pgCode } from '../../packages/application/src/errors';
import { seedMember, seedSearchableSource, sha256 } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('generated artifact all-input privacy and erasure protocol (0208)', () => {
  let database: ReturnType<typeof openAppDatabase>,
    agent: ReturnType<typeof openAgentTestDatabase>,
    auth: pg.Client;
  beforeAll(async () => {
    database = openAppDatabase(urls.app(), { max: 6 });
    agent = openAgentTestDatabase(6);
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });
  afterAll(async () => {
    await Promise.all([auth?.end(), database?.close(), agent?.close()]);
  });
  async function fixture(
    options: {
      noPackages?: boolean;
      system?: boolean;
      classification?: 'internal' | 'confidential' | 'restricted';
    } = {},
  ) {
    // seedAgentVersion publishes as this owner, and 0404 requires a fresh native second factor for
    // agent.publish of every real person; a bare resolved context is refused with MFA_REQUIRED.
    const owner = await nativeMfaOwner(database.db, 'generated-privacy-reviewer', 'sovereign');
    const seeded = await seedMember(database.db, owner, auth);
    const member = await resolveTenantContext(database.db, seeded.userId, owner.organizationId);
    const service = createServiceContext(owner.organizationId);
    const text = 'Synthetic private input and a generated output.';
    const work = await createWorkUnit(database.db, owner, {
      title: 'Generated privacy work',
      objective: 'Check this exact synthetic output.',
      classification: options.classification ?? 'internal',
    });
    const source = await seedSearchableSource(database.db, owner, {
      passages: [text],
      grants: [{ kind: 'membership', membershipId: owner.membershipId }],
    });
    const execution: ArtifactExecution = options.system
      ? { kind: 'system', id: randomUUID(), template: 'test/checklist/v1' }
      : { kind: 'agent_run', id: randomUUID() };
    const version = options.system ? null : await seedAgentVersion(database.db, owner);
    const ensureRun = async (execution: ArtifactExecution) => {
      if (execution.kind !== 'agent_run' || !version) return null;
      const found = await withTenantTx(database.db, owner, (tx) =>
        tx.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, execution.id)),
      );
      if (!found.length) {
        await withRunLookupTx(agent.db, owner.organizationId, (tx) =>
          tx
            .update(agentRuns)
            .set({ status: 'failed', stopCode: 'TEST_REPLACED' })
            .where(eq(agentRuns.workUnitId, work.id)),
        );
        await withTenantTx(database.db, owner, (tx) =>
          tx.insert(agentRuns).values({
            organizationId: owner.organizationId,
            id: execution.id,
            workUnitId: work.id,
            agentVersionId: version.versionId,
            serviceIdentityId: version.serviceIdentityId,
            initiatorMembershipId: owner.membershipId,
            effectiveClassification: options.classification ?? 'internal',
            maxModelTurns: 5,
            maxToolCalls: 5,
            maxTotalTokens: 10000,
            maxCostMicros: 1000000,
            timeoutSeconds: 60,
            maxDelegationDepth: 0,
            delegatedScopes: { tools: [] },
          }),
        );
      }
      // 0417: a run born under authority-v1 records its Work input only through the runtime's own
      // read admission (protocol binding, authority lock, then the observation), which is what the
      // context source does. A bare recordRunInputs is refused RUN_AUTHORITY_PROTOCOL_REQUIRED.
      return prepareRunInputContext(agent.db, owner.organizationId, execution.id);
    };
    const writer = (await ensureRun(execution)) ?? service;
    if (!options.noPackages && !options.system)
      await withTenantTx(database.db, service, async (tx) => {
        const packageId = randomUUID();
        await tx.insert(knowledgeEvidencePackages).values({
          organizationId: owner.organizationId,
          id: packageId,
          purpose: 'agent_turn',
          workUnitId: work.id,
          runId: execution.id,
          viewerMembershipId: owner.membershipId,
          querySha256: sha256('test query'),
          policyVersion: 'test/0208',
          budgetTokens: 1000,
          usedTokens: 12,
          strongestClassification: 'internal',
          packageSha256: sha256(packageId),
        });
        await tx.insert(knowledgeEvidenceItems).values({
          organizationId: owner.organizationId,
          packageId,
          ordinal: 0,
          chunkId: source.chunkIds[0]!,
          documentId: source.documentId,
          sourceId: source.sourceId,
          contentSha256: sha256(text),
          classification: 'internal',
          tokenEstimate: 12,
        });
      });
    const bodies = new Map<string, Buffer>();
    const control: {
      puts: number;
      gets: number;
      beforePut: null | (() => Promise<void>);
      beforeGet: null | (() => Promise<void>);
      putFails: boolean;
    } = { puts: 0, gets: 0, beforePut: null, beforeGet: null, putFails: false };
    const store: ObjectStore = {
      put: async (key, body) => {
        control.puts++;
        await control.beforePut?.();
        if (control.putFails) throw new Error('SYNTHETIC_UNKNOWN_PUT');
        bodies.set(key, Buffer.from(body));
      },
      get: async (key) => {
        control.gets++;
        await control.beforeGet?.();
        const value = bodies.get(key);
        if (!value) throw new Error('SYNTHETIC_MISSING');
        return Buffer.from(value);
      },
      exists: async (key) => bodies.has(key),
      delete: async (key) => {
        bodies.delete(key);
      },
      // Explicit unversioned test map model of the capabilities the production S3 adapter exposes
      // to purges; without them nothing could certify that the bytes are gone.
      deleteForPurge: async (key) => {
        bodies.delete(key);
        return { transport: 'deleted', capabilityVerified: true };
      },
      isPhysicallyAbsent: async (key) => !bodies.has(key),
    };
    const inputs: { artifactId: string; sha256: string }[] = [];
    const records: StructuredArtifactInput[] = [
      { kind: 'work_unit', id: work.id, sha256: sha256(JSON.stringify(work)) },
    ];
    const inventory: ArtifactInputInventory = {
      inspectInTx: async (_tx, _context, input) => ({
        known: true,
        execution: input.execution,
        workUnitId: work.id,
        viewerMembershipId: options.system ? null : owner.membershipId,
        classification: 'internal',
        noKnowledge: !!options.system,
        artifactInputs: inputs,
        recordInputs: records,
      }),
    };
    const input = {
      workUnitId: work.id,
      name: 'generated.txt',
      mimeType: 'text/plain',
      body: Buffer.from(text),
      execution,
      requestKey: randomUUID(),
    };
    const create = async (
      changes: Partial<typeof input> = {},
      port: ArtifactInputInventory = inventory,
    ) => {
      const actual = { ...input, ...changes };
      const agentContext = await ensureRun(actual.execution);
      return addGeneratedArtifact(
        agentContext ? agent.db : database.db,
        store,
        agentContext ?? service,
        actual,
        { inventory: port },
      );
    };
    const close = () =>
      revokeSource(database.db, owner, {
        sourceId: source.sourceId,
        expectedVersion: 1,
        reason: 'Synthetic revoke',
      });
    const raw = async (context: TenantContext) =>
      withTenantTx(database.db, context, async (tx) => ({
        files: await tx.select().from(artifacts),
        links: await tx.select().from(workArtifacts),
      }));
    const read = (artifactId: string, context = owner) =>
      readArtifact(database.db, store, context, { artifactId, workUnitId: work.id });
    const lifecycle: DerivedArtifactLifecycle = {
      erase: async (context, header) => {
        // Explicit test double: it has no outstanding provider request or holds. Real adapters must
        // prove both; this test exercises the real metadata/RLS/retained-lineage protocol after that.
        await eraseDerivedArtifactMetadata(database.db, context, header);
        await store.delete(header.objectKey);
        await withTenantTx(database.db, context, (tx) =>
          tx
            .update(blobLifecycle)
            .set({ state: 'purged', purgedAt: new Date() })
            .where(eq(blobLifecycle.artifactId, header.artifactId)),
        );
        return { state: 'purged', quiescent: true };
      },
    };
    return {
      owner,
      member,
      service,
      work,
      source,
      text,
      execution,
      inventory,
      input,
      inputs,
      records,
      create,
      close,
      read,
      raw,
      store,
      bodies,
      control,
      lifecycle,
      writer,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const purge = (value: Fixture, lifecycle: DerivedArtifactLifecycle | null = value.lifecycle) =>
    createDerivedArtifactPurge({
      database: database.db,
      store: value.store,
      ...(lifecycle ? { lifecycle } : {}),
    });
  async function deniedSql(operation: Promise<unknown>, code: string) {
    let failure: unknown;
    try {
      await operation;
    } catch (error) {
      failure = error;
    }
    expect(pgCode(failure)).toBe(code);
  }

  it('keeps all registered pending output hidden before object put and publishes only after binding', async () => {
    const value = await fixture();
    value.control.beforePut = async () => {
      for (const viewer of [value.owner, value.member, value.service])
        expect(await value.raw(viewer)).toEqual({ files: [], links: [] });
    };
    const output = await value.create();
    expect((await value.read(output.id)).body.toString()).toBe(value.text);
    expect((await value.raw(value.owner)).files).toHaveLength(1);
    expect((await value.raw(value.member)).files).toHaveLength(0);
  });
  it('captures an uncited private source from the actual run package and refuses the broader work reader before object get', async () => {
    const value = await fixture();
    const output = await value.create();
    expect(
      await withTenantTx(database.db, value.service, (tx) =>
        tx.select().from(artifactLineageSources),
      ),
    ).toMatchObject([{ artifactId: output.id, sourceId: value.source.sourceId }]);
    await expect(value.read(output.id, value.member)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(value.control.gets).toBe(0);
    expect((await value.raw(value.member)).links).toHaveLength(0);
  });
  it('does not give a service raw serving access to source-bearing generated output', async () => {
    const value = await fixture();
    const output = await value.create();
    expect(await value.raw(value.service)).toEqual({ files: [], links: [] });
    await expect(value.read(output.id, value.service)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('allows a bound explicit no-knowledge system inventory, while ordinary human uploads remain ordinary', async () => {
    const value = await fixture({ system: true });
    const output = await value.create();
    expect((await value.read(output.id, value.member)).body.toString()).toBe(value.text);
    const ordinary = await addArtifact(database.db, value.store, value.owner, {
      workUnitId: value.work.id,
      name: 'human.txt',
      mimeType: 'text/plain',
      body: Buffer.from('Human upload'),
    });
    expect((await value.read(ordinary.id, value.member)).body.toString()).toBe('Human upload');
  });
  it('refuses the old non-user upload path before object I/O', async () => {
    const value = await fixture();
    await expect(
      addArtifact(database.db, value.store, value.service, value.input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(value.control.puts).toBe(0);
  });
  it('retains restricted artifact access after Work is lowered and follows fresh assignment revocation', async () => {
    const value = await fixture({ system: true, classification: 'restricted' });
    const output = await value.create();
    const adminSeed = await seedMember(database.db, value.owner, auth, 'admin');
    const admin = await resolveTenantContext(
      database.db,
      adminSeed.userId,
      value.owner.organizationId,
    );
    await withTenantTx(database.db, value.owner, (tx) =>
      tx
        .update(workUnits)
        .set({ classification: 'internal', version: value.work.version + 1 })
        .where(eq(workUnits.id, value.work.id)),
    );
    for (const viewer of [value.member, admin, value.service]) {
      expect((await value.raw(viewer)).files).toHaveLength(0);
      await expect(value.read(output.id, viewer)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(value.control.gets).toBe(0);
    await assignContributor(database.db, value.owner, {
      id: value.work.id,
      membershipId: value.member.membershipId,
    });
    expect((await value.read(output.id, value.member)).body.toString()).toBe(value.text);
    await unassign(database.db, value.owner, {
      id: value.work.id,
      membershipId: value.member.membershipId,
    });
    await expect(value.read(output.id, value.member)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await value.read(output.id)).body.toString()).toBe(value.text);
  });
  it('refuses an unavailable exhaustive inventory before object I/O', async () => {
    const value = await fixture();
    await expect(
      value.create({}, { inspectInTx: async () => ({ known: false }) }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(value.control.puts).toBe(0);
  });
  it('refuses a mismatched execution or viewer inventory before object I/O', async () => {
    const value = await fixture();
    const original = value.inventory.inspectInTx;
    await expect(
      value.create(
        {},
        {
          inspectInTx: async (...args) => {
            const found = await original(...args);
            return found.known
              ? { ...found, execution: { kind: 'agent_run', id: randomUUID() } }
              : found;
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      value.create(
        {},
        {
          inspectInTx: async (...args) => {
            const found = await original(...args);
            return found.known
              ? { ...found, viewerMembershipId: value.member.membershipId }
              : found;
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(value.control.puts).toBe(0);
  });
  it('makes a published identical retry skip put and retain the original ID', async () => {
    const value = await fixture();
    const output = await value.create();
    expect(await value.create()).toEqual(output);
    expect(value.control.puts).toBe(1);
  });
  it('leaves a failed/unknown put active and refuses a blind retry even when HEAD is absent', async () => {
    const value = await fixture();
    value.control.putFails = true;
    await expect(value.create()).rejects.toThrow('SYNTHETIC_UNKNOWN_PUT');
    value.control.putFails = false;
    await expect(value.create()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(value.control.puts).toBe(1);
    const [header] = await withTenantTx(database.db, value.service, (tx) =>
      tx.select().from(artifactLineage),
    );
    expect(header).toMatchObject({
      state: 'pending',
      writeState: 'active',
      physicalPurgedAt: null,
    });
    await value.close();
    const unconfirmed = await purge(value, null).purgeSource(value.service, {
      sourceId: value.source.sourceId,
      limit: 25,
    });
    expect(unconfirmed).toMatchObject({ confirmed: false, remaining: 1, removed: 0 });
  });
  it('refuses a direct non-user artifact insert and a non-user uploading row without registration', async () => {
    const value = await fixture(),
      artifactId = randomUUID(),
      key = `${value.owner.organizationId}/artifacts/${artifactId}`;
    await deniedSql(
      withTenantTx(database.db, value.service, (tx) =>
        tx.insert(artifacts).values({
          organizationId: value.owner.organizationId,
          id: artifactId,
          name: 'forged.txt',
          objectKey: key,
          sha256: sha256(value.text),
          mimeType: 'text/plain',
          sizeBytes: value.text.length,
          classification: 'internal',
        }),
      ),
      'EN118',
    );
    await deniedSql(
      withTenantTx(database.db, value.service, (tx) =>
        tx.insert(blobLifecycle).values({
          organizationId: value.owner.organizationId,
          artifactId,
          objectKey: key,
          state: 'uploading',
          purgeAfter: new Date(),
        }),
      ),
      'EN118',
    );
  });
  it('requires a pending header to register its upload in the same transaction', async () => {
    const value = await fixture();
    await deniedSql(
      withTenantTx(agent.db, value.writer, (tx) =>
        createArtifactProvenance({ inventory: value.inventory }).beginInTx(tx, value.writer, {
          execution: value.execution,
          artifactId: randomUUID(),
          workUnitId: value.work.id,
          artifactSha256: sha256(value.text),
          sizeBytes: value.text.length,
        }),
      ),
      'EN118',
    );
  });
  it('refuses source closure during put, retains blocked lineage, and never publishes the bytes', async () => {
    const value = await fixture();
    value.control.beforePut = async () => {
      await value.close();
    };
    await expect(value.create()).rejects.toMatchObject({ code: 'KNOWLEDGE_SOURCE_CLOSED' });
    expect(await value.raw(value.owner)).toEqual({ files: [], links: [] });
    expect(
      await withTenantTx(database.db, value.service, (tx) => tx.select().from(artifactLineage)),
    ).toMatchObject([{ state: 'blocked', writeState: 'settled', physicalPurgedAt: null }]);
  });
  it('rechecks source access after the out-of-transaction object read', async () => {
    const value = await fixture();
    const output = await value.create();
    value.control.beforeGet = async () => {
      await value.close();
    };
    await expect(value.read(output.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(value.control.gets).toBe(1);
  });
  it('revocation hides names, IDs, downloads and service rows immediately before physical cleanup', async () => {
    const value = await fixture();
    const output = await value.create();
    await value.close();
    for (const viewer of [value.owner, value.member, value.service]) {
      expect(await value.raw(viewer)).toEqual({ files: [], links: [] });
      await expect(value.read(output.id, viewer)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(value.bodies.size).toBe(1);
    expect(value.control.gets).toBe(0);
  });
  it('grant removal narrows existing derived output and restoring an unrelated organization grant is not inferred', async () => {
    const value = await fixture();
    const output = await value.create();
    await withTenantTx(database.db, value.owner, (tx) =>
      tx
        .delete(knowledgeSourceGrants)
        .where(eq(knowledgeSourceGrants.sourceId, value.source.sourceId)),
    );
    await expect(value.read(output.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(value.control.gets).toBe(0);
  });
  it('flattens transitive artifact input lineage and checks every uncited ancestor source', async () => {
    const value = await fixture();
    const first = await value.create();
    value.inputs.push({ artifactId: first.id, sha256: sha256(value.text) });
    const second = await value.create({
      execution: { kind: 'agent_run', id: randomUUID() },
      requestKey: randomUUID(),
      name: 'second.txt',
    });
    expect(
      await withTenantTx(database.db, value.service, (tx) =>
        tx
          .select()
          .from(artifactLineageInputs)
          .where(eq(artifactLineageInputs.artifactId, second.id)),
      ),
    ).toMatchObject([{ inputArtifactId: first.id, inputSha256: sha256(value.text) }]);
    await value.close();
    await expect(value.read(second.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects a changed ancestor hash and cross-tenant artifact inventory before object put', async () => {
    const value = await fixture();
    const first = await value.create();
    value.inputs.push({ artifactId: first.id, sha256: '0'.repeat(64) });
    await expect(value.create({ requestKey: randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(value.control.puts).toBe(1);
    const foreign = await fixture();
    const other = await foreign.create();
    value.inputs.splice(0, 1, { artifactId: other.id, sha256: sha256(foreign.text) });
    await expect(value.create({ requestKey: randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(value.control.puts).toBe(1);
  });
  it('retains source bindings for ordinary human files once citations are recorded', async () => {
    const value = await fixture();
    const output = await addArtifact(database.db, value.store, value.owner, {
      ...value.input,
      name: 'human.txt',
    });
    await recordArtifactCitations(database.db, value.owner, {
      artifactId: output.id,
      workUnitId: value.work.id,
      citations: [
        { chunkId: value.source.chunkIds[0]!, artifactStart: 0, artifactEnd: value.text.length },
      ],
    });
    await expect(value.read(output.id, value.member)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await value.close();
    await expect(value.read(output.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('does not let the generic grace-period sweep dispose an unfenced generated writer', async () => {
    const value = await fixture();
    value.control.putFails = true;
    await expect(value.create()).rejects.toThrow();
    const [header] = await withTenantTx(database.db, value.service, (tx) =>
      tx.select().from(artifactLineage),
    );
    value.bodies.set(header!.objectKey, Buffer.from(value.text));
    expect(
      await purgeDueBlobs(database.db, value.store, value.service, new Date(Date.now() + 7200000)),
    ).toEqual({ purged: 0, failed: 0 });
    expect(value.bodies.has(header!.objectKey)).toBe(true);
  });
  it('keeps missing and held lifecycle adapters incomplete, then releases the hold only through a fresh adapter check', async () => {
    const value = await fixture();
    await value.create();
    await value.close();
    expect(
      await purge(value, null).purgeSource(value.service, {
        sourceId: value.source.sourceId,
        limit: 25,
      }),
    ).toMatchObject({ remaining: 1, confirmed: false, removed: 0 });
    const held: DerivedArtifactLifecycle = { erase: async () => ({ state: 'held' }) };
    expect(
      await purge(value, held).purgeSource(value.service, {
        sourceId: value.source.sourceId,
        limit: 25,
      }),
    ).toMatchObject({ remaining: 1, held: 1, confirmed: false, removed: 0 });
    expect(
      await purge(value).purgeSource(value.service, { sourceId: value.source.sourceId, limit: 25 }),
    ).toEqual({ remaining: 0, held: 0, confirmed: true, removed: 1 });
  });
  it('retains immutable source/object lineage after file deletion and reports cumulative verified removals on retry', async () => {
    const value = await fixture();
    const output = await value.create();
    await value.close();
    const adapter = purge(value);
    const proof = await adapter.purgeSource(value.service, {
      sourceId: value.source.sourceId,
      limit: 25,
    });
    expect(proof).toEqual({ removed: 1, remaining: 0, held: 0, confirmed: true });
    expect(
      await adapter.purgeSource(value.service, { sourceId: value.source.sourceId, limit: 25 }),
    ).toEqual(proof);
    const [header] = await withTenantTx(database.db, value.service, (tx) =>
      tx.select().from(artifactLineage),
    );
    expect(header?.artifactId).toBe(output.id);
    expect(header?.physicalPurgedAt).toBeInstanceOf(Date);
    expect(
      await withTenantTx(database.db, value.service, (tx) =>
        tx.select().from(artifactLineageSources),
      ),
    ).toHaveLength(1);
    expect(value.bodies.size).toBe(0);
  });
  it('does not trust an adapter claiming erasure while metadata or actual bytes remain', async () => {
    const value = await fixture();
    await value.create();
    await value.close();
    const lie: DerivedArtifactLifecycle = {
      erase: async () => ({ state: 'purged', quiescent: true }),
    };
    expect(
      await purge(value, lie).purgeSource(value.service, {
        sourceId: value.source.sourceId,
        limit: 25,
      }),
    ).toMatchObject({ removed: 0, remaining: 1, confirmed: false });
  });
  it('binds acceptance to current full-input source access, exact work/objective and latest human rejection', async () => {
    const value = await fixture();
    const output = await value.create();
    const input = { artifactId: output.id, workUnitId: value.work.id };
    await recordArtifactCitations(database.db, value.owner, {
      ...input,
      citations: [
        { chunkId: value.source.chunkIds[0]!, artifactStart: 0, artifactEnd: value.text.length },
      ],
    });
    expect(
      await checkArtifactGrounding(database.db, value.store, value.service, input),
    ).toMatchObject({ verdict: 'passed' });
    const review = await getArtifactVerification(database.db, value.owner, input);
    const accept = {
      ...input,
      artifactSha256: sha256(value.text),
      objectiveSha256: sha256(value.work.objective ?? ''),
      citationsSha256: review.citationsSha256,
      verdict: 'accepted' as const,
    };
    const accepted = await decideArtifact(database.db, value.owner, accept, { store: value.store });
    const current = () =>
      withTenantTx(
        database.db,
        value.service,
        async (tx) =>
          (
            await tx.execute<{ id: string | null }>(
              sql`select knowledge.artifact_acceptance_id(${output.id}::uuid,${value.work.id}::uuid) as id`,
            )
          ).rows[0]?.id,
      );
    expect(await current()).toBe(accepted.verificationId);
    await decideArtifact(database.db, value.owner, {
      ...accept,
      verdict: 'rejected',
      reason: 'Synthetic reviewer rejection',
    });
    expect(await current()).toBeNull();
    await decideArtifact(database.db, value.owner, accept, { store: value.store });
    await value.close();
    expect(await current()).toBeNull();
  });
  it('checks the final source-locked erasure proof from durable state, never an earlier response', async () => {
    const value = await fixture();
    await value.create();
    await value.close();
    const adapter = purge(value, null);
    await adapter.purgeSource(value.service, { sourceId: value.source.sourceId, limit: 25 });
    expect(
      await withTenantTx(database.db, value.service, (tx) =>
        adapter.confirmInTx(tx, value.service, { sourceId: value.source.sourceId }),
      ),
    ).toEqual({ remaining: 1 });
  });
  it('refuses cross-tenant catalog reads and application catalog writes', async () => {
    const value = await fixture();
    await value.create();
    const foreign = await fixture();
    expect(
      await withTenantTx(database.db, foreign.service, (tx) =>
        tx
          .select()
          .from(artifactAclCatalog)
          .where(eq(artifactAclCatalog.organizationId, value.owner.organizationId)),
      ),
    ).toEqual([]);
    await deniedSql(
      withTenantTx(database.db, value.owner, (tx) =>
        tx
          .update(artifactAclCatalog)
          .set({ alive: false })
          .where(eq(artifactAclCatalog.organizationId, value.owner.organizationId)),
      ),
      '42501',
    );
  });

  // 0211 structured observations are trusted executor input, never model citation arguments.
  async function otherWork(
    value: Fixture,
    classification: 'internal' | 'restricted' = 'restricted',
  ) {
    const work = await createWorkUnit(database.db, value.member, {
      title: 'Other Work actually read',
      objective: 'Synthetic retained structured material',
      classification,
    });
    if (classification === 'restricted')
      await assignContributor(database.db, value.member, {
        id: work.id,
        membershipId: value.owner.membershipId,
      });
    value.records.push({ kind: 'work_unit', id: work.id, sha256: sha256(JSON.stringify(work)) });
    return work;
  }
  async function privateProject(value: Fixture) {
    const clientId = randomUUID(),
      projectId = randomUUID();
    await withTenantTx(database.db, value.service, async (tx) => {
      await tx.insert(clients).values({
        organizationId: value.owner.organizationId,
        id: clientId,
        displayName: 'Synthetic restricted client',
        classification: 'restricted',
        ownerMembershipId: value.member.membershipId,
      });
      await tx.insert(clientReaders).values({
        organizationId: value.owner.organizationId,
        clientId,
        membershipId: value.owner.membershipId,
        grantedByMembershipId: value.member.membershipId,
      });
      await tx.insert(projects).values({
        organizationId: value.owner.organizationId,
        id: projectId,
        clientId,
        name: 'Synthetic retained project',
      });
    });
    value.records.push(
      { kind: 'client', id: clientId, sha256: sha256(`actual-client-read:${clientId}`) },
      { kind: 'project', id: projectId, sha256: sha256(`actual-project-read:${projectId}`) },
    );
    return { clientId, projectId };
  }
  const removeOtherAssignment = (value: Fixture, id: string) =>
    unassign(database.db, value.member, { id, membershipId: value.owner.membershipId });

  it('requires an explicit structured list and target Work before starting any object put', async () => {
    for (const records of [
      undefined,
      [],
      [{ kind: 'client', id: randomUUID(), sha256: sha256('unrelated') }],
    ]) {
      const value = await fixture();
      const port = {
        inspectInTx: async (...args: Parameters<ArtifactInputInventory['inspectInTx']>) => {
          const proof = await value.inventory.inspectInTx(...args);
          return proof.known ? { ...proof, recordInputs: records } : proof;
        },
      } as unknown as ArtifactInputInventory;
      await expect(value.create({}, port)).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(value.control.puts).toBe(0);
    }
  });
  it('retains multiple actual historical hashes and ignores routine mutable Work changes while serving', async () => {
    const value = await fixture(),
      work = await otherWork(value, 'internal');
    value.records.push({ kind: 'work_unit', id: work.id, sha256: sha256('a later actual read') });
    const output = await value.create();
    await withTenantTx(database.db, value.member, (tx) =>
      tx
        .update(workUnits)
        .set({ title: 'Changed title', objective: 'Changed objective', version: work.version + 1 })
        .where(eq(workUnits.id, work.id)),
    );
    const records = await withTenantTx(database.db, value.service, (tx) =>
      tx
        .select()
        .from(artifactLineageRecords)
        .where(eq(artifactLineageRecords.artifactId, output.id)),
    );
    expect(records.filter((row) => row.recordId === work.id)).toHaveLength(2);
    expect((await value.read(output.id)).body.toString()).toBe(value.text);
  });
  it('checks actual OTHER Work assignments for the named viewer even when the writer is a service', async () => {
    const value = await fixture(),
      work = await otherWork(value);
    const output = await value.create();
    expect((await value.read(output.id)).body.toString()).toBe(value.text);
    await removeOtherAssignment(value, work.id);
    const gets = value.control.gets;
    await expect(value.read(output.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(value.control.gets).toBe(gets);
    await expect(value.create({ requestKey: randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(value.control.puts).toBe(1);
  });
  it('rechecks retained structured authority after object get and refuses a revoked in-flight read', async () => {
    const value = await fixture(),
      work = await otherWork(value);
    const output = await value.create();
    value.control.beforeGet = () => removeOtherAssignment(value, work.id);
    await expect(value.read(output.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(value.control.gets).toBe(1);
  });
  it('blocks publication after structured revocation during put and keeps durable blocked provenance', async () => {
    const value = await fixture(),
      work = await otherWork(value);
    value.control.beforePut = () => removeOtherAssignment(value, work.id);
    await expect(value.create()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await value.raw(value.owner)).toEqual({ files: [], links: [] });
    const [header] = await withTenantTx(database.db, value.service, (tx) =>
      tx.select().from(artifactLineage),
    );
    expect(header).toMatchObject({
      structuredInventoryComplete: true,
      state: 'blocked',
      writeState: 'settled',
      physicalPurgedAt: null,
    });
    expect(value.bodies.size).toBe(1);
  });
  it('closes existing output when a structured source exceeds its pinned class', async () => {
    const value = await fixture(),
      work = await otherWork(value, 'internal');
    const output = await value.create();
    await withTenantTx(database.db, value.member, (tx) =>
      tx
        .update(workUnits)
        .set({ classification: 'restricted', version: work.version + 1 })
        .where(eq(workUnits.id, work.id)),
    );
    // The viewer remains assigned: the current class alone is now stronger than this internal file.
    await assignContributor(database.db, value.member, {
      id: work.id,
      membershipId: value.owner.membershipId,
    });
    await expect(value.read(output.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(value.control.gets).toBe(0);
  });
  it('retains the actual private parent read after an authorized project reparent to public material', async () => {
    const value = await fixture(),
      records = await privateProject(value);
    const output = await value.create();
    await withTenantTx(database.db, value.service, (tx) =>
      tx.update(projects).set({ clientId: null }).where(eq(projects.id, records.projectId)),
    );
    expect((await value.read(output.id)).body.toString()).toBe(value.text);
    await withTenantTx(database.db, value.service, (tx) =>
      tx.delete(clientReaders).where(eq(clientReaders.clientId, records.clientId)),
    );
    const gets = value.control.gets;
    await expect(value.read(output.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(value.control.gets).toBe(gets);
    const pinned = await withTenantTx(database.db, value.service, (tx) =>
      tx
        .select()
        .from(artifactLineageRecords)
        .where(eq(artifactLineageRecords.artifactId, output.id)),
    );
    expect(pinned.map((row) => row.recordId)).toEqual(
      expect.arrayContaining([records.clientId, records.projectId]),
    );
  });
  it('does not invent an unread parent body/hash when only a Work record was read', async () => {
    const value = await fixture({ system: true }),
      records = await privateProject(value);
    value.records.splice(1);
    await withTenantTx(database.db, value.owner, (tx) =>
      tx
        .update(workUnits)
        .set({ projectId: records.projectId, version: value.work.version + 1 })
        .where(eq(workUnits.id, value.work.id)),
    );
    const output = await value.create();
    await withTenantTx(database.db, value.service, (tx) =>
      tx.delete(clientReaders).where(eq(clientReaders.clientId, records.clientId)),
    );
    expect((await value.read(output.id, value.member)).body.toString()).toBe(value.text);
    expect(
      await withTenantTx(database.db, value.service, (tx) =>
        tx
          .select()
          .from(artifactLineageRecords)
          .where(eq(artifactLineageRecords.artifactId, output.id)),
      ),
    ).toMatchObject([{ recordKind: 'work_unit', recordId: value.work.id }]);
  });
  it('flattens retained structured ancestors independently of later direct read lists', async () => {
    const value = await fixture(),
      work = await otherWork(value);
    const first = await value.create();
    value.inputs.push({ artifactId: first.id, sha256: sha256(value.text) });
    value.records.splice(1);
    const second = await value.create({
      requestKey: randomUUID(),
      execution: { kind: 'agent_run', id: randomUUID() },
    });
    const rows = await withTenantTx(database.db, value.service, (tx) =>
      tx
        .select()
        .from(artifactLineageRecords)
        .where(eq(artifactLineageRecords.artifactId, second.id)),
    );
    expect(rows.some((row) => row.recordKind === 'work_unit' && row.recordId === work.id)).toBe(
      true,
    );
    await removeOtherAssignment(value, work.id);
    await expect(value.read(second.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(value.control.gets).toBe(0);
  });
  it('refuses cross-tenant structured records and malformed hashes before object I/O', async () => {
    const value = await fixture(),
      foreign = await fixture();
    value.records.push({
      kind: 'work_unit',
      id: foreign.work.id,
      sha256: sha256(JSON.stringify(foreign.work)),
    });
    await expect(value.create()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    value.records.splice(1, 1, { kind: 'work_unit', id: value.work.id, sha256: 'invalid' });
    await expect(value.create()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(value.control.puts).toBe(0);
    expect(
      await withTenantTx(database.db, foreign.service, (tx) =>
        tx
          .select()
          .from(structuredRecordCatalog)
          .where(eq(structuredRecordCatalog.organizationId, value.owner.organizationId)),
      ),
    ).toEqual([]);
  });
  it('keeps a missing structured SQL binding incomplete at commit and forbids app catalog/mirror mutations', async () => {
    const value = await fixture();
    await value.create();
    const [header] = await withTenantTx(database.db, value.service, (tx) =>
      tx.select().from(artifactLineage),
    );
    if (!header) throw new Error('TEST_HEADER_MISSING');
    const id = randomUUID(),
      objectKey = `${value.owner.organizationId}/artifacts/${id}`;
    await deniedSql(
      withTenantTx(agent.db, value.writer, async (tx) => {
        await tx.insert(artifactLineage).values({
          ...header,
          artifactId: id,
          objectKey,
          writeId: randomUUID(),
          state: 'pending',
          writeState: 'active',
        });
        await tx.insert(blobLifecycle).values({
          organizationId: value.owner.organizationId,
          artifactId: id,
          objectKey,
          state: 'uploading',
          purgeAfter: new Date(),
        });
      }),
      'EN118',
    );
    for (const operation of [
      () =>
        withTenantTx(database.db, value.service, (tx) =>
          tx.update(structuredRecordCatalog).set({ alive: false }),
        ),
      () => withTenantTx(database.db, value.service, (tx) => tx.delete(structuredWorkAssignments)),
      () => withTenantTx(database.db, value.service, (tx) => tx.delete(artifactLineageRecords)),
    ])
      await deniedSql(operation(), '42501');
  });
  it('serializes publication against an actual structured ACL/class writer without waiting or publishing stale material', async () => {
    const value = await fixture(),
      work = await otherWork(value);
    let release!: () => void, locked!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const writer = withTenantTx(database.db, value.member, async (tx) => {
      await tx
        .update(workUnits)
        .set({ classification: 'internal', version: work.version + 1 })
        .where(eq(workUnits.id, work.id));
      locked();
      await releasePromise;
    });
    await lockedPromise;
    try {
      await expect(value.create()).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    } finally {
      release();
      await writer;
    }
    expect(value.control.puts).toBe(0);
  });
  it('closes a deleted structured record, refuses revocation-only erasure, and requires positive byte/fence proof', async () => {
    const value = await fixture(),
      project = await privateProject(value);
    const output = await value.create(),
      adapter = purge(value, null);
    const record = { kind: 'project' as const, id: project.projectId, limit: 25 };
    await expect(adapter.purgeRecord(value.service, record)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await withTenantTx(database.db, value.service, (tx) =>
      tx.delete(projects).where(eq(projects.id, project.projectId)),
    );
    await expect(value.read(output.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await adapter.purgeRecord(value.service, record)).toMatchObject({
      remaining: 1,
      confirmed: false,
      removed: 0,
    });
    const held: DerivedArtifactLifecycle = { erase: async () => ({ state: 'held' }) };
    expect(await purge(value, held).purgeRecord(value.service, record)).toMatchObject({
      remaining: 1,
      held: 1,
      confirmed: false,
    });
    const lie: DerivedArtifactLifecycle = {
      erase: async () => ({ state: 'purged', quiescent: true }),
    };
    expect(await purge(value, lie).purgeRecord(value.service, record)).toMatchObject({
      remaining: 1,
      confirmed: false,
    });
    expect(await purge(value).purgeRecord(value.service, record)).toEqual({
      remaining: 0,
      removed: 1,
      held: 0,
      confirmed: true,
    });
    expect(
      await withTenantTx(database.db, value.service, (tx) =>
        purge(value).confirmRecordInTx(tx, value.service, record),
      ),
    ).toEqual({ remaining: 0 });
    expect(value.bodies.size).toBe(0);
    expect(
      await withTenantTx(database.db, value.service, (tx) =>
        tx
          .select()
          .from(artifactLineageRecords)
          .where(eq(artifactLineageRecords.artifactId, output.id)),
      ),
    ).toHaveLength(3);
    expect(
      await withTenantTx(database.db, value.service, (tx) =>
        tx.select().from(tombstones).where(eq(tombstones.targetId, output.id)),
      ),
    ).toMatchObject([{ reasonCode: 'STRUCTURED_INPUT_PURGED' }]);
  });
});
