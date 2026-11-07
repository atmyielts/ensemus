import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { openAppDatabase, withTenantTx, domainEvents, workUnits } from '@ensemus/database';
import { onboardingCompletions, onboardingSteps } from '@ensemus/database/product';
import { createServiceContext } from '@ensemus/database/service';
import { createTeam, createWorkUnit, AppError } from '@ensemus/application';
import {
  getOnboarding,
  decideOnboardingStep,
  startFirstSimulation,
} from '@ensemus/application/onboarding';
import { runSimulationStep } from '@ensemus/application/simulations';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import { BUNDLED_WORKFLOWS } from '@ensemus/packs/bundled';
import { eq, sql } from 'drizzle-orm';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';
describe('company setup from actual records and explicit confirmation', () => {
  let app: ReturnType<typeof openAppDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app(), { max: 3 });
  });
  afterAll(async () => {
    await app?.close();
  });
  it('refuses members, service callers and direct SQL completion without actual required facts', async () => {
    const { a } = await makeTwoTenants(app.db),
      ports = createRuntimeProductPorts(app.db);
    for (const context of [a.member.context, createServiceContext(a.organizationId)])
      await expect(getOnboarding(app.db, context, ports)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    await expect(
      decideOnboardingStep(app.db, a.owner.context, ports, {
        step: 'second_factor',
        decision: 'skipped',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      withTenantTx(app.db, a.owner.context, (tx) =>
        tx.insert(onboardingCompletions).values({
          organizationId: a.organizationId,
          completedByMembershipId: a.owner.context.membershipId,
          firstSimulationId: '00000000-0000-4000-8000-000000000001',
          firstSimulationSha256: 'a'.repeat(64),
        }),
      ),
    ).rejects.toThrow();
  });
  it('does not turn an acknowledgement of a record-derived step into readiness', async () => {
    const { a } = await makeTwoTenants(app.db),
      ports = createRuntimeProductPorts(app.db);
    await expect(
      decideOnboardingStep(app.db, a.owner.context, ports, {
        step: 'first_work_unit',
        decision: 'acknowledged',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const state = await getOnboarding(app.db, a.owner.context, ports);
    expect(state.steps.find((s) => s.key === 'first_work_unit')?.state).toBe('to_do');
    expect(state.finished).toBe(false);
    expect(state.completionRecorded).toBe(false);
  });
  it('runs an actual immutable catalog rehearsal with no agent, connector effect or model call', async () => {
    const { a, b } = await makeTwoTenants(app.db),
      key = BUNDLED_WORKFLOWS[0]?.key;
    if (!key) throw new Error('ACTUAL_BUNDLED_CATALOG_MISSING');
    const run = await startFirstSimulation(app.db, a.owner.context, { processKey: key });
    expect(run.status).toBe('queued');
    await runSimulationStep(app.db, createServiceContext(a.organizationId), {
      simulationId: run.id,
    });
    const status = await getOnboarding(app.db, a.owner.context, createRuntimeProductPorts(app.db));
    expect(status.latestSimulation).toMatchObject({ id: run.id, status: 'passed', usable: true });
    await withTenantTx(app.db, a.owner.context, async (tx) => {
      expect((await tx.execute(sql`select count(*)::int n from ai.agent_runs`)).rows[0]).toEqual({
        n: 0,
      });
      expect(
        (await tx.execute(sql`select count(*)::int n from integrations.external_actions`)).rows[0],
      ).toEqual({ n: 0 });
      const events = await tx.select().from(domainEvents);
      expect(events.filter((e) => e.eventType === 'simulation.requested')).toHaveLength(1);
      expect(events.some((e) => e.eventType === 'execution.requested')).toBe(false);
    });
    expect(
      (await getOnboarding(app.db, b.owner.context, createRuntimeProductPorts(app.db)))
        .latestSimulation,
    ).toBeNull();
  });
  it('leaves AI unavailable and core usable, and records one completion only after all real facts', async () => {
    const { a } = await makeTwoTenants(app.db),
      unavailable = async () => {
        throw new AppError('CAPABILITY_UNAVAILABLE');
      },
      ports = { knowledge: { summary: unavailable }, modelReadiness: { summary: unavailable } };
    await decideOnboardingStep(app.db, a.owner.context, ports, {
      step: 'responsibility_statement',
      decision: 'acknowledged',
    });
    await createTeam(app.db, a.owner.context, { name: 'Generated company team' });
    await createWorkUnit(app.db, a.owner.context, { title: 'Generated first real work' });
    await proveSecondFactor(a.owner);
    const key = BUNDLED_WORKFLOWS[0]?.key;
    if (!key) throw new Error('ACTUAL_BUNDLED_CATALOG_MISSING');
    const simulation = await startFirstSimulation(app.db, a.owner.context, { processKey: key });
    await runSimulationStep(app.db, createServiceContext(a.organizationId), {
      simulationId: simulation.id,
    });
    const ready = await getOnboarding(app.db, a.owner.context, ports);
    expect(ready.finished).toBe(true);
    expect(ready.completionRecorded).toBe(false);
    expect(ready.steps.filter((s) => s.state === 'unavailable').map((s) => s.key)).toEqual([
      'first_knowledge_source',
      'model_provider',
    ]);
    const [one, two] = await Promise.all([
      decideOnboardingStep(app.db, a.owner.context, ports, {
        step: 'responsibility_statement',
        decision: 'acknowledged',
      }),
      decideOnboardingStep(app.db, a.owner.context, ports, {
        step: 'responsibility_statement',
        decision: 'acknowledged',
      }),
    ]);
    expect(one.completionRecorded).toBe(true);
    expect(two.completionRecorded).toBe(true);
    await withTenantTx(app.db, a.owner.context, async (tx) => {
      expect(await tx.select().from(onboardingCompletions)).toHaveLength(1);
      expect(
        await tx
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.eventType, 'onboarding.finished')),
      ).toHaveLength(1);
      expect(await tx.select().from(workUnits)).toHaveLength(1);
    });
  });
  it('keeps step receipts tenant-scoped and refuses a member direct SQL setup acknowledgement', async () => {
    const { a, b } = await makeTwoTenants(app.db),
      ports = createRuntimeProductPorts(app.db);
    await decideOnboardingStep(app.db, a.owner.context, ports, {
      step: 'responsibility_statement',
      decision: 'acknowledged',
    });
    expect(
      (await getOnboarding(app.db, b.owner.context, ports)).steps.find(
        (s) => s.key === 'responsibility_statement',
      )?.state,
    ).toBe('to_do');
    await expect(
      withTenantTx(app.db, a.member.context, (tx) =>
        tx.insert(onboardingSteps).values({
          organizationId: a.organizationId,
          stepKey: 'model_provider',
          status: 'skipped',
          decidedByMembershipId: a.member.context.membershipId,
        }),
      ),
    ).rejects.toThrow();
  });
});
