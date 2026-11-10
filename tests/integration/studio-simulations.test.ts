import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import { simulationInputs, simulationRuns } from '@ensemus/database/product';
import { createServiceContext } from '@ensemus/database/service';
import { createAgentDraft, updateAgentDraft } from '@ensemus/application/agent-drafts';
import {
  getSimulation,
  requestSimulation,
  runSimulationStep,
} from '@ensemus/application/simulations';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import { makeTwoTenants, testAnswers } from '../helpers/product';
import { urls } from '../helpers/stack';
import { pgCode } from '../../packages/application/src/errors';

describe('Studio synthetic simulation snapshots', () => {
  let app: ReturnType<typeof openAppDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app());
  });
  afterAll(async () => {
    await app?.close();
  });
  it('denies members/services and foreign subjects without creating execution authority', async () => {
    const { a, b } = await makeTwoTenants(app.db),
      draft = await createAgentDraft(app.db, a.owner.context, createRuntimeProductPorts(app.db), {
        name: 'Generated simulation subject',
        answers: testAnswers(a.owner.context.membershipId),
      });
    for (const context of [a.member.context, createServiceContext(a.organizationId)])
      await expect(
        requestSimulation(app.db, context, {
          subject: { kind: 'agent_draft', draftId: draft.id },
          scenarioKey: 'standard.draft_only',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      requestSimulation(app.db, b.owner.context, {
        subject: { kind: 'agent_draft', draftId: draft.id },
        scenarioKey: 'standard.draft_only',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('runs the actual saved snapshot after editing its draft and repeats without rewriting the report', async () => {
    const { a } = await makeTwoTenants(app.db),
      ports = createRuntimeProductPorts(app.db),
      answers = testAnswers(a.owner.context.membershipId),
      draft = await createAgentDraft(app.db, a.owner.context, ports, {
        name: 'Generated immutable rehearsal',
        answers,
      }),
      simulation = await requestSimulation(app.db, a.owner.context, {
        subject: { kind: 'agent_draft', draftId: draft.id },
        scenarioKey: 'standard.draft_only',
      });
    await updateAgentDraft(app.db, a.owner.context, ports, {
      draftId: draft.id,
      expectedVersion: 1,
      answers: {
        ...answers,
        toolIds: ['work.read'],
        intendedOutcome: 'An edited read-only result with citations.',
      },
    });
    await expect(
      runSimulationStep(app.db, a.owner.context, { simulationId: simulation.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const service = createServiceContext(a.organizationId);
    // No generic service read of private immutable input without the exact admitted simulation scope.
    expect(await withTenantTx(app.db, service, (tx) => tx.select().from(simulationInputs))).toEqual(
      [],
    );
    expect(await runSimulationStep(app.db, service, { simulationId: simulation.id })).toBe(
      'passed',
    );
    const result = await getSimulation(app.db, a.owner.context, simulation.id);
    expect(result.subjectSha256).toBe(draft.specSha256);
    expect(result.report?.subjectSha256).toBe(draft.specSha256);
    expect(result.report?.steps[0]?.reasonCode).toBe('MODEL_NOT_CALLED');
    expect(await runSimulationStep(app.db, service, { simulationId: simulation.id })).toBe(
      'already_finished',
    );
    expect(await getSimulation(app.db, a.owner.context, simulation.id)).toEqual(result);
  });
  it('rolls back a direct SQL queued header without its real immutable snapshot and outbox', async () => {
    const { a } = await makeTwoTenants(app.db),
      draft = await createAgentDraft(app.db, a.owner.context, createRuntimeProductPorts(app.db), {
        name: 'Generated incomplete durable intent',
        answers: testAnswers(a.owner.context.membershipId),
      });
    expect(
      await withTenantTx(app.db, a.owner.context, (tx) =>
        tx.insert(simulationRuns).values({
          organizationId: a.organizationId,
          subjectKind: 'agent_draft',
          subjectId: draft.id,
          subjectSha256: draft.specSha256!,
          scenarioKey: 'standard.draft_only',
          requestedByMembershipId: a.owner.context.membershipId,
        }),
      ).then(() => null, pgCode),
    ).toBe('EN412');
    expect(
      await withTenantTx(app.db, a.owner.context, (tx) => tx.select().from(simulationRuns)),
    ).toEqual([]);
  });
});
