// 0214 real-role/runtime regressions. Synthetic bytes only; no provider/network/physical-fence claim.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  addArtifact,
  assignContributor,
  createClient,
  createProject,
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
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { claimQueuedRun, readRunDirective, storeStepPayload } from '@ensemus/application/ai-runs';
import { recordArtifactCitations } from '@ensemus/application/knowledge/verification';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { proposeFact, reviewFact } from '@ensemus/application/knowledge/facts';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import { purgeRunTranscriptsForSource, revokeSource } from '@ensemus/application/knowledge/purge';
import {
  agentRuns,
  artifactAuthorityRefs,
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
  tombstones,
  withTenantTx,
  withUserTx,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createAgentContext, withRunLookupTx } from '@ensemus/database/agent';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  proposeFromModelTurn,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  sha256Of,
  testAgentSpec,
  withAdmittedRunTx,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';
import { pgCode } from '../../packages/application/src/errors';
import { createDerivedArtifactPurge } from '../../packages/application/src/knowledge/artifact-provenance';

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
  /**
   * `knowledge` names the Knowledge sources the published manifest grants (0414: an agent reads no
   * source its immutable manifest does not name). It runs after the tenant exists and before the
   * version is published, as an owner would create a source and then publish an agent that reads it.
   * `scopes` adds manifest data scopes. A run whose manifest names a Knowledge source has its read
   * scope required (0414), and such a run reads nothing above confidential unless the manifest grants
   * `data.restricted.read` (0414's ai.run_company_ceiling defaults to confidential).
   */
  async function fixture(
    options: {
      knowledge?: (tenant: AiTenant) => Promise<readonly string[]>;
      scopes?: readonly string[];
    } = {},
  ) {
    const tenant = await seedAiTenant(app.db),
      work = await createWorkUnit(app.db, tenant.owner, {
        title: 'Actual target Work',
        objective: 'Synthetic input protocol.',
      });
    const sources = options.knowledge ? await options.knowledge(tenant) : [],
      scopes = options.scopes ?? [];
    const version = await seedAgentVersion(
        app.db,
        tenant.owner,
        sources.length || scopes.length
          ? testAgentSpec({
              context: {
                allowed_scopes: [
                  'work.read',
                  ...scopes,
                  ...sources.map((id) => `knowledge.${id}.read`),
                ],
                memory_write_policy: 'none',
              },
            })
          : testAgentSpec(),
      ),
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
    await withAdmittedRunTx(agent.db, context, (tx) =>
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
    // The tool gateway's gate: every draft effect runs in the transaction that has just read the run
    // with readRun(lock: true), which admits the run's read scope and authority-v1 binding (0417) or
    // clears them. Nothing here admits anything the gateway would not.
    const note = () =>
      withTenantTx(agent.db, context, async (tx) => {
        await tools.readRun(tx, context, runId, { lock: true });
        return tools.noteDraftUpload(tx, context, { draftId, workUnitId: work.id, runId, text });
      });
    const publish = (write: Awaited<ReturnType<typeof note>>, bound = tools) =>
      bound.withTx(context, async (tx) => {
        await bound.readRun(tx, context, runId, { lock: true });
        return bound.insertDraft(tx, context, {
          draftId,
          runId,
          stepId,
          workUnitId: work.id,
          name: 'generated.txt',
          text,
          classification: 'internal',
          evidence: [],
          write,
        });
      });
    /** The output inventory exactly as the draft effect reads it, behind the same gate. */
    const inspect = () =>
      withTenantTx(agent.db, context, async (tx) => {
        await tools.readRun(tx, context, runId, { lock: true });
        return createRunInputInventory().inspectInTx(tx, context, {
          execution: { kind: 'agent_run', id: runId },
          workUnitId: work.id,
          artifactSha256: sha256Of(text),
        });
      });
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
      inspect,
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

  it('reads closed proposal metadata on the app role without private payload privileges', async () => {
    const value = await fixture();
    // As the runtime stores one: the turn's context is compiled (its Work read), then the model turn
    // at step 1 stores the proposal against its own in-flight attempt. No caller stores a proposal
    // without the originating turn, so none writes a step row outside authority-v1 admission.
    await value.source.loadWork(value.context, value.work.id);
    await proposeFromModelTurn(agent.db, value.context, {
      runId: value.runId,
      turnStep: 1,
      toolId: 'artifact.draft.create',
      args: { name: 'synthetic.txt', text: 'SYNTHETIC_PRIVATE_ARGUMENT', evidence: [] },
    });
    await fence(value);
    const metadataOnly = createToolStepStore({ database: app.db, objects: value.store });
    const metadata = await metadataOnly.loadProposalMetadata(value.context, {
      runId: value.runId,
      stepNumber: 1,
    });
    expect(metadata).toMatchObject({
      runId: value.runId,
      toolId: 'artifact.draft.create',
      status: 'proposed',
    });
    expect(metadata).not.toHaveProperty('args');
    await expect(
      value.tools.loadProposal(value.context, { runId: value.runId, stepNumber: 1 }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(
      metadataOnly.loadProposal(value.context, { runId: value.runId, stepNumber: 1 }),
    ).rejects.toThrow();
  });

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
    // Before the revocation the same gate does produce the inventory, so the refusal below is the
    // revocation's doing (bounded run output authority, 0525).
    expect(await value.inspect()).toMatchObject({ known: true, workUnitId: value.work.id });
    await unassign(app.db, value.member, { id: other.id, membershipId: value.owner.membershipId });
    // 0414's run-level current + historical input proof (currentRunCompanyClassInTx) refuses the
    // whole run once a retained input is unreadable, before any per-record read: POLICY_DENIED.
    await expect(value.source.loadTranscript(value.context, value.runId)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(await value.inspect()).toEqual({ known: false });
  });
  it('keeps historic mutable record reads without making routine title changes a revocation', async () => {
    const value = await fixture();
    await withTenantTx(app.db, value.owner, (tx) =>
      tx.execute(
        sql`update work.work_units set title='Later title',version=version+1 where id=${value.work.id}::uuid`,
      ),
    );
    await value.source.loadWork(value.context, value.work.id);
    const proof = await value.inspect();
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
    // The block is durable: the fulfilled put's file is tombstoned, which runs 0501's hold check.
    expect(
      await withTenantTx(app.db, value.service, (tx) =>
        tx
          .select({ reason: tombstones.reasonCode })
          .from(tombstones)
          .where(
            and(eq(tombstones.targetType, 'artifact'), eq(tombstones.targetId, value.draftId)),
          ),
      ),
    ).toEqual([{ reason: 'KNOWLEDGE_SOURCE_PURGED' }]);
  });
  it('plans a non-agent transaction on the agent role over every ceiling-bounded body table (0536)', async () => {
    const value = await fixture(),
      other = await seedAiTenant(app.db);
    // 0417's project/client/file body policies call ai.run_company_ceiling with no run for a
    // non-agent actor, and the planner runs it while estimating their class comparison. 0414 raised
    // AGENT_SCOPE_INVALID there; 0536 answers 0, which no class satisfies, so such a read plans and
    // still admits exactly what the first policy arm and the service's ordinary policies admit: every
    // project and client of its own tenant (0209/0211 service actor), and of the files only an
    // ordinary public/internal human file (0419 knowledge.artifact_readable with no viewer). Another
    // tenant's rows and a confidential file stay out.
    const client = await createClient(app.db, value.owner, {
      displayName: 'Ceiling-bounded client',
      classification: 'internal',
    });
    if (!client) throw new Error('TEST_CLIENT_REFUSED');
    const project = await createProject(app.db, value.owner, {
      name: 'Ceiling-bounded project',
      clientId: client.id,
    });
    const clientless = await createProject(app.db, value.owner, { name: 'Clientless project' });
    if (!project || !clientless) throw new Error('TEST_PROJECT_REFUSED');
    const plainWork = await createWorkUnit(app.db, value.owner, { title: 'Ordinary file Work' }),
      privateWork = await createWorkUnit(app.db, value.owner, {
        title: 'Confidential file Work',
        classification: 'confidential',
      });
    const ordinary = await addArtifact(app.db, value.store, value.owner, {
      workUnitId: plainWork.id,
      name: 'ordinary.txt',
      mimeType: 'text/plain',
      body: Buffer.from('Ordinary internal file.'),
    });
    await addArtifact(app.db, value.store, value.owner, {
      workUnitId: privateWork.id,
      name: 'confidential.txt',
      mimeType: 'text/plain',
      body: Buffer.from('Confidential file.'),
    });
    const otherClient = await createClient(app.db, other.owner, {
      displayName: 'Other tenant client',
      classification: 'internal',
    });
    if (!otherClient) throw new Error('TEST_CLIENT_REFUSED');
    await createProject(app.db, other.owner, {
      name: 'Other tenant project',
      clientId: otherClient.id,
    });
    const otherWork = await createWorkUnit(app.db, other.owner, { title: 'Other tenant Work' });
    await addArtifact(app.db, value.store, other.owner, {
      workUnitId: otherWork.id,
      name: 'other.txt',
      mimeType: 'text/plain',
      body: Buffer.from('Other tenant file.'),
    });
    const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id).sort();
    expect(
      ids(
        await withTenantTx(agent.db, value.service, (tx) =>
          tx.select({ id: projects.id }).from(projects),
        ),
      ),
    ).toEqual([project.id, clientless.id].sort());
    expect(
      ids(
        await withTenantTx(agent.db, value.service, (tx) =>
          tx.select({ id: clients.id }).from(clients),
        ),
      ),
    ).toEqual([client.id]);
    expect(
      ids(
        await withTenantTx(agent.db, value.service, (tx) =>
          tx.select({ id: artifacts.id }).from(artifacts),
        ),
      ),
    ).toEqual([ordinary.id]);
    // An agent transaction bound to its run still plans against that run's own ceiling lookup.
    await expect(
      withTenantTx(agent.db, value.context, (tx) => tx.select().from(artifacts).limit(1)),
    ).resolves.toBeDefined();
  });
  it('reads a claimed authority-v1 run’s directive behind its own admission, and stops one it cannot admit (0417)', async () => {
    const tenant = await seedAiTenant(app.db),
      work = await createWorkUnit(app.db, tenant.owner, { title: 'Directive target Work' }),
      version = await seedAgentVersion(app.db, tenant.owner, testAgentSpec()),
      runId = await seedQueuedRun(app.db, tenant.owner, { workUnitId: work.id, version }),
      temporalRunId = randomUUID(),
      service = createServiceContext(tenant.organizationId);
    const claimed = await claimQueuedRun(agent.db, {
      organizationId: tenant.organizationId,
      workUnitId: work.id,
      temporalRunId,
    });
    expect(claimed?.agentRunId).toBe(runId);
    // The context every agent Activity builds for itself, and the run moved on as the workflow does.
    const context = await createAgentContext(agent.db, {
      organizationId: tenant.organizationId,
      initiatorMembershipId: tenant.owner.membershipId,
      agentRunId: runId,
    });
    await withTenantTx(agent.db, context, (tx) =>
      tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId)),
    );
    const directive = (holder = temporalRunId) =>
      readRunDirective(agent.db, context, {
        agentRunId: runId,
        temporalRunId: holder,
        halt: createHaltCheck,
      });
    // The workflow asks this before every step. 0417's authority_work_body hides the Work from an
    // unadmitted agent transaction, so this read used to find no row and end every running run as
    // stopped (the stack canaries' 'cancelled'). Behind the run's own admission it reads the hold.
    expect(await directive()).toBe('continue');
    // Still the hold that decides: another workflow run, which does not hold the Work, stops.
    expect(await directive(randomUUID())).toBe('stop');
    // A run whose inputs are fenced cannot be admitted, so it stops rather than reading on.
    await withTenantTx(agent.db, service, (tx) =>
      createRunTranscriptPurge().fenceUsing!(tx, service, { runIds: [runId] }),
    );
    expect(await directive()).toBe('stop');
  });
  it('still refuses an agent-actor transaction without its run at the ceiling and every ceiling-bounded body (0536)', async () => {
    const value = await fixture();
    // 0536 answers 0 only for a non-agent actor. The same agent context with app.agent_run_id
    // emptied names no run whose manifest could set a class, so 0414's AGENT_SCOPE_INVALID stands,
    // both when the ceiling is asked directly and when 0417's body policies are planned.
    const withoutRun = (read: (tx: Tx) => Promise<unknown>) =>
      withTenantTx(agent.db, value.context, async (tx) => {
        await tx.execute(sql`select set_config('app.agent_run_id','',true)`);
        return read(tx);
      });
    const refusalOf = async (operation: Promise<unknown>) => {
      const error = await operation.then(
        () => null,
        (found: unknown) => found,
      );
      const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
      return `${String(cause?.code)}:${String(cause?.message)}`;
    };
    const refused = 'EN119:AGENT_SCOPE_INVALID';
    expect(
      await refusalOf(
        withoutRun((tx) => tx.execute(sql`select ai.run_company_ceiling(null::uuid)`)),
      ),
    ).toBe(refused);
    expect(
      await refusalOf(
        withoutRun((tx) =>
          tx.execute(
            sql`select ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid)`,
          ),
        ),
      ),
    ).toBe(refused);
    expect(await refusalOf(withoutRun((tx) => tx.select().from(projects).limit(1)))).toBe(refused);
    expect(await refusalOf(withoutRun((tx) => tx.select().from(clients).limit(1)))).toBe(refused);
    expect(await refusalOf(withoutRun((tx) => tx.select().from(artifacts).limit(1)))).toBe(refused);
    // The control: the very same context with its run bound plans every one of those reads.
    await expect(
      withTenantTx(agent.db, value.context, (tx) => tx.select().from(projects).limit(1)),
    ).resolves.toBeDefined();
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
  it('binds a run’s generated file to its own lineage and class, and only behind its own admission (0525)', async () => {
    const value = await fixture(),
      other = await createWorkUnit(app.db, value.owner, {
        title: 'Other readable Work',
        objective: 'Not this run’s lineage.',
      });
    const refusal = async (operation: Promise<unknown>) => {
      try {
        await operation;
        return null;
      } catch (error) {
        return {
          code: pgCode(error),
          message: (error as { cause?: { message?: string } }).cause?.message,
        };
      }
    };
    /** A pending header shaped exactly as beginInTx writes one; only the named fields differ. */
    const header = (overrides: Partial<typeof artifactLineage.$inferInsert>) => {
      const artifactId = randomUUID();
      return {
        organizationId: value.organizationId,
        artifactId,
        workUnitId: value.work.id,
        objectKey: `${value.organizationId}/artifacts/${artifactId}`,
        artifactSha256: sha256Of('Synthetic bounded output.'),
        sizeBytes: 25,
        classification: 'internal',
        executionKind: 'agent_run',
        executionId: value.runId,
        executorRef: 'agent-run/v1',
        viewerMembershipId: value.context.membershipId,
        inventorySha256: sha256Of('synthetic inventory'),
        inventoryComplete: true,
        structuredInventoryComplete: true,
        state: 'pending',
        writeId: randomUUID(),
        generation: 1,
        writeState: 'active',
        ...overrides,
      };
    };
    const gated = (row: ReturnType<typeof header>) =>
      withTenantTx(agent.db, value.context, async (tx) => {
        await value.tools.readRun(tx, value.context, value.runId, { lock: true });
        await tx.insert(artifactLineage).values(row);
      });
    // Below the run's own class (internal): refused even behind the run's own admission.
    expect(await refusal(gated(header({ classification: 'public' })))).toEqual({
      code: 'EN119',
      message: 'RUN_OUTPUT_AUTHORITY_UNBOUND',
    });
    // Another Work the same person may read is not this run's lineage.
    expect(await refusal(gated(header({ workUnitId: other.id })))).toEqual({
      code: 'EN119',
      message: 'RUN_OUTPUT_AUTHORITY_UNBOUND',
    });
    // Its own lineage and class, but without this transaction's authority-v1 admission (0417).
    expect(
      await refusal(
        withTenantTx(agent.db, value.context, (tx) =>
          tx.insert(artifactLineage).values(header({})),
        ),
      ),
    ).toEqual({ code: 'EN119', message: 'RUN_AUTHORITY_PROTOCOL_REQUIRED' });
    // Nor does the output inventory exist for it outside the gate.
    expect(
      await withTenantTx(agent.db, value.context, (tx) =>
        createRunInputInventory().inspectInTx(tx, value.context, {
          execution: { kind: 'agent_run', id: value.runId },
          workUnitId: value.work.id,
          artifactSha256: sha256Of(value.text),
        }),
      ),
    ).toEqual({ known: false });
    // The same run, behind the gate, at its own class and lineage: the real draft path publishes.
    const write = await value.note();
    expect(write).toMatchObject({ workUnitId: value.work.id, classification: 'internal' });
    await value.tools.putDraft(value.context, { draftId: value.draftId, text: value.text, write });
    await value.publish(write);
    expect(
      await withTenantTx(agent.db, value.service, (tx) =>
        tx
          .select({ state: artifactLineage.state })
          .from(artifactLineage)
          .where(eq(artifactLineage.artifactId, value.draftId)),
      ),
    ).toEqual([{ state: 'bound' }]);
  });

  // 0417 allowed its RUN_OUTPUT_AUTHORITY_UNBOUND gate to be lifted only once 0419's retained
  // authority takes part in fresh named-viewer serving, source purge and byte proof. 0525 lifted it
  // for the bounded case above; each of these proves one of the three on an authority-v1 file.
  /** The SQLSTATE and raised message of a refusal, or null when the operation went through. */
  async function refusalOf(operation: Promise<unknown>) {
    try {
      await operation;
      return null;
    } catch (error) {
      return {
        code: pgCode(error),
        message: (error as { cause?: { message?: string } }).cause?.message,
      };
    }
  }
  /** Note, put and publish the run's draft exactly as the tool gateway does. */
  async function generate(value: Awaited<ReturnType<typeof fixture>>) {
    const write = await value.note();
    await value.tools.putDraft(value.context, { draftId: value.draftId, text: value.text, write });
    await value.publish(write);
    return write;
  }
  const served = (value: Awaited<ReturnType<typeof fixture>>) =>
    readArtifact(app.db, value.store, value.owner, {
      workUnitId: value.work.id,
      artifactId: value.draftId,
    });

  it('serves an authority-v1 generated file only while its viewer can still read every input the run read (0419 serving)', async () => {
    const value = await fixture(),
      other = await createWorkUnit(app.db, value.member, {
        title: 'Other restricted input',
        objective: 'Private structured input.',
        classification: 'restricted',
      });
    await assignContributor(app.db, value.member, {
      id: other.id,
      membershipId: value.owner.membershipId,
    });
    await value.source.loadWork(value.context, other.id);
    const write = await generate(value);
    // At least the run's own class (0525): the run read restricted material.
    expect(write.classification).toBe('restricted');
    expect((await served(value)).body.toString()).toBe(value.text);
    // The file's retained receipt names the other Work the run read, not only the Work it sits on.
    const refs = await withTenantTx(app.db, value.service, (tx) =>
      tx
        .select({ kind: artifactAuthorityRefs.refKind, id: artifactAuthorityRefs.refId })
        .from(artifactAuthorityRefs)
        .where(eq(artifactAuthorityRefs.artifactId, value.draftId)),
    );
    expect(refs).toEqual(expect.arrayContaining([{ kind: 'work_unit', id: other.id }]));
    // The viewer keeps the Work the file is attached to but loses the other input: fresh
    // named-viewer serving reads the retained authority, so the file is no longer theirs.
    await unassign(app.db, value.member, { id: other.id, membershipId: value.owner.membershipId });
    const gets = value.store.gets;
    await expect(served(value)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(value.store.gets).toBe(gets);
    // The person who can still read every input still sees it.
    await assignContributor(app.db, value.member, {
      id: other.id,
      membershipId: value.owner.membershipId,
    });
    expect((await served(value)).body.toString()).toBe(value.text);
  });

  it('closes and removes an authority-v1 generated file when a source its run read is purged (0419 source purge)', async () => {
    const passage = 'Synthetic purged source passage.';
    let source!: Awaited<ReturnType<typeof seedSearchableSource>>;
    const value = await fixture({
      knowledge: async (tenant) => {
        source = await seedSearchableSource(app.db, tenant.owner, {
          passages: [passage],
          grants: [{ kind: 'organization' }],
        });
        return [source.sourceId];
      },
    });
    const file = await addArtifact(app.db, value.store, value.owner, {
      workUnitId: value.work.id,
      name: 'source-input.txt',
      mimeType: 'text/plain',
      body: Buffer.from(passage),
    });
    await recordArtifactCitations(app.db, value.owner, {
      workUnitId: value.work.id,
      artifactId: file.id,
      citations: [{ chunkId: source.chunkIds[0]!, artifactStart: 0, artifactEnd: passage.length }],
    });
    expect(
      await value.source.loadArtifactText(value.context, {
        workUnitId: value.work.id,
        artifactId: file.id,
        maxBytes: 1000,
      }),
    ).toMatchObject({ id: file.id, text: passage });
    await generate(value);
    expect((await served(value)).body.toString()).toBe(value.text);
    // The generated file's own retained authority carries the source the run read through a file.
    const required = await withTenantTx(app.db, value.service, (tx) =>
      tx.execute<{ id: string }>(
        sql`select knowledge.artifact_required_sources(${value.draftId}::uuid) as id`,
      ),
    );
    expect(required.rows.map((row) => row.id)).toContain(source.sourceId);
    await revokeSource(app.db, value.owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Synthetic source closure',
    });
    // Closing the source closes fresh serving at once.
    await expect(served(value)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The source purge finds the generated file through that retained authority, blocks its header
    // and tombstones it. With no erasure adapter it claims no physical removal.
    const purged = await createDerivedArtifactPurge({
      database: app.db,
      store: value.store,
    }).purgeSource(value.service, { sourceId: source.sourceId, limit: 100 });
    expect(purged.confirmed).toBe(false);
    const [header] = await withTenantTx(agent.db, value.service, (tx) =>
      tx
        .select({ state: artifactLineage.state })
        .from(artifactLineage)
        .where(eq(artifactLineage.artifactId, value.draftId)),
    );
    expect(header?.state).toBe('blocked');
    expect(
      await withTenantTx(app.db, value.service, (tx) =>
        tx
          .select({ reason: tombstones.reasonCode })
          .from(tombstones)
          .where(
            and(eq(tombstones.targetType, 'artifact'), eq(tombstones.targetId, value.draftId)),
          ),
      ),
    ).toEqual([{ reason: 'KNOWLEDGE_SOURCE_PURGED' }]);
  });

  it('refuses bytes an authority-v1 file’s retained receipt does not bind (0419 byte proof)', async () => {
    const value = await fixture(),
      other = await createWorkUnit(app.db, value.member, {
        title: 'Other restricted input',
        objective: 'Private structured input.',
        classification: 'restricted',
      });
    await assignContributor(app.db, value.member, {
      id: other.id,
      membershipId: value.owner.membershipId,
    });
    await value.source.loadWork(value.context, other.id);
    const write = await value.note();
    const gated = (body: (tx: Parameters<Parameters<typeof withTenantTx>[2]>[0]) => unknown) =>
      withTenantTx(agent.db, value.context, async (tx) => {
        await value.tools.readRun(tx, value.context, value.runId, { lock: true });
        await body(tx);
      });
    const claim = (artifactId: string) => ({
      organizationId: value.organizationId,
      artifactId,
      runId: value.runId,
      writeId: randomUUID(),
      generation: 1,
      state: 'registered',
    });
    // Even behind the run's own admission, a put claim needs a retained receipt that names it:
    // none exists for bytes with no lineage, and this file's receipt names another token.
    expect(
      await refusalOf(gated((tx) => tx.insert(runOutputWrites).values(claim(randomUUID())))),
    ).toEqual({ code: 'EN119', message: 'ARTIFACT_AUTHORITY_PUT_UNPROVEN' });
    expect(
      await refusalOf(gated((tx) => tx.insert(runOutputWrites).values(claim(value.draftId)))),
    ).toEqual({ code: 'EN119', message: 'ARTIFACT_AUTHORITY_PUT_UNPROVEN' });
    // Bytes that were never put cannot be bound, so nothing is served.
    await denied(value.publish(write), 'EN119');
    expect(
      await withTenantTx(app.db, value.owner, (tx) =>
        tx.select().from(artifacts).where(eq(artifacts.id, value.draftId)),
      ),
    ).toEqual([]);
    // Once a retained input is no longer the viewer's, the real token cannot be claimed either:
    // not by the runtime, and not by the token's own UPDATE behind the gate.
    await unassign(app.db, value.member, { id: other.id, membershipId: value.owner.membershipId });
    await expect(
      value.tools.putDraft(value.context, { draftId: value.draftId, text: value.text, write }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // ai.lock_frozen_input_refs finds the retained input unreadable for the receipt's viewer.
    expect(
      await refusalOf(
        gated((tx) =>
          tx
            .update(runOutputWrites)
            .set({ state: 'started' })
            .where(
              and(
                eq(runOutputWrites.artifactId, value.draftId),
                eq(runOutputWrites.writeId, write.writeId),
              ),
            ),
        ),
      ),
    ).toEqual({ code: 'EN119', message: 'ARTIFACT_AUTHORITY_INPUT_CLOSED' });
    expect(value.store.puts).toBe(0);
  });

  it('captures the actual private fact parent before material leaves, then retains it across reparenting', async () => {
    const word = `factparent${randomUUID().replaceAll('-', '')}`;
    let source!: Awaited<ReturnType<typeof seedSearchableSource>>;
    // The fact's parent client is restricted, so the Work this run reads is restricted through its
    // project. A run that names a Knowledge source has a required read scope (0414), and its manifest
    // must grant data.restricted.read to read restricted material at all (0414 ai.run_company_ceiling).
    const value = await fixture({
        scopes: ['data.restricted.read'],
        knowledge: async (tenant) => {
          source = await seedSearchableSource(app.db, tenant.owner, {
            passages: [word],
            grants: [{ kind: 'organization' }],
          });
          return [source.sourceId];
        },
      }),
      clientId = randomUUID(),
      projectId = randomUUID();
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
    // The retained client read is now unreadable to the initiator, so 0414's run-level input proof
    // (currentRunCompanyClassInTx, reached first through assertRunInputsOpen) refuses dispatch.
    await expect(checkRunInputDispatch(agent.db, value.context)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
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
    const text = 'Synthetic retained source.';
    let source!: Awaited<ReturnType<typeof seedSearchableSource>>;
    // The manifest names the source (0414/0419: a source-derived file is invisible to a run whose
    // immutable scope does not), so the run's read of the citing file is a genuine one.
    const value = await fixture({
      knowledge: async (tenant) => {
        source = await seedSearchableSource(app.db, tenant.owner, {
          passages: [text],
          grants: [{ kind: 'membership', membershipId: tenant.owner.membershipId }],
        });
        return [source.sourceId];
      },
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
    expect(
      await value.source.loadArtifactText(value.context, {
        workUnitId: value.work.id,
        artifactId: file.id,
        maxBytes: 1000,
      }),
    ).toMatchObject({ id: file.id, text });
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
