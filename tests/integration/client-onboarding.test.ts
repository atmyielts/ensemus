// Real tenant transactions and M4 run binding; explicit status overrides isolate state-machine faults.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMinimalContextCompiler } from '@ensemus/agent-runtime/context';
import { AppError, getWorkDetail, listWorkOverview } from '@ensemus/application';
import { agentSpecSha256, publishAgentVersion } from '@ensemus/application/ai-agents';
import { createContextSource } from '@ensemus/application/ai-context-source';
import {
  createEgressLog,
  listEgressDecisions,
  loadTenantPolicyBundle,
} from '@ensemus/application/ai-egress-log';
import { createProfileStore } from '@ensemus/application/ai-model-profiles';
import { readRunFacts } from '@ensemus/application/ai-runs';
import { createOnboardingAgentRuns } from '@ensemus/application/knowledge/onboarding-run-port';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { agentSpecV1Schema } from '@ensemus/contracts/ai';
import { createModelRouter } from '@ensemus/intelligence';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import { createAgentContextAuthorizer } from '../../workers/workflow/src/agent-context-authorizer';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedActiveProfile,
  seedOrganizationBudget,
  seedRateCard,
  testAgentSpec,
} from '../helpers/ai/fixtures';
import { draftRunOutput, startRunning } from '../helpers/ai/run-output';
import {
  startClientOnboarding,
  getClientOnboarding,
  advanceClientOnboarding,
} from '@ensemus/application/knowledge/onboarding';
import {
  recordArtifactCitations,
  checkArtifactGrounding,
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

describe('deal won to one verified onboarding', () => {
  let database: ReturnType<typeof openAppDatabase>, auth: pg.Client;
  let agent: ReturnType<typeof openAgentTestDatabase>;
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
        context: {
          allowed_scopes: ['work.read', `knowledge.${briefSource.sourceId}.read`],
          memory_write_policy: 'none',
        },
      }),
    );
    await publishAgentVersion(database.db, owner, {
      spec,
      policyVersion: 'default',
      evaluationReport: {
        report_version: 1,
        spec_sha256: agentSpecSha256(spec),
        policy_version: 'default',
        suite_ref: spec.evaluation.suite_ref,
        dataset_version: 'synthetic-onboarding-1',
        model_label: 'scripted',
        pass_rate: 1,
        cases: 3,
        passed: true,
        scripted_model: true,
      },
    });
  });
  afterAll(async () => {
    await auth?.end();
    await database?.close();
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
      await withTenantTx(database.db, service(), (tx) =>
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
  const advance = (id: string, port: AgentRuns) =>
    advanceClientOnboarding(database.db, service(), { agentRuns: port }, { onboardingId: id });

  /**
   * Everything a start writes in one tenant, all in its one transaction: the onboarding, its client and
   * project, and its four Work units. The service context reads every row of the tenant in each of them
   * (0209/0211: a service actor passes client and project visibility).
   */
  const footprint = (tenant: TenantContext) =>
    withTenantTx(database.db, createServiceContext(tenant.organizationId), async (tx) => ({
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
    const children = await withTenantTx(database.db, service(), (tx) =>
      tx.select().from(workUnits).where(eq(workUnits.parentId, stored.workUnitId)),
    );
    expect(children).toHaveLength(3);
    const dependencies = await withTenantTx(database.db, service(), (tx) =>
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
  it('requires exact human acceptance before creating one frozen-recipient email intent', async () => {
    const created = await startClientOnboarding(database.db, owner, input()),
      gateway = runs();
    await advance(created.onboardingId, gateway.port);
    const stored = await row(created.onboardingId);
    const objects = new Map<string, Buffer>(),
      store = {
        put: async (key: string, body: Buffer) => {
          objects.set(key, Buffer.from(body));
        },
        get: async (key: string) => objects.get(key)!,
        delete: async (key: string) => {
          objects.delete(key);
        },
        exists: async (key: string) => objects.has(key),
      };
    const text = briefText,
      source = briefSource;
    const writer = await prepareRunInputContext(agent.db, owner.organizationId, stored.agentRunId!);
    // The run works as a running run does: the tool gateway admits its draft effects only then.
    await startRunning(agent.db, writer);
    // Exercise actual retrieval/capture before generation; a later citation cannot invent an input.
    // The scripted Knowledge port stands in for the Knowledge model gateway only. The evidence this
    // agent turn selects is authorized by the runtime's own egress decision, wired exactly as
    // workers/workflow/src/agent-composition.ts wires it: the production authorizer over the main
    // router, the tenant's profiles and its policy bundle, given the task the minimal context
    // compiler builds for this run and bound to the run as knowledge-context.ts binds it.
    const facts = await readRunFacts(agent.db, writer, { agentRunId: stored.agentRunId! });
    const turn = {
      runId: stored.agentRunId!,
      workUnitId: stored.briefWorkUnitId!,
      agentVersionId: facts!.agentVersionId,
      // The authorizer requires a model step in progress and reads no step row; the router's egress
      // rows carry no step either (router/index.ts). A generated ID stands for the turn's step.
      modelStep: { stepId: randomUUID(), stepNumber: 0, attempt: 1 },
    };
    const base = await createMinimalContextCompiler({
      source: createContextSource({
        database: agent.db,
        readObject: async () => {
          throw new Error('TEST_UNEXPECTED_OBJECT_READ');
        },
      }),
      limits: { maxInputChars: 100_000, maxArtifactBytes: 10_000 },
    }).compile(writer, turn);
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
        signal: AbortSignal.timeout(10_000),
      },
    );
    expect(compiled).toMatchObject({ ok: true, items: [{ sourceId: source.sourceId }] });
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
    // The brief is the run's own file, written through the tool gateway's draft path: an
    // authority-v1 run's output inventory exists only behind that run's own admission (0525).
    const artifact = await draftRunOutput(agent.db, store, writer, {
      workUnitId: stored.briefWorkUnitId!,
      stepNumber: 1,
      name: 'Generated brief.txt',
      text,
    });
    await recordArtifactCitations(database.db, owner, {
      workUnitId: stored.briefWorkUnitId!,
      artifactId: artifact.id,
      citations: [{ chunkId: source.chunkIds[0]!, artifactStart: 0, artifactEnd: text.length }],
    });
    gateway.state = {
      ...gateway.state!,
      status: 'completed',
      costMicros: 1234,
      artifactIds: [artifact.id],
      artifactState: 'ready',
    };
    expect(await advance(created.onboardingId, gateway.port)).toMatchObject({
      state: 'waiting_for_acceptance',
      waitFor: 'person',
    });
    expect((await row(created.onboardingId)).emailExternalActionId).toBeNull();
    expect(
      (await getWorkDetail(database.db, owner, stored.briefWorkUnitId!)).evidence.artifactCount,
    ).toBe(0);
    const reviewInput = { workUnitId: stored.briefWorkUnitId!, artifactId: artifact.id };
    await checkArtifactGrounding(database.db, store, service(), reviewInput);
    const proof = await getArtifactVerification(database.db, reviewer, reviewInput);
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
    expect(await advance(created.onboardingId, gateway.port)).toMatchObject({
      state: 'waiting_for_send',
      waitFor: 'external_action',
    });
    await advance(created.onboardingId, gateway.port);
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
    const [action] = await withTenantTx(database.db, service(), (tx) =>
      tx
        .select()
        .from(externalActions)
        .where(eq(externalActions.id, updated.emailExternalActionId!)),
    );
    const [approval] = await withTenantTx(database.db, service(), (tx) =>
      tx.select().from(approvals).where(eq(approvals.id, updated.emailApprovalId!)),
    );
    expect(action?.payload).toMatchObject({ to: ['client@example.invalid'] });
    expect(action?.requestHash).toBe(approval?.actionHash);
    expect(approval?.approverMembershipId).toBe(reviewer.membershipId);
    expect(approval?.requestedByMembershipId).toBe(owner.membershipId);
    expect((await getClientOnboarding(database.db, owner, created.onboardingId)).costMicros).toBe(
      1234,
    );
    const sentRows = await withTenantTx(database.db, service(), (tx) =>
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
      await withTenantTx(database.db, service(), (tx) =>
        tx
          .select()
          .from(workArtifacts)
          .where(eq(workArtifacts.workUnitId, stored.reviewWorkUnitId!)),
      ),
    ).toHaveLength(0);
    const bridge = () =>
      withTenantTx(database.db, service(), (tx) =>
        tx.execute<{ parent: boolean; review: boolean }>(
          sql`select knowledge.onboarding_artifact_evidence(${artifact.id}::uuid,${stored.workUnitId}::uuid) as parent,knowledge.onboarding_artifact_evidence(${artifact.id}::uuid,${stored.reviewWorkUnitId}::uuid) as review`,
        ),
      );
    expect((await bridge()).rows[0]).toEqual({ parent: true, review: true });
    expect(stored.parentObjectiveSha256).not.toBe(stored.reviewObjectiveSha256);
    expect(stored.briefObjectiveSha256).not.toBe(stored.reviewObjectiveSha256);
    await withTenantTx(database.db, service(), (tx) =>
      tx.execute(
        sql`update work.work_units set objective='A changed review goal',version=version+1 where organization_id=${owner.organizationId}::uuid and id=${stored.reviewWorkUnitId}::uuid`,
      ),
    );
    expect((await bridge()).rows[0]).toEqual({ parent: true, review: false });
    expect(
      (await getWorkDetail(database.db, owner, stored.reviewWorkUnitId!)).evidence.artifactCount,
    ).toBe(0);
    expect(await advance(created.onboardingId, gateway.port)).toMatchObject({
      state: 'failed',
      waitFor: 'nothing',
    });
  });
});
