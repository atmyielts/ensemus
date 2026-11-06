// MODEL-04, COMM-02, ADR-028 FD-6, FD-8, FD-12. The ledger and budgets as the real roles, against the real
// constraints and triggers. Written and typechecked. It has not been run yet: it needs containers and the
// role provisioning step in ADR-028. Gateway cases need the policy-router slice merged, because its
// foundation stub denies everything and so cannot tell one denial from another.
import { randomUUID } from 'node:crypto';
import { createWorkUnit } from '@ensemus/application';
import {
  getStopDiagnostics,
  getUsageSummary,
  listBudgets,
  setBudget,
} from '@ensemus/application/ai-budget';
import type { Entitlements, LedgerEntry } from '@ensemus/application/ai-ports';
import {
  createUsageLedger,
  closeRunReservations,
  recordLostAnswer,
} from '@ensemus/application/ai-usage';
import {
  createEntitlements,
  FEATURE_AGENT_RUN,
  FEATURE_MODEL_CALL,
  getEntitlementsView,
} from '@ensemus/commercial';
import {
  agentRuns,
  auditEvents,
  budgetReservations,
  budgets,
  executionSteps,
  openAppDatabase,
  usageLedger,
  withTenantTx,
  type AgentContext,
} from '@ensemus/database';
import { createAgentContext, withRunLookupTx } from '@ensemus/database/agent';
import { modelLedgerKey } from '@ensemus/domain/ai';
import { createInferenceGateway, type ModelRouter } from '@ensemus/intelligence';
import { RecordingLender, ScriptedModelAdapter } from '@ensemus/intelligence/testing';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openAgentTestDatabase,
  seedActiveProfile,
  seedAgentVersion,
  seedAiTenant,
  seedOrganizationBudget,
  seedQueuedRun,
  seedRateCard,
  thisPeriod,
  type AiTenant,
  type SeededAgentVersion,
} from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

