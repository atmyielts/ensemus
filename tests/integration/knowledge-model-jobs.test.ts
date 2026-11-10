// 0216 actual app/agent roles, RLS, money/receipt and permanent-payload-fence guards.
// Synthetic qualification/network adapters only. Native MFA, provider quality and production Cloud
// card bindings have separate gates; this suite grants none of those capabilities to the app role.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentRuns,
  budgetReservations,
  clients,
  executionSteps,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeEvidencePackages,
  knowledgeSourceGrants,
  modelCallAttempts,
  modelCallInputs,
  modelJobPayloads,
  modelJobs,
  modelWorkloadApprovals,
  stepPayloads,
  openAppDatabase,
  resolveTenantContext,
  usageLedger,
  withTenantTx,
  workUnits,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { createDelegatedContext, createServiceContext } from '@ensemus/database/service';
import {
  createWorkUnit,
  createClient,
  createProject,
  assignContributor,
  unassign,
  transitionWorkUnit,
} from '@ensemus/application';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { createModelProfile, addRateCard } from '@ensemus/application/ai-model-profiles';
import { setBudget } from '@ensemus/application/ai-budget';
import { createUsageLedger } from '@ensemus/application/ai-usage';
import { bindKnowledgeModelReceipts } from '@ensemus/application/ai-knowledge-result-consumer';
import { purgeModelJobPayloads } from '@ensemus/application/ai-knowledge-job-content';
import type {
  KnowledgeModelPrincipal,
  PrepareKnowledgeCall,
} from '@ensemus/application/ai-knowledge-ports';
import {
  claimQueuedRun,
  createTurnStore,
  finishRun,
  listLostAttempts,
  purgeEndedRunTranscript,
  storeStepPayload,
} from '@ensemus/application/ai-runs';
import { storeProposal } from '@ensemus/application/ai-tool-steps';
import { admitMainModelInTx, currentRunInputClass } from '@ensemus/application/ai-model-admission';
import { createAgentActivities } from '@ensemus/workflows/agent-activities';
import { workInputHash } from '@ensemus/application/ai-input-ledger';
import {
  approveModelWorkload,
  getKnowledgeModelJob,
  requestKnowledgeModelJob,
  requestModelQualification,
  revokeModelWorkload,
} from '@ensemus/application/knowledge/model-jobs';
import { askQuestion } from '@ensemus/application/knowledge/answers';
import { raiseSourceClassification } from '@ensemus/application/knowledge/sources';
import { ensureEmbeddingSpace } from '@ensemus/application/knowledge/embeddings';
import { createKnowledgeModelGateway, createEmbeddingAdapter } from '@ensemus/intelligence';
import { ScriptedModelAdapter } from '@ensemus/intelligence/testing';
import { createEntitlements } from '@ensemus/commercial';
import {
  operationHash,
  operationKey,
  qualificationOperation,
} from '@ensemus/knowledge/model-operations';
import { ModelCallFailed, type ModelCallMetadata } from '@ensemus/knowledge/ports';
import { deterministicVector } from '@ensemus/knowledge/testing';
import { createKnowledgeModelJobFallbackActivities } from '@ensemus/workflows/knowledge-model-job-fallback-activities';
import { pgCode } from '../../packages/application/src/errors';
import { loadAgentReadScopeInTx } from '../../packages/application/src/ai/read-scope';
import { seedSearchableSource, sha256 } from '../helpers/knowledge';
import {
  seedQualifiedKnowledgeRoute,
  nativeModelContext,
  GENERATED_MODEL_ENDPOINT,
} from '../helpers/knowledge-models';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  testAgentSpec,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

const bounds = {
  maxCalls: 6,
  maxInputTokens: 8192,
  maxOutputTokens: 64,
  maxTotalTokens: 50000,
  maxCostMicros: 10000,
  timeoutSeconds: 240,
};
const signal = () => AbortSignal.timeout(10000);
const codeOf = async (use: () => Promise<unknown>) => {
  try {
    await use();
    return null;
  } catch (error) {
    return pgCode(error);
  }
};
const isPgRefusal = (error: unknown, code: string, message: string) => {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if (
      'code' in current &&
      current.code === code &&
      'message' in current &&
      current.message === message
    )
      return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
};

