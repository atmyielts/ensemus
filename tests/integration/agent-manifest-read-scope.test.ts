// Real app/agent roles after 0411 + 0414. Authored, not a DB/provider execution claim. Scripted
// Knowledge calls below only inspect the material selected BEFORE any possible provider boundary.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createWorkUnit, addArtifact, createClient, createProject } from '@ensemus/application';
import { createContextSource, loadAgentReadScope } from '@ensemus/application/ai-context-source';
import { currentRunInputClass } from '@ensemus/application/ai-model-admission';
import { createTurnStore, finishRun } from '@ensemus/application/ai-runs';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { verifiedFactsFor, proposeFact, reviewFact } from '@ensemus/application/knowledge/facts';
import { createMinimalContextCompiler } from '@ensemus/agent-runtime/context';
import {
  agentRuns,
  clients,
  executionSteps,
  openAppDatabase,
  runInputObservations,
  withTenantTx,
  workUnits,
} from '@ensemus/database';
import { createAgentContext } from '@ensemus/database/agent';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import { createKnowledgeContextCompiler } from '../../workers/workflow/src/knowledge-context';
import { pgCode } from '../../packages/application/src/errors';
import { loadAgentReadScopeInTx } from '../../packages/application/src/ai/read-scope';
import {
  openAgentTestDatabase,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  testAgentSpec,
} from '../helpers/ai/fixtures';
import { seedSearchableSource, knowledgeCanary } from '../helpers/knowledge';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';

