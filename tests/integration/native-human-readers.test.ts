import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { processDrafts, outcomeDrafts, simulationInputs } from '@ensemus/database/product';
import { createProcessDraft } from '@ensemus/application/process-specs';
import { composeOutcome } from '@ensemus/application/outcomes';
import { createAgentDraft } from '@ensemus/application/agent-drafts';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import { requestSimulation, runSimulationStep } from '@ensemus/application/simulations';
import { eq, sql } from 'drizzle-orm';
import { makeTwoTenants, proveSecondFactor, testAnswers } from '../helpers/product';
import { urls } from '../helpers/stack';

describe('native readers of human drafts and admitted rehearsals', () => {
  let web: ReturnType<typeof openAppDatabase>, people: Awaited<ReturnType<typeof makeTwoTenants>>;
  const roles = new Map<string, ReturnType<typeof openAppDatabase>>();
  beforeAll(async () => {
    web = openAppDatabase(urls.app());
    people = await makeTwoTenants(web.db);
    await proveSecondFactor(people.a.owner);
    for (const [name, url] of [
      ['agent', urls.agent()],
      ['worker', urls.worker()],
      ['connector', urls.connector()],
      ['knowledge', urls.knowledge()],
    ] as const)
      roles.set(name, openAppDatabase(url));
  });
  afterAll(async () => {
    await web?.close();
    for (const db of roles.values()) await db.close();
  });
  it('keeps private Studio and personal outcome rows out of every native worker even with user bindings and SET ROLE', async () => {
    const owner = people.a.owner.context,
      member = people.a.member.context;
    const draft = await createProcessDraft(web.db, owner, {
      name: 'Generated private process',
      classification: 'restricted',
    });
    const outcome = await composeOutcome(web.db, member, {
      objective: 'Generated private outcome for native-role qualification',
      today: '2026-11-21',
    });
    for (const [name, db] of roles) {
      expect
        .soft(
          await withTenantTx(db.db, owner, async (tx) => {
            await tx.execute(sql`set local role ensemus_app`);
            return tx
              .select({ id: processDrafts.id })
              .from(processDrafts)
              .where(eq(processDrafts.id, draft.id));
          }),
          name + ' Studio reader',
        )
        .toEqual([]);
      expect
        .soft(
          await withTenantTx(db.db, member, async (tx) => {
            await tx.execute(sql`set local role ensemus_app`);
            return tx
              .select({ id: outcomeDrafts.id })
              .from(outcomeDrafts)
              .where(eq(outcomeDrafts.id, outcome.id));
          }),
          name + ' personal reader',
        )
        .toEqual([]);
    }
    expect(
      await withTenantTx(web.db, owner, (tx) =>
        tx
          .select({ id: processDrafts.id })
          .from(processDrafts)
          .where(eq(processDrafts.id, draft.id)),
      ),
    ).toEqual([{ id: draft.id }]);
    expect(
      await withTenantTx(web.db, member, (tx) =>
        tx
          .select({ id: outcomeDrafts.id })
          .from(outcomeDrafts)
          .where(eq(outcomeDrafts.id, outcome.id)),
      ),
    ).toEqual([{ id: outcome.id }]);
    expect(
      await withTenantTx(web.db, people.a.admin.context, (tx) =>
        tx
          .select({ id: processDrafts.id })
          .from(processDrafts)
          .where(eq(processDrafts.id, draft.id)),
      ),
    ).toEqual([]);
    expect(
      await withTenantTx(web.db, people.a.admin.context, (tx) =>
        tx
          .select({ id: outcomeDrafts.id })
          .from(outcomeDrafts)
          .where(eq(outcomeDrafts.id, outcome.id)),
      ),
    ).toEqual([]);
  });
  it('keeps the actual immutable rehearsal input exclusive to its native platform worker and exact durable intent', async () => {
    const owner = people.a.owner.context,
      svc = createServiceContext(owner.organizationId);
    const draft = await createAgentDraft(web.db, owner, createRuntimeProductPorts(web.db), {
      name: 'Generated private rehearsal',
      answers: testAnswers(owner.membershipId),
    });
    const rehearsal = await requestSimulation(web.db, owner, {
      subject: { kind: 'agent_draft', draftId: draft.id },
      scenarioKey: 'standard.draft_only',
    });
    const input = (db: ReturnType<typeof openAppDatabase>, scope: string) =>
      withTenantTx(db.db, svc, async (tx) => {
        await tx.execute(sql`select set_config('app.studio_simulation_id',${scope},true)`);
        return tx.select({ id: simulationInputs.simulationRunId }).from(simulationInputs);
      });
    for (const [name, db] of roles)
      if (name !== 'worker')
        expect(await input(db, rehearsal.id), name + ' service impersonation').toEqual([]);
    expect(await input(web, rehearsal.id), 'web service impersonation').toEqual([]);
    const worker = roles.get('worker')!;
    expect(await input(worker, ''), 'missing exact intent').toEqual([]);
    expect(await input(worker, rehearsal.id)).toEqual([{ id: rehearsal.id }]);
    expect(await runSimulationStep(worker.db, svc, { simulationId: rehearsal.id })).toBe('passed');
  });
});