describe('bounded Knowledge model jobs and principal-bound result receipts (0216)', () => {
  let app: ReturnType<typeof openAppDatabase>, agent: ReturnType<typeof openAgentTestDatabase>;
  let a: AiTenant, b: AiTenant, qualificationId: string, profileId: string;
  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 6 });
    agent = openAgentTestDatabase(6);
    a = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    a.owner = await nativeModelContext(app.db, a.owner);
    b = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const route = await seedQualifiedKnowledgeRoute(app.db, a.owner, { dimension: 3 });
    if (!route.qualificationId) throw new Error('TEST_QUALIFICATION_MISSING');
    qualificationId = route.qualificationId;
    profileId = route.modelProfileRef;
  });
  afterAll(async () => {
    await Promise.all([app.close(), agent.close()]);
  });

  async function approval(kind: 'query' | 'answer' | 'agent_context' = 'query') {
    return approveModelWorkload(app.db, a.owner, {
      kind,
      scope: 'organization',
      sourceId: null,
      connectionId: null,
      purposes: ['embed'],
      qualificationIds: [qualificationId],
      maxClassification: 'restricted',
      bounds,
      expiresAt: new Date(Date.now() + 240000).toISOString(),
      requestKey: randomUUID(),
    });
  }
  async function fixture(
    options: {
      beforeSend?: () => Promise<void>;
      failure?: boolean;
      classification?: 'internal' | 'restricted';
    } = {},
  ) {
    const approved = await approval(),
      query = `Generated query ${randomUUID()}`;
    const input = {
      kind: 'query' as const,
      answerId: null,
      approvalId: approved.approvalId,
      requestKey: randomUUID(),
      bounds,
      classification: options.classification ?? 'internal',
      query,
    };
    const request = await requestKnowledgeModelJob(app.db, a.member, input);
    const requester = await createDelegatedContext(
      agent.db,
      a.organizationId,
      a.member.membershipId,
    );
    const principal: KnowledgeModelPrincipal = {
      kind: 'job',
      context: requester,
      jobId: request.jobId,
    };
    const calls = createKnowledgeCallStore(agent.db);
    let sends = 0;
    const gateway = createKnowledgeModelGateway({
      store: calls,
      entitlements: createEntitlements(agent.db),
      credentials: {
        withKey: async () => {
          throw new Error('TEST_UNEXPECTED_KEY');
        },
      },
      guard: {
        fetchFor: () => async (_url, init) => {
          sends++;
          await options.beforeSend?.();
          if (options.failure) throw new Error('GENERATED_UNKNOWN_PAID_ATTEMPT');
          const body = JSON.parse(String(init?.body)) as { input: string[] };
          return new Response(
            JSON.stringify({
              data: body.input.map((text, index) => ({
                index,
                embedding: deterministicVector(text, 3),
              })),
              usage: { prompt_tokens: 13 },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      },
      embeddings: createEmbeddingAdapter(),
      adapter: new ScriptedModelAdapter([]),
      privateEndpoints: [GENERATED_MODEL_ENDPOINT],
      canaries: async () => [],
      bundle: async () => null,
    });
    const bound = bindKnowledgeModelReceipts(principal, gateway(principal));
    const route = await bound.model.route({
      organizationId: a.organizationId,
      purpose: 'embed',
      classification: input.classification,
    });
    if (route.decision !== 'allow') throw new Error(`TEST_ROUTE_REFUSED:${route.reasonCode}`);
    const metadata: ModelCallMetadata = { operationKey: operationKey([query]), inputs: [] };
    const embed = (refs = metadata) =>
      bound.model.embed(a.organizationId, route.route, [query], signal(), refs);
    return {
      ...request,
      principal,
      requester,
      calls,
      bound,
      route: route.route,
      metadata,
      embed,
      query,
      input,
      approvalId: approved.approvalId,
      sends: () => sends,
    };
  }
  async function evidence(
    context: TenantContext,
    runId: string | null,
    use: (tx: Tx, packageId: string) => Promise<void>,
    classification: 'internal' | 'restricted' = 'internal',
  ) {
    const packageId = randomUUID();
    await withTenantTx(agent.db, context, async (tx) => {
      await tx.insert(knowledgeEvidencePackages).values({
        organizationId: context.organizationId,
        id: packageId,
        purpose: runId ? 'agent_turn' : 'query',
        runId,
        workUnitId: null,
        viewerMembershipId: context.membershipId,
        querySha256: sha256('generated query'),
        policyVersion: 'generated-test-policy',
        budgetTokens: 500,
        usedTokens: 0,
        strongestClassification: classification,
        packageSha256: sha256(packageId),
      });
      await use(tx, packageId);
    });
    return packageId;
  }
  const attempt = async (jobId: string) =>
    (
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(modelCallAttempts).where(eq(modelCallAttempts.jobId, jobId)),
      )
    )[0];
  const job = async (jobId: string) =>
    (
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(modelJobs).where(eq(modelJobs.id, jobId)),
      )
    )[0];

  async function knowledgeAgentVersion(sourceId?: string | null) {
    if (sourceId === null) return seedAgentVersion(app.db, a.owner);
    const declaredSourceId =
      sourceId ??
      (
        await seedSearchableSource(app.db, a.owner, {
          passages: ['Generated explicitly declared Knowledge source.'],
          grants: [{ kind: 'membership', membershipId: a.owner.membershipId }],
        })
      ).sourceId;
    return seedAgentVersion(
      app.db,
      a.owner,
      testAgentSpec({
        context: {
          allowed_scopes: ['data.restricted.read', `knowledge.${declaredSourceId}.read`],
          memory_write_policy: 'none',
        },
      }),
    );
  }
  async function actualAuxiliaryRun(
    limits: { maxCostMicros?: number; maxTotalTokens?: number } = {},
    projectId?: string,
    knowledgeSourceId?: string | null,
  ) {
    await approval('agent_context');
    const work = await createWorkUnit(app.db, a.owner, {
      title: 'Generated joined model runtime',
      objective: 'A genuine Work context.',
      ...(projectId ? { projectId } : {}),
    });
    await transitionWorkUnit(app.db, a.owner, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    const version = await knowledgeAgentVersion(knowledgeSourceId),
      runId = await seedQueuedRun(app.db, a.owner, { workUnitId: work.id, version, limits }),
      temporalRunId = randomUUID();
    const claim = await claimQueuedRun(agent.db, {
      organizationId: a.organizationId,
      workUnitId: work.id,
      temporalRunId,
    });
    if (!claim) throw new Error('TEST_RUN_CLAIM_REFUSED');
    const context = await prepareRunInputContext(agent.db, a.organizationId, runId);
    await withTenantTx(agent.db, context, (tx) =>
      tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId)),
    );
    const start = await createTurnStore(agent.db).beginTurn(context, { runId, stepNumber: 1 });
    if (start.kind !== 'begin') throw new Error('TEST_STEP_REFUSED');
    const principal: KnowledgeModelPrincipal = {
        kind: 'agent_run',
        context,
        step: {
          runId,
          stepId: start.stepId,
          stepNumber: 1,
          attempt: start.attempt,
          workUnitId: work.id,
          agentVersionId: version.versionId,
        },
      },
      calls = createKnowledgeCallStore(agent.db),
      candidate = (await calls.candidates(principal, 'embed'))[0];
    if (!candidate) throw new Error('TEST_CANDIDATE_MISSING');
    const input: PrepareKnowledgeCall = {
      candidate,
      purpose: 'embed',
      classification: 'internal',
      requestHash: operationHash({
        purpose: 'embed',
        inputs: ['Generated auxiliary input'],
        dimension: 3,
      }),
      metadata: { operationKey: operationKey([runId]), inputs: [] },
      ceiling: { inputTokens: 31, outputTokens: 0 },
      policyVersion: 'generated-test-policy',
    };
    const main = {
      ...principal.step,
      purpose: 'reason',
      classification: 'internal' as const,
      profileId,
      costMicros: 1,
      profileVersion: 1,
      reservationAttempt: start.attempt,
      ceiling: { inputTokens: 30, outputTokens: 5 },
      priorUsage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    };
    return { work, runId, temporalRunId, context, principal, calls, input, main };
  }
  it.each([
    { limits: { maxCostMicros: 1 }, label: 'money' },
    { limits: { maxTotalTokens: 40 }, label: 'tokens' },
  ] as const)(
    'rechecks actual auxiliary spending before the main envelope: $label',
    async ({ limits }) => {
      const f = await actualAuxiliaryRun(limits),
        call = await f.calls.prepare(f.principal, f.input);
      await f.calls.dispatch(f.principal, call.callId);
      await f.calls.settle(f.principal, call.callId, {
        usage: { inputTokens: 13, outputTokens: 0 },
        mayHaveBilled: true,
        reasonCode: null,
      });
      expect(
        await withTenantTx(agent.db, f.context, (tx) => admitMainModelInTx(tx, f.context, f.main)),
      ).toBe('BUDGET_EXHAUSTED');
      expect(
        await withTenantTx(app.db, a.owner, (tx) =>
          tx.select().from(usageLedger).where(eq(usageLedger.runId, f.runId)),
        ),
      ).toHaveLength(2);
      expect(
        await withTenantTx(app.db, a.owner, (tx) =>
          tx.select().from(modelCallAttempts).where(eq(modelCallAttempts.runId, f.runId)),
        ),
      ).toHaveLength(1);
    },
  );
  it('refuses auxiliary spending without an explicit immutable Knowledge source scope, even with workload approval', async () => {
    const f = await actualAuxiliaryRun({}, undefined, null);
    await expect(f.calls.prepare(f.principal, f.input)).rejects.toMatchObject({
      code: 'EGRESS_DENIED',
    });
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(modelCallAttempts).where(eq(modelCallAttempts.runId, f.runId)),
      ),
    ).toEqual([]);
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(budgetReservations).where(eq(budgetReservations.runId, f.runId)),
      ),
    ).toEqual([]);
  });
  it('rechecks the current class of a discarded earlier input document, independently of its source class', async () => {
    const source = await seedSearchableSource(app.db, a.owner, {
      passages: ['Generated earlier candidate'],
      grants: [{ kind: 'membership', membershipId: a.owner.membershipId }],
    });
    const f = await actualAuxiliaryRun({}, undefined, source.sourceId);
    const [chunk] = await withTenantTx(app.db, a.owner, (tx) =>
      tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.id, source.chunkIds[0]!)),
    );
    if (!chunk) throw new Error('TEST_CHUNK_MISSING');
    const call = await f.calls.prepare(f.principal, {
      ...f.input,
      metadata: {
        ...f.input.metadata,
        inputs: [
          {
            kind: 'chunk',
            id: chunk.id,
            sourceId: source.sourceId,
            sha256: chunk.contentSha256,
            classification: 'internal',
          },
        ],
      },
    });
    await f.calls.dispatch(f.principal, call.callId);
    await f.calls.settle(f.principal, call.callId, {
      usage: { inputTokens: 13, outputTokens: 0 },
      mayHaveBilled: true,
      reasonCode: null,
    });
    await withTenantTx(app.db, createServiceContext(a.organizationId), (tx) =>
      tx
        .update(knowledgeDocuments)
        .set({ classification: 'restricted', version: sql`${knowledgeDocuments.version}+1` })
        .where(eq(knowledgeDocuments.id, source.documentId)),
    );
    expect(await currentRunInputClass(agent.db, f.context)).toBe('restricted');
    expect(
      await withTenantTx(agent.db, f.context, (tx) => admitMainModelInTx(tx, f.context, f.main)),
    ).toBe('CLASS_DENIED');
  });
  it('includes the target Work current client floor even when only the Work body was actually read', async () => {
    const client = await createClient(app.db, a.owner, {
      displayName: 'Generated current-scope client',
      classification: 'internal',
    });
    if (!client) throw new Error('TEST_CLIENT_REFUSED');
    const project = await createProject(app.db, a.owner, {
      name: 'Generated current-scope project',
      clientId: client.id,
    });
    if (!project) throw new Error('TEST_PROJECT_REFUSED');
    const f = await actualAuxiliaryRun({}, project.id);
    await withTenantTx(app.db, a.owner, (tx) =>
      tx.update(clients).set({ classification: 'restricted' }).where(eq(clients.id, client.id)),
    );
    expect(await currentRunInputClass(agent.db, f.context)).toBe('restricted');
    expect(
      await withTenantTx(agent.db, f.context, (tx) => admitMainModelInTx(tx, f.context, f.main)),
    ).toBe('CLASS_DENIED');
  });
  it('binds actual finish and terminal reclaim to permanent fencing and once-only unknown auxiliary reconciliation', async () => {
    const f = await actualAuxiliaryRun(),
      call = await f.calls.prepare(f.principal, f.input);
    await f.calls.dispatch(f.principal, call.callId);
    await expect(
      f.calls.prepare(f.principal, {
        ...f.input,
        metadata: { ...f.input.metadata, operationKey: operationKey(['automatic retry', f.runId]) },
      }),
    ).rejects.toThrow();
    // The worker's composition binds the native service purge here (agent-composition.ts); this
    // records each call and its real answer, so the test sees the run's end reach the purge.
    const purges: { organizationId: string; runId: string; answer: 'purged' | 'held' }[] = [];
    const activities = createAgentActivities({
      database: agent.db,
      modelAccounting: {
        reconcileRun: (organizationId, runId) =>
          f.calls.reconcileRun(createServiceContext(organizationId), runId),
      },
      transcripts: {
        purgeEnded: async (organizationId, runId) => {
          const answer = await purgeEndedRunTranscript(
            agent.db,
            createServiceContext(organizationId),
            { agentRunId: runId },
          );
          purges.push({ organizationId, runId, answer });
          return answer;
        },
      },
      gateway: {
        turn: async () => {
          throw new Error('TEST_UNEXPECTED_MODEL');
        },
      },
      tools: {
        handle: async () => {
          throw new Error('TEST_UNEXPECTED_TOOL');
        },
      },
      context: {
        compile: async () => {
          throw new Error('TEST_UNEXPECTED_COMPILE');
        },
      },
    });
    const ref = {
      organizationId: a.organizationId,
      workUnitId: f.work.id,
      agentRunId: f.runId,
      temporalRunId: f.temporalRunId,
    };
    // An older workflow run ends nothing, so it erases nothing either.
    await activities.finishAgentRun({
      ...ref,
      temporalRunId: randomUUID(),
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    expect(purges).toEqual([]);
    await activities.finishAgentRun({ ...ref, status: 'cancelled', stopCode: 'STOPPED_BY_PERSON' });
    expect(purges).toEqual([
      { organizationId: a.organizationId, runId: f.runId, answer: 'purged' },
    ]);
    expect(await activities.reclaimAgentRun(ref)).toEqual({ kind: 'nothing_queued' });
    await activities.finishAgentRun({ ...ref, status: 'cancelled', stopCode: 'STOPPED_BY_PERSON' });
    // A retried finish repeats the purge harmlessly (FD-5, 0515).
    expect(purges.map((purge) => purge.answer)).toEqual(['purged', 'purged']);
    const rows = await withTenantTx(app.db, a.owner, (tx) =>
      tx.select().from(modelCallAttempts).where(eq(modelCallAttempts.id, call.callId)),
    );
    expect(rows).toEqual([
      expect.objectContaining({ state: 'unknown', status: 'estimated', costMicros: 1 }),
    ]);
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(usageLedger).where(eq(usageLedger.modelCallId, call.callId)),
      ),
    ).toHaveLength(2);
    expect(
      (
        await withTenantTx(app.db, a.owner, (tx) =>
          tx
            .select()
            .from(budgetReservations)
            .where(eq(budgetReservations.modelCallId, call.callId)),
        )
      ).every((row) => row.status === 'settled'),
    ).toBe(true);
  });
  it('rejects an older bundle/attempt and requires same-transaction admission even for an existing main hold', async () => {
    const f = await actualAuxiliaryRun(),
      call = await f.calls.prepare(f.principal, f.input);
    await f.calls.dispatch(f.principal, call.callId);
    await f.calls.settle(f.principal, call.callId, {
      usage: { inputTokens: 13, outputTokens: 0 },
      mayHaveBilled: true,
      reasonCode: null,
    });
    const ledger = createUsageLedger(agent.db),
      request = {
        runId: f.runId,
        stepId: f.main.stepId,
        attempt: f.main.attempt,
        agentVersionId: f.main.agentVersionId,
        amountMicros: 1,
      };
    await expect(
      withTenantTx(agent.db, f.context, (tx) => ledger.reserve(tx, f.context, request)),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const reservation = await withTenantTx(agent.db, f.context, async (tx) => {
      expect(await admitMainModelInTx(tx, f.context, f.main)).toBeNull();
      const first = await ledger.reserve(tx, f.context, request);
      expect(await ledger.reserve(tx, f.context, request)).toEqual(first);
      return first;
    });
    if (!reservation.ok) throw new Error('TEST_MAIN_RESERVATION_REFUSED');
    await expect(
      withTenantTx(agent.db, f.context, (tx) => ledger.reserve(tx, f.context, request)),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(
      withTenantTx(agent.db, f.context, async (tx) => {
        expect(await admitMainModelInTx(tx, f.context, { ...f.main, costMicros: 2 })).toBeNull();
        await ledger.reserve(tx, f.context, { ...request, amountMicros: 2 });
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      withTenantTx(agent.db, f.context, async (tx) => {
        // Admit actual read scope, but never stamp the main-model writer protocol. This isolates
        // 0414's specific earlier runtime backstop as further before-body protocols are joined.
        await loadAgentReadScopeInTx(tx, f.context);
        await tx
          .update(executionSteps)
          .set({ attempt: f.main.attempt + 1 })
          .where(eq(executionSteps.id, f.main.stepId));
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isPgRefusal(error, 'EN119', 'MAIN_MODEL_RUNTIME_REQUIRED'),
    );
    const [untouched] = await withTenantTx(agent.db, f.context, (tx) =>
      tx
        .select({ attempt: executionSteps.attempt, state: executionSteps.state })
        .from(executionSteps)
        .where(eq(executionSteps.id, f.main.stepId)),
    );
    expect(untouched).toEqual({ attempt: f.main.attempt, state: 'in_flight' });
    const resumed = await createTurnStore(agent.db).beginTurn(f.context, {
      runId: f.runId,
      stepNumber: 1,
    });
    expect(resumed).toMatchObject({
      kind: 'begin',
      attempt: 2,
      lostAttempt: { reservationId: reservation.reservationId, attempt: 1 },
    });
    await storeStepPayload(agent.db, f.context, {
      stepId: f.main.stepId,
      kind: 'completion',
      classification: 'internal',
      content: 'Generated current-attempt completion',
      attempt: 2,
    });
    await expect(
      storeStepPayload(agent.db, f.context, {
        stepId: f.main.stepId,
        kind: 'completion',
        classification: 'internal',
        content: 'Generated stale completion',
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // An older bundle writes without the attempt binding. With no row of that kind to replace, the
    // 0216 result guard refuses its INSERT (MODEL_RESULT_ATTEMPT_STALE).
    expect(
      await codeOf(() =>
        storeStepPayload(agent.db, f.context, {
          stepId: f.main.stepId,
          kind: 'prompt',
          classification: 'internal',
          content: 'Generated older-bundle prompt',
        }),
      ),
    ).toBe('EN119');
    // Replacing the current completion is refused before that INSERT: 0515's material delete guard
    // lets only the native agent service delete a step payload (MATERIAL_DELETE_NATIVE_OPERATION_REQUIRED).
    expect(
      await codeOf(() =>
        storeStepPayload(agent.db, f.context, {
          stepId: f.main.stepId,
          kind: 'completion',
          classification: 'internal',
          content: 'Generated older-bundle completion',
        }),
      ),
    ).toBe('42501');
    // 0417 authority_transcript_body: the agent reads its own transcript only in a transaction that
    // holds the run's read-scope and authority-v1 admission, as the runtime always opens it.
    expect(
      await withTenantTx(agent.db, f.context, async (tx) => {
        await loadAgentReadScopeInTx(tx, f.context);
        return tx
          .select({ content: stepPayloads.content })
          .from(stepPayloads)
          .where(and(eq(stepPayloads.stepId, f.main.stepId), eq(stepPayloads.kind, 'completion')));
      }),
    ).toEqual([{ content: 'Generated current-attempt completion' }]);
    await expect(
      storeProposal(agent.db, f.context, {
        runId: f.runId,
        stepNumber: 1,
        toolId: 'artifact.draft.create',
        args: { name: 'generated.txt', text: 'Generated stale proposal', evidence: [] },
        originatingModel: { stepId: f.main.stepId, attempt: 1 },
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await storeProposal(agent.db, f.context, {
      runId: f.runId,
      stepNumber: 1,
      toolId: 'artifact.draft.create',
      args: { name: 'generated.txt', text: 'Generated current proposal', evidence: [] },
      originatingModel: { stepId: f.main.stepId, attempt: 2 },
    });
    expect(
      await withTenantTx(agent.db, f.context, (tx) => admitMainModelInTx(tx, f.context, f.main)),
    ).toBe('INITIATOR_INACTIVE');
    expect(
      (
        await withTenantTx(agent.db, f.context, (tx) =>
          tx.execute<{ protocol: string }>(
            sql`select current_setting('app.knowledge_model_protocol',true) protocol`,
          ),
        )
      ).rows[0]?.protocol,
    ).toBe('');
    await withTenantTx(agent.db, f.context, (tx) =>
      ledger.release(tx, f.context, reservation.reservationId),
    );
  });

  it('requires explicit spend authority and denies an ordinary member or absent native gate', async () => {
    const raw = {
      kind: 'query' as const,
      scope: 'organization' as const,
      sourceId: null,
      connectionId: null,
      purposes: ['embed' as const],
      qualificationIds: [qualificationId],
      maxClassification: 'internal' as const,
      bounds,
      expiresAt: new Date(Date.now() + 240000).toISOString(),
      requestKey: randomUUID(),
    };
    const noninteractive = await resolveTenantContext(app.db, a.owner.userId, a.organizationId);
    await expect(approveModelWorkload(app.db, noninteractive, raw)).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
    });
    await expect(approveModelWorkload(app.db, a.member, raw)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      requestModelQualification(app.db, noninteractive, {
        profileId,
        expectedProfileVersion: 1,
        purpose: 'embed',
        dimension: 3,
        vectorSpaceVersion: 'generated-v1',
        requestKey: randomUUID(),
        bounds: { ...bounds, maxCalls: 1 },
      }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('binds the request key to immutable input/bounds, with no duplicate event or payload', async () => {
    const f = await fixture();
    expect(await requestKnowledgeModelJob(app.db, a.member, f.input)).toEqual({ jobId: f.jobId });
    await expect(
      requestKnowledgeModelJob(app.db, a.member, { ...f.input, query: 'changed material' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(requestKnowledgeModelJob(app.db, b.member, f.input)).rejects.toThrow();
    await expect(getKnowledgeModelJob(app.db, a.owner, f.jobId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await getKnowledgeModelJob(app.db, a.member, f.jobId)).state).toBe('prepared');
    expect(f.sends()).toBe(0);
  });
  it('keeps private payload SELECT/DELETE and attempt mutation unavailable to the app role', async () => {
    const f = await fixture();
    expect(
      await codeOf(() =>
        withTenantTx(app.db, a.member, (tx) => tx.select().from(modelJobPayloads)),
      ),
    ).toBe('42501');
    expect(
      await codeOf(() =>
        withTenantTx(app.db, createServiceContext(a.organizationId), (tx) =>
          tx.delete(modelJobPayloads).where(eq(modelJobPayloads.jobId, f.jobId)),
        ),
      ),
    ).toBe('42501');
    expect(
      await codeOf(() =>
        withTenantTx(app.db, a.owner, (tx) =>
          tx.update(modelJobs).set({ spentMicros: 0 }).where(eq(modelJobs.id, f.jobId)),
        ),
      ),
    ).toBe('42501');
    expect(
      await withTenantTx(app.db, b.owner, (tx) =>
        tx.select().from(modelJobs).where(eq(modelJobs.id, f.jobId)),
      ),
    ).toEqual([]);
  });
  it('pins approved metadata as real model workers without granting nonhuman or foreign revocation', async () => {
    const f = await fixture();
    const actualRun = await actualAuxiliaryRun();
    for (const context of [
      f.requester,
      actualRun.context,
      createServiceContext(a.organizationId),
    ]) {
      expect(
        await withTenantTx(agent.db, context, (tx) =>
          tx
            .select({ id: modelWorkloadApprovals.id })
            .from(modelWorkloadApprovals)
            .where(eq(modelWorkloadApprovals.id, f.approvalId))
            .for('share', { noWait: true }),
        ),
      ).toEqual([{ id: f.approvalId }]);
      expect(
        await codeOf(() =>
          withTenantTx(agent.db, context, (tx) =>
            tx
              .update(modelWorkloadApprovals)
              .set({ revokedAt: new Date() })
              .where(eq(modelWorkloadApprovals.id, f.approvalId)),
          ),
        ),
      ).toBe('42501');
    }
    const foreign = await createDelegatedContext(agent.db, b.organizationId, b.member.membershipId);
    expect(
      await withTenantTx(agent.db, foreign, (tx) =>
        tx
          .select({ id: modelWorkloadApprovals.id })
          .from(modelWorkloadApprovals)
          .where(eq(modelWorkloadApprovals.id, f.approvalId))
          .for('share', { noWait: true }),
      ),
    ).toEqual([]);
    expect(
      await withTenantTx(agent.db, foreign, (tx) =>
        tx
          .update(modelWorkloadApprovals)
          .set({ revokedAt: new Date() })
          .where(eq(modelWorkloadApprovals.id, f.approvalId))
          .returning({ id: modelWorkloadApprovals.id }),
      ),
    ).toEqual([]);
    expect(
      await codeOf(() =>
        withTenantTx(agent.db, createServiceContext(a.organizationId), async (tx) => {
          // Role membership and mutable actor settings cannot turn the actual agent login into app authority.
          await tx.execute(sql`set local role ensemus_app`);
          await tx.execute(sql`select set_config('app.actor_type','user',true),
        set_config('app.user_id',${a.owner.userId},true),set_config('app.membership_id',${a.owner.membershipId},true)`);
          await tx
            .update(modelWorkloadApprovals)
            .set({ revokedAt: new Date() })
            .where(eq(modelWorkloadApprovals.id, f.approvalId));
        }),
      ),
    ).toBe('42501');
    const [unchanged] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select({ revokedAt: modelWorkloadApprovals.revokedAt })
        .from(modelWorkloadApprovals)
        .where(eq(modelWorkloadApprovals.id, f.approvalId)),
    );
    expect(unchanged?.revokedAt).toBeNull();
    // Conservative stopping deliberately does not require a new MFA proof or native session stamp.
    const plainOwner = await resolveTenantContext(app.db, a.owner.userId, a.organizationId);
    await revokeModelWorkload(app.db, plainOwner, f.approvalId);
    const [revoked] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select({ revokedAt: modelWorkloadApprovals.revokedAt })
        .from(modelWorkloadApprovals)
        .where(eq(modelWorkloadApprovals.id, f.approvalId)),
    );
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
  });
  it('charges actual usage once, and accepts only an actual domain result in its publication transaction', async () => {
    const f = await fixture(),
      output = await f.embed();
    expect(output.usage).toMatchObject({ inputTokens: 13, outputTokens: 0, costMicros: 1 });
    const packageId = await evidence(f.requester, null, async (tx, id) => {
      await f.bound.acceptResultInTx(tx, output.usage, { kind: 'evidence', id });
      await f.bound.acceptResultInTx(tx, output.usage, { kind: 'evidence', id });
    });
    expect(await attempt(f.jobId)).toMatchObject({ state: 'accepted', resultId: packageId });
    const rows = await withTenantTx(app.db, a.owner, (tx) =>
      tx.select().from(usageLedger).where(eq(usageLedger.modelJobId, f.jobId)),
    );
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.costMicros, 0)).toBe(1);
    expect(
      rows.every(
        (row) =>
          row.runId === null &&
          row.stepId === null &&
          row.workUnitId === null &&
          row.modelCallId === output.usage.callId,
      ),
    ).toBe(true);
    expect(f.sends()).toBe(1);
  });
  it('refuses a missing published target, a copied receipt, another job and another tenant', async () => {
    const f = await fixture(),
      output = await f.embed(),
      other = await fixture();
    await expect(
      withTenantTx(agent.db, f.requester, (tx) =>
        f.bound.acceptResultInTx(tx, output.usage, { kind: 'evidence', id: randomUUID() }),
      ),
    ).rejects.toThrow();
    await expect(
      evidence(f.requester, null, (tx, id) =>
        f.bound.acceptResultInTx(tx, { ...output.usage }, { kind: 'evidence', id }),
      ),
    ).rejects.toThrow();
    const rebound = bindKnowledgeModelReceipts(other.principal, {
      ...other.bound.model,
      embed: async () => output,
    });
    const borrowed = await rebound.model.embed(
      a.organizationId,
      other.route,
      [other.query],
      signal(),
      other.metadata,
    );
    await expect(
      evidence(other.requester, null, (tx, id) =>
        rebound.acceptResultInTx(tx, borrowed.usage, { kind: 'evidence', id }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(agent.db, b.member, (tx) =>
        f.bound.acceptResultInTx(tx, output.usage, { kind: 'evidence', id: randomUUID() }),
      ),
    ).rejects.toThrow();
    expect((await attempt(f.jobId))?.state).toBe('response_received');
  });
  it('rolls back publication/acceptance together and restores every temporary binding on success and error', async () => {
    const f = await fixture(),
      output = await f.embed(),
      service = createServiceContext(a.organizationId);
    let rolledBackId = '';
    await expect(
      evidence(f.requester, null, async (tx, id) => {
        rolledBackId = id;
        await f.bound.acceptResultInTx(tx, output.usage, { kind: 'evidence', id });
        throw new Error('GENERATED_ROLLBACK');
      }),
    ).rejects.toThrow('GENERATED_ROLLBACK');
    expect((await attempt(f.jobId))?.state).toBe('response_received');
    expect(
      await withTenantTx(app.db, a.member, (tx) =>
        tx
          .select()
          .from(knowledgeEvidencePackages)
          .where(eq(knowledgeEvidencePackages.id, rolledBackId)),
      ),
    ).toEqual([]);
    await withTenantTx(agent.db, service, async (tx) => {
      const saved = async () =>
        (
          await tx.execute<{ bindings: unknown }>(
            sql`select jsonb_build_array(current_setting('app.organization_id',true),current_setting('app.user_id',true),current_setting('app.membership_id',true),current_setting('app.actor_type',true),current_setting('app.agent_run_id',true),current_setting('app.agent_input_protocol',true),current_setting('app.knowledge_model_protocol',true),current_setting('app.model_job_id',true)) bindings`,
          )
        ).rows[0]?.bindings;
      const before = await saved();
      await expect(
        f.bound.acceptResultInTx(tx, output.usage, { kind: 'evidence', id: randomUUID() }),
      ).rejects.toThrow();
      expect(await saved()).toEqual(before);
    });
    await evidence(f.requester, null, async (tx, id) => {
      const before = await tx.execute(
        sql`select current_setting('app.actor_type',true) actor,current_setting('app.knowledge_model_protocol',true) protocol,current_setting('app.model_job_id',true) job`,
      );
      await f.bound.acceptResultInTx(tx, output.usage, { kind: 'evidence', id });
      expect(
        (
          await tx.execute(
            sql`select current_setting('app.actor_type',true) actor,current_setting('app.knowledge_model_protocol',true) protocol,current_setting('app.model_job_id',true) job`,
          )
        ).rows,
      ).toEqual(before.rows);
    });
  });
  it('refuses a paid response after actual source revocation without losing the canonical charge', async () => {
    const source = await seedSearchableSource(app.db, a.owner, {
      passages: ['Generated private passage'],
      grants: [{ kind: 'membership', membershipId: a.member.membershipId }],
    });
    const [chunk] = await withTenantTx(app.db, a.member, (tx) =>
      tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.id, source.chunkIds[0]!)),
    );
    if (!chunk) throw new Error('TEST_CHUNK_MISSING');
    const f = await fixture({
      beforeSend: () =>
        withTenantTx(app.db, a.owner, async (tx) => {
          await tx
            .delete(knowledgeSourceGrants)
            .where(
              and(
                eq(knowledgeSourceGrants.sourceId, source.sourceId),
                eq(knowledgeSourceGrants.membershipId, a.member.membershipId),
              ),
            );
        }),
    });
    await expect(
      f.embed({
        ...f.metadata,
        inputs: [
          {
            kind: 'chunk',
            id: chunk.id,
            sourceId: source.sourceId,
            sha256: chunk.contentSha256,
            classification: 'internal',
          },
        ],
      }),
    ).rejects.toThrow();
    expect(f.sends()).toBe(1);
    expect(await attempt(f.jobId)).toMatchObject({
      state: 'response_received',
      status: 'final',
      costMicros: 1,
    });
    const rows = await withTenantTx(app.db, a.owner, (tx) =>
      tx.select().from(usageLedger).where(eq(usageLedger.modelJobId, f.jobId)),
    );
    expect(rows).toHaveLength(2);
  });
  it('keeps retained structured hashes historical, while revocation closes result acceptance', async () => {
    const work = await createWorkUnit(app.db, a.owner, {
      title: 'Generated delegated Work',
      objective: 'First actual read.',
      classification: 'restricted',
    });
    await assignContributor(app.db, a.owner, {
      id: work.id,
      membershipId: a.member.membershipId,
    });
    const f = await fixture({ classification: 'restricted' }),
      metadata: ModelCallMetadata = {
        ...f.metadata,
        inputs: [
          {
            kind: 'work_unit',
            id: work.id,
            sha256: workInputHash(work),
            classification: 'restricted',
          },
        ],
      };
    const output = await f.embed(metadata);
    await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .update(workUnits)
        .set({ objective: 'Later ordinary edit.', version: sql`${workUnits.version}+1` })
        .where(eq(workUnits.id, work.id)),
    );
    await f.calls.assertResultFresh(f.principal, output.usage.callId!);
    await unassign(app.db, a.owner, {
      id: work.id,
      membershipId: a.member.membershipId,
    });
    // Unassigning INTERNAL Work does not revoke its organization-wide read right. This case uses
    // the actual restricted named-person boundary and the same sufficient result protection.
    const access = await withTenantTx(agent.db, f.requester, (tx) =>
      tx.execute<{ readable: boolean }>(
        sql`select knowledge.structured_record_readable('work_unit',${work.id}::uuid,${a.member.membershipId}::uuid) readable`,
      ),
    );
    expect(access.rows[0]?.readable).toBe(false);
    await expect(f.calls.assertResultFresh(f.principal, output.usage.callId!)).rejects.toThrow();
    await expect(
      evidence(
        f.requester,
        null,
        (tx, id) => f.bound.acceptResultInTx(tx, output.usage, { kind: 'evidence', id }),
        'restricted',
      ),
    ).rejects.toThrow();
    expect(await attempt(f.jobId)).toMatchObject({
      state: 'response_received',
      status: 'final',
      costMicros: 1,
      resultId: null,
    });
  });
  it('never resends an unconfirmed paid attempt and settles its reserved ceiling exactly once', async () => {
    const f = await fixture({ failure: true });
    await expect(f.embed()).rejects.toThrow('MODEL_UNAVAILABLE');
    const first = await attempt(f.jobId);
    expect(first).toMatchObject({
      state: 'unknown',
      status: 'estimated',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(first?.costMicros).toBe(first?.reservedMicros);
    await expect(f.embed()).rejects.toThrow();
    await f.calls.reconcileJob(createServiceContext(a.organizationId), f.jobId);
    await f.calls.reconcileJob(createServiceContext(a.organizationId), f.jobId);
    expect(f.sends()).toBe(1);
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(usageLedger).where(eq(usageLedger.modelJobId, f.jobId)),
      ),
    ).toHaveLength(2);
    expect((await job(f.jobId))?.reservedMicros).toBe(0);
  });
  it('allows only a genuinely unclaimed fallback, then requires agent deletion and actual COUNT0 proof', async () => {
    const f = await fixture(),
      fallback = createKnowledgeModelJobFallbackActivities({ database: app.db });
    await fallback.refuseUnclaimedModelJob({ organizationId: a.organizationId, jobId: f.jobId });
    expect(await job(f.jobId)).toMatchObject({
      state: 'refused',
      calls: 0,
      payloadsPurgedAt: null,
    });
    expect(
      await codeOf(() =>
        withTenantTx(app.db, a.owner, (tx) =>
          tx
            .update(modelJobs)
            .set({ payloadsPurgedAt: new Date(), purgedFenceGeneration: 1 })
            .where(eq(modelJobs.id, f.jobId)),
        ),
      ),
    ).toBe('42501');
    const service = createServiceContext(a.organizationId);
    expect(await purgeModelJobPayloads(agent.db, service, f.jobId)).toEqual({ removed: 1 });
    expect(await purgeModelJobPayloads(agent.db, service, f.jobId)).toEqual({ removed: 0 });
    expect(await job(f.jobId)).toMatchObject({
      fenceGeneration: 1,
      purgedFenceGeneration: 1,
      payloadsPurgedAt: expect.any(Date),
    });
    expect(
      await codeOf(() =>
        withTenantTx(agent.db, f.requester, (tx) =>
          tx.insert(modelJobPayloads).values({
            organizationId: a.organizationId,
            jobId: f.jobId,
            query: 'Forbidden late private text',
          }),
        ),
      ),
    ).toBe('EN120');
    const claimed = await fixture();
    await claimed.embed();
    await fallback.refuseUnclaimedModelJob({
      organizationId: a.organizationId,
      jobId: claimed.jobId,
    });
    expect((await job(claimed.jobId))?.state).toBe('running');
  });
  it('preserves a real private query under an actual hold, including direct older-worker deletion', async () => {
    const f = await fixture(),
      service = createServiceContext(a.organizationId),
      holdId = randomUUID();
    const privateCount = () =>
      withTenantTx(
        agent.db,
        service,
        async (tx) =>
          (
            await tx.execute<{ count: number }>(
              sql`select count(job_id)::integer count from ai.model_job_payloads where organization_id=${a.organizationId}::uuid and job_id=${f.jobId}::uuid`,
            )
          ).rows[0]!.count,
      );
    expect(await privateCount()).toBe(1);
    await withTenantTx(app.db, a.owner, async (tx) => {
      await tx.execute(sql`insert into lifecycle.legal_holds(organization_id,id,matter_ref,placed_by_membership_id)
        values(${a.organizationId}::uuid,${holdId}::uuid,${randomUUID()},${a.owner.membershipId}::uuid)`);
      await tx.execute(sql`insert into lifecycle.legal_hold_scopes(organization_id,hold_id,scope_type)
        values(${a.organizationId}::uuid,${holdId}::uuid,'organization')`);
    });
    try {
      expect(
        await codeOf(() =>
          withTenantTx(agent.db, service, (tx) =>
            tx.delete(modelJobPayloads).where(eq(modelJobPayloads.jobId, f.jobId)),
          ),
        ),
      ).toBe('EN119');
      expect(await codeOf(() => purgeModelJobPayloads(agent.db, service, f.jobId))).toBe('EN119');
      expect(await privateCount()).toBe(1);
      expect(await job(f.jobId)).toMatchObject({
        payloadsPurgedAt: null,
        purgedFenceGeneration: null,
      });
    } finally {
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.execute(sql`update lifecycle.legal_holds set status='released',released_by_membership_id=${a.owner.membershipId}::uuid,
        released_at=now(),release_reason_code='TEST_RELEASE',version=version+1 where organization_id=${a.organizationId}::uuid and id=${holdId}::uuid`),
      );
    }
    expect(await purgeModelJobPayloads(agent.db, service, f.jobId)).toEqual({ removed: 1 });
    expect(await privateCount()).toBe(0);
    expect(await job(f.jobId)).toMatchObject({
      fenceGeneration: 1,
      purgedFenceGeneration: 1,
      payloadsPurgedAt: expect.any(Date),
    });
  });

  it('serializes fallback against the actual claim row instead of guessing from zero counters', async () => {
    const f = await fixture();
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>((resolve) => {
        locked = resolve;
      }),
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    const holder = withTenantTx(agent.db, createServiceContext(a.organizationId), async (tx) => {
      await tx
        .select({ id: modelJobs.id })
        .from(modelJobs)
        .where(eq(modelJobs.id, f.jobId))
        .for('update');
      locked();
      await hold;
    });
    await ready;
    try {
      expect(
        await codeOf(() =>
          withTenantTx(app.db, a.member, async (tx) => {
            await tx.execute(sql`select set_config('lock_timeout','100ms',true)`);
            await tx
              .update(modelJobs)
              .set({ state: 'refused', refusalCode: 'MODEL_UNAVAILABLE' })
              .where(eq(modelJobs.id, f.jobId));
          }),
        ),
      ).toBe('55P03');
    } finally {
      release();
      await holder;
    }
    expect((await job(f.jobId))?.state).toBe('prepared');
  });
  it('conservatively reconciles actual auxiliary run calls only after terminal fencing, never through legacy recovery', async () => {
    await approval('agent_context');
    const work = await createWorkUnit(app.db, a.owner, {
        title: 'Generated auxiliary run',
        objective: 'Read and compile.',
      }),
      version = await knowledgeAgentVersion(),
      runId = await seedQueuedRun(app.db, a.owner, { workUnitId: work.id, version });
    const context = await prepareRunInputContext(agent.db, a.organizationId, runId);
    await withTenantTx(agent.db, context, async (tx) => {
      await tx.update(agentRuns).set({ status: 'preparing' }).where(eq(agentRuns.id, runId));
      await tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId));
    });
    const started = await createTurnStore(agent.db).beginTurn(context, { runId, stepNumber: 0 });
    if (started.kind !== 'begin') throw new Error('TEST_STEP_REFUSED');
    const principal: KnowledgeModelPrincipal = {
        kind: 'agent_run',
        context,
        step: {
          runId,
          stepId: started.stepId,
          stepNumber: 0,
          attempt: started.attempt,
          workUnitId: work.id,
          agentVersionId: version.versionId,
        },
      },
      calls = createKnowledgeCallStore(agent.db);
    const candidate = (await calls.candidates(principal, 'embed'))[0];
    if (!candidate) throw new Error('TEST_CANDIDATE_MISSING');
    const input: PrepareKnowledgeCall = {
      candidate,
      purpose: 'embed',
      classification: 'internal',
      requestHash: operationHash({ purpose: 'embed', inputs: ['generated query'], dimension: 3 }),
      metadata: { operationKey: operationKey([runId]), inputs: [] },
      ceiling: { inputTokens: 31, outputTokens: 0 },
      policyVersion: 'generated-test-policy',
    };
    const uncaptured = await createWorkUnit(app.db, a.owner, {
      title: 'Generated uncaptured other Work',
      objective: 'Never returned by the context source.',
    });
    await expect(
      calls.prepare(principal, {
        ...input,
        metadata: {
          operationKey: operationKey(['uncaptured', runId]),
          inputs: [
            {
              kind: 'work_unit',
              id: uncaptured.id,
              sha256: workInputHash(uncaptured),
              classification: 'internal',
            },
          ],
        },
      }),
    ).rejects.toThrow();
    const claim = await calls.prepare(principal, input);
    expect(await calls.dispatch(principal, claim.callId)).toBe(true);
    expect(await listLostAttempts(agent.db, context, { agentRunId: runId })).toEqual([]);
    const service = createServiceContext(a.organizationId);
    await expect(calls.reconcileRun(service, runId)).rejects.toThrow();
    await finishRun(agent.db, context, {
      agentRunId: runId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    const held = await withTenantTx(app.db, a.owner, (tx) =>
      tx.select().from(budgetReservations).where(eq(budgetReservations.modelCallId, claim.callId)),
    );
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((row) => row.status === 'held')).toBe(true);
    await calls.reconcileRun(service, runId);
    await calls.reconcileRun(service, runId);
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(modelCallAttempts).where(eq(modelCallAttempts.id, claim.callId)),
      ),
    ).toEqual([expect.objectContaining({ state: 'unknown', status: 'estimated', costMicros: 1 })]);
    const rows = await withTenantTx(app.db, a.owner, (tx) =>
      tx.select().from(usageLedger).where(eq(usageLedger.modelCallId, claim.callId)),
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) => row.runId === runId && row.stepId === started.stepId && row.modelJobId === null,
      ),
    ).toBe(true);
  });
  it('does not let repeated answer idempotency change approved spend authority', async () => {
    const approved = await approval('answer'),
      input = {
        question: 'Generated answer question',
        classification: 'internal' as const,
        requestKey: randomUUID(),
        model: { approvalId: approved.approvalId, bounds },
      };
    const first = await askQuestion(app.db, a.member, input);
    expect(await askQuestion(app.db, a.member, input)).toEqual(first);
    await expect(
      askQuestion(app.db, a.member, {
        ...input,
        model: { ...input.model, bounds: { ...bounds, maxCostMicros: bounds.maxCostMicros - 1 } },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const without = {
      question: input.question,
      classification: input.classification,
      requestKey: input.requestKey,
    };
    await expect(askQuestion(app.db, a.member, without)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  it('refuses a revoked approval at the actual dispatch boundary with no provider send', async () => {
    const f = await fixture();
    await revokeModelWorkload(app.db, a.owner, f.approvalId);
    await expect(f.embed()).rejects.toBeInstanceOf(ModelCallFailed);
    expect(f.sends()).toBe(0);
    expect(await attempt(f.jobId)).toBeUndefined();
  });
  it('closes an internal receipt when a retained source rises above its pinned protection', async () => {
    const source = await seedSearchableSource(app.db, a.owner, {
      passages: ['Generated classified passage'],
      grants: [{ kind: 'membership', membershipId: a.member.membershipId }],
    });
    const [chunk] = await withTenantTx(app.db, a.member, (tx) =>
      tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.id, source.chunkIds[0]!)),
    );
    if (!chunk) throw new Error('TEST_CHUNK_MISSING');
    const f = await fixture(),
      output = await f.embed({
        ...f.metadata,
        inputs: [
          {
            kind: 'chunk',
            id: chunk.id,
            sourceId: source.sourceId,
            sha256: chunk.contentSha256,
            classification: 'internal',
          },
        ],
      });
    await raiseSourceClassification(app.db, a.owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      classification: 'restricted',
    });
    await expect(
      evidence(f.requester, null, (tx, id) =>
        f.bound.acceptResultInTx(tx, output.usage, { kind: 'evidence', id }),
      ),
    ).rejects.toThrow();
    expect((await attempt(f.jobId))?.state).toBe('response_received');
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(modelCallInputs).where(eq(modelCallInputs.callId, output.usage.callId!)),
      ),
    ).toEqual([expect.objectContaining({ classification: 'internal', sourceId: source.sourceId })]);
  });
  it('does not activate an embedding space from an alias, dimension or qualification of another profile', async () => {
    const f = await fixture(),
      service = createServiceContext(a.organizationId);
    await ensureEmbeddingSpace(app.db, service, f.route);
    await expect(
      ensureEmbeddingSpace(app.db, service, { ...f.route, modelProfileRef: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      ensureEmbeddingSpace(app.db, service, {
        ...f.route,
        embedding: { dimension: 4, vectorSpaceVersion: 'generated-v1' },
      }),
    ).rejects.toThrow();
    const legacy = { ...f.route };
    delete legacy.qualificationId;
    await expect(ensureEmbeddingSpace(app.db, service, legacy)).rejects.toThrow();
  });
  it('refuses Cloud-managed reservation without the actual approved-credit hold port and rolls back every hold', async () => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'cloud' });
    tenant.owner = await nativeModelContext(app.db, tenant.owner);
    const profile = await createModelProfile(
      app.db,
      tenant.owner,
      {
        provider_kind: 'local_openai_compatible',
        model_id: 'generated-cloud-model',
        alias: 'Generated Cloud qualification',
        endpoint_url: GENERATED_MODEL_ENDPOINT,
        billing_owner: 'ensemus',
        region: null,
        capabilities: ['text', 'structured_output'],
        limits: { max_input_tokens: 8192, max_output_tokens: 64 },
        allowed_classes: ['public'],
        allowed_purposes: ['embed'],
        retention_basis: 'self_hosted',
        contract_ref: null,
        fallback_profile_ids: [],
      },
      { privateEndpoints: [GENERATED_MODEL_ENDPOINT] },
    );
    await addRateCard(app.db, tenant.owner, {
      profileId: profile.id,
      inputMicrosPerMtok: 11,
      outputMicrosPerMtok: 17,
    });
    await setBudget(app.db, tenant.owner, {
      scope: 'organization',
      agent_version_id: null,
      period: new Date().toISOString().slice(0, 7),
      limit_micros: 10000,
    });
    const request = await requestModelQualification(app.db, tenant.owner, {
      profileId: profile.id,
      expectedProfileVersion: profile.version,
      purpose: 'embed',
      dimension: 3,
      vectorSpaceVersion: 'generated-cloud-v1',
      requestKey: randomUUID(),
      bounds: { ...bounds, maxCalls: 1 },
    });
    const requester = await createDelegatedContext(
        agent.db,
        tenant.organizationId,
        tenant.owner.membershipId,
      ),
      principal: KnowledgeModelPrincipal = {
        kind: 'job',
        context: requester,
        jobId: request.jobId,
      },
      calls = createKnowledgeCallStore(agent.db),
      candidate = (await calls.candidates(principal, 'embed'))[0];
    if (!candidate) throw new Error('TEST_CANDIDATE_MISSING');
    const hash = operationHash(qualificationOperation('embed', 3));
    await expect(
      calls.prepare(principal, {
        candidate,
        purpose: 'embed',
        classification: 'public',
        requestHash: hash,
        qualificationProofHash: hash,
        metadata: { operationKey: operationKey([request.jobId]), inputs: [] },
        ceiling: { inputTokens: 31, outputTokens: 0 },
        policyVersion: 'generated-test-policy',
      }),
    ).rejects.toThrow('BUDGET_EXHAUSTED');
    const rows = await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.select().from(modelCallAttempts).where(eq(modelCallAttempts.jobId, request.jobId)),
    );
    expect(rows).toEqual([]);
    const reservations = await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.select().from(budgetReservations).where(eq(budgetReservations.modelJobId, request.jobId)),
    );
    expect(reservations).toEqual([]);
  });
});
