// Private Work and its review/effect bodies must not be readable merely from the bound tenant.
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  openAppDatabase,
  withTenantTx,
  workUnits,
  approvals,
  externalActions,
  workTransitions,
  approvalDecisions,
} from '@ensemus/database';
import { createServiceContext, createDelegatedContext } from '@ensemus/database/service';
import {
  createWorkUnit,
  getWorkUnit,
  proposeExternalAction,
  decideApproval,
  transitionWorkUnit,
} from '@ensemus/application';
import { EMAIL_SEND_TOOL, EMAIL_SEND_VERSION } from '@ensemus/domain/external-action';
import { eq, sql } from 'drizzle-orm';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { seedConnection } from '../helpers/integrations';
import { urls } from '../helpers/stack';
describe('private Work material through actual native readers', () => {
  let web: ReturnType<typeof openAppDatabase>, people: Awaited<ReturnType<typeof makeTwoTenants>>;
  const native = new Map<string, ReturnType<typeof openAppDatabase>>();
  beforeAll(async () => {
    web = openAppDatabase(urls.app());
    people = await makeTwoTenants(web.db);
    await proveSecondFactor(people.a.owner);
    for (const [role, url] of [
      ['agent', urls.agent()],
      ['worker', urls.worker()],
      ['connector', urls.connector()],
      ['knowledge', urls.knowledge()],
    ] as const)
      native.set(role, openAppDatabase(url));
  });
  afterAll(async () => {
    await web?.close();
    for (const db of native.values()) await db.close();
  });
  it('holds the existing DAL private-Work rule on raw Work, approval and action reads too', async () => {
    const owner = people.a.owner.context;
    const work = await createWorkUnit(web.db, owner, {
      title: 'Generated confidential work',
      objective: 'GENERATED-PRIVATE-WORK-BODY',
      classification: 'confidential',
    });
    const connectionId = await seedConnection(web.db, owner, {
      config: { fromAddress: 'generated-sender@example.invalid' },
    });
    const action = await proposeExternalAction(web.db, owner, {
      workUnitId: work.id,
      connectionId,
      toolName: EMAIL_SEND_TOOL,
      toolVersion: EMAIL_SEND_VERSION,
      payload: {
        to: ['generated-recipient@example.invalid'],
        subject: 'Generated private effect',
        text_body: 'GENERATED-PRIVATE-EFFECT-BODY',
      },
      approverMembershipId: people.a.admin.context.membershipId,
    });
    await decideApproval(web.db, people.a.admin.context, {
      approvalId: action.approvalId,
      decision: 'deny',
      shownHash: action.requestHash,
      reason: 'GENERATED-PRIVATE-DECISION-REASON',
    });
    await transitionWorkUnit(web.db, owner, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
      reason: 'GENERATED-PRIVATE-TRANSITION-REASON',
    });
    await expect(getWorkUnit(web.db, people.a.member.context, work.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const body = async (
      db: ReturnType<typeof openAppDatabase>,
      context: typeof owner,
      setRole = false,
    ) =>
      withTenantTx(db.db, context, async (tx) => {
        if (setRole) await tx.execute(sql`set local role ensemus_app`);
        return {
          work: await tx
            .select({ objective: workUnits.objective })
            .from(workUnits)
            .where(eq(workUnits.id, work.id)),
          review: await tx
            .select({ action: approvals.action })
            .from(approvals)
            .where(eq(approvals.id, action.approvalId)),
          history: await tx
            .select({ reason: workTransitions.reason })
            .from(workTransitions)
            .where(eq(workTransitions.workUnitId, work.id)),
          decision: await tx
            .select({ reason: approvalDecisions.reason })
            .from(approvalDecisions)
            .where(eq(approvalDecisions.approvalId, action.approvalId)),
          effect: await tx
            .select({ payload: externalActions.payload })
            .from(externalActions)
            .where(eq(externalActions.id, action.externalActionId)),
        };
      });
    expect
      .soft(await body(web, people.a.member.context), 'unassigned actual member')
      .toEqual({ work: [], review: [], effect: [], history: [], decision: [] });
    expect(await body(web, people.b.owner.context), 'other company').toEqual({
      work: [],
      review: [],
      effect: [],
      history: [],
      decision: [],
    });
    for (const [role, db] of native)
      expect
        .soft(await body(db, owner, true), role + ' with copied human bindings')
        .toEqual({ work: [], review: [], effect: [], history: [], decision: [] });
    expect
      .soft(
        await body(web, createServiceContext(owner.organizationId)),
        'web without a worker login',
      )
      .toEqual({ work: [], review: [], effect: [], history: [], decision: [] });
    for (const role of ['agent', 'knowledge'])
      expect
        .soft(
          await body(native.get(role)!, createServiceContext(owner.organizationId)),
          role + ' without an admitted service purpose',
        )
        .toEqual({ work: [], review: [], effect: [], history: [], decision: [] });
    expect(
      await body(
        native.get('worker')!,
        await createDelegatedContext(
          native.get('worker')!.db,
          owner.organizationId,
          owner.membershipId,
        ),
      ),
      'delegated worker without an actual process intent',
    ).toEqual({ work: [], review: [], effect: [], history: [], decision: [] });
    for (const context of [owner, people.a.admin.context]) {
      const allowed = await body(web, context);
      expect(allowed.work).toEqual([{ objective: 'GENERATED-PRIVATE-WORK-BODY' }]);
      expect(allowed.review).toHaveLength(1);
      expect(allowed.effect).toHaveLength(1);
      expect(allowed.history).toEqual([{ reason: 'GENERATED-PRIVATE-TRANSITION-REASON' }]);
      expect(allowed.decision).toEqual([{ reason: 'GENERATED-PRIVATE-DECISION-REASON' }]);
    }
  });
});