const limits = { maxInputChars: 100000, maxArtifactBytes: 10000 };
describe('immutable agent source/company-data scope and rolling protocol', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4);
  let a: Awaited<ReturnType<typeof seedAiTenant>>, b: Awaited<ReturnType<typeof seedAiTenant>>;
  beforeAll(async () => {
    a = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    b = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
  });
  afterAll(async () => {
    await agent.close();
    await app.close();
  });
  const source = (
    readObject: (key: string) => Promise<Buffer> = async () => {
      throw new Error('TEST_UNEXPECTED_BYTES');
    },
  ) => createContextSource({ database: agent.db, readObject });
  async function fixture(
    scopes: string[],
    classification: 'public' | 'internal' | 'confidential' | 'restricted' = 'internal',
    projectId?: string,
    maxDepth = 0,
  ) {
    const work = await createWorkUnit(app.db, a.owner, {
      title: `Scoped ${randomUUID()}`,
      objective: 'Use only authorized material.',
      classification,
      ...(projectId ? { projectId } : {}),
    });
    const version = await seedAgentVersion(
      app.db,
      a.owner,
      testAgentSpec({
        context: { allowed_scopes: scopes, memory_write_policy: 'none' },
        execution: {
          max_model_turns: 5,
          max_tool_calls: 5,
          max_total_tokens: 10000,
          max_cost_usd: '1',
          timeout_seconds: 60,
          max_delegation_depth: maxDepth,
        },
      }),
    );
    const runId = await seedQueuedRun(app.db, a.owner, {
      workUnitId: work.id,
      version,
      classification,
      limits: { maxDelegationDepth: maxDepth },
    });
    const context = await createAgentContext(agent.db, {
      organizationId: a.organizationId,
      initiatorMembershipId: a.owner.membershipId,
      agentRunId: runId,
    });
    return {
      work,
      version,
      runId,
      context,
      ref: { runId, workUnitId: work.id, agentVersionId: version.versionId },
    };
  }
  it('refuses old-bundle Work/model-step admission, accepts the actual new metadata admission, and clears unrelated contexts', async () => {
    const f = await fixture(['data.public.read'], 'public');
    await withTenantTx(agent.db, f.context, async (tx) => {
      expect(
        await tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, f.work.id)),
      ).toEqual([]);
      expect(
        (
          await tx.execute<{ allowed: boolean }>(
            sql`select ai.main_reservation_admitted(${f.runId}::uuid,${randomUUID()}::uuid,1,0) allowed`,
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      await expect(
        tx.transaction(async (inner) => {
          await inner.execute(
            sql`select set_config('app.knowledge_model_protocol','main-runtime-v1',true)`,
          );
          await inner.insert(executionSteps).values({
            organizationId: a.organizationId,
            runId: f.runId,
            stepNumber: 1,
            kind: 'model_turn',
            state: 'in_flight',
            labelCode: 'THINKING',
          });
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
    });
    expect((await loadAgentReadScope(agent.db, f.context, f.ref)).ceiling).toBe('public');
    await expect(currentRunInputClass(agent.db, f.context)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect((await source().loadWork(f.context, f.work.id)).classification).toBe('public');
    const step = await createTurnStore(agent.db).beginTurn(f.context, { ...f.ref, stepNumber: 1 });
    expect(step.kind).toBe('begin');
    if (step.kind !== 'begin') throw new Error('TEST_STEP_MISSING');
    await withTenantTx(agent.db, f.context, async (tx) => {
      // An existing in-flight step cannot be reclaimed by an old bundle after admission's Tx ends.
      await expect(
        tx.transaction((inner) =>
          inner
            .update(executionSteps)
            .set({ attempt: 2 })
            .where(eq(executionSteps.id, step.stepId)),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
      await tx.execute(
        sql`select set_config('app.knowledge_model_protocol',${`main-v1:${f.runId}:${step.stepId}:1:0`},true)`,
      );
      expect(
        (
          await tx.execute<{ admitted: boolean }>(
            sql`select ai.run_input_admitted(${f.runId}::uuid) admitted`,
          )
        ).rows[0]?.admitted,
      ).toBe(false);
      await loadAgentReadScopeInTx(tx, f.context);
      expect(
        (
          await tx.execute<{ admitted: boolean }>(
            sql`select ai.run_input_admitted(${f.runId}::uuid) admitted`,
          )
        ).rows[0]?.admitted,
      ).toBe(true);
      expect(
        await tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, f.work.id)),
      ).toEqual([{ id: f.work.id }]);
    });
    await withTenantTx(app.db, a.owner, async (tx) => {
      const bindings = await tx.execute<{ scope: string; part: string }>(
        sql`select current_setting('app.agent_scope_protocol',true) scope,current_setting('app.portability_part_sha256',true) part`,
      );
      expect(bindings.rows[0]).toEqual({ scope: '', part: '' });
    });
  });
  it('allows public company material with internal policy protection, without promoting the manifest to public', async () => {
    const f = await fixture(['data.public.read'], 'public');
    const compiler = createMinimalContextCompiler({ source: source(), limits });
    const result = await compiler.compile(f.context, f.ref);
    expect(result.classification).toBe('internal');
    expect(result.messages.find((message) => message.role === 'policy')?.classification).toBe(
      'internal',
    );
    expect(await currentRunInputClass(agent.db, f.context)).toBe('public');
  });
  it('denies above-ceiling target and OTHER Work before an observation or file byte is served', async () => {
    const f = await fixture(['data.internal.read']);
    await source().loadWork(f.context, f.work.id);
    const secret = await createWorkUnit(app.db, a.owner, {
      title: knowledgeCanary(),
      classification: 'confidential',
    });
    const objects = new Map<string, Buffer>();
    const file = await addArtifact(
      app.db,
      {
        put: async (key, body) => {
          objects.set(key, body);
        },
        get: async (key) => {
          const body = objects.get(key);
          if (!body) throw new Error('TEST_OBJECT_MISSING');
          return body;
        },
        delete: async (key) => {
          objects.delete(key);
        },
        exists: async (key) => objects.has(key),
      },
      a.owner,
      {
        workUnitId: secret.id,
        name: 'private.txt',
        mimeType: 'text/plain',
        body: Buffer.from(knowledgeCanary()),
      },
    );
    let reads = 0;
    const scoped = source(async (key) => {
      reads += 1;
      return objects.get(key)!;
    });
    await expect(scoped.loadWork(f.context, secret.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      await scoped.loadArtifactText(f.context, {
        workUnitId: secret.id,
        artifactId: file.id,
        maxBytes: 10000,
      }),
    ).toEqual({ refused: 'NOT_PERMITTED' });
    expect(reads).toBe(0);
    const seen = await withTenantTx(agent.db, f.context, (tx) =>
      tx
        .select({ id: runInputObservations.inputId })
        .from(runInputObservations)
        .where(eq(runInputObservations.runId, f.runId)),
    );
    expect(seen.map((row) => row.id)).not.toContain(secret.id);
    const target = await fixture(['data.internal.read'], 'restricted');
    await expect(scoped.loadWork(target.context, target.work.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('keeps legacy M4 resource ABAC when data scopes are absent', async () => {
    const f = await fixture(['work.read'], 'restricted');
    expect((await source().loadWork(f.context, f.work.id)).classification).toBe('restricted');
  });
  it('does not invoke the Knowledge model factory when the actual manifest has no KB grant', async () => {
    const f = await fixture(['data.internal.read']);
    const turn = await createTurnStore(agent.db).beginTurn(f.context, { ...f.ref, stepNumber: 1 });
    if (turn.kind !== 'begin') throw new Error('TEST_STEP_MISSING');
    const compiler = createKnowledgeContextCompiler({
      database: agent.db,
      base: createMinimalContextCompiler({ source: source(), limits }),
      limits,
      forPrincipal: () => {
        throw new Error('TEST_KNOWLEDGE_NOT_GRANTED');
      },
    });
    const compiled = await compiler.compile(f.context, {
      ...f.ref,
      modelStep: { stepId: turn.stepId, stepNumber: 1, attempt: turn.attempt },
      signal: AbortSignal.timeout(10000),
    });
    expect(compiled.sources.map((row) => row.type)).toEqual(['work_unit']);
  });
  it('filters selected sources and current class before LIMIT/reranking, including higher-ranked unselected/private candidates', async () => {
    const word = knowledgeCanary(),
      excluded = knowledgeCanary();
    const allowed = await seedSearchableSource(app.db, a.owner, {
      classification: 'public',
      passages: [`${word} permitted`],
      grants: [{ kind: 'organization' }],
    });
    await seedSearchableSource(app.db, a.owner, {
      classification: 'public',
      passages: Array.from({ length: 70 }, () => `${word} ${word} ${excluded}`),
      grants: [{ kind: 'organization' }],
    });
    const above = await seedSearchableSource(app.db, a.owner, {
      classification: 'confidential',
      passages: Array.from({ length: 70 }, () => `${word} ${word} ${excluded}`),
      grants: [{ kind: 'organization' }],
    });
    const f = await fixture(
      [
        'data.public.read',
        `knowledge.${allowed.sourceId}.read`,
        `knowledge.${above.sourceId}.read`,
      ],
      'public',
    );
    const sent: string[] = [];
    const model = createScriptedModelPort({
      rerank: (_question, passages) => {
        sent.push(...passages);
        return {
          order: passages.map((_, i) => i),
          usage: { inputTokens: 1, outputTokens: 1, costMicros: null },
        };
      },
    });
    const result = await compileEvidence(
      agent.db,
      f.context,
      { model, authorizeAgentContext: async () => true },
      {
        purpose: 'agent_turn',
        question: word,
        queryClassification: 'internal',
        workUnitId: f.work.id,
        runId: f.runId,
        budgetTokens: 500,
        signal: AbortSignal.timeout(10000),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      items: [{ sourceId: allowed.sourceId }],
      strongestClassification: 'internal',
    });
    expect(sent.join('\n')).not.toContain(excluded);
    expect(model.calls.filter((call) => call.method === 'embed')).toEqual([]);
  });
  it('cannot widen the immutable source manifest through compile input, including foreign-tenant IDs', async () => {
    const word = knowledgeCanary();
    const foreign = await seedSearchableSource(app.db, b.owner, {
      passages: [word],
      grants: [{ kind: 'organization' }],
    });
    const allowed = await seedSearchableSource(app.db, a.owner, {
      passages: ['different authorized material'],
      grants: [{ kind: 'organization' }],
    });
    const f = await fixture(['data.internal.read', `knowledge.${allowed.sourceId}.read`]);
    const model = createScriptedModelPort({});
    const result = await compileEvidence(
      agent.db,
      f.context,
      { model, authorizeAgentContext: async () => true },
      {
        purpose: 'agent_turn',
        question: word,
        queryClassification: 'internal',
        workUnitId: f.work.id,
        runId: f.runId,
        sourceIds: [foreign.sourceId],
        budgetTokens: 500,
        signal: AbortSignal.timeout(10000),
      },
    );
    expect(result).toMatchObject({ ok: true, items: [] });
    expect(model.calls).toEqual([]);
  });
  it('excludes facts with any unselected evidence before body/capture and keeps allowed complete evidence', async () => {
    const people = await makeTwoTenants(app.db);
    await proveSecondFactor(people.a.owner);
    const work = await createWorkUnit(app.db, people.a.owner.context, {
      title: 'Fact scope',
      classification: 'public',
    });
    const selected = await seedSearchableSource(app.db, people.a.owner.context, {
      classification: 'public',
      passages: ['Selected evidence'],
      grants: [{ kind: 'organization' }],
    });
    const other = await seedSearchableSource(app.db, people.a.owner.context, {
      classification: 'public',
      passages: ['Unselected evidence'],
      grants: [{ kind: 'organization' }],
    });
    const fact = async (chunkIds: string[]) => {
      const created = await proposeFact(app.db, people.a.owner.context, {
        subjectRef: `work_unit:${work.id}`,
        predicate: 'scope.note',
        claim: knowledgeCanary(),
        origin: 'person',
        evidence: chunkIds.map((chunkId) => ({ chunkId, quoteStart: 0, quoteEnd: 5 })),
      });
      await reviewFact(app.db, people.a.admin.context, {
        factId: created.factId,
        expectedVersion: 1,
        decision: 'verify',
        reason: 'Checked generated evidence.',
      });
      return created.factId;
    };
    const mixed = await fact([selected.chunkIds[0]!, other.chunkIds[0]!]),
      complete = await fact([selected.chunkIds[0]!]);
    const rows = await verifiedFactsFor(app.db, people.a.owner.context, {
      subjectRefs: [`work_unit:${work.id}`],
      sourceIds: [selected.sourceId],
      maxClassification: 'public',
      limit: 50,
    });
    expect(rows.map((row) => row.id)).toEqual([complete]);
    expect(rows.map((row) => row.id)).not.toContain(mixed);
    expect(
      (
        await verifiedFactsFor(app.db, people.a.owner.context, {
          subjectRefs: [`work_unit:${work.id}`],
          sourceIds: [selected.sourceId],
          maxClassification: 'public',
          limit: 1,
        })
      ).map((row) => row.id),
    ).toEqual([complete]);
  });
  it('retains captured higher class after a genuine parent classification lowering', async () => {
    const client = await createClient(app.db, a.owner, {
      displayName: 'Protected parent',
      classification: 'confidential',
    });
    if (!client) throw new Error('TEST_CLIENT_REFUSED');
    const project = await createProject(app.db, a.owner, {
      name: 'Protected project',
      clientId: client.id,
    });
    if (!project) throw new Error('TEST_PROJECT_REFUSED');
    const f = await fixture(['data.confidential.read'], 'public', project.id);
    expect((await source().loadWork(f.context, f.work.id)).classification).toBe('confidential');
    await withTenantTx(app.db, a.owner, (tx) =>
      tx.update(clients).set({ classification: 'internal' }).where(eq(clients.id, client.id)),
    );
    expect(await currentRunInputClass(agent.db, f.context)).toBe('confidential');
    const observation = await withTenantTx(agent.db, f.context, (tx) =>
      tx
        .select({ classification: runInputObservations.classification })
        .from(runInputObservations)
        .where(eq(runInputObservations.runId, f.runId)),
    );
    expect(observation).toContainEqual({ classification: 'confidential' });
  });
  it('does not mint a scope marker or return material after the durable terminal fence', async () => {
    const f = await fixture(['data.public.read'], 'public');
    await source().loadWork(f.context, f.work.id);
    await finishRun(agent.db, f.context, {
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    await expect(source().loadWork(f.context, f.work.id)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    await withTenantTx(agent.db, f.context, async (tx) => {
      const proof = await tx.execute<{ admitted: boolean; marker: string }>(
        sql`select ai.run_input_admitted(${f.runId}::uuid) admitted,current_setting('app.agent_scope_protocol',true) marker`,
      );
      expect(proof.rows[0]).toEqual({ admitted: false, marker: '' });
    });
  });
  it('atomically rolls back copied child Work when actual delegation-birth input proof is unavailable', async () => {
    const f = await fixture(['data.internal.read'], 'internal', undefined, 1);
    await source().loadWork(f.context, f.work.id);
    const childId = randomUUID(),
      childRun = randomUUID(),
      title = knowledgeCanary();
    await expect(
      withTenantTx(agent.db, f.context, async (tx) => {
        // Actual new scope admission in this effect Tx, not a manually asserted marker or invented reads.
        await loadAgentReadScopeInTx(tx, f.context);
        await tx.insert(workUnits).values({
          organizationId: a.organizationId,
          id: childId,
          parentId: f.work.id,
          ownerMembershipId: a.owner.membershipId,
          createdByMembershipId: a.owner.membershipId,
          title,
          classification: 'internal',
        });
        await tx.insert(agentRuns).values({
          organizationId: a.organizationId,
          id: childRun,
          workUnitId: childId,
          agentVersionId: f.version.versionId,
          parentRunId: f.runId,
          depth: 1,
          initiatorMembershipId: a.owner.membershipId,
          serviceIdentityId: f.version.serviceIdentityId,
          effectiveClassification: 'internal',
          maxModelTurns: 5,
          maxToolCalls: 5,
          maxTotalTokens: 10000,
          maxCostMicros: 1000000,
          timeoutSeconds: 60,
          maxDelegationDepth: 0,
          delegatedScopes: { tools: ['work.read'] },
        });
      }),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, childId)),
      ),
    ).toEqual([]);
  });
});
