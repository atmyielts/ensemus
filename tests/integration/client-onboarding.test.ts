// Real tenant transactions and M4 run binding; explicit status overrides isolate state-machine faults.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMinimalContextCompiler } from '@ensemus/agent-runtime/context';
import { createToolGateway } from '@ensemus/agent-runtime/tools';
import { AppError, getWorkDetail, listWorkOverview, type ObjectStore } from '@ensemus/application';
import { publishAgentVersion } from '@ensemus/application/ai-agents';
import { createContextSource } from '@ensemus/application/ai-context-source';
import {
  createEgressLog,
  listEgressDecisions,
  loadTenantPolicyBundle,
} from '@ensemus/application/ai-egress-log';
import { createProfileStore } from '@ensemus/application/ai-model-profiles';
import {
  claimQueuedRun,
  completeTurn,
  createTurnStore,
  finishRun,
  setRunStatus,
  storeStepPayload,
  verifyOutput,
} from '@ensemus/application/ai-runs';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createApprovalBinder } from '@ensemus/application/ai-tool-approvals';
import { externalActionPort } from '@ensemus/application/ai-external-action-port';
import { createToolStepStore, storeProposal } from '@ensemus/application/ai-tool-steps';
import {
  admitMainModelDispatchInTx,
  receiveMainInputSnapshotInTx,
  type MainModelAdmission,
} from '@ensemus/application/ai-model-admission';
import { createOnboardingAgentRuns } from '@ensemus/application/knowledge/onboarding-run-port';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { agentSpecV1Schema } from '@ensemus/contracts/ai';
import { CLIENT_BRIEF_SCHEMA_REF } from '@ensemus/contracts/knowledge';
import { createModelRouter } from '@ensemus/intelligence';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import { createAgentContextAuthorizer } from '../../workers/workflow/src/agent-context-authorizer';
import { signedReportFor, TEST_TRUST } from '../helpers/ai/evaluation';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedActiveProfile,
  seedOrganizationBudget,
  seedRateCard,
  testAgentSpec,
} from '../helpers/ai/fixtures';
import {
  startClientOnboarding,
  getClientOnboarding,
} from '@ensemus/application/knowledge/onboarding';
import {
  decideArtifact,
  getArtifactVerification,
} from '@ensemus/application/knowledge/verification';
import type { AgentRuns } from '@ensemus/application/knowledge/ports';
import {
  approvals,
  clientOnboardings,
  clients,
  connections,
  externalActions,
  openAppDatabase,
  projects,
  resolveTenantContext,
  withTenantTx,
  workArtifacts,
  workDependencies,
  workUnits,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { EMAIL_CONNECTOR_TYPE } from '@ensemus/domain/external-action';
import { eq, sql } from 'drizzle-orm';
import { seedMember, seedSearchableSource } from '../helpers/knowledge';
import { nativeMfaOwner } from '../helpers/knowledge-native';
import { urls } from '../helpers/stack';
import { createClientOnboardingActivities } from '@ensemus/workflows/client-onboarding-activities';
import { LifecycleMemoryStore } from './saas-lifecycle-fixture';

describe('deal won to one verified onboarding', () => {
  let database: ReturnType<typeof openAppDatabase>, auth: pg.Client;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let worker: ReturnType<typeof openAppDatabase>;
  let owner: TenantContext,
    reviewer: TenantContext,
    reader: TenantContext,
    foreign: TenantContext,
    connectionId: string,
    foreignConnectionId: string,
    profileId: string,
    briefSource: Awaited<ReturnType<typeof seedSearchableSource>>;
  const briefText = 'Generated cited client brief.';
  const service = () => createServiceContext(owner.organizationId);
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    worker = openAppDatabase(urls.worker());
    agent = openAgentTestDatabase();
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    // This owner activates a model profile and publishes the onboarding agent below. 0404 requires
    // a fresh native second factor of any real person for both, so it is an actual native session
    // with a proven factor, not a bare resolved context. The foreign owner publishes nothing, but it
    // makes an email connection of its own, the other tenant's row a start must not reach, and 0404
    // (integrations.guard_connection_management) requires the same proven factor for that.
    owner = await nativeMfaOwner(database.db, 'generated-onboarding-person', 'sovereign');
    foreign = await nativeMfaOwner(database.db, 'generated-onboarding-foreign', 'sovereign');
    const admin = await seedMember(database.db, owner, auth, 'member');
    reviewer = await resolveTenantContext(database.db, admin.userId, owner.organizationId);
    // A plain member: the role that may not start an onboarding (packages/domain/src/policy.ts).
    const member = await seedMember(database.db, owner, auth, 'member');
    reader = await resolveTenantContext(database.db, member.userId, owner.organizationId);
    const emailConnection = async (tenant: TenantContext) => {
      const id = randomUUID();
      await withTenantTx(database.db, tenant, (tx) =>
        tx.insert(connections).values({
          organizationId: tenant.organizationId,
          id,
          connectorType: EMAIL_CONNECTOR_TYPE,
          displayName: 'Generated email connection',
          config: { fromAddress: 'sender@example.invalid' },
        }),
      );
      return id;
    };
    connectionId = await emailConnection(owner);
    foreignConnectionId = await emailConnection(foreign);
    // The brief's turn is authorized by the runtime's own egress decision below, which routes through
    // the main router: an active profile with no rate card is refused there (RATE_CARD_MISSING).
    profileId = await seedActiveProfile(database.db, agent.db, owner);
    await seedRateCard(database.db, owner, profileId);
    await seedOrganizationBudget(database.db, owner, 1_000_000);
    // The brief's run retrieves from this source, so the published manifest declares it, as a real
    // agent's must: an agent turn retrieves only from declared sources (compileEvidence refuses an
    // undeclared scope with EGRESS_DENIED, and read admission refuses an undeclared package source).
    briefSource = await seedSearchableSource(database.db, owner, {
      passages: [briefText],
      grants: [{ kind: 'organization' }],
    });
    const spec = agentSpecV1Schema.parse(
      testAgentSpec({
        id: 'client-brief',
        output: {
          schema_ref: CLIENT_BRIEF_SCHEMA_REF,
          verification: ['source_citation_check', 'human_artifact_acceptance'],
        },
        context: {
          allowed_scopes: ['work.read', `knowledge.${briefSource.sourceId}.read`],
          memory_write_policy: 'none',
        },
      }),
    );
    await publishAgentVersion(database.db, owner, {
      spec,
      policyVersion: 'default',
      evaluationReport: signedReportFor(spec, 'default'),
      evaluationTrust: TEST_TRUST,
    });
  });
  afterAll(async () => {
    await auth?.end();
    await database?.close();
    await worker?.close();
    await agent?.close();
  });
  const input = () => ({
    dealRef: `generated-deal-${randomUUID()}`,
    clientName: 'Generated client',
    projectName: 'Generated project',
    ownerMembershipId: owner.membershipId,
    reviewerMembershipId: reviewer.membershipId,
    emailConnectionId: connectionId,
    contactEmail: 'client@example.invalid',
  });
  const row = async (id: string) =>
    (
      await withTenantTx(worker.db, service(), (tx) =>
        tx.select().from(clientOnboardings).where(eq(clientOnboardings.id, id)),
      )
    )[0]!;
  function runs() {
    let requested = 0;
    const actual = createOnboardingAgentRuns();
    let state: Awaited<ReturnType<AgentRuns['statusOf']>> = null;
    const port: AgentRuns = {
      requestRun: async (tx, context, request) => {
        requested++;
        expect(context.membershipId).toBe(owner.membershipId);
        expect(request.requestKey).toBeDefined();
        const requestedRun = await actual.requestRun(tx, context, request);
        state = {
          status: 'running',
          costMicros: null,
          workUnitId: request.workUnitId,
          initiatorMembershipId: context.membershipId,
          artifactIds: [],
          artifactState: 'none',
        };
        return requestedRun;
      },
      statusOf: async () => state,
    };
    return {
      port,
      get requested() {
        return requested;
      },
      get state() {
        return state;
      },
      set state(next) {
        state = next;
      },
    };
  }
  const noBriefStore = new LifecycleMemoryStore();
  const advance = (id: string, port: AgentRuns, store: ObjectStore = noBriefStore) =>
    createClientOnboardingActivities({
      database: worker.db,
      agentRuns: port,
      store,
    }).advanceOnboarding({ organizationId: owner.organizationId, onboardingId: id });

  /**
   * Everything a start writes in one tenant, all in its one transaction: the onboarding, its client and
   * project, and its four Work units. The service context reads every row of the tenant in each of them
   * (0209/0211: a service actor passes client and project visibility).
   */
  const footprint = (tenant: TenantContext) =>
    withTenantTx(worker.db, createServiceContext(tenant.organizationId), async (tx) => ({
      onboardings: (await tx.select({ id: clientOnboardings.id }).from(clientOnboardings)).length,
      clients: (await tx.select({ id: clients.id }).from(clients)).length,
      projects: (await tx.select({ id: projects.id }).from(projects)).length,
      work: (await tx.select({ id: workUnits.id }).from(workUnits)).length,
    }));

  it('refuses unauthorized, foreign, self-review, missing-connection and unsafe address requests atomically', async () => {
    const before = { here: await footprint(owner), there: await footprint(foreign) };
    // A plain member may not start one, even naming someone else to review it. Over HTTP this is the
    // connectors job's (tests/stack/slice-2.test.ts); the main gate refuses every start first.
    await expect(startClientOnboarding(database.db, reader, input())).rejects.toEqual(
      new AppError('FORBIDDEN'),
    );
    await expect(startClientOnboarding(database.db, service(), input())).rejects.toEqual(
      new AppError('FORBIDDEN'),
    );
    await expect(
      startClientOnboarding(database.db, owner, {
        ...input(),
        reviewerMembershipId: owner.membershipId,
      }),
    ).rejects.toEqual(new AppError('APPROVAL_SELF_APPROVAL'));
    await expect(
      startClientOnboarding(database.db, owner, {
        ...input(),
        ownerMembershipId: reader.membershipId,
        reviewerMembershipId: owner.membershipId,
      }),
    ).rejects.toEqual(new AppError('APPROVAL_SELF_APPROVAL'));
    await expect(
      startClientOnboarding(database.db, owner, {
        ...input(),
        reviewerMembershipId: foreign.membershipId,
      }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    // An email connection that does not exist, and one that does but is another tenant's, are both
    // missing to this tenant: its policies never show it the other row.
    await expect(
      startClientOnboarding(database.db, owner, { ...input(), emailConnectionId: randomUUID() }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    await expect(
      startClientOnboarding(database.db, owner, {
        ...input(),
        emailConnectionId: foreignConnectionId,
      }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    // That row is real and its own tenant's, so the refusal above is tenancy, not a missing ID.
    expect(
      await withTenantTx(database.db, foreign, (tx) =>
        tx
          .select({ id: connections.id })
          .from(connections)
          .where(eq(connections.id, foreignConnectionId)),
      ),
    ).toEqual([{ id: foreignConnectionId }]);
    await expect(
      startClientOnboarding(database.db, owner, {
        ...input(),
        contactEmail: 'client@example.invalid\r\nBcc:other@example.invalid',
      }),
    ).rejects.toEqual(new AppError('INVALID_INPUT'));
    // No refusal kept anything, in this tenant or the other one.
    expect({ here: await footprint(owner), there: await footprint(foreign) }).toEqual(before);
  });
  it('creates one atomic hierarchy and one run; a repeated deal or lost Activity response creates nothing extra', async () => {
    const request = input(),
      created = await startClientOnboarding(database.db, owner, request);
    await expect(startClientOnboarding(database.db, owner, request)).rejects.toEqual(
      new AppError('CLIENT_ONBOARDING_EXISTS'),
    );
    const stored = await row(created.onboardingId);
    expect(
      new Set([
        stored.workUnitId,
        stored.briefWorkUnitId,
        stored.reviewWorkUnitId,
        stored.sendWorkUnitId,
      ]).size,
    ).toBe(4);
    const children = await withTenantTx(worker.db, service(), (tx) =>
      tx.select().from(workUnits).where(eq(workUnits.parentId, stored.workUnitId)),
    );
    expect(children).toHaveLength(3);
    const dependencies = await withTenantTx(worker.db, service(), (tx) =>
      tx.select().from(workDependencies),
    );
    expect(
      dependencies.filter((edge) =>
        [stored.reviewWorkUnitId, stored.sendWorkUnitId].includes(edge.dependentId),
      ),
    ).toHaveLength(2);
    const gateway = runs();
    expect(await advance(created.onboardingId, gateway.port)).toMatchObject({
      state: 'waiting_for_brief',
      waitFor: 'agent_run',
    });
    await advance(created.onboardingId, gateway.port);
    expect(gateway.requested).toBe(1);
    expect((await row(created.onboardingId)).agentRunId).not.toBeNull();
    await expect(getClientOnboarding(database.db, foreign, created.onboardingId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    expect(
      (await getClientOnboarding(database.db, owner, created.onboardingId)).costMicros,
    ).toBeNull();
  });
  it('does not trust another work/initiator, a missing identity, or fabricated cost from the run port', async () => {
    type State = NonNullable<Awaited<ReturnType<AgentRuns['statusOf']>>>;
    const changes: ((state: State) => State)[] = [
      (state) => ({ ...state, workUnitId: randomUUID() }),
      (state) => ({ ...state, initiatorMembershipId: foreign.membershipId }),
      (state) => {
        const { workUnitId: _missing, ...rest } = state;
        return rest;
      },
      (state) => ({ ...state, costMicros: -1 }),
    ];
    for (const change of changes) {
      const created = await startClientOnboarding(database.db, owner, input()),
        gateway = runs();
      await advance(created.onboardingId, gateway.port);
      gateway.state = change({ ...gateway.state!, status: 'completed' });
      expect(await advance(created.onboardingId, gateway.port)).toMatchObject({
        state: 'failed',
        waitFor: 'nothing',
      });
      expect(
        (await getClientOnboarding(database.db, owner, created.onboardingId)).costMicros,
      ).toBeNull();
    }
  });
  it('hands a real cited run to its human reviewer before creating an email approval', async () => {
    const created = await startClientOnboarding(database.db, owner, input());
    const port = createOnboardingAgentRuns();
    const store = new LifecycleMemoryStore();
    await advance(created.onboardingId, port, store);
    const stored = await row(created.onboardingId);
    const runId = stored.agentRunId!,
      workUnitId = stored.briefWorkUnitId!;
    const claim = await claimQueuedRun(agent.db, {
      organizationId: owner.organizationId,
      workUnitId,
      temporalRunId: randomUUID(),
    });
    if (!claim || claim.agentRunId !== runId) throw new Error('TEST_ONBOARDING_RUN_NOT_CLAIMED');
    const writer = await prepareRunInputContext(agent.db, owner.organizationId, runId);
    await setRunStatus(agent.db, writer, { agentRunId: runId, status: 'running' });

    const turns = createTurnStore(agent.db);
    const begin = async (stepNumber: number) => {
      const turn = await turns.beginTurn(writer, { runId, stepNumber });
      if (turn.kind !== 'begin') throw new Error('TEST_ONBOARDING_TURN_NOT_STARTED');
      return { stepId: turn.stepId, attempt: turn.attempt, stepNumber };
    };
    const draftTurn = await begin(claim.nextStepNumber);
    const text = briefText,
      source = briefSource;
    const turn = { runId, workUnitId, agentVersionId: claim.agentVersionId, modelStep: draftTurn };
    const base = await createMinimalContextCompiler({
      source: createContextSource({
        database: agent.db,
        readObject: async () => {
          throw new Error('TEST_UNEXPECTED_OBJECT_READ');
        },
      }),
      limits: { maxInputChars: 100_000, maxArtifactBytes: 10_000 },
    }).compile(writer, turn);
    expect(base.messages.find(({ role }) => role === 'policy')?.text).toContain(
      'artifact_id (the exact tool result ID)',
    );
    const authorize = createAgentContextAuthorizer({
      database: agent.db,
      router: createModelRouter({
        profiles: createProfileStore(agent.db),
        egress: createEgressLog(agent.db),
        bundle: (context) => loadTenantPolicyBundle(agent.db, context),
      }),
    });
    const decisionsBefore = await listEgressDecisions(database.db, owner, {
      runId: stored.agentRunId!,
    });
    const compiled = await compileEvidence(
      agent.db,
      writer,
      {
        model: createScriptedModelPort({}),
        authorizeAgentContext: (context, request) =>
          authorize(context, turn, { ...request, task: base.task }),
      },
      {
        purpose: 'agent_turn',
        question: text,
        queryClassification: 'internal',
        workUnitId: stored.briefWorkUnitId!,
        runId: stored.agentRunId!,
        sourceIds: [source.sourceId],
        budgetTokens: 1000,
        // The scripted model test is bounded by Vitest; it does not exercise cancellation.
        signal: new AbortController().signal,
      },
    );
    expect(compiled, compiled.ok ? undefined : compiled.code).toMatchObject({
      ok: true,
      items: [{ sourceId: source.sourceId }],
    });
    // The decision that let it through is recorded: one allow, for this run's own profile and class.
    const decisions = await listEgressDecisions(database.db, owner, {
      runId: stored.agentRunId!,
    });
    expect(decisions.slice(decisionsBefore.length)).toEqual([
      expect.objectContaining({
        runId: stored.agentRunId!,
        profileId,
        dataClass: 'internal',
        purpose: 'reason',
        decision: 'allow',
        reasonCode: 'ALLOWED',
      }),
    ]);
    if (!compiled.ok || !compiled.items[0]) throw new Error('TEST_EVIDENCE_MISSING');
    const passage = compiled.items[0];
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    // The provider is scripted. Prepare, dispatch and response receipts still use their native
    // admission path, with the resulting tool proposal and authored draft committed by the gateway.
    async function receive(
      step: Awaited<ReturnType<typeof begin>>,
      result: { kind: 'tool_call' | 'final'; toolId: string | null; payload: string },
      presentedKnowledge?: NonNullable<MainModelAdmission['snapshot']>['presentedKnowledge'],
    ) {
      const snapshot = {
        id: randomUUID(),
        writerToken: randomUUID(),
        requestHash: hash(randomUUID()),
      };
      for (const phase of ['prepare', 'dispatch'] as const)
        expect(
          await withTenantTx(agent.db, writer, (tx) =>
            admitMainModelDispatchInTx(tx, writer, {
              runId,
              workUnitId,
              agentVersionId: claim!.agentVersionId,
              stepId: step.stepId,
              attempt: step.attempt,
              reservationAttempt: step.attempt,
              purpose: 'reason',
              classification: 'internal',
              profileId,
              profileVersion: 1,
              ceiling: { inputTokens: 30, outputTokens: 5 },
              costMicros: 1,
              priorUsage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
              snapshot: {
                ...snapshot,
                phase,
                ...(presentedKnowledge ? { presentedKnowledge } : {}),
              },
            }),
          ),
        ).toBeNull();
      await withTenantTx(agent.db, writer, (tx) =>
        receiveMainInputSnapshotInTx(tx, writer, {
          snapshotId: snapshot.id,
          writerToken: snapshot.writerToken,
          kind: result.kind,
          toolId: result.toolId,
          payloadHash: hash(result.payload),
        }),
      );
      return snapshot.id;
    }
    const toolId = 'artifact.draft.create';
    const args = {
      name: 'Generated brief.txt',
      text: `${text}[${passage.citationKey}]`,
      evidence: [],
    };
    const inputSnapshotId = await receive(
      draftTurn,
      { kind: 'tool_call', toolId, payload: JSON.stringify(args) },
      { packageId: compiled.packageId, ordinals: [Number(passage.citationKey.slice(1))] },
    );
    await storeProposal(agent.db, writer, {
      runId,
      stepNumber: draftTurn.stepNumber,
      toolId,
      args,
      originatingModel: { stepId: draftTurn.stepId, attempt: draftTurn.attempt, inputSnapshotId },
    });
    await completeTurn(agent.db, writer, {
      agentRunId: runId,
      stepId: draftTurn.stepId,
      attempt: draftTurn.attempt,
      outcome: 'tool_proposed',
      code: null,
      delta: {},
    });
    const halt = createHaltCheck();
    const toolStore = createToolStepStore({ database: agent.db, objects: store });
    const gateway = createToolGateway({
      source: createContextSource({ database: agent.db, readObject: (key) => store.get(key) }),
      store: toolStore,
      halt,
      externalActions: externalActionPort,
      approvals: createApprovalBinder({ externalActions: externalActionPort, halt }),
    });
    const toolStep = draftTurn.stepNumber + 1;
    expect(
      await gateway.handle(writer, {
        runId,
        workUnitId,
        agentVersionId: claim.agentVersionId,
        stepNumber: toolStep,
      }),
    ).toMatchObject({ outcome: 'done' });
    const artifactId = toolStore.draftIdFor(writer, { runId, stepNumber: toolStep });
    const final = await begin(toolStep + 1);
    const content = JSON.stringify({ artifact_id: artifactId, summary: text, open_questions: [] });
    await receive(final, { kind: 'final', toolId: null, payload: content });
    await storeStepPayload(agent.db, writer, {
      stepId: final.stepId,
      kind: 'completion',
      attempt: final.attempt,
      classification: 'internal',
      content,
    });
    await completeTurn(agent.db, writer, {
      agentRunId: runId,
      stepId: final.stepId,
      attempt: final.attempt,
      outcome: 'final_output',
      code: null,
      delta: {},
    });
    await setRunStatus(agent.db, writer, { agentRunId: runId, status: 'verifying' });
    expect(await verifyOutput(agent.db, writer, { agentRunId: runId })).toBe('completed');
    expect(await verifyOutput(agent.db, writer, { agentRunId: runId })).toBe('completed');
    await finishRun(agent.db, writer, { agentRunId: runId, status: 'completed', stopCode: null });
    expect(await advance(created.onboardingId, port, store)).toMatchObject({
      state: 'waiting_for_acceptance',
      waitFor: 'person',
    });
    expect((await row(created.onboardingId)).emailExternalActionId).toBeNull();
    expect(
      (await getWorkDetail(database.db, owner, stored.briefWorkUnitId!)).evidence.artifactCount,
    ).toBe(0);
    const reviewInput = { workUnitId, artifactId };
    const proof = await getArtifactVerification(database.db, reviewer, reviewInput);
    expect(proof.citations).toMatchObject([{ chunkId: passage.chunkId, available: true }]);
    expect(proof.grounding?.verdict).toBe('passed');
    expect(proof.human).toBeNull();
    await decideArtifact(
      database.db,
      reviewer,
      {
        ...reviewInput,
        artifactSha256: proof.artifactSha256,
        objectiveSha256: proof.objectiveSha256,
        citationsSha256: proof.citationsSha256,
        verdict: 'accepted',
      },
      { store },
    );
    expect(await advance(created.onboardingId, port, store)).toMatchObject({
      state: 'waiting_for_send',
      waitFor: 'external_action',
    });
    await advance(created.onboardingId, port);
    const updated = await row(created.onboardingId);
    for (const workId of [stored.workUnitId, stored.briefWorkUnitId!, stored.reviewWorkUnitId!])
      expect((await getWorkDetail(database.db, owner, workId)).evidence.artifactCount).toBe(1);
    const overview = await listWorkOverview(database.db, owner, { projectId: stored.projectId! });
    expect(
      overview.items
        .filter((work) => work.id !== stored.sendWorkUnitId)
        .map((work) => work.evidence.artifactCount),
    ).toEqual([1, 1, 1]);
    expect(updated.acceptedVerificationId).not.toBeNull();
    expect(updated.emailExternalActionId).not.toBeNull();
    const [action] = await withTenantTx(worker.db, service(), (tx) =>
      tx
        .select()
        .from(externalActions)
        .where(eq(externalActions.id, updated.emailExternalActionId!)),
    );
    const [approval] = await withTenantTx(worker.db, service(), (tx) =>
      tx.select().from(approvals).where(eq(approvals.id, updated.emailApprovalId!)),
    );
    expect(action?.payload).toMatchObject({ to: ['client@example.invalid'] });
    expect(action?.requestHash).toBe(approval?.actionHash);
    expect(approval?.approverMembershipId).toBe(reviewer.membershipId);
    expect(approval?.requestedByMembershipId).toBe(owner.membershipId);
    expect(
      (await getClientOnboarding(database.db, owner, created.onboardingId)).costMicros,
    ).toBeNull();
    const sentRows = await withTenantTx(worker.db, service(), (tx) =>
      tx.execute<{ count: string }>(
        sql`select count(*)::text as count from integrations.external_actions where organization_id=${owner.organizationId}::uuid and work_unit_id=${stored.sendWorkUnitId}::uuid`,
      ),
    );
    expect(sentRows.rows[0]?.count).toBe('1');
    expect(
      await withTenantTx(database.db, owner, (tx) =>
        tx
          .select()
          .from(workArtifacts)
          .where(eq(workArtifacts.workUnitId, stored.reviewWorkUnitId!)),
      ),
    ).toHaveLength(1);
    expect(
      await withTenantTx(worker.db, service(), (tx) =>
        tx
          .select()
          .from(workArtifacts)
          .where(eq(workArtifacts.workUnitId, stored.reviewWorkUnitId!)),
      ),
    ).toHaveLength(0);
    const bridge = () =>
      withTenantTx(worker.db, service(), (tx) =>
        tx.execute<{ parent: boolean; review: boolean }>(
          sql`select knowledge.onboarding_artifact_evidence(${artifactId}::uuid,${stored.workUnitId}::uuid) as parent,knowledge.onboarding_artifact_evidence(${artifactId}::uuid,${stored.reviewWorkUnitId}::uuid) as review`,
        ),
      );
    expect((await bridge()).rows[0]).toEqual({ parent: true, review: true });
    expect(stored.parentObjectiveSha256).not.toBe(stored.reviewObjectiveSha256);
    expect(stored.briefObjectiveSha256).not.toBe(stored.reviewObjectiveSha256);
    await withTenantTx(worker.db, service(), (tx) =>
      tx.execute(
        sql`update work.work_units set objective='A changed review goal',version=version+1 where organization_id=${owner.organizationId}::uuid and id=${stored.reviewWorkUnitId}::uuid`,
      ),
    );
    expect((await bridge()).rows[0]).toEqual({ parent: true, review: false });
    expect(
      (await getWorkDetail(database.db, owner, stored.reviewWorkUnitId!)).evidence.artifactCount,
    ).toBe(0);
    expect(await advance(created.onboardingId, port)).toMatchObject({
      state: 'failed',
      waitFor: 'nothing',
    });
  });
});
