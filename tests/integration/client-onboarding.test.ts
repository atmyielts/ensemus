// Real tenant transactions and M4 run binding; explicit status overrides isolate state-machine faults.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, getWorkDetail, listWorkOverview } from '@ensemus/application';
import { agentSpecSha256, publishAgentVersion } from '@ensemus/application/ai-agents';
import { createOnboardingAgentRuns } from '@ensemus/application/knowledge/onboarding-run-port';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { addGeneratedArtifact } from '@ensemus/application/knowledge/artifact-provenance';
import { createRunInputInventory } from '@ensemus/application/ai-input-ledger';
import { agentSpecV1Schema } from '@ensemus/contracts/ai';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedActiveProfile,
  seedOrganizationBudget,
  testAgentSpec,
} from '../helpers/ai/fixtures';
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
  connections,
  createOrganization,
  externalActions,
  openAppDatabase,
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
import { urls } from '../helpers/stack';

describe('deal won to one verified onboarding', () => {
  let database: ReturnType<typeof openAppDatabase>, auth: pg.Client;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let owner: TenantContext,
    reviewer: TenantContext,
    reader: TenantContext,
    foreign: TenantContext,
    connectionId: string;
  const service = () => createServiceContext(owner.organizationId);
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    agent = openAgentTestDatabase();
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const makeOwner = async () => {
      const userId = randomUUID();
      await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
        userId,
        'Generated onboarding person',
        `${userId}@example.invalid`,
      ]);
      const org = await createOrganization(database.db, {
        userId,
        name: 'Generated onboarding company',
        commercialMode: 'sovereign',
      });
      return resolveTenantContext(database.db, userId, org.organizationId);
    };
    owner = await makeOwner();
    foreign = await makeOwner();
    const admin = await seedMember(database.db, owner, auth, 'member');
    reviewer = await resolveTenantContext(database.db, admin.userId, owner.organizationId);
    const member = await seedMember(database.db, owner, auth);
    reader = await resolveTenantContext(database.db, member.userId, owner.organizationId);
    connectionId = randomUUID();
    await withTenantTx(database.db, owner, (tx) =>
      tx.insert(connections).values({
        organizationId: owner.organizationId,
        id: connectionId,
        connectorType: EMAIL_CONNECTOR_TYPE,
        displayName: 'Generated email connection',
        config: { fromAddress: 'sender@example.invalid' },
      }),
    );
    await seedActiveProfile(database.db, agent.db, owner);
    await seedOrganizationBudget(database.db, owner, 1_000_000);
    const spec = agentSpecV1Schema.parse(testAgentSpec({ id: 'client-brief' }));
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

  it('refuses unauthorized, foreign, self-review and unsafe address requests atomically', async () => {
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
    await expect(
      startClientOnboarding(database.db, owner, {
        ...input(),
        contactEmail: 'client@example.invalid\r\nBcc:other@example.invalid',
      }),
    ).rejects.toEqual(new AppError('INVALID_INPUT'));
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
    const text = 'Generated cited client brief.';
    const writer = await prepareRunInputContext(agent.db, owner.organizationId, stored.agentRunId!);
    const source = await seedSearchableSource(database.db, owner, {
      passages: [text],
      grants: [{ kind: 'organization' }],
    });
    // Exercise actual retrieval/capture before generation; a later citation cannot invent an input.
    // This scripted model port is confined to the synthetic state-machine test.
    const compiled = await compileEvidence(
      agent.db,
      writer,
      { model: createScriptedModelPort({}) },
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
    const artifact = await addGeneratedArtifact(
      agent.db,
      store,
      writer,
      {
        workUnitId: stored.briefWorkUnitId!,
        name: 'Generated brief.txt',
        mimeType: 'text/plain',
        body: Buffer.from(text),
        execution: { kind: 'agent_run', id: stored.agentRunId! },
        requestKey: randomUUID(),
      },
      { inventory: createRunInputInventory() },
    );
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
