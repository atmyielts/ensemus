// Actual tenant/agent roles and the real M4 run/outbox kernel. No provider or model quality claim.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { createMinimalContextCompiler, type RunRef } from '@ensemus/agent-runtime/context';
import {
  AppError,
  addArtifact,
  updateWorkUnit,
  unassign,
  type ObjectStore,
} from '@ensemus/application';
import { agentSpecSha256, publishAgentVersion } from '@ensemus/application/ai-agents';
import { createContextSource } from '@ensemus/application/ai-context-source';
import {
  createEgressLog,
  listEgressDecisions,
  loadTenantPolicyBundle,
} from '@ensemus/application/ai-egress-log';
import { createProfileStore } from '@ensemus/application/ai-model-profiles';
import { startAgentRun } from '@ensemus/application/ai-run-control';
import { readRunFacts } from '@ensemus/application/ai-runs';
import { compileEvidence, type CompileDeps } from '@ensemus/application/knowledge/compiler';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import { createOnboardingAgentRuns } from '@ensemus/application/knowledge/onboarding-run-port';
import {
  advanceClientOnboarding,
  startClientOnboarding,
} from '@ensemus/application/knowledge/onboarding';
import { agentSpecV1Schema } from '@ensemus/contracts/ai';
import {
  agentPublications,
  agentRuns,
  clientOnboardings,
  connections,
  domainEvents,
  memberships,
  openAppDatabase,
  outboxEvents,
  policyBundles,
  serviceIdentities,
  tombstones,
  usageLedger,
  withTenantTx,
  workAssignments,
  type AgentContext,
  type TenantContext,
} from '@ensemus/database';
import { createDelegatedContext, createServiceContext } from '@ensemus/database/service';
import { withRunLookupTx } from '@ensemus/database/agent';
import { AGENT_RUN_REQUESTED } from '@ensemus/domain/ai-events';
import { EMAIL_CONNECTOR_TYPE } from '@ensemus/domain/external-action';
import {
  makeTestUser,
  openAgentTestDatabase,
  prepareRunInputContext,
  seedActiveProfile,
  seedAiTenant,
  seedOrganizationBudget,
  seedRateCard,
  sha256Of,
  testAgentSpec,
  thisPeriod,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { draftRunOutput, startRunning } from '../helpers/ai/run-output';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { seedSearchableSource } from '../helpers/knowledge';
import { createModelRouter } from '@ensemus/intelligence';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import { createAgentContextAuthorizer } from '../../workers/workflow/src/agent-context-authorizer';
import { urls } from '../helpers/stack';

const port = createOnboardingAgentRuns();
const refused = (code: string, action: Promise<unknown>) =>
  expect(action).rejects.toSatisfy(
    (error: unknown) => error instanceof AppError && error.code === code,
  );

describe('onboarding uses one authorized actual M4 run', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let su: pg.Client;
  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 4 });
    agent = openAgentTestDatabase();
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
  });
  afterAll(async () => {
    await app?.close();
    await agent?.close();
    await su?.end();
  });

  /**
   * `knowledge` names the Knowledge sources the published brief agent reads. It runs after the
   * tenant exists and before publication, as an owner creates a source and then publishes an agent
   * whose manifest grants it (0414: an agent turn retrieves only from declared sources).
   */
  async function fixture(
    options: {
      publish?: boolean;
      knowledge?: (tenant: AiTenant) => Promise<readonly string[]>;
    } = {},
  ) {
    const tenant = await seedAiTenant(app.db);
    const { owner, member: reviewer } = tenant;
    const service = createServiceContext(tenant.organizationId);
    const connectionId = randomUUID();
    await withTenantTx(app.db, owner, (tx) =>
      tx.insert(connections).values({
        organizationId: tenant.organizationId,
        id: connectionId,
        connectorType: EMAIL_CONNECTOR_TYPE,
        displayName: 'Generated gateway email',
        config: { fromAddress: 'sender@example.invalid' },
      }),
    );
    const created = await startClientOnboarding(app.db, owner, {
      dealRef: `generated-gateway-${randomUUID()}`,
      clientName: 'Generated gateway client',
      projectName: 'Generated gateway project',
      ownerMembershipId: owner.membershipId,
      reviewerMembershipId: reviewer.membershipId,
      emailConnectionId: connectionId,
      contactEmail: 'client@example.invalid',
    });
    const profileId = await seedActiveProfile(app.db, agent.db, owner);
    await seedOrganizationBudget(app.db, owner, 1_000_000);
    const sources = options.knowledge ? await options.knowledge(tenant) : [];
    const spec = agentSpecV1Schema.parse(
      testAgentSpec({
        id: 'client-brief',
        ...(sources.length
          ? {
              context: {
                allowed_scopes: ['work.read', ...sources.map((id) => `knowledge.${id}.read`)],
                memory_write_policy: 'none',
              },
            }
          : {}),
      }),
    );
    const published =
      options.publish === false
        ? null
        : await publishAgentVersion(app.db, owner, {
            spec,
            policyVersion: 'default',
            evaluationReport: {
              report_version: 1,
              spec_sha256: agentSpecSha256(spec),
              policy_version: 'default',
              suite_ref: spec.evaluation.suite_ref,
              dataset_version: 'synthetic-gateway-1',
              model_label: 'scripted',
              pass_rate: 1,
              cases: 3,
              passed: true,
              scripted_model: true,
            },
          });
    const delegated = await createDelegatedContext(
      app.db,
      tenant.organizationId,
      owner.membershipId,
    );
    const row = async () =>
      (
        await withTenantTx(app.db, service, (tx) =>
          tx.select().from(clientOnboardings).where(eq(clientOnboardings.id, created.onboardingId)),
        )
      )[0]!;
    const snapshot = await row();
    if (!snapshot.briefWorkUnitId) throw new Error('TEST_BRIEF_MISSING');
    const request = {
      workUnitId: snapshot.briefWorkUnitId,
      agentKey: 'client-brief',
      requestKey: snapshot.id,
    };
    const requestRun = (context = delegated, input = request) =>
      withTenantTx(app.db, context, (tx) => port.requestRun(tx, context, input));
    const runRows = () =>
      withTenantTx(app.db, service, (tx) =>
        tx.select().from(agentRuns).where(eq(agentRuns.workUnitId, request.workUnitId)),
      );
    return {
      ...tenant,
      service,
      delegated,
      published,
      row,
      request,
      requestRun,
      runRows,
      profileId,
      onboardingId: snapshot.id,
    };
  }

  /**
   * The runtime's egress decision for the evidence an agent turn of this run selects, wired exactly as
   * workers/workflow/src/agent-composition.ts wires it: the production authorizer over the main router,
   * the tenant's profiles and its policy bundle. It is given the task the minimal context compiler builds
   * for this run, and bound to the run as knowledge-context.ts binds it for compileEvidence.
   */
  async function runtimeEgress(
    writer: AgentContext,
    runId: string,
    workUnitId: string,
  ): Promise<NonNullable<CompileDeps['authorizeAgentContext']>> {
    const facts = await readRunFacts(agent.db, writer, { agentRunId: runId });
    if (!facts) throw new Error('TEST_RUN_FACTS_MISSING');
    const turn: RunRef = {
      runId,
      workUnitId,
      agentVersionId: facts.agentVersionId,
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
    return (context, request) => authorize(context, turn, { ...request, task: base.task });
  }

  const rawBind = (f: Awaited<ReturnType<typeof fixture>>, runId: string, context = f.delegated) =>
    withTenantTx(app.db, context, (tx) =>
      tx
        .update(clientOnboardings)
        .set({
          agentRunId: runId,
          state: 'waiting_for_brief',
          version: sql`${clientOnboardings.version}+1`,
        })
        .where(eq(clientOnboardings.id, f.onboardingId)),
    );
  const unboundRun = (f: Awaited<ReturnType<typeof fixture>>) =>
    startAgentRun(app.db, f.owner, {
      work_unit_id: f.request.workUnitId,
      agent_version_id: f.published!.id,
    });
  const deferred = () => {
    let resolve = () => undefined as void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve: () => resolve() };
  };
  const sqlRefused = (code: string, action: Promise<unknown>) =>
    expect(action).rejects.toSatisfy((error: unknown) => {
      let cause = error;
      for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
        if ('code' in cause && cause.code === code) return true;
        cause = 'cause' in cause ? cause.cause : null;
      }
      return false;
    });

  it('SQL independently refuses human, service and foreign-run binding before accepting its exact delegated run', async () => {
    const f = await fixture(),
      run = await unboundRun(f);
    for (const context of [f.owner, f.service] as TenantContext[])
      await sqlRefused('42501', rawBind(f, run.id, context));
    await sqlRefused('EN215', rawBind(f, randomUUID()));
    expect(await f.row()).toMatchObject({ state: 'started', agentRunId: null });
    await rawBind(f, run.id);
    expect(await f.row()).toMatchObject({ state: 'waiting_for_brief', agentRunId: run.id });
  });

  it.each(['reviewer assignment', 'publication set', 'service identity'] as const)(
    'serializes SQL binding against a concurrent change to the %s',
    async (change) => {
      const f = await fixture(),
        run = await unboundRun(f);
      const serviceIdentityId = (await f.runRows())[0]!.serviceIdentityId;
      const entered = deferred(),
        release = deferred();
      const mutation = withTenantTx(app.db, f.owner, async (tx) => {
        if (change === 'reviewer assignment') {
          await tx
            .delete(workAssignments)
            .where(
              and(
                eq(workAssignments.workUnitId, f.request.workUnitId),
                eq(workAssignments.membershipId, f.member.membershipId),
              ),
            );
        } else if (change === 'publication set') {
          await tx.insert(agentPublications).values({
            organizationId: f.organizationId,
            definitionId: f.published!.definition_id,
            versionId: f.published!.id,
            activeFrom: new Date(Date.now() - 1000),
            activeUntil: new Date(Date.now() + 60 * 60 * 1000),
          });
        } else {
          await tx
            .update(serviceIdentities)
            .set({ status: 'disabled' })
            .where(eq(serviceIdentities.id, serviceIdentityId));
        }
        entered.resolve();
        await release.promise;
      });
      try {
        await Promise.race([
          entered.promise,
          mutation.then(() => {
            throw new Error('TEST_MUTATION_NOT_HELD');
          }),
        ]);
        await sqlRefused('55P03', rawBind(f, run.id));
        expect(await f.row()).toMatchObject({ state: 'started', agentRunId: null });
      } finally {
        release.resolve();
        await mutation;
      }
      await sqlRefused('EN215', rawBind(f, run.id));
      expect(await f.row()).toMatchObject({ state: 'started', agentRunId: null });
    },
  );

  it('binds one real run, outbox and waiting state across retries and a lost response', async () => {
    const f = await fixture();
    const [first, ...repeated] = await Promise.all([
      f.requestRun(),
      f.requestRun(),
      f.requestRun(),
    ]);
    expect(repeated).toEqual([first, first]);
    const rows = await f.runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.agentRunId,
      initiatorMembershipId: f.owner.membershipId,
      agentVersionId: f.published!.id,
    });
    expect(await f.row()).toMatchObject({
      state: 'waiting_for_brief',
      agentRunId: first.agentRunId,
    });
    const events = await withTenantTx(app.db, f.owner, (tx) =>
      tx
        .select({ id: domainEvents.id, outboxId: outboxEvents.eventId })
        .from(domainEvents)
        .innerJoin(
          outboxEvents,
          and(
            eq(outboxEvents.organizationId, domainEvents.organizationId),
            eq(outboxEvents.eventId, domainEvents.id),
          ),
        )
        .where(
          and(
            eq(domainEvents.eventType, AGENT_RUN_REQUESTED),
            eq(domainEvents.aggregateId, f.request.workUnitId),
          ),
        ),
    );
    expect(events).toHaveLength(1);
    expect(
      await withTenantTx(app.db, f.delegated, (tx) =>
        port.statusOf(tx, f.delegated, first.agentRunId),
      ),
    ).toMatchObject({
      status: 'queued',
      costMicros: null,
      workUnitId: f.request.workUnitId,
      initiatorMembershipId: f.owner.membershipId,
      artifactIds: [],
    });
    await withRunLookupTx(agent.db, f.organizationId, (tx) =>
      tx
        .update(agentRuns)
        .set({ status: 'cancelled', stopCode: 'TEST_CANCELLED' })
        .where(eq(agentRuns.id, first.agentRunId)),
    );
    expect(await f.requestRun()).toEqual(first);
    expect(await f.runRows()).toHaveLength(1);
  });

  it('rolls the run, event and binding back together if the caller transaction fails', async () => {
    const f = await fixture();
    await expect(
      withTenantTx(app.db, f.delegated, async (tx) => {
        await port.requestRun(tx, f.delegated, f.request);
        throw new Error('TEST_CALLER_ROLLBACK');
      }),
    ).rejects.toThrow('TEST_CALLER_ROLLBACK');
    expect(await f.runRows()).toHaveLength(0);
    expect(await f.row()).toMatchObject({ state: 'started', agentRunId: null });
    await f.requestRun();
    expect(await f.runRows()).toHaveLength(1);
  });

  it.each(['55P03', '40P01', '40001', '08006', 'ECONNREFUSED'])(
    'rolls back and leaves a %s infrastructure failure retryable rather than failing onboarding',
    async (code) => {
      const f = await fixture();
      const error = Object.assign(new Error('Synthetic database boundary failure'), {
        cause: { code },
      });
      await expect(
        advanceClientOnboarding(
          app.db,
          f.service,
          {
            agentRuns: {
              ...port,
              requestRun: async () => {
                throw error;
              },
            },
          },
          { onboardingId: f.onboardingId },
        ),
      ).rejects.toBe(error);
      expect(await f.row()).toMatchObject({ state: 'started', agentRunId: null });
      expect(await f.runRows()).toHaveLength(0);
      expect(
        await advanceClientOnboarding(
          app.db,
          f.service,
          { agentRuns: port },
          { onboardingId: f.onboardingId },
        ),
      ).toMatchObject({ state: 'waiting_for_brief' });
    },
  );

  it('never accepts a successful response from an adapter that did not bind its real run', async () => {
    const f = await fixture();
    expect(
      await advanceClientOnboarding(
        app.db,
        f.service,
        {
          agentRuns: { ...port, requestRun: async () => ({ agentRunId: randomUUID() }) },
        },
        { onboardingId: f.onboardingId },
      ),
    ).toMatchObject({ state: 'failed' });
    expect(await f.row()).toMatchObject({ agentRunId: null, stateCode: 'RUN_BINDING_UNCONFIRMED' });
    expect(await f.runRows()).toHaveLength(0);
  });

  it('does not publish/select an agent when the approved client-brief publication is absent', async () => {
    const f = await fixture({ publish: false });
    await refused('INVALID_STATE', f.requestRun());
    expect(await f.runRows()).toHaveLength(0);
    expect(
      await advanceClientOnboarding(
        app.db,
        f.service,
        { agentRuns: port },
        { onboardingId: f.onboardingId },
      ),
    ).toMatchObject({ state: 'failed' });
    expect(await f.row()).toMatchObject({ stateCode: 'AGENT_UNAVAILABLE', agentRunId: null });
  });

  it('refuses another tenant, another member, another Work and arbitrary run starts', async () => {
    const f = await fixture();
    const foreign = await seedAiTenant(app.db);
    const foreignActor = await createDelegatedContext(
      app.db,
      foreign.organizationId,
      foreign.owner.membershipId,
    );
    await refused('NOT_FOUND', f.requestRun(foreignActor));
    const other = await createDelegatedContext(app.db, f.organizationId, f.member.membershipId);
    await refused('NOT_FOUND', f.requestRun(other));
    await refused(
      'NOT_FOUND',
      f.requestRun(f.delegated, { ...f.request, workUnitId: randomUUID() }),
    );
    await refused(
      'FORBIDDEN',
      startAgentRun(app.db, f.delegated, {
        work_unit_id: f.request.workUnitId,
        agent_version_id: f.published!.id,
      }),
    );
    expect(await f.runRows()).toHaveLength(0);
  });

  it('rereads current member authority rather than trusting a previously created delegated context', async () => {
    const f = await fixture();
    // 0404 keeps at least one active owner (LAST_OWNER), so a second owner is added first, by the
    // current owner, before this owner is demoted; the delegated context was created beforehand.
    const successor = await makeTestUser('gateway-successor-owner');
    await withTenantTx(app.db, f.owner, (tx) =>
      tx
        .insert(memberships)
        .values({ organizationId: f.organizationId, userId: successor, role: 'owner' }),
    );
    await withTenantTx(app.db, f.owner, (tx) =>
      tx
        .update(memberships)
        .set({ role: 'member' })
        .where(eq(memberships.id, f.owner.membershipId)),
    );
    await refused('FORBIDDEN', f.requestRun());
    expect(await f.runRows()).toHaveLength(0);
  });

  it.each(['objective', 'owner', 'assignment', 'hierarchy', 'project'] as const)(
    'refuses a changed %s pin before inserting any run',
    async (change) => {
      const f = await fixture();
      if (change === 'objective')
        await updateWorkUnit(app.db, f.owner, f.request.workUnitId, 1, {
          objective: 'Changed after onboarding creation.',
        });
      if (change === 'owner')
        await withTenantTx(app.db, f.owner, (tx) =>
          tx.execute(sql`update work.work_units set owner_membership_id=${f.owner.membershipId}::uuid
            where id=${f.request.workUnitId}::uuid`),
        );
      if (change === 'assignment')
        await unassign(app.db, f.owner, {
          id: f.request.workUnitId,
          membershipId: f.member.membershipId,
        });
      // The generated superuser write still binds the row's tenant for the export epoch trigger
      // (0303/0522), as every superuser fixture does; it changes nothing else about the write.
      if (change === 'hierarchy')
        await inFixtureTenant(su, f.organizationId, () =>
          su.query('update work.work_units set parent_id=null where organization_id=$1 and id=$2', [
            f.organizationId,
            f.request.workUnitId,
          ]),
        );
      if (change === 'project')
        await withTenantTx(app.db, f.owner, (tx) =>
          tx.execute(
            sql`update work.work_units set project_id=null where id=${f.request.workUnitId}::uuid`,
          ),
        );
      await refused('VERSION_CONFLICT', f.requestRun());
      expect(await f.runRows()).toHaveLength(0);
    },
  );

  it('stops later advancement when the selected reviewer assignment has been removed', async () => {
    const f = await fixture();
    await advanceClientOnboarding(
      app.db,
      f.service,
      { agentRuns: port },
      { onboardingId: f.onboardingId },
    );
    await unassign(app.db, f.owner, {
      id: f.request.workUnitId,
      membershipId: f.member.membershipId,
    });
    expect(
      await advanceClientOnboarding(
        app.db,
        f.service,
        { agentRuns: port },
        { onboardingId: f.onboardingId },
      ),
    ).toMatchObject({ state: 'failed' });
    expect(await f.row()).toMatchObject({ stateCode: 'REVIEWER_UNAVAILABLE' });
    expect(await f.runRows()).toHaveLength(1);
  });

  it('rereads publication and service identity before starting', async () => {
    const f = await fixture();
    await withTenantTx(app.db, f.owner, (tx) =>
      tx
        .update(agentPublications)
        .set({ activeUntil: new Date(0) })
        .where(eq(agentPublications.versionId, f.published!.id)),
    );
    await refused('INVALID_STATE', f.requestRun());
    expect(await f.runRows()).toHaveLength(0);
    const g = await fixture();
    await withTenantTx(app.db, g.owner, (tx) =>
      tx
        .update(serviceIdentities)
        .set({ status: 'disabled' })
        .where(
          sql`${serviceIdentities.id} in(select service_identity_id from ai.agent_definitions where organization_id=${g.organizationId}::uuid)`,
        ),
    );
    await refused('INVALID_STATE', g.requestRun());
  });

  it('refuses overlapping current publications rather than silently choosing a version', async () => {
    const f = await fixture();
    await withTenantTx(app.db, f.owner, (tx) =>
      tx.insert(agentPublications).values({
        organizationId: f.organizationId,
        definitionId: f.published!.definition_id,
        versionId: f.published!.id,
        activeUntil: new Date(Date.now() + 60_000),
      }),
    );
    await refused('INVALID_STATE', f.requestRun());
    expect(await f.runRows()).toHaveLength(0);
  });

  it('reports measured ledger cost including corrections, never the unbacked run counter', async () => {
    const f = await fixture(),
      run = await f.requestRun();
    const firstId = randomUUID();
    await withRunLookupTx(agent.db, f.organizationId, async (tx) => {
      const base = {
        organizationId: f.organizationId,
        meter: 'model_input_tokens',
        quantity: 100,
        unit: 'token',
        billingPeriod: thisPeriod(),
        commercialMode: 'byom',
        workUnitId: f.request.workUnitId,
        runId: run.agentRunId,
        billable: false,
      };
      await tx.insert(usageLedger).values({
        ...base,
        id: firstId,
        idempotencyKey: `test:${firstId}`,
        costMicros: 500,
        status: 'estimated',
      });
      await tx.insert(usageLedger).values({
        ...base,
        idempotencyKey: `test:${randomUUID()}`,
        quantity: -20,
        costMicros: -100,
        status: 'correction',
        correctsId: firstId,
      });
      await tx.update(agentRuns).set({ costMicros: 999 }).where(eq(agentRuns.id, run.agentRunId));
    });
    const status = await withTenantTx(app.db, f.delegated, (tx) =>
      port.statusOf(tx, f.delegated, run.agentRunId),
    );
    expect(status?.costMicros).toBe(400);
  });

  it('returns only a bound output of this actual run and removes it immediately after source revocation', async () => {
    const text = 'Generated gateway evidence.';
    let source!: Awaited<ReturnType<typeof seedSearchableSource>>;
    const f = await fixture({
        knowledge: async (tenant) => {
          source = await seedSearchableSource(app.db, tenant.owner, {
            passages: [text],
            grants: [{ kind: 'membership', membershipId: tenant.owner.membershipId }],
          });
          return [source.sourceId];
        },
      }),
      run = await f.requestRun();
    // The main router refuses a profile with no rate card (RATE_CARD_MISSING), so this tenant has one.
    await seedRateCard(app.db, f.owner, f.profileId);
    const writer = await prepareRunInputContext(agent.db, f.organizationId, run.agentRunId);
    await startRunning(agent.db, writer);
    // The run genuinely retrieves the source in an agent turn, so its evidence package is a real
    // read of this run, admitted by the runtime's own egress decision for the turn. An evidence
    // package written by the service is not a read, and read admission refuses a package source the
    // manifest does not name (0414).
    const authorizeAgentContext = await runtimeEgress(writer, run.agentRunId, f.request.workUnitId);
    expect(await listEgressDecisions(app.db, f.owner, { runId: run.agentRunId })).toEqual([]);
    expect(
      await compileEvidence(
        agent.db,
        writer,
        { model: createScriptedModelPort({}), authorizeAgentContext },
        {
          purpose: 'agent_turn',
          question: text,
          queryClassification: 'internal',
          workUnitId: f.request.workUnitId,
          runId: run.agentRunId,
          sourceIds: [source.sourceId],
          budgetTokens: 1000,
          signal: AbortSignal.timeout(10_000),
        },
      ),
    ).toMatchObject({ ok: true, items: [{ sourceId: source.sourceId }] });
    // The decision that let it through is recorded: one allow, for this tenant's profile and class.
    expect(await listEgressDecisions(app.db, f.owner, { runId: run.agentRunId })).toEqual([
      expect.objectContaining({
        runId: run.agentRunId,
        profileId: f.profileId,
        dataClass: 'internal',
        purpose: 'reason',
        decision: 'allow',
        reasonCode: 'ALLOWED',
      }),
    ]);
    const objects = new Map<string, Buffer>();
    const store: ObjectStore = {
      put: async (key, body) => {
        objects.set(key, Buffer.from(body));
      },
      get: async (key) => {
        const body = objects.get(key);
        if (!body) throw new Error('TEST_MISSING_OBJECT');
        return body;
      },
      delete: async (key) => {
        objects.delete(key);
      },
      exists: async (key) => objects.has(key),
    };
    // The run's own file, through the tool gateway's draft path (an authority-v1 run's output
    // inventory exists only behind that run's own admission, 0525).
    const output = await draftRunOutput(agent.db, store, writer, {
      workUnitId: f.request.workUnitId,
      stepNumber: 1,
      name: 'Generated brief.txt',
      text,
    });
    const status = () =>
      withTenantTx(app.db, f.delegated, (tx) => port.statusOf(tx, f.delegated, run.agentRunId));
    expect((await status())?.artifactIds).toEqual([output.id]);
    await revokeSource(app.db, f.owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Synthetic revoke',
    });
    expect(await status()).toMatchObject({ artifactState: 'unavailable', artifactIds: [] });
  });

  it('refuses evidence the tenant’s egress policy keeps in: no model call, the refusal surfaced, and only the refusal recorded', async () => {
    const text = 'Generated gateway evidence the policy keeps in.';
    let source!: Awaited<ReturnType<typeof seedSearchableSource>>;
    const f = await fixture({
        knowledge: async (tenant) => {
          source = await seedSearchableSource(app.db, tenant.owner, {
            passages: [text],
            grants: [{ kind: 'membership', membershipId: tenant.owner.membershipId }],
          });
          return [source.sourceId];
        },
      }),
      run = await f.requestRun();
    // Everything the allowed case has, so the only difference is the policy below.
    await seedRateCard(app.db, f.owner, f.profileId);
    const writer = await prepareRunInputContext(agent.db, f.organizationId, run.agentRunId);
    await startRunning(agent.db, writer);
    const authorizeAgentContext = await runtimeEgress(writer, run.agentRunId, f.request.workUnitId);
    // The organization's egress policy now keeps internal data off this kind of provider, mid-run. A
    // bundle can only tighten the default matrix (S1), and the router reads the active one each time.
    await withTenantTx(app.db, f.owner, (tx) =>
      tx.insert(policyBundles).values({
        organizationId: f.organizationId,
        version: 1,
        sha256: sha256Of('generated-onboarding-bundle'),
        document: { denyClasses: { customer_private_inference: ['internal'] } },
        active: true,
        createdByMembershipId: f.owner.membershipId,
      }),
    );
    // The scripted port stands in for the Knowledge model gateway, which agent-composition.ts gives the
    // same tenant bundle, so it refuses here as that gateway would. Whatever is asked of it is then only
    // a routing question: no model method is reached.
    const model = createScriptedModelPort({
      route: () => ({
        decision: 'deny',
        reasonCode: 'CLASS_DENIED',
        policyVersion: 'generated-onboarding-bundle',
      }),
    });
    const counts = async () => {
      const { rows } = await su.query<{ packages: number; allowed: number }>(
        `select (select count(*)::int from knowledge.evidence_packages
                  where organization_id = $1 and run_id = $2) as packages,
                (select count(*)::int from knowledge.model_calls
                  where organization_id = $1 and decision <> 'deny') as allowed`,
        [f.organizationId, run.agentRunId],
      );
      return rows[0];
    };
    const before = await counts();

    const result = await compileEvidence(
      agent.db,
      writer,
      { model, authorizeAgentContext },
      {
        purpose: 'agent_turn',
        question: text,
        queryClassification: 'internal',
        workUnitId: f.request.workUnitId,
        runId: run.agentRunId,
        sourceIds: [source.sourceId],
        budgetTokens: 1000,
        signal: AbortSignal.timeout(10_000),
      },
    );

    // The refusal code is what the turn sees, and the model was never called.
    expect(result).toEqual({ ok: false, code: 'EGRESS_DENIED' });
    expect(model.calls.filter((call) => call.method !== 'route')).toEqual([]);
    // The runtime's decision is recorded as a refusal of this run's evidence by the tenant's policy:
    // one deny row naming the profile it would have gone to, and no allow.
    expect(await listEgressDecisions(app.db, f.owner, { runId: run.agentRunId })).toEqual([
      expect.objectContaining({
        runId: run.agentRunId,
        profileId: f.profileId,
        dataClass: 'internal',
        purpose: 'reason',
        decision: 'deny',
        reasonCode: 'CLASS_DENIED',
      }),
    ]);
    // Nothing else: no evidence package for the run, no allowed model call, no profile bound, and the
    // run has no output to show for it.
    expect(await counts()).toEqual(before);
    expect(before?.packages).toBe(0);
    expect(await readRunFacts(agent.db, writer, { agentRunId: run.agentRunId })).toMatchObject({
      status: 'running',
      bound: null,
    });
    expect(
      await withTenantTx(app.db, f.delegated, (tx) =>
        port.statusOf(tx, f.delegated, run.agentRunId),
      ),
    ).toMatchObject({ artifactIds: [] });
  });

  it('refuses a completed legacy adapter response without complete output inventory authority', async () => {
    const f = await fixture();
    await f.requestRun();
    const legacy = {
      status: 'completed',
      costMicros: null,
      workUnitId: f.request.workUnitId,
      initiatorMembershipId: f.owner.membershipId,
      artifactIds: [randomUUID()],
    } as unknown as NonNullable<Awaited<ReturnType<typeof port.statusOf>>>;
    expect(
      await advanceClientOnboarding(
        app.db,
        f.service,
        {
          agentRuns: { ...port, statusOf: async () => legacy },
        },
        { onboardingId: f.onboardingId },
      ),
    ).toMatchObject({ state: 'failed' });
    expect(await f.row()).toMatchObject({ stateCode: 'BRIEF_UNAVAILABLE', briefArtifactId: null });
  });

  it('never chooses a visible singleton after another actual output of the same run is tombstoned', async () => {
    const f = await fixture(),
      run = await f.requestRun();
    const writer = await prepareRunInputContext(agent.db, f.organizationId, run.agentRunId);
    await startRunning(agent.db, writer);
    const text = 'Generated multi-output brief evidence.';
    const objects = new Map<string, Buffer>();
    const store: ObjectStore = {
      put: async (key, body) => {
        objects.set(key, Buffer.from(body));
      },
      get: async (key) => {
        const body = objects.get(key);
        if (!body) throw new Error('TEST_MISSING_OBJECT');
        return body;
      },
      delete: async (key) => {
        objects.delete(key);
      },
      exists: async (key) => objects.has(key),
    };
    // Two of the run's own files from two tool steps, each through the tool gateway's draft path.
    const create = (name: string, stepNumber: number) =>
      draftRunOutput(agent.db, store, writer, {
        workUnitId: f.request.workUnitId,
        stepNumber,
        name,
        text,
      });
    const first = await create('First actual generated output.txt', 1);
    const second = await create('Second actual generated output.txt', 2);
    const status = () =>
      withTenantTx(app.db, f.delegated, (tx) => port.statusOf(tx, f.delegated, run.agentRunId));
    expect(await status()).toMatchObject({ artifactState: 'ambiguous', artifactIds: [] });
    // This is a real per-artifact access fence written under the actual application role. No source
    // read is omitted from the run inventory, and the test makes no physical-byte-erasure claim.
    await withTenantTx(app.db, f.owner, (tx) =>
      tx.insert(tombstones).values({
        organizationId: f.organizationId,
        targetType: 'artifact',
        targetId: first.id,
        reasonCode: 'USER_DELETED',
      }),
    );
    const actual = await withTenantTx(app.db, f.owner, (tx) =>
      tx.execute<{ first: boolean; second: boolean }>(
        sql`select knowledge.artifact_readable(${first.id}::uuid,${f.owner.membershipId}::uuid) as first,
        knowledge.artifact_readable(${second.id}::uuid,${f.owner.membershipId}::uuid) as second`,
      ),
    );
    expect(actual.rows[0]).toEqual({ first: false, second: true });
    expect(await status()).toMatchObject({ artifactState: 'ambiguous', artifactIds: [] });
    // The run is already running (it wrote its files), so it finishes from there.
    await withRunLookupTx(agent.db, f.organizationId, async (tx) => {
      for (const state of ['verifying', 'completed'])
        await tx.update(agentRuns).set({ status: state }).where(eq(agentRuns.id, run.agentRunId));
    });
    expect(
      await advanceClientOnboarding(
        app.db,
        f.service,
        { agentRuns: port },
        { onboardingId: f.onboardingId },
      ),
    ).toMatchObject({ state: 'failed' });
    expect(await f.row()).toMatchObject({ stateCode: 'BRIEF_AMBIGUOUS', briefArtifactId: null });
  });

  it('does not turn a human upload attached to the brief into an agent output', async () => {
    const f = await fixture();
    const run = await f.requestRun();
    const bytes = new Map<string, Buffer>();
    const store: ObjectStore = {
      put: async (key, body) => {
        bytes.set(key, body);
      },
      get: async (key) => {
        const body = bytes.get(key);
        if (!body) throw new Error('TEST_MISSING_OBJECT');
        return body;
      },
      delete: async (key) => {
        bytes.delete(key);
      },
      exists: async (key) => bytes.has(key),
    };
    await addArtifact(app.db, store, f.owner, {
      workUnitId: f.request.workUnitId,
      name: 'Human attachment',
      mimeType: 'text/plain',
      body: Buffer.from('Generated test attachment'),
    });
    const state = await withTenantTx(app.db, f.delegated, (tx) =>
      port.statusOf(tx, f.delegated, run.agentRunId),
    );
    expect(state?.artifactIds).toEqual([]);
    expect(
      await withTenantTx(app.db, f.delegated, (tx) => port.statusOf(tx, f.delegated, randomUUID())),
    ).toBeNull();
  });
});
