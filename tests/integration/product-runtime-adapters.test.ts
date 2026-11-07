// Actual M4/M7/PG roles, no provider or Temporal call. Generated metadata only.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { AppError, createWorkUnit, getWorkUnit, setOwner, unassign } from '@ensemus/application';
import {
  agentSpecSha256,
  pinAgentVersion,
  publishAgentVersion,
} from '@ensemus/application/ai-agents';
import { requestProcessAgentRun } from '@ensemus/application/ai-run-control';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import { advanceProcessRun, startProcessRun } from '@ensemus/application/process-runs';
import { publishProcessSpecInTx } from '@ensemus/application/process-specs';
import { agentSpecV1Schema } from '@ensemus/contracts/ai';
import {
  agentDefinitions,
  agentPublications,
  agentRuns,
  memberships,
  openAppDatabase,
  runControls,
  withTenantTx,
  type Tx,
} from '@ensemus/database';
import { processRunSteps } from '@ensemus/database/product';
import { withRunLookupTx } from '@ensemus/database/agent';
import { createDelegatedContext, createServiceContext } from '@ensemus/database/service';
import { compileProcessGraph } from '@ensemus/domain/process-spec';
import { databaseInTransaction } from '../../packages/application/src/transaction-database';
import {
  openAgentTestDatabase,
  seedActiveProfile,
  seedAgentVersion,
  seedAiTenant,
  seedOrganizationBudget,
  seedQueuedRun,
  testAgentSpec,
} from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const refused = (code: string) => expect.objectContaining({ code });

