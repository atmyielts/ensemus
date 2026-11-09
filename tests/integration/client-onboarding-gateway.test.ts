// Actual tenant/agent roles and the real M4 run/outbox kernel. No provider or model quality claim.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import {
  AppError,
  addArtifact,
  updateWorkUnit,
  unassign,
  type ObjectStore,
} from '@ensemus/application';
import { agentSpecSha256, publishAgentVersion } from '@ensemus/application/ai-agents';
import { startAgentRun } from '@ensemus/application/ai-run-control';
import { createRunInputInventory } from '@ensemus/application/ai-input-ledger';
import { addGeneratedArtifact } from '@ensemus/application/knowledge/artifact-provenance';
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
  knowledgeEvidenceItems,
  knowledgeEvidencePackages,
  memberships,
  openAppDatabase,
  outboxEvents,
  serviceIdentities,
  tombstones,
  usageLedger,
  withTenantTx,
  workAssignments,
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
  testAgentSpec,
  thisPeriod,
} from '../helpers/ai/fixtures';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { seedSearchableSource, sha256 } from '../helpers/knowledge';
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

  async function fixture(options: { publish?: boolean } = {}) {
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
    await seedActiveProfile(app.db, agent.db, owner);
    await seedOrganizationBudget(app.db, owner, 1_000_000);
    const spec = agentSpecV1Schema.parse(testAgentSpec({ id: 'client-brief' }));
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
      onboardingId: snapshot.id,
    };
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
    const f = await fixture(),
      run = await f.requestRun();
    const writer = await prepareRunInputContext(agent.db, f.organizationId, run.agentRunId);
    const text = 'Generated gateway evidence.';
    const source = await seedSearchableSource(app.db, f.owner, {
      passages: [text],
      grants: [{ kind: 'membership', membershipId: f.owner.membershipId }],
    });
    await withTenantTx(app.db, f.service, async (tx) => {
      const packageId = randomUUID();
      await tx.insert(knowledgeEvidencePackages).values({
        organizationId: f.organizationId,
        id: packageId,
        purpose: 'agent_turn',
        workUnitId: f.request.workUnitId,
        runId: run.agentRunId,
        viewerMembershipId: f.owner.membershipId,
        querySha256: sha256('generated query'),
        policyVersion: 'test/gateway',
        budgetTokens: 1000,
        usedTokens: 10,
        strongestClassification: 'internal',
        packageSha256: sha256(packageId),
      });
      await tx.insert(knowledgeEvidenceItems).values({
        organizationId: f.organizationId,
        packageId,
        ordinal: 1,
        chunkId: source.chunkIds[0]!,
        documentId: source.documentId,
        sourceId: source.sourceId,
        contentSha256: sha256(text),
        classification: 'internal',
        tokenEstimate: 10,
      });
    });
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
    const output = await addGeneratedArtifact(
      agent.db,
      store,
      writer,
      {
        workUnitId: f.request.workUnitId,
        name: 'Generated brief.txt',
        mimeType: 'text/plain',
        body: Buffer.from(text),
        execution: { kind: 'agent_run', id: run.agentRunId },
        requestKey: randomUUID(),
      },
      { inventory: createRunInputInventory() },
    );
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
    const create = (name: string) =>
      addGeneratedArtifact(
        agent.db,
        store,
        writer,
        {
          workUnitId: f.request.workUnitId,
          name,
          mimeType: 'text/plain',
          body: Buffer.from(text),
          execution: { kind: 'agent_run', id: run.agentRunId },
          requestKey: randomUUID(),
        },
        { inventory: createRunInputInventory() },
      );
    const first = await create('First actual generated output.txt');
    const second = await create('Second actual generated output.txt');
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
    await withRunLookupTx(agent.db, f.organizationId, async (tx) => {
      for (const state of ['preparing', 'running', 'verifying', 'completed'])
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