describe('usage and budgets, as the real roles', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let a: AiTenant;
  let b: AiTenant;
  const ledger = () => createUsageLedger(agent.db);

  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 4 });
    agent = openAgentTestDatabase(4);
    a = await seedAiTenant(app.db);
    b = await seedAiTenant(app.db);
  });

  afterAll(async () => {
    await app.close();
    await agent.close();
  });

  type Run = {
    runId: string;
    workUnitId: string;
    version: SeededAgentVersion;
    context: AgentContext;
  };

  const startRun = async (tenant: AiTenant): Promise<Run> => {
    const version = await seedAgentVersion(app.db, tenant.owner);
    const work = await createWorkUnit(app.db, tenant.owner, {
      title: 'Agent work',
      objective: 'Do it.',
    });
    const runId = await seedQueuedRun(app.db, tenant.owner, { workUnitId: work.id, version });
    const context = await createAgentContext(agent.db, {
      organizationId: tenant.organizationId,
      initiatorMembershipId: tenant.owner.membershipId,
      agentRunId: runId,
    });
    return { runId, workUnitId: work.id, version, context };
  };

  const startStep = async (
    tenant: AiTenant,
    run: Run,
    stepNumber: number,
    over: Partial<typeof executionSteps.$inferInsert> = {},
  ) => {
    const stepId = randomUUID();
    await withRunLookupTx(agent.db, tenant.organizationId, (tx) =>
      tx.insert(executionSteps).values({
        organizationId: tenant.organizationId,
        id: stepId,
        runId: run.runId,
        stepNumber,
        kind: 'model_turn',
        state: 'in_flight',
        labelCode: 'THINKING',
        ...over,
      }),
    );
    return stepId;
  };

  const reserve = (run: Run, stepId: string, amountMicros: number, attempt = 1) =>
    withTenantTx(agent.db, run.context, (tx) =>
      ledger().reserve(tx, run.context, {
        runId: run.runId,
        stepId,
        attempt,
        agentVersionId: run.version.versionId,
        amountMicros,
      }),
    );

  const holdId = async (run: Run, stepId: string, amountMicros: number) => {
    const held = await reserve(run, stepId, amountMicros);
    if (!held.ok) throw new Error(`expected a hold, got ${held.code}`);
    return held.reservationId;
  };

  const budgetRow = async (tenant: AiTenant, id: string) => {
    const [row] = await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.select().from(budgets).where(eq(budgets.id, id)),
    );
    if (!row) throw new Error('no such budget');
    return row;
  };

  const entry = (run: Run, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    idempotencyKey: `test:${randomUUID()}`,
    meter: 'tool_call',
    quantity: 1,
    unit: 'call',
    costMicros: 0,
    rateCardId: null,
    rateCardVersion: null,
    reservationId: null,
    workUnitId: run.workUnitId,
    runId: run.runId,
    stepId: null,
    profileId: null,
    profileVersion: null,
    providerKind: null,
    requestHash: null,
    status: 'final',
    ...over,
  });

  const record = (run: Run, row: LedgerEntry) =>
    withTenantTx(agent.db, run.context, (tx) => ledger().record(tx, run.context, row));

  /** A fresh tenant, so one test's budget cannot help or hinder another's. */
  const freshTenant = (commercialMode: 'cloud' | 'byom' | 'sovereign' = 'byom') =>
    seedAiTenant(app.db, { commercialMode });

  describe('reserving', () => {
    it('denies with no budget, and writes nothing', async () => {
      const tenant = await freshTenant();
      const run = await startRun(tenant);
      const stepId = await startStep(tenant, run, 1);
      await expect(reserve(run, stepId, 100)).resolves.toEqual({
        ok: false,
        code: 'BUDGET_NOT_CONFIGURED',
      });
      const rows = await withTenantTx(app.db, tenant.owner, (tx) =>
        tx.select().from(budgetReservations),
      );
      expect(rows).toEqual([]);
    });

    it('does not take last month’s budget for this one', async () => {
      const tenant = await freshTenant();
      await setBudget(app.db, tenant.owner, {
        scope: 'organization',
        agent_version_id: null,
        period: '2020-01',
        limit_micros: 1_000_000,
      });
      const run = await startRun(tenant);
      const stepId = await startStep(tenant, run, 1);
      await expect(reserve(run, stepId, 100)).resolves.toEqual({
        ok: false,
        code: 'BUDGET_NOT_CONFIGURED',
      });
    });

    it('lets one of two concurrent reservations have the last of the headroom', async () => {
      const tenant = await freshTenant();
      const budgetId = await seedOrganizationBudget(app.db, tenant.owner, 100);
      const run = await startRun(tenant);
      const steps = await Promise.all([startStep(tenant, run, 1), startStep(tenant, run, 2)]);
      const answers = await Promise.all(steps.map((stepId) => reserve(run, stepId, 100)));
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
      expect(answers.filter((answer) => !answer.ok)).toEqual([
        { ok: false, code: 'BUDGET_EXHAUSTED' },
      ]);
      expect(await budgetRow(tenant, budgetId)).toMatchObject({ reservedMicros: 100 });
    });

    it('holds on the agent version’s budget too, and leaves nothing held when that one refuses', async () => {
      const tenant = await freshTenant();
      const organizationBudget = await seedOrganizationBudget(app.db, tenant.owner, 1_000);
      const run = await startRun(tenant);
      const { budgetId: versionBudget } = await setBudget(app.db, tenant.owner, {
        scope: 'agent_version',
        agent_version_id: run.version.versionId,
        period: thisPeriod(),
        limit_micros: 50,
      });
      const stepId = await startStep(tenant, run, 1);

      await expect(reserve(run, stepId, 100)).resolves.toEqual({
        ok: false,
        code: 'BUDGET_EXHAUSTED',
      });
      expect(await budgetRow(tenant, organizationBudget)).toMatchObject({ reservedMicros: 0 });
      expect(await budgetRow(tenant, versionBudget)).toMatchObject({ reservedMicros: 0 });

      await expect(reserve(run, stepId, 40)).resolves.toMatchObject({ ok: true, amountMicros: 40 });
      expect(await budgetRow(tenant, organizationBudget)).toMatchObject({ reservedMicros: 40 });
      expect(await budgetRow(tenant, versionBudget)).toMatchObject({ reservedMicros: 40 });
    });

    it('holds once for the same step and attempt, even asked twice at once', async () => {
      const tenant = await freshTenant();
      const budgetId = await seedOrganizationBudget(app.db, tenant.owner, 1_000);
      const run = await startRun(tenant);
      const stepId = await startStep(tenant, run, 1);
      const [first, second] = await Promise.all([
        reserve(run, stepId, 100),
        reserve(run, stepId, 100),
      ]);
      expect(second).toEqual(first);
      expect(await budgetRow(tenant, budgetId)).toMatchObject({ reservedMicros: 100 });
    });

    it('reports the tightest headroom, and null with none', async () => {
      const tenant = await freshTenant();
      const run = await startRun(tenant);
      const query = { runId: run.runId, agentVersionId: run.version.versionId };
      await expect(ledger().headroom(run.context, query)).resolves.toEqual({
        availableMicros: null,
      });
      await seedOrganizationBudget(app.db, tenant.owner, 1_000);
      await setBudget(app.db, tenant.owner, {
        scope: 'agent_version',
        agent_version_id: run.version.versionId,
        period: thisPeriod(),
        limit_micros: 300,
      });
      await expect(ledger().headroom(run.context, query)).resolves.toEqual({
        availableMicros: 300,
      });
    });
  });

  describe('settling and releasing', () => {
    it('settles what happened, even past the limit', async () => {
      const tenant = await freshTenant();
      const budgetId = await seedOrganizationBudget(app.db, tenant.owner, 100);
      const run = await startRun(tenant);
      const reservationId = await holdId(run, await startStep(tenant, run, 1), 100);
      const settle = () =>
        withTenantTx(agent.db, run.context, (tx) =>
          ledger().settle(tx, run.context, { reservationId, actualMicros: 900 }),
        );
      await settle();
      await settle();
      expect(await budgetRow(tenant, budgetId)).toMatchObject({
        reservedMicros: 0,
        spentMicros: 900,
      });
    });

    it('gives the unused reservation back on cancel', async () => {
      const tenant = await freshTenant();
      const budgetId = await seedOrganizationBudget(app.db, tenant.owner, 100);
      const run = await startRun(tenant);
      const stepId = await startStep(tenant, run, 1);
      const reservationId = await holdId(run, stepId, 100);
      await withTenantTx(agent.db, run.context, (tx) =>
        ledger().release(tx, run.context, reservationId),
      );
      expect(await budgetRow(tenant, budgetId)).toMatchObject({
        reservedMicros: 0,
        spentMicros: 0,
      });
      await expect(reserve(run, await startStep(tenant, run, 2), 100)).resolves.toMatchObject({
        ok: true,
      });
    });
  });

  describe('the ledger', () => {
    it('keeps one row for one idempotency key', async () => {
      const tenant = await freshTenant();
      const run = await startRun(tenant);
      const row = entry(run);
      await expect(record(run, row)).resolves.toBe(true);
      await expect(record(run, row)).resolves.toBe(false);
      const rows = await withTenantTx(app.db, tenant.owner, (tx) =>
        tx.select().from(usageLedger).where(eq(usageLedger.idempotencyKey, row.idempotencyKey)),
      );
      expect(rows).toHaveLength(1);
    });

    it('writes an estimate at the reserved amount for a lost answer, and over-counts', async () => {
      const tenant = await freshTenant();
      const budgetId = await seedOrganizationBudget(app.db, tenant.owner, 1_000);
      const run = await startRun(tenant);
      const stepId = await startStep(tenant, run, 7);
      const reservationId = await holdId(run, stepId, 600);
      const lost = {
        lost: { attempt: 1, reservationId, amountMicros: 600 },
        runId: run.runId,
        stepId,
        stepNumber: 7,
        workUnitId: run.workUnitId,
        profile: null,
        rateCard: null,
      };
      const write = () =>
        withTenantTx(agent.db, run.context, (tx) =>
          recordLostAnswer(ledger(), tx, run.context, lost),
        );
      await expect(write()).resolves.toBe(true);
      await expect(write()).resolves.toBe(false);

      const rows = await withTenantTx(app.db, tenant.owner, (tx) =>
        tx.select().from(usageLedger).where(eq(usageLedger.runId, run.runId)),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        idempotencyKey: modelLedgerKey(run.runId, 7, 1),
        status: 'estimated',
        costMicros: 600,
        reservationId,
      });
      expect(await budgetRow(tenant, budgetId)).toMatchObject({
        reservedMicros: 0,
        spentMicros: 600,
      });
    });

    it('estimates an interrupted call when a stopped run closes, and frees what nothing used', async () => {
      const tenant = await freshTenant();
      const budgetId = await seedOrganizationBudget(app.db, tenant.owner, 1_000);
      const run = await startRun(tenant);
      await holdId(run, await startStep(tenant, run, 1), 200);
      await holdId(run, await startStep(tenant, run, 2, { state: 'failed' }), 300);

      const close = () =>
        withTenantTx(agent.db, run.context, (tx) =>
          closeRunReservations(tx, run.context, { runId: run.runId }),
        );
      await expect(close()).resolves.toEqual({ released: 1, estimated: 1, estimatedMicros: 200 });
      await expect(close()).resolves.toEqual({ released: 0, estimated: 0, estimatedMicros: 0 });
      expect(await budgetRow(tenant, budgetId)).toMatchObject({
        reservedMicros: 0,
        spentMicros: 200,
      });
    });

    it.each(['app', 'agent', 'migrator', 'auth', 'dispatcher', 'secrets', 'superuser'] as const)(
      'refuses UPDATE, DELETE and TRUNCATE as %s',
      async (role) => {
        const run = await startRun(a);
        await record(run, entry(run));
        const client = new pg.Client({ connectionString: urls[role]() });
        await client.connect();
        try {
          await client.query(`select set_config('app.organization_id', $1, false)`, [
            a.organizationId,
          ]);
          await expect(
            client.query('update platform.usage_ledger set cost_micros = 0'),
          ).rejects.toThrow();
          await expect(client.query('delete from platform.usage_ledger')).rejects.toThrow();
          await expect(client.query('truncate platform.usage_ledger')).rejects.toThrow();
        } finally {
          await client.end();
        }
      },
    );

    it('refuses the web role moving money or writing a reservation', async () => {
      const tenant = await freshTenant();
      const budgetId = await seedOrganizationBudget(app.db, tenant.owner, 1_000);
      const run = await startRun(tenant);
      const stepId = await startStep(tenant, run, 1);
      await expect(
        withTenantTx(app.db, tenant.owner, (tx) =>
          tx.update(budgets).set({ spentMicros: 0 }).where(eq(budgets.id, budgetId)),
        ),
      ).rejects.toThrow();
      await expect(
        withTenantTx(app.db, tenant.owner, (tx) =>
          tx.insert(budgetReservations).values({
            organizationId: tenant.organizationId,
            budgetId,
            runId: run.runId,
            stepId,
            amountMicros: 1,
          }),
        ),
      ).rejects.toThrow();
      // And its own ledger, used through its own handle, cannot write either.
      const webContext = run.context;
      await expect(
        withTenantTx(app.db, webContext, (tx) =>
          createUsageLedger(app.db).record(tx, webContext, entry(run)),
        ),
      ).rejects.toThrow();
    });

    it('reconciles a run against the sum of its ledger', async () => {
      const tenant = await freshTenant();
      const run = await startRun(tenant);
      const profileId = await seedActiveProfile(app.db, agent.db, tenant.owner);
      const rateCardId = await seedRateCard(app.db, tenant.owner, profileId);
      const priced = {
        meter: 'model_input_tokens',
        unit: 'token',
        profileId,
        profileVersion: 1,
        providerKind: 'local_openai_compatible',
        rateCardId,
        rateCardVersion: 1,
      } as const;
      await record(run, entry(run, { ...priced, quantity: 25, costMicros: 25 }));
      await record(run, entry(run, { ...priced, quantity: 75, costMicros: 75 }));
      await expect(ledger().reconcileRun(run.context, run.runId)).resolves.toEqual({
        ledgerMicros: 100,
        counterMicros: 0,
        matches: false,
      });
      await withRunLookupTx(agent.db, tenant.organizationId, (tx) =>
        tx.update(agentRuns).set({ costMicros: 100 }).where(eq(agentRuns.id, run.runId)),
      );
      await expect(ledger().reconcileRun(run.context, run.runId)).resolves.toEqual({
        ledgerMicros: 100,
        counterMicros: 100,
        matches: true,
      });
    });

    it('records the rate card version, and refuses one it does not have', async () => {
      const tenant = await freshTenant();
      const run = await startRun(tenant);
      const profileId = await seedActiveProfile(app.db, agent.db, tenant.owner);
      const rateCardId = await seedRateCard(app.db, tenant.owner, profileId);
      const priced = {
        meter: 'model_input_tokens',
        unit: 'token',
        quantity: 10,
        costMicros: 10,
        rateCardId,
        profileId,
        profileVersion: 1,
      } as const;
      await expect(record(run, entry(run, { ...priced, rateCardVersion: 1 }))).resolves.toBe(true);
      await expect(record(run, entry(run, { ...priced, rateCardVersion: 2 }))).rejects.toThrow();
      await expect(
        record(run, entry(run, { ...priced, rateCardId: null, rateCardVersion: null })),
      ).rejects.toThrow();
      const [row] = await withTenantTx(app.db, tenant.owner, (tx) =>
        tx.select().from(usageLedger).where(eq(usageLedger.runId, run.runId)),
      );
      expect(row).toMatchObject({ rateCardId, rateCardVersion: 1 });
    });
  });

  describe('who pays (QA-027)', () => {
    const modelRow = (run: Run, profileId: string, rateCardId: string) =>
      entry(run, {
        meter: 'model_input_tokens',
        unit: 'token',
        quantity: 10,
        costMicros: 10,
        rateCardId,
        rateCardVersion: 1,
        profileId,
        profileVersion: 1,
      });

    const usageOf = async (tenant: AiTenant, run: Run) => {
      const [row] = await withTenantTx(app.db, tenant.owner, (tx) =>
        tx.select().from(usageLedger).where(eq(usageLedger.runId, run.runId)),
      );
      return row;
    };

    it.each(['byom', 'sovereign'] as const)(
      'marks %s usage as not billable, and labels it an estimate',
      async (mode) => {
        const tenant = await freshTenant(mode);
        const run = await startRun(tenant);
        const profileId = await seedActiveProfile(app.db, agent.db, tenant.owner);
        const rateCardId = await seedRateCard(app.db, tenant.owner, profileId);
        await record(run, modelRow(run, profileId, rateCardId));
        expect(await usageOf(tenant, run)).toMatchObject({ billable: false, commercialMode: mode });
        await expect(
          getUsageSummary(app.db, tenant.owner, { period: thisPeriod() }),
        ).resolves.toMatchObject({
          billable: false,
          is_estimate: true,
          spent_micros: 10,
          input_tokens: 10,
        });
      },
    );

    it('does not bill Cloud for a profile the customer pays for', async () => {
      const tenant = await freshTenant('cloud');
      const run = await startRun(tenant);
      const profileId = await seedActiveProfile(app.db, agent.db, tenant.owner, {
        billingOwner: 'customer',
      });
      const rateCardId = await seedRateCard(app.db, tenant.owner, profileId);
      await record(run, modelRow(run, profileId, rateCardId));
      expect(await usageOf(tenant, run)).toMatchObject({
        billable: false,
        commercialMode: 'cloud',
      });
    });

    it('bills Cloud for a profile Ensemus pays for', async () => {
      const tenant = await freshTenant('cloud');
      const run = await startRun(tenant);
      const profileId = await seedActiveProfile(app.db, agent.db, tenant.owner, {
        billingOwner: 'ensemus',
      });
      const rateCardId = await seedRateCard(app.db, tenant.owner, profileId);
      await record(run, modelRow(run, profileId, rateCardId));
      expect(await usageOf(tenant, run)).toMatchObject({ billable: true, commercialMode: 'cloud' });
    });
  });

  describe('setting a budget', () => {
    const organizationBudget = (limit: number) => ({
      scope: 'organization' as const,
      agent_version_id: null,
      period: thisPeriod(),
      limit_micros: limit,
    });

    it('refuses a member, and a run acting for the owner', async () => {
      const tenant = await freshTenant();
      await expect(setBudget(app.db, tenant.member, organizationBudget(100))).rejects.toMatchObject(
        { code: 'FORBIDDEN' },
      );
      const run = await startRun(tenant);
      await expect(setBudget(app.db, run.context, organizationBudget(100))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      const rows = await withTenantTx(app.db, tenant.owner, (tx) => tx.select().from(budgets));
      expect(rows).toEqual([]);
    });

    it('keeps one row per scope and month, leaves spending alone, and audits with no amount', async () => {
      const tenant = await freshTenant();
      const first = await setBudget(app.db, tenant.owner, organizationBudget(100));
      const again = await setBudget(app.db, tenant.owner, organizationBudget(200));
      expect(again.budgetId).toBe(first.budgetId);
      expect(await budgetRow(tenant, first.budgetId)).toMatchObject({
        limitMicros: 200,
        reservedMicros: 0,
        spentMicros: 0,
      });
      const audits = await withTenantTx(app.db, tenant.owner, (tx) =>
        tx
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.action, 'budget.set'),
              eq(auditEvents.targetRef, `budget:${first.budgetId}`),
            ),
          ),
      );
      expect(audits).toHaveLength(2);
      expect(JSON.stringify(audits)).not.toContain('200');
    });

    it('refuses a budget on another tenant’s agent version, as it would a mistyped one', async () => {
      const version = await seedAgentVersion(app.db, a.owner);
      await expect(
        setBudget(app.db, b.owner, {
          scope: 'agent_version',
          agent_version_id: version.versionId,
          period: thisPeriod(),
          limit_micros: 100,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', auditAs: 'FOREIGN_REFERENCE' });
    });
  });

  describe('across tenants', () => {
    it('shows another tenant nothing of a budget or its spending, under the same name', async () => {
      const period = thisPeriod();
      const tenantA = await freshTenant();
      const tenantB = await freshTenant();
      const budgetId = await seedOrganizationBudget(app.db, tenantA.owner, 1_000);
      const run = await startRun(tenantA);
      await holdId(run, await startStep(tenantA, run, 1), 100);
      const profileId = await seedActiveProfile(app.db, agent.db, tenantA.owner);
      const rateCardId = await seedRateCard(app.db, tenantA.owner, profileId);
      await record(
        run,
        entry(run, {
          meter: 'model_input_tokens',
          unit: 'token',
          quantity: 5,
          costMicros: 5,
          profileId,
          profileVersion: 1,
          providerKind: 'local_openai_compatible',
          rateCardId,
          rateCardVersion: 1,
        }),
      );

      await expect(listBudgets(app.db, tenantB.owner, { period })).resolves.toEqual([]);
      await expect(getUsageSummary(app.db, tenantB.owner, { period })).resolves.toMatchObject({
        limit_micros: null,
        reserved_micros: 0,
        spent_micros: 0,
      });
      const direct = await withTenantTx(app.db, tenantB.owner, (tx) =>
        tx.select().from(budgets).where(eq(budgets.id, budgetId)),
      );
      expect(direct).toEqual([]);
    });

    it('cannot settle, release, or read a reservation or run from another tenant', async () => {
      const tenantA = await freshTenant();
      const tenantB = await freshTenant();
      await seedOrganizationBudget(app.db, tenantA.owner, 1_000);
      const runA = await startRun(tenantA);
      const runB = await startRun(tenantB);
      const reservationId = await holdId(runA, await startStep(tenantA, runA, 1), 100);

      await expect(
        withTenantTx(agent.db, runB.context, (tx) =>
          ledger().settle(tx, runB.context, { reservationId, actualMicros: 1 }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        withTenantTx(agent.db, runB.context, (tx) =>
          ledger().release(tx, runB.context, reservationId),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(ledger().reconcileRun(runB.context, runA.runId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('refuses a run writing another run’s usage inside its own tenant', async () => {
      const tenant = await freshTenant();
      const first = await startRun(tenant);
      const second = await startRun(tenant);
      await expect(record(first, entry(second))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('entitlements', () => {
    const issue = async (
      organizationId: string,
      row: {
        mode: string;
        version: number;
        period: string;
        features: string[];
        capacities?: object;
      },
    ) => {
      // Nothing a tenant can write: M6's license and M8's billing do this later. Superuser stands in.
      const client = new pg.Client({ connectionString: urls.superuser() });
      await client.connect();
      try {
        await client.query(
          `insert into platform.entitlements
             (organization_id, mode, version, period, features, capacities)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            organizationId,
            row.mode,
            row.version,
            row.period,
            row.features,
            JSON.stringify(row.capacities ?? {}),
          ],
        );
      } finally {
        await client.end();
      }
    };

    it.each(['byom', 'sovereign'] as const)(
      'entitles %s with nothing billable, and no row',
      async (mode) => {
        const tenant = await freshTenant(mode);
        await expect(
          createEntitlements(agent.db).check(tenant.owner, FEATURE_MODEL_CALL),
        ).resolves.toEqual({ ok: true, billable: false, commercialMode: mode });
        await expect(getEntitlementsView(app.db, tenant.owner)).resolves.toEqual({
          mode,
          features: [FEATURE_AGENT_RUN, FEATURE_MODEL_CALL],
          capacity: {},
        });
      },
    );

    it('gives Cloud nothing until a row says so, and only what the newest row says', async () => {
      const tenant = await freshTenant('cloud');
      const entitlements = createEntitlements(agent.db);
      await expect(entitlements.check(tenant.owner, FEATURE_MODEL_CALL)).resolves.toEqual({
        ok: false,
        code: 'ENTITLEMENT_DENIED',
      });
      await expect(getEntitlementsView(app.db, tenant.owner)).resolves.toEqual({
        mode: 'cloud',
        features: [],
        capacity: {},
      });

      await issue(tenant.organizationId, {
        mode: 'cloud',
        version: 1,
        period: '2020-01',
        features: [FEATURE_MODEL_CALL],
      });
      await expect(entitlements.check(tenant.owner, FEATURE_MODEL_CALL)).resolves.toMatchObject({
        ok: false,
      });

      await issue(tenant.organizationId, {
        mode: 'cloud',
        version: 2,
        period: thisPeriod(),
        features: [FEATURE_MODEL_CALL],
        capacities: { test_capacity: 3 },
      });
      await expect(entitlements.check(tenant.owner, FEATURE_MODEL_CALL)).resolves.toEqual({
        ok: true,
        billable: true,
        commercialMode: 'cloud',
      });
      await expect(entitlements.check(tenant.owner, FEATURE_AGENT_RUN)).resolves.toMatchObject({
        ok: false,
      });
      await expect(getEntitlementsView(app.db, tenant.owner)).resolves.toEqual({
        mode: 'cloud',
        features: [FEATURE_MODEL_CALL],
        capacity: { test_capacity: 3 },
      });

      await issue(tenant.organizationId, {
        mode: 'cloud',
        version: 3,
        period: thisPeriod(),
        features: [],
      });
      await expect(entitlements.check(tenant.owner, FEATURE_MODEL_CALL)).resolves.toMatchObject({
        ok: false,
      });
    });

    it('does not let one tenant’s row reach another, and refuses a member the view', async () => {
      const tenantA = await freshTenant('cloud');
      const tenantB = await freshTenant('cloud');
      await issue(tenantA.organizationId, {
        mode: 'cloud',
        version: 1,
        period: thisPeriod(),
        features: [FEATURE_MODEL_CALL],
      });
      await expect(
        createEntitlements(agent.db).check(tenantB.owner, FEATURE_MODEL_CALL),
      ).resolves.toMatchObject({ ok: false });
      await expect(getEntitlementsView(app.db, tenantA.member)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('tells an entitlement stop from a policy stop in admin diagnostics, with counts only', async () => {
      const tenant = await freshTenant();
      const stopRun = async (status: string, stopCode: string) => {
        const run = await startRun(tenant);
        await withRunLookupTx(agent.db, tenant.organizationId, (tx) =>
          tx.update(agentRuns).set({ status, stopCode }).where(eq(agentRuns.id, run.runId)),
        );
      };
      await stopRun('policy_denied', 'ENTITLEMENT_DENIED');
      await stopRun('policy_denied', 'POLICY_DENIED');
      await stopRun('policy_denied', 'POLICY_DENIED');
      await stopRun('failed', 'MODEL_UNAVAILABLE');
      await expect(
        getStopDiagnostics(app.db, tenant.owner, { period: thisPeriod() }),
      ).resolves.toEqual([
        { code: 'ENTITLEMENT_DENIED', kind: 'entitlement', count: 1 },
        { code: 'POLICY_DENIED', kind: 'policy', count: 2 },
      ]);
    });
  });

  // These need the real gateway from the policy-router slice. Doubles stand in for everything but the
  // ledger and entitlements, and the scripted model would obey if the gateway ever reached it.
  describe('through the gateway', () => {
    const gatewayFor = (
      entitlements: Entitlements,
      router: ModelRouter,
      adapter: ScriptedModelAdapter,
      lender: RecordingLender,
    ) =>
      createInferenceGateway({
        entitlements,
        ledger: createUsageLedger(agent.db),
        withTx: (context, fn) => withTenantTx(agent.db, context, fn),
        router,
        egress: { record: async () => undefined },
        guard: {
          fetchFor: () => {
            throw new Error('nothing here should reach the network');
          },
        },
        credentials: lender,
        adapter,
        turns: {
          beginTurn: async () => {
            throw new Error('the gateway does not begin turns');
          },
          bindProfile: async () => undefined,
        },
        halt: { assertRunning: async () => undefined },
        privateEndpoints: [],
        canaries: async () => [],
      });

    const compiled = {
      messages: [],
      tools: [],
      responseSchema: null,
      task: {
        runId: '',
        purpose: 'reason' as const,
        quality: 'balanced' as const,
        required: ['text'] as const,
        classification: 'restricted' as const,
        requiredRegion: null,
        allowFallback: false,
        pinned: null,
      },
      requestHash: 'a'.repeat(64),
      maxOutputTokens: 100,
      timeoutMs: 1_000,
    };

    const stepOf = (run: Run, stepId: string) => ({
      runId: run.runId,
      stepId,
      stepNumber: 1,
      attempt: 1,
      workUnitId: run.workUnitId,
      agentVersionId: run.version.versionId,
    });

    it('stops at the entitlement, before routing, a reservation or a key', async () => {
      const tenant = await freshTenant('cloud');
      await seedOrganizationBudget(app.db, tenant.owner, 1_000_000);
      const run = await startRun(tenant);
      const stepId = await startStep(tenant, run, 1);
      const adapter = new ScriptedModelAdapter([{ kind: 'final', text: 'obeyed' }]);
      const lender = new RecordingLender(Buffer.from(randomUUID()));
      let routed = 0;
      const outcome = await gatewayFor(
        createEntitlements(agent.db),
        {
          select: async () => {
            routed += 1;
            return { kind: 'denied', reasonCode: 'NO_CANDIDATE', policyVersion: 'test' };
          },
        },
        adapter,
        lender,
      ).turn(run.context, stepOf(run, stepId), compiled, new AbortController().signal);

      expect(outcome.decisionCode).toBe('ENTITLEMENT_DENIED');
      expect(routed).toBe(0);
      expect(adapter.hits).toBe(0);
      expect(lender.asked).toEqual([]);
    });

    it('lets no entitlement override a policy denial, and names the policy as the reason', async () => {
      // Entitled to everything, with plenty of budget. The router's denial still has the last word.
      const tenant = await freshTenant('byom');
      const budgetId = await seedOrganizationBudget(app.db, tenant.owner, 1_000_000);
      const run = await startRun(tenant);
      const stepId = await startStep(tenant, run, 1);
      const adapter = new ScriptedModelAdapter([{ kind: 'final', text: 'obeyed' }]);
      const lender = new RecordingLender(Buffer.from(randomUUID()));
      const outcome = await gatewayFor(
        createEntitlements(agent.db),
        {
          select: async () => ({
            kind: 'denied',
            reasonCode: 'CLASS_DENIED',
            policyVersion: 'test',
          }),
        },
        adapter,
        lender,
      ).turn(run.context, stepOf(run, stepId), compiled, new AbortController().signal);

      expect(outcome.outcome).toBe('policy_denied');
      expect(outcome.decisionCode).toBe('CLASS_DENIED');
      expect(adapter.hits).toBe(0);
      expect(lender.asked).toEqual([]);
      expect(await budgetRow(tenant, budgetId)).toMatchObject({
        reservedMicros: 0,
        spentMicros: 0,
      });
    });

    it('denies with no rate card, before any money is held or any key opened', async () => {
      const tenant = await freshTenant('byom');
      const budgetId = await seedOrganizationBudget(app.db, tenant.owner, 1_000_000);
      const run = await startRun(tenant);
      const stepId = await startStep(tenant, run, 1);
      const adapter = new ScriptedModelAdapter([{ kind: 'final', text: 'obeyed' }]);
      const lender = new RecordingLender(Buffer.from(randomUUID()));
      const outcome = await gatewayFor(
        createEntitlements(agent.db),
        {
          select: async () => ({
            kind: 'denied',
            reasonCode: 'RATE_CARD_MISSING',
            policyVersion: 'test',
          }),
        },
        adapter,
        lender,
      ).turn(run.context, stepOf(run, stepId), compiled, new AbortController().signal);

      expect(outcome.decisionCode).toBe('RATE_CARD_MISSING');
      expect(adapter.hits).toBe(0);
      expect(lender.asked).toEqual([]);
      expect(await budgetRow(tenant, budgetId)).toMatchObject({ reservedMicros: 0 });
    });
  });
});