describe('real product runtime adapters', () => {
  let app: ReturnType<typeof openAppDatabase>, agent: ReturnType<typeof openAgentTestDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app(), { max: 4 });
    agent = openAgentTestDatabase();
  });
  afterAll(async () => {
    await agent?.close();
    await app?.close();
  });
  const ports = () => createRuntimeProductPorts(app.db);
  async function fixture() {
    const tenant = await seedAiTenant(app.db),
      version = await seedAgentVersion(app.db, tenant.owner),
      work = await createWorkUnit(app.db, tenant.owner, { title: 'Generated adapter work' }),
      runId = await seedQueuedRun(app.db, tenant.owner, { workUnitId: work.id, version });
    return { ...tenant, version, work, runId };
  }

  it('reads actual run metadata and leaves unpriced cost unknown; a stop is only a durable request', async () => {
    const f = await fixture();
    expect(await ports().agentRuns.listMine(f.owner, {})).toMatchObject({
      items: [
        {
          id: f.runId,
          workUnitId: f.work.id,
          workTitle: f.work.title,
          status: 'queued',
          costMicros: null,
          costIsEstimate: true,
        },
      ],
      next: null,
    });
    await ports().agentRuns.requestStop(f.owner, f.runId);
    await ports().agentRuns.requestStop(f.owner, f.runId);
    const controls = await withTenantTx(app.db, f.owner, (tx) =>
      tx.select().from(runControls).where(eq(runControls.runId, f.runId)),
    );
    expect(controls.map((row) => row.kind)).toEqual(['stop']);
    expect((await ports().agentRuns.get(f.owner, f.runId)).status).toBe('queued');
  });

  it('filters inaccessible Work before the page cap and refuses foreign and malformed references', async () => {
    const f = await fixture(),
      foreign = await seedAiTenant(app.db);
    const hidden = await createWorkUnit(app.db, f.owner, {
      title: 'PRIVATE_ADAPTER_TITLE',
      classification: 'restricted',
    });
    const hiddenRun = await seedQueuedRun(app.db, f.owner, {
      workUnitId: hidden.id,
      version: f.version,
    });
    await setOwner(app.db, f.owner, {
      id: hidden.id,
      expectedVersion: hidden.version,
      ownerMembershipId: f.member.membershipId,
    });
    await unassign(app.db, f.owner, { id: hidden.id, membershipId: f.owner.membershipId });
    const page = await ports().agentRuns.listMine(f.owner, { limit: 1 });
    expect(page.items.map((row) => row.id)).toEqual([f.runId]);
    expect(page.next).toBeNull();
    expect(JSON.stringify(page)).not.toContain('PRIVATE_ADAPTER_TITLE');
    for (const [context, id] of [
      [f.owner, hiddenRun],
      [foreign.owner, f.runId],
    ] as const)
      await expect(ports().agentRuns.get(context, id)).rejects.toEqual(refused('NOT_FOUND'));
    await expect(ports().agentRuns.listMine(f.owner, { after: 'not-a-cursor' })).rejects.toEqual(
      refused('INVALID_INPUT'),
    );
  });

  it('does not turn a service/delegated display call or a stale role into a human capability', async () => {
    const f = await fixture(),
      service = createServiceContext(f.organizationId),
      delegated = await createDelegatedContext(app.db, f.organizationId, f.owner.membershipId);
    for (const context of [service, delegated])
      await expect(ports().agentRuns.listMine(context, {})).rejects.toEqual(refused('FORBIDDEN'));
    await withTenantTx(app.db, f.owner, (tx) =>
      tx
        .update(memberships)
        .set({ role: 'member' })
        .where(eq(memberships.id, f.owner.membershipId)),
    );
    await expect(ports().agentRegistry.orgLimits(f.owner)).rejects.toEqual(refused('FORBIDDEN'));
    await expect(ports().agentRegistry.list(f.owner)).rejects.toEqual(refused('FORBIDDEN'));
  });

  it('never returns arbitrary uppercase model-like stop text as a trusted reason', async () => {
    const f = await fixture();
    await withRunLookupTx(agent.db, f.organizationId, (tx) =>
      tx
        .update(agentRuns)
        .set({ status: 'cancelled', stopCode: 'PRIVATE_MODEL_CONTENT_CANARY', endedAt: new Date() })
        .where(eq(agentRuns.id, f.runId)),
    );
    const result = await ports().agentRuns.get(f.owner, f.runId);
    expect(result).toMatchObject({ status: 'cancelled', stopCode: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MODEL_CONTENT_CANARY');
  });

  async function publication(
    context: Awaited<ReturnType<typeof seedAiTenant>>['owner'],
    version = 1,
  ) {
    const spec = agentSpecV1Schema.parse(testAgentSpec({ id: 'generated-product-agent', version }));
    return publishAgentVersion(app.db, context, {
      spec,
      policyVersion: 'default',
      evaluationReport: {
        report_version: 1,
        spec_sha256: agentSpecSha256(spec),
        policy_version: 'default',
        suite_ref: spec.evaluation.suite_ref,
        dataset_version: 'generated-product-adapter-1',
        model_label: 'scripted',
        pass_rate: 1,
        cases: 1,
        passed: true,
        scripted_model: true,
      },
    });
  }

  it('pins the real earlier immutable version without cloning it or touching an already started run', async () => {
    const f = await seedAiTenant(app.db),
      first = await publication(f.owner),
      second = await publication(f.owner, 2);
    const [definition] = await withTenantTx(app.db, f.owner, (tx) =>
      tx.select().from(agentDefinitions).where(eq(agentDefinitions.id, second.definition_id)),
    );
    const work = await createWorkUnit(app.db, f.owner, { title: 'Generated pinned-version work' });
    const runId = await seedQueuedRun(app.db, f.owner, {
      workUnitId: work.id,
      version: {
        definitionId: second.definition_id,
        versionId: second.id,
        serviceIdentityId: definition!.serviceIdentityId,
      },
    });
    await pinAgentVersion(app.db, f.owner, first.id);
    const current = await withTenantTx(app.db, f.owner, (tx) =>
      tx
        .select()
        .from(agentPublications)
        .where(
          and(
            eq(agentPublications.definitionId, first.definition_id),
            sql`${agentPublications.activeFrom}<=now()
        and (${agentPublications.activeUntil} is null or ${agentPublications.activeUntil}>now())`,
          ),
        ),
    );
    expect(current.map((row) => row.versionId)).toEqual([first.id]);
    const [run] = await withTenantTx(app.db, f.owner, (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, runId)),
    );
    expect(run?.agentVersionId).toBe(second.id);
    expect((await ports().agentRegistry.list(f.owner)).map((row) => row.versionId)).toEqual([
      second.id,
      first.id,
    ]);
    const delegated = await createDelegatedContext(app.db, f.organizationId, f.owner.membershipId);
    await expect(pinAgentVersion(app.db, delegated, first.id)).rejects.toEqual(
      refused('FORBIDDEN'),
    );
  });

  it('binds one actual compiled process step/run atomically and reuses it after publication changes', async () => {
    const f = await seedAiTenant(app.db),
      published = await publication(f.owner);
    await seedActiveProfile(app.db, agent.db, f.owner);
    await seedOrganizationBudget(app.db, f.owner, 1_000_000);
    const compiled = compileProcessGraph(
      {
        schemaVersion: 1,
        nodes: [
          { id: 'start', kind: 'start', label: 'Start', x: 0, y: 0 },
          {
            id: 'assistant',
            kind: 'agent_task',
            label: 'Prepare a draft',
            agentDefinitionId: published.definition_id,
            x: 1,
            y: 0,
          },
          { id: 'end', kind: 'end', label: 'Finish', x: 2, y: 0 },
        ],
        edges: [
          { from: 'start', to: 'assistant' },
          { from: 'assistant', to: 'end' },
        ],
      },
      {
        classification: 'internal',
        agentDefinitionIds: new Set([published.definition_id]),
        toolIds: new Set(),
      },
      hash,
    );
    if (!compiled.ok) throw new Error('TEST_PROCESS_NOT_COMPILED');
    const publishedProcess = await withTenantTx(app.db, f.owner, (tx) =>
      publishProcessSpecInTx(tx, f.owner, {
        processKey: 'generated-product-process',
        name: 'Generated process',
        classification: 'internal',
        spec: compiled.spec,
        specSha256: compiled.specSha256,
        source: 'graph',
      }),
    );
    const process = await startProcessRun(app.db, f.owner, {
        specId: publishedProcess.specId,
        title: 'Generated process work',
      }),
      service = createServiceContext(f.organizationId),
      temporalRunId = randomUUID();
    await advanceProcessRun(app.db, service, ports(), { runId: process.id, temporalRunId });
    const [step] = await withTenantTx(app.db, service, (tx) =>
      tx.select().from(processRunSteps).where(eq(processRunSteps.runId, process.id)),
    );
    expect(step).toMatchObject({
      stepKey: 'assistant',
      status: 'waiting',
      agentRunId: expect.any(String),
    });
    expect((await getWorkUnit(app.db, f.owner, step!.workUnitId!)).parentId).toBe(
      process.rootWorkUnitId,
    );
    const delegated = await createDelegatedContext(app.db, f.organizationId, f.owner.membershipId);
    await withTenantTx(app.db, f.owner, (tx) =>
      tx
        .update(agentPublications)
        .set({ activeUntil: sql`now()` })
        .where(
          and(
            eq(agentPublications.definitionId, published.definition_id),
            sql`${agentPublications.activeUntil} is null`,
          ),
        ),
    );
    expect(
      await requestProcessAgentRun(app.db, delegated, {
        processRunId: process.id,
        stepKey: 'assistant',
        workUnitId: step!.workUnitId!,
        agentVersionId: published.id,
        initiatorMembershipId: f.owner.membershipId,
      }),
    ).toEqual({ runId: step!.agentRunId });
    const actual = await withTenantTx(app.db, service, (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.workUnitId, step!.workUnitId!)),
    );
    expect(actual.map((row) => row.id)).toEqual([step!.agentRunId]);
    await expect(
      requestProcessAgentRun(app.db, f.owner, {
        processRunId: process.id,
        stepKey: 'assistant',
        workUnitId: step!.workUnitId!,
        agentVersionId: published.id,
        initiatorMembershipId: f.owner.membershipId,
      }),
    ).rejects.toEqual(refused('FORBIDDEN'));
  });

  const bindings = async (tx: Tx) =>
    (
      await tx.execute<{
        organization: string;
        actor: string;
        user: string;
        session: string;
      }>(sql`select
    current_setting('app.organization_id',true) as organization,current_setting('app.actor_type',true) as actor,
    current_setting('app.user_id',true) as "user",current_setting('app.interactive_session_id',true) as session`)
    ).rows[0];
  it('restores successful nested actor/session bindings and keeps unbound reads unbound', async () => {
    const f = await seedAiTenant(app.db),
      service = createServiceContext(f.organizationId);
    await withTenantTx(app.db, service, async (tx) => {
      const before = await bindings(tx),
        joined = databaseInTransaction(tx);
      expect(await withTenantTx(joined, f.owner, bindings)).toMatchObject({
        organization: f.organizationId,
        actor: 'user',
        user: f.owner.userId,
      });
      expect(await bindings(tx)).toEqual(before);
      expect(await joined.run(bindings)).toEqual({
        organization: '',
        actor: '',
        user: '',
        session: '',
      });
      expect(await bindings(tx)).toEqual(before);
    });
  });
  it('rolls nested writes and bindings back while leaving the outer service transaction usable', async () => {
    const f = await seedAiTenant(app.db),
      service = createServiceContext(f.organizationId);
    let rolledBackId = '';
    await withTenantTx(app.db, service, async (tx) => {
      const before = await bindings(tx),
        joined = databaseInTransaction(tx);
      await expect(
        withTenantTx(joined, f.owner, async (nested) => {
          rolledBackId = (
            await createWorkUnit(databaseInTransaction(nested), f.owner, {
              title: 'Generated rolled back Work',
            })
          ).id;
          await nested.execute(sql`select 1/0`);
        }),
      ).rejects.toThrow();
      expect(await bindings(tx)).toEqual(before);
      expect((await tx.execute(sql`select 1 as alive`)).rows).toEqual([{ alive: 1 }]);
    });
    await expect(getWorkUnit(app.db, f.owner, rolledBackId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
  });
});
