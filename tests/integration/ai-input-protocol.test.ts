// 0214 real-role/runtime regressions. Synthetic bytes only; no provider/network/physical-fence claim.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  addArtifact,
  assignContributor,
  createWorkUnit,
  readArtifact,
  unassign,
  type ObjectStore,
} from '@ensemus/application';
import { createContextSource } from '@ensemus/application/ai-context-source';
import {
  createRunInputInventory,
  createRunTranscriptPurge,
  checkRunInputDispatch,
} from '@ensemus/application/ai-input-ledger';
import { createToolStepStore } from '@ensemus/application/ai-tool-steps';
import { storeStepPayload } from '@ensemus/application/ai-runs';
import { recordArtifactCitations } from '@ensemus/application/knowledge/verification';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { proposeFact, reviewFact } from '@ensemus/application/knowledge/facts';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import { purgeRunTranscriptsForSource, revokeSource } from '@ensemus/application/knowledge/purge';
import {
  agentRuns,
  artifactLineage,
  artifacts,
  clients,
  clientReaders,
  projects,
  executionSteps,
  openAppDatabase,
  runInputCheckpoints,
  runInputObservations,
  runOutputWrites,
  stepPayloads,
  withTenantTx,
  withUserTx,
  type AppDatabase,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { withRunLookupTx } from '@ensemus/database/agent';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  sha256Of,
} from '../helpers/ai/fixtures';
import { seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';
import { pgCode } from '../../packages/application/src/errors';

class Store implements ObjectStore {
  bodies = new Map<string, Buffer>();
  puts = 0;
  gets = 0;
  beforePut: (() => Promise<void>) | null = null;
  beforeGet: (() => Promise<void>) | null = null;
  failPut = false;
  async put(key: string, body: Buffer) {
    this.puts++;
    await this.beforePut?.();
    if (this.failPut) throw new Error('TEST_UNKNOWN_PUT');
    this.bodies.set(key, Buffer.from(body));
  }
  async get(key: string) {
    this.gets++;
    await this.beforeGet?.();
    const body = this.bodies.get(key);
    if (!body) throw new Error('TEST_OBJECT_MISSING');
    return Buffer.from(body);
  }
  async delete(key: string) {
    this.bodies.delete(key);
  }
  async exists(key: string) {
    return this.bodies.has(key);
  }
}

describe('durable agent input protocol and content fence as actual roles', () => {
  let app: ReturnType<typeof openAppDatabase>, agent: ReturnType<typeof openAgentTestDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app(), { max: 6 });
    agent = openAgentTestDatabase(6);
  });
  afterAll(async () => {
    await Promise.all([app.close(), agent.close()]);
  });
  async function fixture() {
    const tenant = await seedAiTenant(app.db),
      work = await createWorkUnit(app.db, tenant.owner, {
        title: 'Actual target Work',
        objective: 'Synthetic input protocol.',
      });
    const version = await seedAgentVersion(app.db, tenant.owner),
      runId = await seedQueuedRun(app.db, tenant.owner, { workUnitId: work.id, version });
    const context = await prepareRunInputContext(agent.db, tenant.organizationId, runId),
      service = createServiceContext(tenant.organizationId),
      store = new Store();
    await withTenantTx(agent.db, context, async (tx) => {
      await tx.update(agentRuns).set({ status: 'preparing' }).where(eq(agentRuns.id, runId));
      await tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId));
    });
    const source = createContextSource({ database: agent.db, readObject: (key) => store.get(key) }),
      tools = createToolStepStore({ database: agent.db, objects: store });
    const stepId = randomUUID();
    await withTenantTx(agent.db, context, (tx) =>
      tx.insert(executionSteps).values({
        organizationId: tenant.organizationId,
        id: stepId,
        runId,
        stepNumber: 0,
        kind: 'tool_call',
        state: 'in_flight',
        labelCode: 'DRAFTING_ARTIFACT',
      }),
    );
    const draftId = tools.draftIdFor(context, { runId, stepNumber: 0 }),
      text = 'Synthetic generated output.';
    const note = () =>
      withTenantTx(agent.db, context, (tx) =>
        tools.noteDraftUpload(tx, context, { draftId, workUnitId: work.id, runId, text }),
      );
    const publish = (write: Awaited<ReturnType<typeof note>>, bound = tools) =>
      bound.withTx(context, (tx) =>
        bound.insertDraft(tx, context, {
          draftId,
          runId,
          stepId,
          workUnitId: work.id,
          name: 'generated.txt',
          text,
          classification: 'internal',
          evidence: [],
          write,
        }),
      );
    return {
      ...tenant,
      work,
      version,
      runId,
      context,
      service,
      store,
      source,
      tools,
      stepId,
      draftId,
      text,
      note,
      publish,
    };
  }
  async function denied(operation: Promise<unknown>, code: string) {
    let error: unknown;
    try {
      await operation;
    } catch (found) {
      error = found;
    }
    expect(pgCode(error)).toBe(code);
  }
  async function fence(value: Awaited<ReturnType<typeof fixture>>) {
    return withTenantTx(agent.db, value.service, (tx) =>
      createRunTranscriptPurge().fenceUsing!(tx, value.service, { runIds: [value.runId] }),
    );
  }

  it('records exact target and OTHER Work hashes durably, then fresh revocation closes transcript and output inventory', async () => {
    const value = await fixture(),
      other = await createWorkUnit(app.db, value.member, {
        title: 'Other private Work',
        objective: 'Private structured input.',
        classification: 'restricted',
      });
    await assignContributor(app.db, value.member, {
      id: other.id,
      membershipId: value.owner.membershipId,
    });
    await value.source.loadWork(value.context, other.id);
    await storeStepPayload(agent.db, value.context, {
      stepId: value.stepId,
      kind: 'tool_output',
      classification: 'restricted',
      content: 'Synthetic private material',
    });
    const observed = await withTenantTx(agent.db, value.context, (tx) =>
      tx.select().from(runInputObservations),
    );
    expect(observed.map((row) => row.inputId)).toEqual(
      expect.arrayContaining([value.work.id, other.id]),
    );
    expect(JSON.stringify(observed)).not.toContain('Other private Work');
    await unassign(app.db, value.member, { id: other.id, membershipId: value.owner.membershipId });
    await expect(value.source.loadTranscript(value.context, value.runId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      await withTenantTx(agent.db, value.context, (tx) =>
        createRunInputInventory().inspectInTx(tx, value.context, {
          execution: { kind: 'agent_run', id: value.runId },
          workUnitId: value.work.id,
          artifactSha256: sha256Of(value.text),
        }),
      ),
    ).toEqual({ known: false });
  });
  it('keeps historic mutable record reads without making routine title changes a revocation', async () => {
    const value = await fixture();
    await withTenantTx(app.db, value.owner, (tx) =>
      tx.execute(
        sql`update work.work_units set title='Later title',version=version+1 where id=${value.work.id}::uuid`,
      ),
    );
    await value.source.loadWork(value.context, value.work.id);
    const proof = await withTenantTx(agent.db, value.context, (tx) =>
      createRunInputInventory().inspectInTx(tx, value.context, {
        execution: { kind: 'agent_run', id: value.runId },
        workUnitId: value.work.id,
        artifactSha256: sha256Of(value.text),
      }),
    );
    expect(
      proof.known && proof.recordInputs.filter((row) => row.id === value.work.id),
    ).toHaveLength(2);
    await expect(checkRunInputDispatch(agent.db, value.context)).resolves.toBeUndefined();
  });
  it('records file inputs only after verified bytes and refuses a fence committed during object get', async () => {
    const value = await fixture(),
      file = await addArtifact(app.db, value.store, value.owner, {
        workUnitId: value.work.id,
        name: 'input.txt',
        mimeType: 'text/plain',
        body: Buffer.from('Synthetic file input'),
      });
    value.store.beforeGet = async () => {
      await fence(value);
    };
    await expect(
      value.source.loadArtifactText(value.context, {
        workUnitId: value.work.id,
        artifactId: file.id,
        maxBytes: 1000,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(
      await withTenantTx(agent.db, value.service, (tx) =>
        tx
          .select()
          .from(runInputObservations)
          .where(eq(runInputObservations.inputKind, 'artifact')),
      ),
    ).toEqual([]);
  });
  it('denies an older worker new-step and existing-step retry writes before material use', async () => {
    const value = await fixture();
    await denied(
      withRunLookupTx(agent.db, value.organizationId, (tx) =>
        tx.insert(executionSteps).values({
          organizationId: value.organizationId,
          runId: value.runId,
          stepNumber: 1,
          kind: 'model_turn',
          state: 'in_flight',
          labelCode: 'THINKING',
        }),
      ),
      'EN119',
    );
    await denied(
      withRunLookupTx(agent.db, value.organizationId, (tx) =>
        tx.update(executionSteps).set({ attempt: 2 }).where(eq(executionSteps.id, value.stepId)),
      ),
      'EN119',
    );
    await denied(
      withRunLookupTx(agent.db, value.organizationId, (tx) =>
        tx.insert(stepPayloads).values({
          organizationId: value.organizationId,
          stepId: value.stepId,
          kind: 'completion',
          classification: 'internal',
          content: 'late old runtime',
          contentSha256: sha256Of('late old runtime'),
        }),
      ),
      'EN119',
    );
    expect(value.store.puts).toBe(0);
  });
  it('admits only branded agent transactions and clears its protocol on other actors and errors', async () => {
    const value = await fixture();
    const marker = async (tx: Parameters<Parameters<AppDatabase['transaction']>[1]>[0]) =>
      (
        await tx.execute<{ protocol: string }>(
          sql`select coalesce(current_setting('app.agent_input_protocol',true),'') as protocol`,
        )
      ).rows[0]?.protocol;
    expect(await withTenantTx(agent.db, value.context, marker)).toBe('v1');
    await expect(
      withTenantTx(agent.db, value.context, async () => {
        throw new Error('TEST_TRANSACTION_ROLLBACK');
      }),
    ).rejects.toThrow('TEST_TRANSACTION_ROLLBACK');
    expect(await withTenantTx(agent.db, value.service, marker)).toBe('');
    expect(await withTenantTx(agent.db, value.owner, marker)).toBe('');
    expect(await withUserTx(agent.db, value.owner.userId, marker)).toBe('');
    expect(await withRunLookupTx(agent.db, value.organizationId, marker)).toBe('');
    expect(await agent.db.run(marker)).toBe('');
    await denied(
      withTenantTx(app.db, value.owner, (tx) =>
        tx.insert(runInputCheckpoints).values({
          organizationId: value.organizationId,
          runId: value.runId,
          historyComplete: true,
        }),
      ),
      '42501',
    );
    await denied(
      withTenantTx(agent.db, value.context, (tx) =>
        tx
          .update(runInputCheckpoints)
          .set({ historyComplete: false })
          .where(eq(runInputCheckpoints.runId, value.runId)),
      ),
      '42501',
    );
  });
  it('durably fences and removes payloads, rejects late writes, and never grants the app payload access', async () => {
    const value = await fixture(),
      adapter = createRunTranscriptPurge();
    await storeStepPayload(agent.db, value.context, {
      stepId: value.stepId,
      kind: 'completion',
      classification: 'internal',
      content: 'private prompt canary',
    });
    await fence(value);
    await denied(
      withTenantTx(agent.db, value.service, (tx) =>
        tx
          .update(runInputCheckpoints)
          .set({ payloadsPurgedAt: new Date(), purgedFenceGeneration: 1 })
          .where(eq(runInputCheckpoints.runId, value.runId)),
      ),
      'EN119',
    );
    const result = await withTenantTx(agent.db, value.service, async (tx) => {
      expect(await adapter.fenceUsing!(tx, value.service, { runIds: [value.runId] })).toEqual({
        fenced: true,
      });
      return adapter.purgeUsing(tx, value.service, { runIds: [value.runId] });
    });
    expect(result).toEqual({ removed: 1, remaining: 0 });
    const [receipt] = await withTenantTx(agent.db, value.service, (tx) =>
      tx.select().from(runInputCheckpoints).where(eq(runInputCheckpoints.runId, value.runId)),
    );
    expect(receipt?.payloadsPurgedAt).toBeInstanceOf(Date);
    expect(receipt?.purgedFenceGeneration).toBe(receipt?.fenceGeneration);
    await denied(
      withTenantTx(agent.db, value.service, (tx) =>
        tx
          .update(runInputCheckpoints)
          .set({ payloadsPurgedAt: new Date(0) })
          .where(eq(runInputCheckpoints.runId, value.runId)),
      ),
      '42501',
    );
    await expect(
      storeStepPayload(agent.db, value.context, {
        stepId: value.stepId,
        kind: 'completion',
        classification: 'internal',
        content: 'late completion',
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await denied(
      withTenantTx(app.db, value.owner, (tx) => tx.select().from(stepPayloads)),
      '42501',
    );
    await expect(
      withTenantTx(app.db, value.service, (tx) =>
        adapter.purgeUsing(tx, value.service, { runIds: [] }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await denied(
      withTenantTx(agent.db, value.service, (tx) =>
        tx
          .update(runInputCheckpoints)
          .set({ fencedAt: null })
          .where(eq(runInputCheckpoints.runId, value.runId)),
      ),
      '42501',
    );
  });
  it('refuses a foreign run fence and does not change its checkpoint or reveal its payloads', async () => {
    const value = await fixture(),
      foreign = await fixture(),
      adapter = createRunTranscriptPurge();
    await expect(
      withTenantTx(agent.db, foreign.service, (tx) =>
        adapter.fenceUsing!(tx, foreign.service, { runIds: [value.runId] }),
      ),
    ).rejects.toBeDefined();
    const [checkpoint] = await withTenantTx(agent.db, value.service, (tx) =>
      tx.select().from(runInputCheckpoints).where(eq(runInputCheckpoints.runId, value.runId)),
    );
    expect(checkpoint?.fencedAt).toBeNull();
    expect(
      await withTenantTx(agent.db, foreign.service, (tx) =>
        tx.select().from(runInputObservations).where(eq(runInputObservations.runId, value.runId)),
      ),
    ).toEqual([]);
  });
  it('claims one exact token for put and requires a settled receipt before atomic bound publication', async () => {
    const value = await fixture(),
      write = await value.note();
    await denied(value.publish(write), 'EN119');
    await value.tools.putDraft(value.context, { draftId: value.draftId, text: value.text, write });
    await expect(
      value.tools.putDraft(value.context, { draftId: value.draftId, text: value.text, write }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await value.publish(write);
    expect(value.store.puts).toBe(1);
    const [header] = await withTenantTx(agent.db, value.service, (tx) =>
      tx.select().from(artifactLineage).where(eq(artifactLineage.artifactId, value.draftId)),
    );
    expect(header).toMatchObject({
      state: 'bound',
      writeState: 'settled',
      structuredInventoryComplete: true,
    });
    expect(
      (
        await readArtifact(app.db, value.store, value.owner, {
          workUnitId: value.work.id,
          artifactId: value.draftId,
        })
      ).body.toString(),
    ).toBe(value.text);
  });
  it('settles an actually fulfilled put after a late fence but blocks its publication', async () => {
    const value = await fixture(),
      write = await value.note();
    value.store.beforePut = async () => {
      await fence(value);
    };
    await value.tools.putDraft(value.context, { draftId: value.draftId, text: value.text, write });
    await expect(value.publish(write)).rejects.toBeDefined();
    await value.tools.abandonDraftUpload(value.context, write);
    const [header] = await withTenantTx(agent.db, value.service, (tx) =>
      tx.select().from(artifactLineage).where(eq(artifactLineage.artifactId, value.draftId)),
    );
    const [writer] = await withTenantTx(agent.db, value.service, (tx) =>
      tx.select().from(runOutputWrites).where(eq(runOutputWrites.artifactId, value.draftId)),
    );
    expect(header).toMatchObject({
      state: 'blocked',
      writeState: 'settled',
      physicalPurgedAt: null,
    });
    expect(writer?.state).toBe('settled');
    expect(value.store.bodies.size).toBe(1);
    expect(
      await withTenantTx(app.db, value.owner, (tx) =>
        tx.select().from(artifacts).where(eq(artifacts.id, value.draftId)),
      ),
    ).toEqual([]);
  });
  it('keeps a rejected or unknown put started and refuses a blind duplicate despite absent HEAD', async () => {
    const value = await fixture(),
      write = await value.note();
    value.store.failPut = true;
    await expect(
      value.tools.putDraft(value.context, { draftId: value.draftId, text: value.text, write }),
    ).rejects.toThrow('TEST_UNKNOWN_PUT');
    value.store.failPut = false;
    await expect(
      value.tools.putDraft(value.context, { draftId: value.draftId, text: value.text, write }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const [writer] = await withTenantTx(agent.db, value.service, (tx) =>
      tx.select().from(runOutputWrites).where(eq(runOutputWrites.artifactId, value.draftId)),
    );
    expect(writer?.state).toBe('started');
    expect(value.store.puts).toBe(1);
    expect(value.store.bodies.size).toBe(0);
  });
  it('rejects a concurrent duplicate token claim while the first upload is still in flight', async () => {
    const value = await fixture(),
      write = await value.note();
    let entered!: () => void, release!: () => void;
    const seen = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    value.store.beforePut = async () => {
      entered();
      await hold;
    };
    const first = value.tools.putDraft(value.context, {
      draftId: value.draftId,
      text: value.text,
      write,
    });
    await seen;
    try {
      await expect(
        value.tools.putDraft(value.context, { draftId: value.draftId, text: value.text, write }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    } finally {
      release();
      await first;
    }
    expect(value.store.puts).toBe(1);
  });
  it('preserves a published file after a lost SQL acknowledgement and never issues a second put', async () => {
    const value = await fixture(),
      write = await value.note();
    await value.tools.putDraft(value.context, { draftId: value.draftId, text: value.text, write });
    let lose = true;
    const lostDatabase = {
      transaction: async (...args: Parameters<AppDatabase['transaction']>) => {
        const answer = await agent.db.transaction(...args);
        if (lose) {
          lose = false;
          throw new Error('TEST_LOST_COMMIT_ACK');
        }
        return answer;
      },
    } as unknown as AppDatabase;
    const lost = createToolStepStore({ database: lostDatabase, objects: value.store });
    await expect(value.publish(write, lost)).rejects.toThrow('TEST_LOST_COMMIT_ACK');
    await value.tools.abandonDraftUpload(value.context, write);
    const [header] = await withTenantTx(agent.db, value.service, (tx) =>
      tx.select().from(artifactLineage).where(eq(artifactLineage.artifactId, value.draftId)),
    );
    expect(header).toMatchObject({ state: 'bound', writeState: 'settled' });
    await expect(value.note()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(value.store.puts).toBe(1);
  });
  it('captures the actual private fact parent before material leaves, then retains it across reparenting', async () => {
    const value = await fixture(),
      clientId = randomUUID(),
      projectId = randomUUID(),
      word = `factparent${randomUUID().replaceAll('-', '')}`;
    await withTenantTx(app.db, value.service, async (tx) => {
      await tx.insert(clients).values({
        organizationId: value.organizationId,
        id: clientId,
        displayName: 'Private actual fact parent',
        classification: 'restricted',
        ownerMembershipId: value.member.membershipId,
      });
      await tx.insert(clientReaders).values({
        organizationId: value.organizationId,
        clientId,
        membershipId: value.owner.membershipId,
        grantedByMembershipId: value.member.membershipId,
      });
      await tx.insert(projects).values({
        organizationId: value.organizationId,
        id: projectId,
        clientId,
        name: 'Actual private fact project',
      });
      await tx.execute(
        sql`update work.work_units set project_id=${projectId}::uuid,version=version+1 where id=${value.work.id}::uuid`,
      );
    });
    const [project] = await withTenantTx(app.db, value.service, (tx) =>
      tx.select().from(projects).where(eq(projects.id, projectId)),
    );
    if (!project) throw new Error('TEST_PROJECT_MISSING');
    const source = await seedSearchableSource(app.db, value.owner, {
      passages: [word],
      grants: [{ kind: 'organization' }],
    });
    const fact = await proposeFact(app.db, value.member, {
      subjectRef: `project:${projectId}`,
      predicate: 'generated_fact_parent',
      claim: { label: word },
      origin: 'person',
      evidence: [{ chunkId: source.chunkIds[0]!, quoteStart: 0, quoteEnd: word.length }],
    });
    await reviewFact(app.db, value.owner, {
      factId: fact.factId,
      expectedVersion: 1,
      decision: 'verify',
      reason: 'Synthetic verified source.',
    });
    const compiled = await compileEvidence(
      agent.db,
      value.context,
      { model: createScriptedModelPort({}), authorizeAgentContext: async () => true },
      {
        purpose: 'agent_turn',
        workUnitId: value.work.id,
        runId: value.runId,
        question: word,
        queryClassification: 'internal',
        budgetTokens: 500,
        signal: AbortSignal.timeout(10000),
      },
    );
    expect(compiled).toMatchObject({ ok: true, verifiedFacts: [{ factId: fact.factId }] });
    const observations = await withTenantTx(agent.db, value.service, (tx) =>
      tx.select().from(runInputObservations).where(eq(runInputObservations.runId, value.runId)),
    );
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inputKind: 'client', inputId: clientId }),
        expect.objectContaining({
          inputKind: 'project',
          inputId: projectId,
          inputSha256: sha256Of(JSON.stringify(project)),
        }),
      ]),
    );
    expect(JSON.stringify(observations)).not.toContain('Private actual fact parent');
    await withTenantTx(app.db, value.service, (tx) =>
      tx.update(projects).set({ clientId: null }).where(eq(projects.id, projectId)),
    );
    await expect(checkRunInputDispatch(agent.db, value.context)).resolves.toBeUndefined();
    await withTenantTx(app.db, value.service, (tx) =>
      tx.delete(clientReaders).where(eq(clientReaders.clientId, clientId)),
    );
    await expect(checkRunInputDispatch(agent.db, value.context)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('refuses a mismatched compiler run and a user claiming a run before model material or routing', async () => {
    const value = await fixture(),
      model = createScriptedModelPort({});
    const input = {
      purpose: 'agent_turn' as const,
      workUnitId: value.work.id,
      runId: randomUUID(),
      question: 'Synthetic compiler question',
      queryClassification: 'internal' as const,
      budgetTokens: 100,
      signal: AbortSignal.timeout(10000),
    };
    await expect(compileEvidence(agent.db, value.context, { model }, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      compileEvidence(app.db, value.owner, { model }, { ...input, runId: value.runId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(model.calls).toEqual([]);
  });
  it('finds uncited source-bearing artifact reads in actual source transcript purge', async () => {
    const value = await fixture(),
      text = 'Synthetic retained source.',
      source = await seedSearchableSource(app.db, value.owner, {
        passages: [text],
        grants: [{ kind: 'membership', membershipId: value.owner.membershipId }],
      });
    const file = await addArtifact(app.db, value.store, value.owner, {
      workUnitId: value.work.id,
      name: 'source-input.txt',
      mimeType: 'text/plain',
      body: Buffer.from(text),
    });
    await recordArtifactCitations(app.db, value.owner, {
      workUnitId: value.work.id,
      artifactId: file.id,
      citations: [{ chunkId: source.chunkIds[0]!, artifactStart: 0, artifactEnd: text.length }],
    });
    await value.source.loadArtifactText(value.context, {
      workUnitId: value.work.id,
      artifactId: file.id,
      maxBytes: 1000,
    });
    await storeStepPayload(agent.db, value.context, {
      stepId: value.stepId,
      kind: 'tool_output',
      classification: 'internal',
      content: text,
    });
    const references = await withTenantTx(agent.db, value.service, (tx) =>
      tx.execute<{ id: string }>(sql`select ai.source_input_runs(${source.sourceId}::uuid) as id`),
    );
    expect(references.rows.map((row) => row.id)).toContain(value.runId);
    await revokeSource(app.db, value.owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Synthetic source closure',
    });
    expect(
      await purgeRunTranscriptsForSource(
        agent.db,
        value.service,
        { transcripts: createRunTranscriptPurge() },
        { sourceId: source.sourceId },
      ),
    ).toEqual({ removed: 1 });
    expect(
      await withTenantTx(agent.db, value.service, (tx) =>
        tx
          .select()
          .from(stepPayloads)
          .where(
            and(
              eq(stepPayloads.organizationId, value.organizationId),
              eq(stepPayloads.stepId, value.stepId),
            ),
          ),
      ),
    ).toEqual([]);
  });
});
