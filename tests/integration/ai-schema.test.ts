// ADR-028 FD-4, FD-5, FD-10, FD-13, FD-15. The rules that live in reviewed SQL, tried as the real roles.
// Needs the role provisioning step in ADR-028. Written and typechecked. It has not been run yet.
import { randomUUID } from 'node:crypto';
import { createWorkUnit } from '@ensemus/application';
import {
  agentRuns,
  executionSteps,
  killSwitches,
  modelProfiles,
  openAppDatabase,
  runControls,
  stepPayloads,
  usageLedger,
  withTenantTx,
} from '@ensemus/database';
import { createAgentContext, withRunLookupTx } from '@ensemus/database/agent';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedActiveProfile,
  seedAgentVersion,
  seedAiTenant,
  seedDraftProfile,
  seedQueuedRun,
  sha256Of,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

describe('governed AI schema, as the real roles', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let a: AiTenant;
  let b: AiTenant;

  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 2 });
    agent = openAgentTestDatabase();
    a = await seedAiTenant(app.db);
    b = await seedAiTenant(app.db);
  });

  afterAll(async () => {
    await app.close();
    await agent.close();
  });

  const work = async (tenant: AiTenant) =>
    (await createWorkUnit(app.db, tenant.owner, { title: 'Agent work', objective: 'Do it.' })).id;

  const queuedRun = async (tenant: AiTenant) => {
    const version = await seedAgentVersion(app.db, tenant.owner);
    return seedQueuedRun(app.db, tenant.owner, { workUnitId: await work(tenant), version });
  };

  /** A step and a payload written by the agent role, so the refusals below have something to refuse. */
  const seedPayload = async (tenant: AiTenant) => {
    const runId = await queuedRun(tenant);
    const stepId = randomUUID();
    const context = await prepareRunInputContext(agent.db, tenant.organizationId, runId);
    await withTenantTx(agent.db, context, async (tx) => {
      await tx.insert(executionSteps).values({
        organizationId: tenant.organizationId,
        id: stepId,
        runId,
        stepNumber: 0,
        kind: 'model_turn',
        state: 'in_flight',
        labelCode: 'THINKING',
      });
      await tx.insert(stepPayloads).values({
        organizationId: tenant.organizationId,
        stepId,
        kind: 'prompt',
        classification: 'internal',
        content: 'a prompt',
        contentSha256: sha256Of('a prompt'),
      });
    });
    return { runId, stepId };
  };

  it('has forced RLS on every new table', async () => {
    const su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    const { rows } = await su.query(
      `select n.nspname || '.' || c.relname as t
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p') and n.nspname = 'ai'
          and not (c.relrowsecurity and c.relforcerowsecurity)`,
    );
    await su.end();
    expect(rows).toEqual([]);
  });

  it('never lets the web role read a prompt, even with its tenant bound', async () => {
    await seedPayload(a);
    await expect(
      withTenantTx(app.db, a.owner, (tx) => tx.select().from(stepPayloads)),
    ).rejects.toThrow();
  });

  it('confines the agent role to the bound tenant', async () => {
    const { stepId } = await seedPayload(a);
    const rows = await withRunLookupTx(agent.db, b.organizationId, (tx) =>
      tx.select().from(stepPayloads).where(eq(stepPayloads.stepId, stepId)),
    );
    expect(rows).toEqual([]);
  });

  it('refuses a web role writing to the ledger', async () => {
    const runId = await queuedRun(a);
    await expect(
      withTenantTx(app.db, a.owner, (tx) =>
        tx.insert(usageLedger).values({
          organizationId: a.organizationId,
          idempotencyKey: `test:${randomUUID()}`,
          meter: 'tool_call',
          quantity: 1,
          unit: 'call',
          costMicros: 0,
          billingPeriod: '2026-11',
          commercialMode: 'byom',
          workUnitId: randomUUID(),
          runId,
          status: 'final',
          billable: false,
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses the web role moving a run, except to close a stranded one', async () => {
    const runId = await queuedRun(a);
    await expect(
      withTenantTx(app.db, a.owner, (tx) =>
        tx.update(agentRuns).set({ status: 'preparing' }).where(eq(agentRuns.id, runId)),
      ),
    ).rejects.toThrow();
    await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .update(agentRuns)
        .set({ status: 'failed', stopCode: 'STRANDED' })
        .where(eq(agentRuns.id, runId)),
    );
  });

  it('refuses a run lowering its class or a counter', async () => {
    const runId = await queuedRun(a);
    await expect(
      withRunLookupTx(agent.db, a.organizationId, (tx) =>
        tx
          .update(agentRuns)
          .set({ effectiveClassification: 'public' })
          .where(eq(agentRuns.id, runId)),
      ),
    ).rejects.toThrow();
  });

  it('refuses a run raising its own limits, as every role', async () => {
    const runId = await queuedRun(a);
    await expect(
      withRunLookupTx(agent.db, a.organizationId, (tx) =>
        tx.update(agentRuns).set({ maxCostMicros: 999_999_999 }).where(eq(agentRuns.id, runId)),
      ),
    ).rejects.toThrow();
  });

  it('refuses a second live run on a Work Unit', async () => {
    const version = await seedAgentVersion(app.db, a.owner);
    const workUnitId = await work(a);
    await seedQueuedRun(app.db, a.owner, { workUnitId, version });
    await expect(seedQueuedRun(app.db, a.owner, { workUnitId, version })).rejects.toThrow();
  });

  it('keeps run controls append-only', async () => {
    const runId = await queuedRun(a);
    await withTenantTx(app.db, a.owner, (tx) =>
      tx.insert(runControls).values({
        organizationId: a.organizationId,
        runId,
        kind: 'stop',
        byMembershipId: a.owner.membershipId,
      }),
    );
    await expect(
      withTenantTx(app.db, a.owner, (tx) =>
        tx.update(runControls).set({ kind: 'resume' }).where(eq(runControls.runId, runId)),
      ),
    ).rejects.toThrow();
  });

  describe('a model profile', () => {
    it('cannot be made active by the web role', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.update(modelProfiles).set({ status: 'probing' }).where(eq(modelProfiles.id, id)),
      );
      await expect(
        withTenantTx(app.db, a.owner, (tx) =>
          tx.update(modelProfiles).set({ status: 'active' }).where(eq(modelProfiles.id, id)),
        ),
      ).rejects.toThrow();
    });

    it('goes back to draft, without its key, when its endpoint changes', async () => {
      const id = await seedActiveProfile(app.db, agent.db, a.owner);
      await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .update(modelProfiles)
          .set({ endpointUrl: 'http://127.0.0.1:59998/v1' })
          .where(eq(modelProfiles.id, id)),
      );
      const [row] = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(modelProfiles).where(eq(modelProfiles.id, id)),
      );
      expect(row).toMatchObject({
        status: 'draft',
        secretRef: null,
        qualifiedAt: null,
        version: 2,
      });
    });

    it('cannot be seen from another tenant', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      const rows = await withTenantTx(app.db, b.owner, (tx) =>
        tx.select().from(modelProfiles).where(eq(modelProfiles.id, id)),
      );
      expect(rows).toEqual([]);
    });
  });

  describe('a kill switch', () => {
    it('cannot be written globally by a tenant', async () => {
      await expect(
        withTenantTx(app.db, a.owner, (tx) =>
          tx.insert(killSwitches).values({ scope: 'global', reasonCode: 'TEST' }),
        ),
      ).rejects.toThrow();
    });

    it('cannot be aimed at another tenant', async () => {
      await expect(
        withTenantTx(app.db, a.owner, (tx) =>
          tx.insert(killSwitches).values({
            organizationId: b.organizationId,
            scope: 'organization',
            reasonCode: 'TEST',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('createAgentContext', () => {
    it('carries the initiator, and refuses one who is no longer active', async () => {
      const runId = randomUUID();
      const context = await createAgentContext(agent.db, {
        organizationId: a.organizationId,
        initiatorMembershipId: a.member.membershipId,
        agentRunId: runId,
      });
      expect(context).toMatchObject({
        actorType: 'agent',
        role: 'member',
        membershipId: a.member.membershipId,
        agentRunId: runId,
      });

      await expect(
        createAgentContext(agent.db, {
          organizationId: b.organizationId,
          initiatorMembershipId: a.member.membershipId,
          agentRunId: runId,
        }),
      ).rejects.toThrow('Not found or not permitted');
    });
  });
});
