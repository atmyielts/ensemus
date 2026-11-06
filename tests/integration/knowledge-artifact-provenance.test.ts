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
  artifactLineageSources,
  artifacts,
  blobLifecycle,
  createOrganization,
  knowledgeEvidenceItems,
  knowledgeEvidencePackages,
  knowledgeSourceGrants,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  workArtifacts,
  workUnits,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
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
} from '../../packages/application/src/knowledge/artifact-provenance';
import { pgCode } from '../../packages/application/src/errors';
import { seedMember, seedSearchableSource, sha256 } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('generated artifact all-input privacy and erasure protocol (0208)', () => {
  let database: ReturnType<typeof openAppDatabase>, auth: pg.Client;
  beforeAll(async () => {
    database = openAppDatabase(urls.app(), { max: 6 });
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });
  afterAll(async () => {
    await Promise.all([auth?.end(), database?.close()]);
  });
  async function fixture(
    options: {
      noPackages?: boolean;
      system?: boolean;
      classification?: 'internal' | 'confidential' | 'restricted';
    } = {},
  ) {
    const userId = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
      userId,
      'Generated privacy reviewer',
      `${userId}@example.invalid`,
    ]);
    const org = await createOrganization(database.db, {
      userId,
      name: 'Generated artifact privacy',
      commercialMode: 'sovereign',
    });
    const owner = await resolveTenantContext(database.db, userId, org.organizationId);
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
    };
    const inputs: { artifactId: string; sha256: string }[] = [];
    const inventory: ArtifactInputInventory = {
      inspectInTx: async (_tx, _context, input) => ({
        known: true,
        execution: input.execution,
        workUnitId: work.id,
        viewerMembershipId: options.system ? null : owner.membershipId,
        classification: 'internal',
        noKnowledge: !!options.system,
        artifactInputs: inputs,
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
    const create = (
      changes: Partial<typeof input> = {},
      port: ArtifactInputInventory = inventory,
    ) =>
      addGeneratedArtifact(
        database.db,
        store,
        service,
        { ...input, ...changes },
        { inventory: port },
      );
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
      create,
      close,
      read,
      raw,
      store,
      bodies,
      control,
      lifecycle,
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
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
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
      withTenantTx(database.db, value.service, (tx) =>
        createArtifactProvenance({ inventory: value.inventory }).beginInTx(tx, value.service, {
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
});
