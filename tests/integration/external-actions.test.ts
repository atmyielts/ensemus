// WORK-08, QA-007, QA-008, AI-TS-01, SEC-06 (ADR-027 D1 and D2). Real PostgreSQL, real roles and triggers,
// real Activities, and the same runExternalAction the workflow runs. Only the provider is scripted, because
// the point is to count how many times it was reached. Faults are injected at every step boundary, and each
// is asserted by the number of effects at the provider rather than by what a row says.
import { randomUUID } from 'node:crypto';
import { NotSent, type Connector, type ConnectorRegistry } from '@ensemus/connectors';
import {
  assignContributor,
  beginAttempt,
  beginReconcile,
  countVerifiedReceipts,
  createWorkUnit,
  decideApproval,
  expireOverdueApprovals,
  failUnsent,
  finishAttempt,
  finishReconcile,
  getWorkDetail,
  getWorkUnit,
  inspectInterrupted,
  listWorkOverview,
  onApprovalClosedInTx,
  proposeExternalAction,
  retryExternalAction,
  reviseExternalAction,
  transitionWorkUnit,
  type ExternalActionGateway,
  type PreparedAttempt,
} from '@ensemus/application';
import {
  approvals,
  connections,
  createOrganization,
  domainEvents,
  externalActionAttempts,
  externalActionReceipts,
  externalActions,
  notifications,
  openAppDatabase,
  outboxEvents,
  resolveTenantContext,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  EMAIL_SEND_TOOL,
  EMAIL_SEND_VERSION,
  MAX_SEND_ATTEMPTS,
  type AttemptResult,
  type ExternalActionStatus,
  type ReconcileResult,
} from '@ensemus/domain/external-action';
import type { WorkState } from '@ensemus/domain/work-unit';
import {
  createConnectorGateway,
  createExternalActionActivities,
} from '@ensemus/workflows/external-action-activities';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runExternalAction } from '../../packages/workflows/src/external-action-step';
import { seedConnection, seedExternalAction, testEmailPayload } from '../helpers/integrations';
import { urls } from '../helpers/stack';
import {
  createScriptedGateway,
  type ScriptedGateway,
  type SendScript,
} from './fixtures/scripted-gateway';

// The SDK's own runSend has its own tests in its own slice, and its stub throws until that lands. This
// double does the part of its job the connector gateway leans on: NotSent means not sent, and anything
// else is indeterminate.
vi.mock('@ensemus/connectors/runtime', async () => {
  const { NotSent: Thrown } = await import('@ensemus/connectors');
  return {
    runSend: async (call: {
      connector: Connector;
      context: object;
      request: never;
    }): Promise<AttemptResult> => {
      try {
        return await call.connector.actions!.send(
          { ...call.context, signal: new AbortController().signal } as never,
          call.request,
        );
      } catch (error) {
        if (error instanceof Thrown) {
          return { outcome: 'not_sent', code: error.code, retryable: error.retryable };
        }
        return { outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT' };
      }
    },
    runReconcile: async (call: {
      connector: Connector;
      context: object;
      request: never;
    }): Promise<ReconcileResult> =>
      call.connector.actions!.reconcile(
        { ...call.context, signal: new AbortController().signal } as never,
        call.request,
      ),
  };
});

const code = (name: string) => expect.objectContaining({ code: name });
const SENDER = 'sender@example.invalid';
const CANARY = 'canary-7b1f@example.invalid';
const mail = (overrides: Record<string, unknown> = {}) => ({
  to: ['recipient@example.invalid'],
  subject: 'A test message',
  text_body: 'Nothing here is real.',
  ...overrides,
});

/** How a transaction dies: before it starts, inside it so it rolls back, or after it commits. */
type DbFault = 'before' | 'rollback' | 'after_commit';

/**
 * The database as a worker sees it through an outage. Counts transactions, and fails the ones named. The
 * last case is the nasty one: the row is committed, and the worker never hears.
 */
function flaky(real: AppDatabase, faults: Readonly<Record<number, DbFault>>): AppDatabase {
  let call = 0;
  const lost = () => new Error('Connection terminated unexpectedly');
  return {
    transaction: async (bindings: Record<string, string>, fn: (tx: never) => Promise<unknown>) => {
      call += 1;
      const fault = faults[call];
      if (fault === 'before') throw lost();
      if (fault === 'rollback') {
        return real.transaction(bindings, async (tx) => {
          await fn(tx as never);
          throw lost();
        });
      }
      const result = await real.transaction(bindings, fn as never);
      if (fault === 'after_commit') throw lost();
      return result;
    },
    run: (fn: never) => real.run(fn),
  } as unknown as AppDatabase;
}

describe('verified external actions', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let superuser: pg.Client;
  let owner: TenantContext;
  let approver: TenantContext;
  let contributor: TenantContext;
  let bystander: TenantContext;
  let other: TenantContext;
  let connection: string;
  let otherConnection: string;

  const db = () => database.db;

  const makeUser = async (label: string) => {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      `${label}-${id}@example.invalid`,
    ]);
    return id;
  };

  const newOrg = async (label: string) => {
    const user = await makeUser(label);
    const { organizationId } = await createOrganization(db(), {
      userId: user,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    return resolveTenantContext(db(), user, organizationId);
  };

  const join = async (context: TenantContext, label: string) => {
    const user = await makeUser(label);
    await withTenantTx(db(), context, (tx) =>
      tx.execute(
        sql`insert into org.memberships (organization_id, id, user_id, role)
            values (${context.organizationId}, ${randomUUID()}, ${user}, 'member')`,
      ),
    );
    return resolveTenantContext(db(), user, context.organizationId);
  };

  const newWork = async (context = owner, extra: Record<string, unknown> = {}) =>
    (await createWorkUnit(db(), context, { title: 'Tell them', objective: 'Say it.', ...extra }))
      .id;

  const walkWork = async (id: string, statuses: WorkState[], reason?: string) => {
    let current = await getWorkUnit(db(), owner, id);
    for (const to of statuses) {
      current = await transitionWorkUnit(db(), owner, {
        id,
        expectedVersion: current.version,
        to,
        ...(reason ? { reason } : {}),
      });
    }
    return current;
  };

  const propose = async (
    overrides: Partial<Parameters<typeof proposeExternalAction>[2]> = {},
    context = owner,
  ) =>
    proposeExternalAction(db(), context, {
      workUnitId: overrides.workUnitId ?? (await newWork()),
      connectionId: connection,
      toolName: EMAIL_SEND_TOOL,
      toolVersion: EMAIL_SEND_VERSION,
      payload: mail(),
      approverMembershipId: approver.membershipId,
      ...overrides,
    });

  const approve = (proposal: { approvalId: string; requestHash: string }) =>
    decideApproval(db(), approver, {
      approvalId: proposal.approvalId,
      decision: 'approve',
      shownHash: proposal.requestHash,
    });

  const readyToSend = async (overrides: Parameters<typeof propose>[0] = {}) => {
    const proposal = await propose(overrides);
    await approve(proposal);
    return proposal;
  };

  const rowOf = async (id: string) => {
    const [row] = await withTenantTx(db(), owner, (tx) =>
      tx.select().from(externalActions).where(eq(externalActions.id, id)),
    );
    if (!row) throw new Error('No such intent');
    return row;
  };
  const statusOf = async (id: string) => (await rowOf(id)).status as ExternalActionStatus;
  const attemptsOf = (id: string) =>
    withTenantTx(db(), owner, (tx) =>
      tx
        .select()
        .from(externalActionAttempts)
        .where(eq(externalActionAttempts.externalActionId, id)),
    );
  const receiptsOf = (id: string) =>
    withTenantTx(db(), owner, (tx) =>
      tx
        .select()
        .from(externalActionReceipts)
        .where(eq(externalActionReceipts.externalActionId, id)),
    );
  const notificationsAbout = (id: string, context = owner) =>
    withTenantTx(db(), context, (tx) =>
      tx
        .select()
        .from(notifications)
        .where(eq(notifications.targetRef, `external_action:${id}`)),
    );
  const eventsAbout = (id: string) =>
    withTenantTx(db(), owner, (tx) =>
      tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, id)),
    );

  const inputFor = (id: string, context = owner) => ({
    organizationId: context.organizationId,
    externalActionId: id,
  });

  const activitiesOver = (gateway: ExternalActionGateway, over: AppDatabase = db()) =>
    createExternalActionActivities(over, gateway);

  /**
   * The workflow, as far as anything here can tell: the same runExternalAction, over real Activities. A
   * send whose worker died never answers, so Temporal's timeout is what the workflow sees, and that is what
   * this does as soon as the gateway goes quiet. The Activity is left hanging, as a zombie would be.
   */
  function drive(
    gateway: ScriptedGateway,
    id: string,
    options: { worker?: AppDatabase; beforeEachStep?: () => Promise<void> } = {},
  ) {
    const worker = activitiesOver(gateway, options.worker ?? db());
    const platform = activitiesOver(gateway);
    const input = inputFor(id);
    const run = { ...input, runId: randomUUID() };
    let reported = false;
    const pending: Promise<unknown>[] = [];
    const hook = async () => options.beforeEachStep?.();
    return {
      pending,
      run: () =>
        runExternalAction({
          send: async () => {
            await hook();
            const send = worker.sendExternalAction(run);
            pending.push(send.catch(() => undefined));
            if (reported) return send;
            const died = gateway.died().then(() => {
              reported = true;
              throw new Error('Temporal timed the Activity out');
            });
            return Promise.race([send, died]);
          },
          inspect: async () => {
            await hook();
            return platform.inspectInterruptedAction(input);
          },
          reconcile: async (reconcileCode) => {
            await hook();
            return worker.reconcileExternalAction({ ...input, code: reconcileCode });
          },
          concludeWithoutAnswer: (reconcileCode) =>
            platform.concludeWithoutAnswer({ ...input, code: reconcileCode }),
          failUnsent: (failCode) => platform.failUnsentAction({ ...input, code: failCode }),
          outcome: () => platform.settledActionOutcome(input),
          sleep: async () => undefined,
          neverPickedUp: () => false,
        }),
    };
  }

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    superuser = new pg.Client({ connectionString: urls.superuser() });
    await superuser.connect();
    owner = await newOrg('owner');
    other = await newOrg('other');
    approver = await join(owner, 'approver');
    contributor = await join(owner, 'contributor');
    bystander = await join(owner, 'bystander');
    connection = await seedConnection(db(), owner, { config: { fromAddress: SENDER } });
    otherConnection = await seedConnection(db(), other, { config: { fromAddress: SENDER } });
  });

  afterAll(async () => {
    await database?.close();
    await auth?.end();
    await superuser?.end();
  });

  describe('proposing', () => {
    it('writes one intent and one approval with the same hash, and tells nothing outside of it', async () => {
      const proposal = await propose({ payload: mail({ to: [CANARY] }) });
      const row = await rowOf(proposal.externalActionId);
      expect(row).toMatchObject({
        status: 'awaiting_approval',
        requestHash: proposal.requestHash,
        approvalId: proposal.approvalId,
        idempotencyKey: `ensemus-${proposal.externalActionId}`,
        classification: 'internal',
        createdByMembershipId: owner.membershipId,
      });
      const [approval] = await withTenantTx(db(), owner, (tx) =>
        tx.select().from(approvals).where(eq(approvals.id, proposal.approvalId)),
      );
      expect(approval?.actionHash).toBe(proposal.requestHash);
      const events = await eventsAbout(proposal.externalActionId);
      expect(events.map((event) => event.eventType)).toEqual(['external_action.proposed']);
      expect(JSON.stringify(events)).not.toContain(CANARY);
    });

    it('lets a service ask on a webhook’s behalf, with the owner to decide and no requester', async () => {
      const work = await newWork();
      const service = createServiceContext(owner.organizationId);
      const proposal = await proposeExternalAction(db(), service, {
        workUnitId: work,
        connectionId: connection,
        toolName: EMAIL_SEND_TOOL,
        toolVersion: EMAIL_SEND_VERSION,
        payload: mail(),
        approverMembershipId: owner.membershipId,
      });
      expect((await rowOf(proposal.externalActionId)).createdByMembershipId).toBeNull();
      const [approval] = await withTenantTx(db(), owner, (tx) =>
        tx.select().from(approvals).where(eq(approvals.id, proposal.approvalId)),
      );
      expect(approval).toMatchObject({
        approverMembershipId: owner.membershipId,
        requestedByMembershipId: null,
      });
      await expect(
        decideApproval(db(), owner, {
          approvalId: proposal.approvalId,
          decision: 'approve',
          shownHash: proposal.requestHash,
        }),
      ).resolves.toEqual({ status: 'approved' });
    });

    it('freezes the sender from the connection, so changing the connection changes nothing approved', async () => {
      const own = await seedConnection(db(), owner, { config: { fromAddress: SENDER } });
      const proposal = await propose({ connectionId: own });
      await withTenantTx(db(), owner, (tx) =>
        tx
          .update(connections)
          .set({ config: { fromAddress: 'someone-else@example.invalid' } })
          .where(eq(connections.id, own)),
      );
      expect((await rowOf(proposal.externalActionId)).payload).toMatchObject({
        from: { address: SENDER },
      });
    });

    it('refuses a payload naming a sender other than the connection', async () => {
      await expect(
        propose({ payload: mail({ from: { address: 'spoof@example.invalid' } }) }),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });

    it('refuses a connection with no sender set', async () => {
      const none = await seedConnection(db(), owner);
      await expect(propose({ connectionId: none })).rejects.toEqual(code('INVALID_INPUT'));
    });

    it.each([
      ['a line break in the subject', mail({ subject: 'Hi\r\nBcc: x@example.invalid' })],
      ['no recipient', mail({ to: [] })],
      ['a bad address', mail({ to: ['not an address'] })],
      ['an extra field', mail({ attachments: [] })],
    ])('refuses %s', async (_label, payload) => {
      await expect(propose({ payload })).rejects.toEqual(code('INVALID_INPUT'));
    });

    it('refuses a tool nothing knows about', async () => {
      await expect(propose({ toolName: 'wire.transfer' })).rejects.toEqual(code('INVALID_INPUT'));
      await expect(propose({ toolVersion: '99' })).rejects.toEqual(code('INVALID_INPUT'));
    });

    it('refuses a connection whose type cannot perform it', async () => {
      const inbound = await seedConnection(db(), owner, { connectorType: 'inbound_webhook' });
      await expect(propose({ connectionId: inbound })).rejects.toEqual(code('INVALID_INPUT'));
    });

    it('refuses restricted work, even from a service', async () => {
      const work = await newWork(owner, { classification: 'restricted' });
      await expect(propose({ workUnitId: work })).rejects.toEqual(code('RESTRICTED_NOT_ALLOWED'));
      await expect(
        propose({ workUnitId: work }, createServiceContext(owner.organizationId)),
      ).rejects.toEqual(code('RESTRICTED_NOT_ALLOWED'));
    });

    it('refuses a proposer naming themselves as approver', async () => {
      await expect(propose({ approverMembershipId: owner.membershipId })).rejects.toEqual(
        code('APPROVAL_SELF_APPROVAL'),
      );
    });

    it('refuses an approver who could not see what they would approve', async () => {
      const work = await newWork(owner, { classification: 'confidential' });
      await expect(propose({ workUnitId: work })).rejects.toEqual(code('INVALID_INPUT'));
    });

    it('refuses a connection that is not active', async () => {
      const revoked = await seedConnection(db(), owner, {
        config: { fromAddress: SENDER },
        state: 'revoked',
      });
      await expect(propose({ connectionId: revoked })).rejects.toEqual(
        code('CONNECTION_NOT_ACTIVE'),
      );
    });

    it("answers not found for another tenant's Work Unit or connection", async () => {
      const theirs = await newWork(other);
      await expect(propose({ workUnitId: theirs })).rejects.toEqual(code('NOT_FOUND'));
      await expect(propose({ connectionId: otherConnection })).rejects.toEqual(code('NOT_FOUND'));
    });

    it('answers not found to a member who cannot see the work', async () => {
      const work = await newWork(owner, { classification: 'confidential' });
      await expect(
        proposeExternalAction(db(), bystander, {
          workUnitId: work,
          connectionId: connection,
          toolName: EMAIL_SEND_TOOL,
          toolVersion: EMAIL_SEND_VERSION,
          payload: mail(),
          approverMembershipId: approver.membershipId,
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
    });

    it('refuses a member who can read the work and has no part in it', async () => {
      await expect(
        proposeExternalAction(db(), bystander, {
          workUnitId: await newWork(),
          connectionId: connection,
          toolName: EMAIL_SEND_TOOL,
          toolVersion: EMAIL_SEND_VERSION,
          payload: mail(),
          approverMembershipId: approver.membershipId,
        }),
      ).rejects.toEqual(code('FORBIDDEN'));
    });

    it('leaves nothing behind when it is refused', async () => {
      const work = await newWork();
      await expect(propose({ workUnitId: work, payload: mail({ to: [] }) })).rejects.toBeInstanceOf(
        Error,
      );
      const rows = await withTenantTx(db(), owner, (tx) =>
        tx.select().from(approvals).where(eq(approvals.workUnitId, work)),
      );
      expect(rows).toEqual([]);
    });
  });

  describe('deciding', () => {
    it('moves to ready and emits the one event that starts a workflow, on approval', async () => {
      const proposal = await propose();
      await approve(proposal);
      const row = await rowOf(proposal.externalActionId);
      expect(row.status).toBe('ready');
      const events = await eventsAbout(proposal.externalActionId);
      expect(events.map((event) => event.eventType)).toEqual([
        'external_action.proposed',
        'external_action.ready',
      ]);
      const ready = events.find((event) => event.eventType === 'external_action.ready');
      const queued = await withTenantTx(db(), owner, (tx) =>
        tx
          .select()
          .from(outboxEvents)
          .where(eq(outboxEvents.eventId, ready?.id as string)),
      );
      expect(queued).toHaveLength(1);
    });

    it('cancels on denial, and nothing can send it', async () => {
      const proposal = await propose();
      await decideApproval(db(), approver, {
        approvalId: proposal.approvalId,
        decision: 'deny',
        shownHash: proposal.requestHash,
        reason: 'No.',
      });
      const row = await rowOf(proposal.externalActionId);
      expect(row).toMatchObject({ status: 'cancelled', statusReason: 'APPROVAL_DENIED' });
      const gateway = createScriptedGateway([]);
      await expect(
        activitiesOver(gateway).sendExternalAction({
          ...inputFor(proposal.externalActionId),
          runId: 'r',
        }),
      ).resolves.toEqual({ step: 'cancelled' });
      expect(gateway.sendCalls()).toBe(0);
    });

    it('cancels when the approval expires', async () => {
      const proposal = await propose({ expiresAt: new Date(Date.now() + 60_000) });
      await expireOverdueApprovals(
        db(),
        createServiceContext(owner.organizationId),
        new Date(Date.now() + 120_000),
      );
      expect(await rowOf(proposal.externalActionId)).toMatchObject({
        status: 'cancelled',
        statusReason: 'APPROVAL_EXPIRED',
      });
    });

    it('cancels when the work stops with the decision still open', async () => {
      const work = await newWork();
      const proposal = await propose({ workUnitId: work });
      await walkWork(work, ['cancelled']);
      expect(await rowOf(proposal.externalActionId)).toMatchObject({
        status: 'cancelled',
        statusReason: 'APPROVAL_NOT_VALID',
      });
    });

    it('cancels an approved intent when reopening the work voids its approval', async () => {
      const work = await newWork();
      const proposal = await readyToSend({ workUnitId: work });
      await walkWork(work, ['ready', 'running', 'verifying', 'completed']);
      await walkWork(work, ['ready'], 'Going round again.');
      expect(await rowOf(proposal.externalActionId)).toMatchObject({
        status: 'cancelled',
        statusReason: 'APPROVAL_NOT_VALID',
      });
    });

    it('does not let someone else decide it, or decide what they were not shown', async () => {
      const proposal = await propose();
      await expect(
        decideApproval(db(), contributor, {
          approvalId: proposal.approvalId,
          decision: 'approve',
          shownHash: proposal.requestHash,
        }),
      ).rejects.toEqual(code('APPROVAL_WRONG_APPROVER'));
      await expect(
        decideApproval(db(), approver, {
          approvalId: proposal.approvalId,
          decision: 'approve',
          shownHash: 'f'.repeat(64),
        }),
      ).rejects.toEqual(code('APPROVAL_HASH_MISMATCH'));
      expect(await statusOf(proposal.externalActionId)).toBe('awaiting_approval');
    });

    it('refuses to approve when the stored payload no longer matches what it binds', async () => {
      const proposal = await propose();
      await superuser.query(
        `update integrations.external_actions set payload = payload || '{"to":["x@example.invalid"]}'
          where id = $1`,
        [proposal.externalActionId],
      );
      await expect(approve(proposal)).rejects.toEqual(code('APPROVAL_STALE'));
      expect(await statusOf(proposal.externalActionId)).toBe('awaiting_approval');
    });

    it('pauses running work while it waits, and approval hands it back', async () => {
      const work = await newWork();
      await walkWork(work, ['ready', 'running']);
      const proposal = await propose({ workUnitId: work });
      expect((await getWorkUnit(db(), owner, work)).status).toBe('awaiting_approval');
      await approve(proposal);
      expect((await getWorkUnit(db(), owner, work)).status).toBe('running');
      expect(await statusOf(proposal.externalActionId)).toBe('ready');
    });

    it('does not touch an approval that belongs to no intent', async () => {
      await expect(
        withTenantTx(db(), owner, (tx) =>
          onApprovalClosedInTx(tx, owner, { approvalId: randomUUID(), outcome: 'denied' }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('sending, with nothing going wrong', () => {
    it('records the attempt before the send, then one effect, one receipt, and tells people', async () => {
      const work = await newWork();
      await assign(work, contributor.membershipId);
      const proposal = await proposeExternalAction(db(), contributor, {
        workUnitId: work,
        connectionId: connection,
        toolName: EMAIL_SEND_TOOL,
        toolVersion: EMAIL_SEND_VERSION,
        payload: mail(),
        approverMembershipId: approver.membershipId,
      });
      await approve(proposal);
      const id = proposal.externalActionId;
      let seenAtSend: ExternalActionStatus | undefined;
      let attemptsAtSend = -1;
      const script = createScriptedGateway(['accept']);
      const gateway: ExternalActionGateway = {
        ...script,
        send: async (organizationId, attempt) => {
          // The whole point of the boundary: by the time anything leaves, the record is committed.
          seenAtSend = await statusOf(id);
          attemptsAtSend = (await attemptsOf(id)).length;
          return script.send(organizationId, attempt);
        },
      };
      await expect(
        activitiesOver(gateway).sendExternalAction({ ...inputFor(id), runId: 'run-1' }),
      ).resolves.toEqual({ step: 'sent' });
      expect(seenAtSend).toBe('sending');
      expect(attemptsAtSend).toBe(1);
      expect(script.effects()).toHaveLength(1);
      expect(script.effects()[0]).toMatchObject({
        idempotencyKey: `ensemus-${id}`,
        requestHash: proposal.requestHash,
        payload: expect.objectContaining({ from: { address: SENDER } }),
      });

      expect(await rowOf(id)).toMatchObject({
        status: 'sent',
        statusReason: 'ACCEPTED_BY_RELAY',
        externalId: `<${id}@test.invalid>`,
      });
      expect((await rowOf(id)).settledAt).toBeInstanceOf(Date);
      expect(await attemptsOf(id)).toEqual([
        expect.objectContaining({
          attemptNo: 1,
          runId: 'run-1',
          outcome: 'accepted',
          outcomeCode: 'ACCEPTED_BY_RELAY',
          providerStatus: 250,
        }),
      ]);
      expect(await receiptsOf(id)).toEqual([
        expect.objectContaining({
          outcome: 'sent',
          basis: 'provider',
          code: 'ACCEPTED_BY_RELAY',
          externalId: `<${id}@test.invalid>`,
          requestHash: proposal.requestHash,
        }),
      ]);
      expect((await notificationsAbout(id, owner)).map((n) => n.kind).sort()).toEqual([
        'external_action.sent',
        'external_action.sent',
      ]);
    });

    it('records an answer once, however many times it is told and whatever else it is told', async () => {
      const { externalActionId: id } = await readyToSend();
      const service = createServiceContext(owner.organizationId);
      const begun = await beginAttempt(db(), service, { externalActionId: id, runId: 'r' });
      if (begun.kind !== 'send') throw new Error('Expected a send');
      const attemptId = begun.attempt.attemptId;
      const accepted = { outcome: 'accepted', code: 'ACCEPTED_BY_RELAY' } as const;
      await expect(finishAttempt(db(), service, { attemptId, result: accepted })).resolves.toBe(
        'sent',
      );
      await expect(finishAttempt(db(), service, { attemptId, result: accepted })).resolves.toBe(
        'sent',
      );
      await expect(
        finishAttempt(db(), service, {
          attemptId,
          result: { outcome: 'not_sent', code: 'RELAY_BUSY', retryable: true },
        }),
      ).resolves.toBe('sent');
      expect(await receiptsOf(id)).toHaveLength(1);
      expect(await notificationsAbout(id)).toHaveLength(1);
      expect((await attemptsOf(id))[0]?.outcome).toBe('accepted');
    });

    it('carries IDs, enums and counters out of the Activity, and no payload', async () => {
      const proposal = await readyToSend({ payload: mail({ to: [CANARY], subject: CANARY }) });
      const step = await activitiesOver(createScriptedGateway(['accept'])).sendExternalAction({
        ...inputFor(proposal.externalActionId),
        runId: 'r',
      });
      expect(JSON.stringify(step)).not.toContain(CANARY);
      const events = await eventsAbout(proposal.externalActionId);
      expect(events.map((event) => event.eventType)).toContain('external_action.sent');
      expect(JSON.stringify(events)).not.toContain(CANARY);
    });

    it('ends failed, with the provider’s word, when it refuses', async () => {
      const proposal = await readyToSend();
      const id = proposal.externalActionId;
      const gateway = createScriptedGateway(['refuse']);
      await expect(drive(gateway, id).run()).resolves.toBe('failed');
      expect(gateway.effects()).toHaveLength(0);
      expect(await rowOf(id)).toMatchObject({
        status: 'failed',
        statusReason: 'RECIPIENT_REFUSED',
      });
      expect(await receiptsOf(id)).toEqual([
        expect.objectContaining({ outcome: 'failed', basis: 'provider', providerStatus: 550 }),
      ]);
    });

    it('tries again after not_sent: one effect, one receipt, two attempts', async () => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(['not_sent', 'accept']);
      await expect(drive(gateway, id).run()).resolves.toBe('sent');
      expect(gateway.effects()).toHaveLength(1);
      expect(await attemptsOf(id)).toHaveLength(2);
      expect(await receiptsOf(id)).toHaveLength(1);
      const attempts = await attemptsOf(id);
      expect(attempts.map((a) => a.outcome).sort()).toEqual(['accepted', 'not_sent']);
      expect(new Set(attempts.map((a) => a.idempotencyKey)).size).toBe(1);
    });

    it('stops after five that did not send: failed, ATTEMPTS_EXHAUSTED, no effect', async () => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(
        Array.from({ length: MAX_SEND_ATTEMPTS }, (): SendScript => 'not_sent'),
      );
      await expect(drive(gateway, id).run()).resolves.toBe('failed');
      expect(gateway.effects()).toHaveLength(0);
      expect(gateway.sendCalls()).toBe(MAX_SEND_ATTEMPTS);
      expect(await rowOf(id)).toMatchObject({
        status: 'failed',
        statusReason: 'ATTEMPTS_EXHAUSTED',
      });
      expect(await receiptsOf(id)).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          basis: 'system',
          code: 'ATTEMPTS_EXHAUSTED',
        }),
      ]);
    });

    it('does not try again after a not_sent that says trying would not help', async () => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(['not_sent_final']);
      await expect(drive(gateway, id).run()).resolves.toBe('failed');
      expect(gateway.sendCalls()).toBe(1);
      expect(await rowOf(id)).toMatchObject({ status: 'failed', statusReason: 'AUTH_FAILED' });
    });
  });

  /**
   * QA-008 and AI-TS-01. Every boundary between "nothing has happened" and "the result is stored". The two
   * columns on the right are the assertion: what it ends as, and how many times the provider took it.
   */
  const BOUNDARIES: readonly {
    name: string;
    script: SendScript[];
    worker?: Record<number, DbFault>;
    ends: 'sent' | 'unknown';
    effects: number;
  }[] = [
    {
      name: 'before the attempt record: the database is gone',
      script: ['accept'],
      worker: { 1: 'before' },
      ends: 'sent',
      effects: 1,
    },
    {
      name: 'before the attempt record: the worker dies inside the transaction',
      script: ['accept'],
      worker: { 1: 'rollback' },
      ends: 'sent',
      effects: 1,
    },
    {
      name: 'after the record, before the send: the worker never hears the commit',
      script: [],
      worker: { 1: 'after_commit' },
      ends: 'unknown',
      effects: 0,
    },
    {
      name: 'after the record, before the send: the worker dies',
      script: ['die_before_effect'],
      ends: 'unknown',
      effects: 0,
    },
    {
      name: 'after the provider accepted, before the reply: the reply never comes',
      script: ['accept_then_silent'],
      ends: 'unknown',
      effects: 1,
    },
    {
      name: 'after the provider accepted, before the reply: the connector throws',
      script: ['accept_then_throw'],
      ends: 'unknown',
      effects: 1,
    },
    {
      name: 'after the provider accepted, before the reply: the worker dies',
      script: ['accept_then_die'],
      ends: 'unknown',
      effects: 1,
    },
    {
      name: 'after the reply, before the result is stored: the database is gone',
      script: ['accept'],
      worker: { 2: 'before' },
      ends: 'unknown',
      effects: 1,
    },
    {
      name: 'after the reply, before the result is stored: the worker dies inside the transaction',
      script: ['accept'],
      worker: { 2: 'rollback' },
      ends: 'unknown',
      effects: 1,
    },
    {
      name: 'after the result is stored: the worker never hears the commit',
      script: ['accept'],
      worker: { 2: 'after_commit' },
      ends: 'sent',
      effects: 1,
    },
  ];

  describe('faults at every step boundary', () => {
    const assertEnding = async (
      id: string,
      gateway: ScriptedGateway,
      boundary: (typeof BOUNDARIES)[number],
    ) => {
      expect(gateway.effects()).toHaveLength(boundary.effects);
      expect(await statusOf(id)).toBe(boundary.ends);
      // Nothing is left looking as though it may still be in flight.
      const attempts = await attemptsOf(id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.outcome).toBe(boundary.ends === 'sent' ? 'accepted' : 'indeterminate');
      // One person-shaped thing to look at, not a pile of them.
      const receipts = await receiptsOf(id);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        outcome: boundary.ends,
        basis: boundary.ends === 'sent' ? 'provider' : 'reconciliation',
      });
    };

    const replayEverything = async (id: string, gateway: ScriptedGateway) => {
      const before = { sends: gateway.sendCalls(), effects: gateway.effects().length };
      const status = await statusOf(id);
      const activities = activitiesOver(gateway);
      // A whole second run of the workflow, as if Temporal lost the first, and then the Activity on its own.
      await expect(drive(gateway, id).run()).resolves.toBe(status);
      for (let i = 0; i < 3; i += 1) {
        await expect(
          activities.sendExternalAction({ ...inputFor(id), runId: `replay-${i}` }),
        ).resolves.toEqual({ step: status });
      }
      expect(gateway.sendCalls()).toBe(before.sends);
      expect(gateway.effects()).toHaveLength(before.effects);
      expect(await statusOf(id)).toBe(status);
    };

    it.each(BOUNDARIES)('$name: ends $ends with $effects effect(s)', async (boundary) => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(boundary.script);
      const worker = boundary.worker ? flaky(db(), boundary.worker) : db();
      await expect(drive(gateway, id, { worker }).run()).resolves.toBe(boundary.ends);
      await assertEnding(id, gateway, boundary);
      await replayEverything(id, gateway);
    });

    it.each(BOUNDARIES)(
      '$name: a replayed send at every step changes nothing',
      async (boundary) => {
        const { externalActionId: id } = await readyToSend();
        const gateway = createScriptedGateway(boundary.script);
        const worker = boundary.worker ? flaky(db(), boundary.worker) : db();
        const replayed = activitiesOver(gateway);
        let replays = 0;
        const driven = drive(gateway, id, {
          worker,
          // Only once the worker's own first send has been tried, so the fault still lands where it should.
          beforeEachStep: async () => {
            replays += 1;
            if (replays === 1) return;
            await replayed
              .sendExternalAction({ ...inputFor(id), runId: `hostile-${replays}` })
              .catch(() => undefined);
          },
        });
        await expect(driven.run()).resolves.toBe(boundary.ends);
        await assertEnding(id, gateway, boundary);
      },
    );

    it('tells the accountable owner and the requester about an unknown, once each', async () => {
      const work = await newWork();
      await assign(work, contributor.membershipId);
      const proposal = await proposeExternalAction(db(), contributor, {
        workUnitId: work,
        connectionId: connection,
        toolName: EMAIL_SEND_TOOL,
        toolVersion: EMAIL_SEND_VERSION,
        payload: mail(),
        approverMembershipId: approver.membershipId,
      });
      await approve(proposal);
      const id = proposal.externalActionId;
      const gateway = createScriptedGateway(['accept_then_silent']);
      await drive(gateway, id).run();
      await drive(gateway, id).run();
      const told = await withTenantTx(db(), owner, (tx) =>
        tx
          .select({ who: notifications.recipientMembershipId, kind: notifications.kind })
          .from(notifications)
          .where(eq(notifications.targetRef, `external_action:${id}`)),
      );
      expect(told).toHaveLength(2);
      expect(told.map((row) => row.kind)).toEqual([
        'external_action.unknown',
        'external_action.unknown',
      ]);
      expect(told.map((row) => row.who).sort()).toEqual(
        [owner.membershipId, contributor.membershipId].sort(),
      );
      expect(await eventsAbout(id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ eventType: 'external_action.unknown' })]),
      );
    });

    it('stores no provider text, whatever the connector threw', async () => {
      const { externalActionId: id } = await readyToSend();
      await drive(createScriptedGateway(['accept_then_throw']), id).run();
      const everything = JSON.stringify([
        await rowOf(id),
        await attemptsOf(id),
        await receiptsOf(id),
        await eventsAbout(id),
      ]);
      expect(everything).not.toContain('Some text from a provider');
    });

    it('a stored unknown takes no further step without a person', async () => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(['accept_then_silent']);
      await drive(gateway, id).run();
      await expect(inspectInterrupted(db(), owner, { externalActionId: id })).resolves.toBe(
        'settled',
      );
      await expect(
        beginAttempt(db(), createServiceContext(owner.organizationId), {
          externalActionId: id,
          runId: 'r',
        }),
      ).resolves.toEqual({ kind: 'stop', status: 'unknown' });
      await expect(
        failUnsent(db(), createServiceContext(owner.organizationId), {
          externalActionId: id,
          code: 'ATTEMPTS_EXHAUSTED',
        }),
      ).resolves.toBeUndefined();
      expect(await statusOf(id)).toBe('unknown');
    });
  });

  describe('two workers and zombies', () => {
    it('lets one of two simultaneous sends through, and the other touches nobody', async () => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(['accept']);
      const activities = activitiesOver(gateway);
      const steps = await Promise.all([
        activities.sendExternalAction({ ...inputFor(id), runId: 'one' }),
        activities.sendExternalAction({ ...inputFor(id), runId: 'two' }),
      ]);
      expect(gateway.sendCalls()).toBe(1);
      expect(gateway.effects()).toHaveLength(1);
      expect(steps.map((step) => step.step).sort()).toEqual(expect.arrayContaining(['sent']));
      expect(await attemptsOf(id)).toHaveLength(1);
    });

    it('believes a late accepted answer: unknown becomes sent, and nothing is sent again', async () => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(['accept_then_die']);
      const driven = drive(gateway, id);
      await expect(driven.run()).resolves.toBe('unknown');
      gateway.wakeZombie({
        outcome: 'accepted',
        code: 'ACCEPTED_BY_RELAY',
        providerStatus: 250,
        externalId: 'late-id',
      });
      await Promise.all(driven.pending);
      expect(gateway.effects()).toHaveLength(1);
      expect(await rowOf(id)).toMatchObject({ status: 'sent', externalId: 'late-id' });
      expect((await attemptsOf(id))[0]).toMatchObject({
        outcome: 'accepted',
        externalId: 'late-id',
      });
      const receipts = await receiptsOf(id);
      expect(receipts.map((r) => r.outcome).sort()).toEqual(['sent', 'unknown']);
    });

    it('believes a late refusal from the provider', async () => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(['accept_then_die']);
      const driven = drive(gateway, id);
      await driven.run();
      gateway.wakeZombie({ outcome: 'rejected', code: 'RECIPIENT_REFUSED', providerStatus: 550 });
      await Promise.all(driven.pending);
      expect(await statusOf(id)).toBe('failed');
    });

    it.each([
      { outcome: 'not_sent', code: 'RELAY_BUSY', retryable: true },
      { outcome: 'indeterminate', code: 'TIMEOUT_AFTER_COMMIT' },
    ] as const)(
      'does not take a late $outcome as evidence: it stays unknown, and no way back to a send opens',
      async (late) => {
        const { externalActionId: id } = await readyToSend();
        const gateway = createScriptedGateway(['die_before_effect']);
        const driven = drive(gateway, id);
        await driven.run();
        gateway.wakeZombie(late);
        await Promise.all(driven.pending);
        expect(await statusOf(id)).toBe('unknown');
        expect((await attemptsOf(id))[0]?.outcome).toBe('indeterminate');
      },
    );

    it('keeps what a person said, and still records what a zombie later found', async () => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(['accept_then_die']);
      const driven = drive(gateway, id);
      await driven.run();
      await withTenantTx(db(), owner, (tx) =>
        tx
          .update(externalActions)
          .set({
            status: 'failed',
            resolution: 'confirmed_not_sent',
            resolvedByMembershipId: owner.membershipId,
            resolutionReason: 'Looked and could not find it.',
          })
          .where(eq(externalActions.id, id)),
      );
      gateway.wakeZombie({ outcome: 'accepted', code: 'ACCEPTED_BY_RELAY' });
      await Promise.all(driven.pending);
      expect(await statusOf(id)).toBe('failed');
      expect((await attemptsOf(id))[0]?.outcome).toBe('accepted');
      expect((await receiptsOf(id)).map((r) => r.outcome)).toContain('sent');
      const evidence = await withTenantTx(db(), owner, async (tx) =>
        countVerifiedReceipts(tx, (await rowOf(id)).workUnitId),
      );
      expect(evidence).toBe(0);
    });
  });

  describe('reconciling', () => {
    const silent = async (
      reconciles: (ReconcileResult | Error)[],
      lookup: 'none' | 'best_effort' | 'authoritative',
    ) => {
      const { externalActionId: id } = await readyToSend();
      return {
        id,
        gateway: createScriptedGateway(['indeterminate_without_effect', 'accept'], {
          reconciles,
          lookup,
        }),
      };
    };

    it('takes a found answer as sent', async () => {
      const { id, gateway } = await silent(
        [{ answer: 'found', externalId: 'found-id', providerStatus: 200 }],
        'best_effort',
      );
      await expect(drive(gateway, id).run()).resolves.toBe('sent');
      expect(gateway.sendCalls()).toBe(1);
      expect(await rowOf(id)).toMatchObject({
        status: 'sent',
        externalId: 'found-id',
        statusReason: 'PROVIDER_FOUND_IT',
      });
      expect(await receiptsOf(id)).toEqual([
        expect.objectContaining({
          outcome: 'sent',
          basis: 'reconciliation',
          externalId: 'found-id',
        }),
      ]);
    });

    it('takes a refused answer as failed', async () => {
      const { id, gateway } = await silent([{ answer: 'refused' }], 'best_effort');
      await expect(drive(gateway, id).run()).resolves.toBe('failed');
      expect(gateway.sendCalls()).toBe(1);
    });

    it('sends again only when an authoritative lookup says nothing went', async () => {
      const { id, gateway } = await silent([{ answer: 'not_found' }], 'authoritative');
      await expect(drive(gateway, id).run()).resolves.toBe('sent');
      expect(gateway.sendCalls()).toBe(2);
      expect(gateway.effects()).toHaveLength(1);
      expect((await attemptsOf(id)).map((a) => a.outcome).sort()).toEqual(['accepted', 'not_sent']);
    });

    it('does not send again when a best-effort lookup does not find it', async () => {
      const { id, gateway } = await silent([{ answer: 'not_found' }], 'best_effort');
      await expect(drive(gateway, id).run()).resolves.toBe('unknown');
      expect(gateway.sendCalls()).toBe(1);
    });

    it('treats a reconcile that blows up as not being able to answer', async () => {
      const { id, gateway } = await silent([new Error('Provider text')], 'best_effort');
      await expect(drive(gateway, id).run()).resolves.toBe('unknown');
      expect(gateway.sendCalls()).toBe(1);
      expect(JSON.stringify(await receiptsOf(id))).not.toContain('Provider text');
    });

    it('survives dying at each step of reconciling, with one receipt and one telling', async () => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(['accept_then_silent']);
      const input = inputFor(id);
      const healthy = activitiesOver(gateway);
      await expect(healthy.sendExternalAction({ ...input, runId: 'r' })).resolves.toEqual({
        step: 'reconcile',
      });

      // Dies on the way in, then just after beginReconcile committed, then with finishReconcile rolled back.
      for (const faults of [{ 1: 'before' }, { 1: 'after_commit' }, { 2: 'rollback' }] as const) {
        await expect(
          activitiesOver(gateway, flaky(db(), faults)).reconcileExternalAction({
            ...input,
            code: 'WORKER_INTERRUPTED',
          }),
        ).rejects.toBeInstanceOf(Error);
        await expect(healthy.inspectInterruptedAction(input)).resolves.toBe('attempt_open');
      }
      // The answer is stored, and the worker does not hear it.
      await expect(
        activitiesOver(gateway, flaky(db(), { 2: 'after_commit' })).reconcileExternalAction({
          ...input,
          code: 'WORKER_INTERRUPTED',
        }),
      ).rejects.toBeInstanceOf(Error);
      await expect(healthy.inspectInterruptedAction(input)).resolves.toBe('settled');
      await expect(
        healthy.reconcileExternalAction({ ...input, code: 'WORKER_INTERRUPTED' }),
      ).resolves.toBe('unknown');

      expect(gateway.effects()).toHaveLength(1);
      expect(await receiptsOf(id)).toHaveLength(1);
      expect(await notificationsAbout(id)).toHaveLength(1);
      expect(
        (await eventsAbout(id)).filter((e) => e.eventType === 'external_action.unknown'),
      ).toHaveLength(1);
    });

    it('marks an open attempt indeterminate with the code it is given, and no later code replaces it', async () => {
      const { externalActionId: id } = await readyToSend();
      const service = createServiceContext(owner.organizationId);
      const begun = await beginAttempt(db(), service, { externalActionId: id, runId: 'r' });
      expect(begun.kind).toBe('send');
      const prepared = await beginReconcile(db(), service, {
        externalActionId: id,
        code: 'WORKER_INTERRUPTED',
      });
      expect(prepared.kind).toBe('reconcile');
      expect(await statusOf(id)).toBe('reconciling');
      expect((await attemptsOf(id))[0]).toMatchObject({
        outcome: 'indeterminate',
        outcomeCode: 'WORKER_INTERRUPTED',
      });
    });

    it('can conclude without a connector, when none ever came back', async () => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(['accept_then_die']);
      const activities = activitiesOver(gateway);
      const input = inputFor(id);
      void activities.sendExternalAction({ ...input, runId: 'r' }).catch(() => undefined);
      await gateway.died();
      await expect(
        activities.concludeWithoutAnswer({ ...input, code: 'WORKER_INTERRUPTED' }),
      ).resolves.toBe('unknown');
      expect(gateway.reconcileCalls()).toBe(0);
      expect(await rowOf(id)).toMatchObject({
        status: 'unknown',
        statusReason: 'PROVIDER_CANNOT_ANSWER',
      });
    });
  });

  describe('every state, sent again', () => {
    const CONTACT_NOBODY: readonly [ExternalActionStatus, string][] = [
      ['awaiting_approval', 'cancelled'],
      ['sending', 'reconcile'],
      ['reconciling', 'reconcile'],
      ['sent', 'sent'],
      ['failed', 'failed'],
      ['unknown', 'unknown'],
      ['cancelled', 'cancelled'],
    ];

    it.each(CONTACT_NOBODY)(
      'a send on an intent that is %s contacts nobody and answers %s',
      async (status, step) => {
        const seeded = await seedExternalAction(db(), owner, {
          workUnitId: await newWork(),
          connectionId: connection,
          approverMembershipId: approver.membershipId,
          status,
        });
        const before = await rowOf(seeded.id);
        const attemptsBefore = (await attemptsOf(seeded.id)).length;
        const gateway = createScriptedGateway([]);
        const activities = activitiesOver(gateway);
        for (let i = 0; i < 3; i += 1) {
          await expect(
            activities.sendExternalAction({ ...inputFor(seeded.id), runId: `again-${i}` }),
          ).resolves.toEqual({ step });
        }
        expect(gateway.sendCalls()).toBe(0);
        const after = await rowOf(seeded.id);
        expect(after.status).toBe(before.status);
        expect(after.version).toBe(before.version);
        expect(await attemptsOf(seeded.id)).toHaveLength(attemptsBefore);
      },
    );
  });

  describe('QA-007: changing recipients after approval', () => {
    it('voids the approval, cancels the old intent, and only the new recipients ever get anything', async () => {
      const work = await newWork();
      const first = await readyToSend({
        workUnitId: work,
        payload: mail({ to: ['old@example.invalid'] }),
      });
      const row = await rowOf(first.externalActionId);
      const second = await reviseExternalAction(db(), owner, {
        externalActionId: first.externalActionId,
        expectedVersion: row.version,
        payload: mail({ to: ['new@example.invalid'] }),
        approverMembershipId: approver.membershipId,
      });

      expect(second.externalActionId).not.toBe(first.externalActionId);
      expect(second.requestHash).not.toBe(first.requestHash);
      expect(await rowOf(first.externalActionId)).toMatchObject({
        status: 'cancelled',
        statusReason: 'SUPERSEDED',
      });
      expect(await rowOf(second.externalActionId)).toMatchObject({
        status: 'awaiting_approval',
        supersedesId: first.externalActionId,
      });
      const [oldApproval] = await withTenantTx(db(), owner, (tx) =>
        tx.select().from(approvals).where(eq(approvals.id, first.approvalId)),
      );
      expect(oldApproval?.status).toBe('cancelled');

      // The old decision cannot be spent, and the old intent cannot go.
      await expect(approve(first)).rejects.toEqual(code('APPROVAL_NOT_PENDING'));
      const gateway = createScriptedGateway(['accept']);
      const activities = activitiesOver(gateway);
      await expect(
        activities.sendExternalAction({ ...inputFor(first.externalActionId), runId: 'old' }),
      ).resolves.toEqual({ step: 'cancelled' });
      // The new one has not been approved, so it cannot go either.
      await expect(
        activities.sendExternalAction({ ...inputFor(second.externalActionId), runId: 'new' }),
      ).resolves.toEqual({ step: 'cancelled' });
      expect(gateway.sendCalls()).toBe(0);

      await approve(second);
      await expect(
        activities.sendExternalAction({ ...inputFor(second.externalActionId), runId: 'new' }),
      ).resolves.toEqual({ step: 'sent' });
      expect(gateway.effects()).toHaveLength(1);
      expect(gateway.effects()[0]?.payload).toMatchObject({ to: ['new@example.invalid'] });
      expect(JSON.stringify(gateway.effects())).not.toContain('old@example.invalid');
    });

    it('works while the first decision is still open', async () => {
      const first = await propose();
      const second = await reviseExternalAction(db(), owner, {
        externalActionId: first.externalActionId,
        expectedVersion: 1,
        payload: mail({ to: ['new@example.invalid'] }),
        approverMembershipId: approver.membershipId,
      });
      await expect(approve(first)).rejects.toEqual(code('APPROVAL_NOT_PENDING'));
      await expect(approve(second)).resolves.toEqual({ status: 'approved' });
    });

    it('refuses a stale version', async () => {
      const first = await propose();
      await expect(
        reviseExternalAction(db(), owner, {
          externalActionId: first.externalActionId,
          expectedVersion: 99,
          payload: mail(),
          approverMembershipId: approver.membershipId,
        }),
      ).rejects.toEqual(code('VERSION_CONFLICT'));
    });

    it('refuses once any attempt exists, even one that definitely did not send', async () => {
      const { externalActionId: id } = await readyToSend();
      await activitiesOver(createScriptedGateway(['not_sent'])).sendExternalAction({
        ...inputFor(id),
        runId: 'r',
      });
      expect(await statusOf(id)).toBe('ready');
      await expect(
        reviseExternalAction(db(), owner, {
          externalActionId: id,
          expectedVersion: (await rowOf(id)).version,
          payload: mail({ to: ['new@example.invalid'] }),
          approverMembershipId: approver.membershipId,
        }),
      ).rejects.toEqual(code('EXTERNAL_ACTION_NOT_EDITABLE'));
    });

    it.each(['sent', 'unknown', 'failed', 'cancelled'] as const)(
      'refuses from %s',
      async (status) => {
        const seeded = await seedExternalAction(db(), owner, {
          workUnitId: await newWork(),
          connectionId: connection,
          approverMembershipId: approver.membershipId,
          status,
        });
        await expect(
          reviseExternalAction(db(), owner, {
            externalActionId: seeded.id,
            expectedVersion: (await rowOf(seeded.id)).version,
            payload: mail(),
            approverMembershipId: approver.membershipId,
          }),
        ).rejects.toEqual(code('EXTERNAL_ACTION_NOT_EDITABLE'));
      },
    );

    it('needs the same rights as proposing, and another tenant gets not found', async () => {
      const first = await propose();
      await expect(
        reviseExternalAction(db(), bystander, {
          externalActionId: first.externalActionId,
          expectedVersion: 1,
          payload: mail(),
          approverMembershipId: approver.membershipId,
        }),
      ).rejects.toEqual(code('FORBIDDEN'));
      await expect(
        reviseExternalAction(db(), other, {
          externalActionId: first.externalActionId,
          expectedVersion: 1,
          payload: mail(),
          approverMembershipId: other.membershipId,
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
      expect(await statusOf(first.externalActionId)).toBe('awaiting_approval');
    });

    it('ends a row edited behind the application’s back as PAYLOAD_CHANGED, with no contact', async () => {
      const { externalActionId: id } = await readyToSend();
      await superuser.query(
        `update integrations.external_actions set payload = payload || '{"to":["tampered@example.invalid"]}'
          where id = $1`,
        [id],
      );
      const gateway = createScriptedGateway(['accept']);
      await expect(
        activitiesOver(gateway).sendExternalAction({ ...inputFor(id), runId: 'r' }),
      ).resolves.toEqual({ step: 'cancelled' });
      expect(gateway.sendCalls()).toBe(0);
      expect(await rowOf(id)).toMatchObject({
        status: 'cancelled',
        statusReason: 'PAYLOAD_CHANGED',
      });
      expect(await receiptsOf(id)).toEqual([
        expect.objectContaining({ outcome: 'cancelled', basis: 'system', code: 'PAYLOAD_CHANGED' }),
      ]);
      expect(await attemptsOf(id)).toHaveLength(0);
    });
  });

  describe('SEC-06: stopped between approval and attempt', () => {
    const stoppedWith = async (id: string, reason: string, gateway: ScriptedGateway) => {
      await expect(
        activitiesOver(gateway).sendExternalAction({ ...inputFor(id), runId: 'r' }),
      ).resolves.toEqual({ step: 'cancelled' });
      expect(gateway.sendCalls()).toBe(0);
      expect(await rowOf(id)).toMatchObject({ status: 'cancelled', statusReason: reason });
      expect(await attemptsOf(id)).toHaveLength(0);
      // Someone expected this to go, so they are told it did not.
      expect((await notificationsAbout(id)).map((n) => n.kind)).toContain('external_action.failed');
    };

    it('stops when the work was stopped', async () => {
      const work = await newWork();
      const { externalActionId: id } = await readyToSend({ workUnitId: work });
      await walkWork(work, ['cancelled']);
      await stoppedWith(id, 'WORK_STOPPED', createScriptedGateway(['accept']));
    });

    it('stops when the connection was revoked', async () => {
      const own = await seedConnection(db(), owner, { config: { fromAddress: SENDER } });
      const { externalActionId: id } = await readyToSend({ connectionId: own });
      await withTenantTx(db(), owner, (tx) =>
        tx.update(connections).set({ state: 'revoked' }).where(eq(connections.id, own)),
      );
      await stoppedWith(id, 'CONNECTION_NOT_ACTIVE', createScriptedGateway(['accept']));
    });

    it('stops when the approval expired, rather than sending late', async () => {
      const { externalActionId: id } = await readyToSend({
        expiresAt: new Date(Date.now() + 1_500),
      });
      await new Promise((done) => setTimeout(done, 1_600));
      await stoppedWith(id, 'APPROVAL_EXPIRED', createScriptedGateway(['accept']));
    });

    it('stops a retry whose approval expired between tries', async () => {
      const { externalActionId: id } = await readyToSend({
        expiresAt: new Date(Date.now() + 1_500),
      });
      const gateway = createScriptedGateway(['not_sent', 'accept']);
      const activities = activitiesOver(gateway);
      await expect(
        activities.sendExternalAction({ ...inputFor(id), runId: 'r' }),
      ).resolves.toMatchObject({ step: 'retry' });
      await new Promise((done) => setTimeout(done, 1_600));
      await expect(activities.sendExternalAction({ ...inputFor(id), runId: 'r' })).resolves.toEqual(
        { step: 'cancelled' },
      );
      expect(gateway.sendCalls()).toBe(1);
      expect(gateway.effects()).toHaveLength(0);
    });
  });

  describe('another tenant', () => {
    it('cannot read, send or inspect an intent, and the provider hears nothing', async () => {
      const { externalActionId: id } = await readyToSend();
      const gateway = createScriptedGateway(['accept']);
      const activities = activitiesOver(gateway);
      const foreign = { organizationId: other.organizationId, externalActionId: id };
      await expect(activities.sendExternalAction({ ...foreign, runId: 'r' })).rejects.toEqual(
        code('NOT_FOUND'),
      );
      await expect(activities.inspectInterruptedAction(foreign)).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        activities.reconcileExternalAction({ ...foreign, code: 'WORKER_INTERRUPTED' }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(activities.settledActionOutcome(foreign)).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        activities.failUnsentAction({ ...foreign, code: 'CONNECTOR_UNAVAILABLE' }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        finishAttempt(db(), createServiceContext(other.organizationId), {
          attemptId: randomUUID(),
          result: { outcome: 'accepted', code: 'ACCEPTED_BY_RELAY' },
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        finishReconcile(db(), createServiceContext(other.organizationId), {
          attemptId: randomUUID(),
          result: { answer: 'cannot_answer' },
          lookup: 'none',
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
      expect(gateway.sendCalls()).toBe(0);
      const seen = await withTenantTx(db(), other, (tx) =>
        tx.select().from(externalActions).where(eq(externalActions.id, id)),
      );
      expect(seen).toEqual([]);
      expect(await statusOf(id)).toBe('ready');
    });
  });

  describe('asking again', () => {
    const failed = async () =>
      seedExternalAction(db(), owner, {
        workUnitId: await newWork(),
        connectionId: connection,
        approverMembershipId: approver.membershipId,
        status: 'failed',
        payload: testEmailPayload({ from: { address: SENDER } }),
      });

    it('makes a new intent pointing back, which needs its own approval', async () => {
      const seeded = await failed();
      const again = await retryExternalAction(db(), owner, {
        externalActionId: seeded.id,
        approverMembershipId: approver.membershipId,
      });
      expect(again.externalActionId).not.toBe(seeded.id);
      expect(again.approvalId).not.toBe(seeded.approvalId);
      expect(await rowOf(again.externalActionId)).toMatchObject({
        status: 'awaiting_approval',
        retryOfId: seeded.id,
        requestHash: again.requestHash,
      });
      expect(await statusOf(seeded.id)).toBe('failed');
    });

    it('takes the sender from the connection as it is now', async () => {
      const seeded = await seedExternalAction(db(), owner, {
        workUnitId: await newWork(),
        connectionId: connection,
        approverMembershipId: approver.membershipId,
        status: 'failed',
        payload: testEmailPayload({ from: { address: 'old-sender@example.invalid' } }),
      });
      const again = await retryExternalAction(db(), owner, {
        externalActionId: seeded.id,
        approverMembershipId: approver.membershipId,
      });
      expect((await rowOf(again.externalActionId)).payload).toMatchObject({
        from: { address: SENDER },
      });
    });

    it('refuses a second retry while the first can still go', async () => {
      const seeded = await failed();
      const first = await retryExternalAction(db(), owner, {
        externalActionId: seeded.id,
        approverMembershipId: approver.membershipId,
      });
      await expect(
        retryExternalAction(db(), owner, {
          externalActionId: seeded.id,
          approverMembershipId: approver.membershipId,
        }),
      ).rejects.toEqual(code('EXTERNAL_ACTION_NOT_RETRYABLE'));
      await decideApproval(db(), approver, {
        approvalId: first.approvalId,
        decision: 'deny',
        shownHash: first.requestHash,
        reason: 'Not this one.',
      });
      await expect(
        retryExternalAction(db(), owner, {
          externalActionId: seeded.id,
          approverMembershipId: approver.membershipId,
        }),
      ).resolves.toMatchObject({ externalActionId: expect.any(String) });
    });

    it.each([
      'awaiting_approval',
      'ready',
      'sending',
      'reconciling',
      'sent',
      'unknown',
      'cancelled',
    ] as const)(
      'refuses from %s: an unknown intent has no send button, here either',
      async (status) => {
        const seeded = await seedExternalAction(db(), owner, {
          workUnitId: await newWork(),
          connectionId: connection,
          approverMembershipId: approver.membershipId,
          status,
        });
        await expect(
          retryExternalAction(db(), owner, {
            externalActionId: seeded.id,
            approverMembershipId: approver.membershipId,
          }),
        ).rejects.toEqual(code('EXTERNAL_ACTION_NOT_RETRYABLE'));
      },
    );

    it('needs rights on the work, and another tenant gets not found', async () => {
      const seeded = await failed();
      await expect(
        retryExternalAction(db(), bystander, {
          externalActionId: seeded.id,
          approverMembershipId: approver.membershipId,
        }),
      ).rejects.toEqual(code('FORBIDDEN'));
      await expect(
        retryExternalAction(db(), other, {
          externalActionId: seeded.id,
          approverMembershipId: other.membershipId,
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
    });
  });

  describe('failing what never went', () => {
    it('ends a ready intent, with the system’s word and no attempt', async () => {
      const { externalActionId: id } = await readyToSend();
      const service = createServiceContext(owner.organizationId);
      await failUnsent(db(), service, { externalActionId: id, code: 'CONNECTOR_UNAVAILABLE' });
      await failUnsent(db(), service, { externalActionId: id, code: 'CONNECTOR_UNAVAILABLE' });
      expect(await rowOf(id)).toMatchObject({
        status: 'failed',
        statusReason: 'CONNECTOR_UNAVAILABLE',
      });
      expect(await receiptsOf(id)).toEqual([
        expect.objectContaining({ outcome: 'failed', basis: 'system' }),
      ]);
    });

    it('will not end one with an attempt that may have sent', async () => {
      const seeded = await seedExternalAction(db(), owner, {
        workUnitId: await newWork(),
        connectionId: connection,
        approverMembershipId: approver.membershipId,
        status: 'sending',
      });
      await failUnsent(db(), createServiceContext(owner.organizationId), {
        externalActionId: seeded.id,
        code: 'CONNECTOR_UNAVAILABLE',
      });
      expect(await statusOf(seeded.id)).toBe('sending');
    });
  });

  describe('as evidence', () => {
    const receiptWork = async (context = owner) =>
      newWork(context, { completionCriteria: [{ kind: 'external_receipt' }] });

    it('offers the criterion only to a tenant with an active connection that can act', async () => {
      const lonely = await newOrg('lonely');
      await expect(receiptWork(lonely)).rejects.toEqual(code('INVALID_INPUT'));

      await seedConnection(db(), lonely, { connectorType: 'inbound_webhook' });
      await expect(receiptWork(lonely)).rejects.toEqual(code('INVALID_INPUT'));

      await seedConnection(db(), lonely, { state: 'revoked' });
      await expect(receiptWork(lonely)).rejects.toEqual(code('INVALID_INPUT'));

      await seedConnection(db(), lonely, { state: 'active' });
      await expect(receiptWork(lonely)).resolves.toEqual(expect.any(String));
    });

    it('holds completion until the provider has accepted, and unknown does not count', async () => {
      const work = await receiptWork();
      const proposal = await readyToSend({ workUnitId: work });
      await walkWork(work, ['ready', 'running', 'verifying']);
      await expect(walkWork(work, ['completed'])).rejects.toEqual(code('EVIDENCE_MISSING'));

      const gateway = createScriptedGateway(['accept']);
      await drive(gateway, proposal.externalActionId).run();
      expect((await getWorkDetail(db(), owner, work)).evidence.verifiedReceiptCount).toBe(1);
      const overview = await listWorkOverview(db(), owner, { status: 'verifying' });
      expect(overview.items.find((item) => item.id === work)?.evidence.verifiedReceiptCount).toBe(
        1,
      );
      await expect(walkWork(work, ['completed'])).resolves.toMatchObject({ status: 'completed' });
    });

    it('does not count an unknown', async () => {
      const work = await receiptWork();
      const { externalActionId: id } = await readyToSend({ workUnitId: work });
      await drive(createScriptedGateway(['accept_then_silent']), id).run();
      expect((await getWorkDetail(db(), owner, work)).evidence.verifiedReceiptCount).toBe(0);
    });

    it('counts a person’s word on an unknown, and that person’s word is what the receipt says', async () => {
      const work = await receiptWork();
      const seeded = await seedExternalAction(db(), owner, {
        workUnitId: work,
        connectionId: connection,
        approverMembershipId: approver.membershipId,
        status: 'unknown',
      });
      await withTenantTx(db(), owner, async (tx) => {
        await tx
          .update(externalActions)
          .set({
            status: 'sent',
            resolution: 'confirmed_sent',
            resolvedByMembershipId: owner.membershipId,
            resolutionReason: 'Found it in the relay log.',
          })
          .where(eq(externalActions.id, seeded.id));
        await tx.insert(externalActionReceipts).values({
          organizationId: owner.organizationId,
          externalActionId: seeded.id,
          outcome: 'sent',
          basis: 'person',
          requestHash: seeded.requestHash,
          actorMembershipId: owner.membershipId,
        });
      });
      expect((await getWorkDetail(db(), owner, work)).evidence.verifiedReceiptCount).toBe(1);
    });

    it('does not count a sent action from a different Work Unit', async () => {
      const work = await receiptWork();
      await drive(createScriptedGateway(['accept']), (await readyToSend()).externalActionId).run();
      expect((await getWorkDetail(db(), owner, work)).evidence.verifiedReceiptCount).toBe(0);
    });

    it('moves the stamp a following page compares when an action moves', async () => {
      const work = await newWork();
      const before = (await getWorkDetail(db(), owner, work)).evidenceStamp;
      const proposal = await readyToSend({ workUnitId: work });
      const during = (await getWorkDetail(db(), owner, work)).evidenceStamp;
      expect(during).not.toBe(before);
      await drive(createScriptedGateway(['accept']), proposal.externalActionId).run();
      expect((await getWorkDetail(db(), owner, work)).evidenceStamp).not.toBe(during);
    });
  });

  describe('the gateway over a connector', () => {
    const prepared = (overrides: Partial<PreparedAttempt['connection']> = {}): PreparedAttempt => ({
      externalActionId: randomUUID(),
      attemptId: randomUUID(),
      attemptNo: 1,
      toolName: EMAIL_SEND_TOOL,
      toolVersion: EMAIL_SEND_VERSION,
      idempotencyKey: 'ensemus-test',
      requestHash: 'a'.repeat(64),
      payload: testEmailPayload(),
      connection: {
        id: randomUUID(),
        connectorType: 'test_connector',
        config: {},
        credentialSecretId: randomUUID(),
        ...overrides,
      },
    });

    const connectorThat = (
      send: NonNullable<Connector['actions']>['send'],
      options: {
        required?: boolean;
        parse?: (raw: unknown) => unknown;
        lookup?: 'none' | 'authoritative';
      } = {},
    ): Connector => ({
      manifest: {
        type: 'test_connector',
        version: '1',
        displayName: 'Test',
        capabilities: {
          actions: [EMAIL_SEND_TOOL],
          reconcile: options.lookup ?? 'none',
          nativeIdempotency: false,
          sync: null,
          aclMapping: false,
          webhooks: null,
          network: 'none',
        },
        credential: { required: options.required ?? true, purpose: 'connector_credential' },
      },
      parseConfig: options.parse ?? ((raw) => raw),
      actions: { send, reconcile: async () => ({ answer: 'cannot_answer' }) },
    });

    const registryOf = (...list: Connector[]): ConnectorRegistry => ({
      get: (type) => list.find((item) => item.manifest.type === type),
      manifests: () => list.map((item) => item.manifest),
    });

    const secretsThat = (
      withSecret: (use: (secret: Buffer) => Promise<unknown>) => Promise<unknown>,
    ) => ({
      withSecret: ((_binding: unknown, use: (secret: Buffer) => Promise<unknown>) =>
        withSecret(use)) as never,
      revoke: async () => undefined,
    });
    const lendsSecret = secretsThat((use) => use(Buffer.from('generated-test-value')));
    const network = {
      openRelay: async () => {
        throw new Error('Not in these tests');
      },
    };

    const gatewayWith = (connector: Connector | null, secrets = lendsSecret) =>
      createConnectorGateway({
        database: db(),
        registry: connector ? registryOf(connector) : registryOf(),
        secrets,
        network,
      });

    it('refuses a connector that is not on the list, with nothing contacted', async () => {
      await expect(gatewayWith(null).send(owner.organizationId, prepared())).resolves.toEqual({
        outcome: 'not_sent',
        code: 'CONNECTOR_UNAVAILABLE',
        retryable: false,
      });
    });

    it('refuses settings the connector does not accept, with nothing contacted', async () => {
      const send = vi.fn();
      const connector = connectorThat(send, {
        parse: () => {
          throw new Error('Bad settings');
        },
      });
      await expect(gatewayWith(connector).send(owner.organizationId, prepared())).resolves.toEqual({
        outcome: 'not_sent',
        code: 'CONNECTOR_UNAVAILABLE',
        retryable: false,
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses a connection with no credential when the connector needs one', async () => {
      const send = vi.fn();
      await expect(
        gatewayWith(connectorThat(send)).send(
          owner.organizationId,
          prepared({ credentialSecretId: null }),
        ),
      ).resolves.toEqual({ outcome: 'not_sent', code: 'CREDENTIAL_UNAVAILABLE', retryable: false });
      expect(send).not.toHaveBeenCalled();
    });

    it('lends the credential for the one call, and passes the request as it is', async () => {
      let seen: unknown;
      const connector = connectorThat(async (context, request) => {
        seen = request.payload;
        await context.credentials.withCredential(async (secret) => {
          expect(secret.toString()).toBe('generated-test-value');
        });
        return { outcome: 'accepted', code: 'ACCEPTED_BY_PROVIDER' };
      });
      const attempt = prepared();
      await expect(gatewayWith(connector).send(owner.organizationId, attempt)).resolves.toEqual({
        outcome: 'accepted',
        code: 'ACCEPTED_BY_PROVIDER',
      });
      expect(seen).toEqual(attempt.payload);
    });

    it('calls it not sent when the secret could not be opened, because nothing was tried', async () => {
      const refuses = secretsThat(async () => {
        throw new Error('Sealed value could not be opened');
      });
      const connector = connectorThat(async (context) => {
        await context.credentials.withCredential(async () => undefined);
        return { outcome: 'accepted', code: 'ACCEPTED_BY_PROVIDER' };
      });
      await expect(
        gatewayWith(connector, refuses).send(owner.organizationId, prepared()),
      ).resolves.toEqual({ outcome: 'not_sent', code: 'CREDENTIAL_UNAVAILABLE', retryable: false });
    });

    it('does not call it not sent when the lease fails after the secret was used', async () => {
      const failsAfter = secretsThat(async (use) => {
        await use(Buffer.from('generated-test-value'));
        throw new Error('Wiping failed');
      });
      const connector = connectorThat(async (context) => {
        await context.credentials.withCredential(async () => undefined);
        return { outcome: 'accepted', code: 'ACCEPTED_BY_PROVIDER' };
      });
      await expect(
        gatewayWith(connector, failsAfter).send(owner.organizationId, prepared()),
      ).resolves.toEqual({ outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT' });
    });

    it('lets a connector say NotSent from inside the lease', async () => {
      const connector = connectorThat(async (context) =>
        context.credentials.withCredential(async () => {
          throw new NotSent('AUTH_FAILED', false);
        }),
      );
      await expect(gatewayWith(connector).send(owner.organizationId, prepared())).resolves.toEqual({
        outcome: 'not_sent',
        code: 'AUTH_FAILED',
        retryable: false,
      });
    });

    it('reports how far a lookup can be believed from the manifest, and none for a stranger', () => {
      const connector = connectorThat(vi.fn(), { lookup: 'authoritative' });
      const gateway = gatewayWith(connector);
      expect(gateway.lookupOf('test_connector')).toBe('authoritative');
      expect(gateway.lookupOf('nobody_knows')).toBe('none');
    });

    it('cannot answer a reconcile for a connector that is not on the list', async () => {
      await expect(gatewayWith(null).reconcile(owner.organizationId, prepared())).resolves.toEqual({
        answer: 'cannot_answer',
      });
    });

    it('ends a real intent as failed when the connector is gone, without contacting anything', async () => {
      const { externalActionId: id } = await readyToSend();
      const activities = createExternalActionActivities(db(), gatewayWith(null));
      await expect(activities.sendExternalAction({ ...inputFor(id), runId: 'r' })).resolves.toEqual(
        { step: 'failed' },
      );
      expect(await rowOf(id)).toMatchObject({
        status: 'failed',
        statusReason: 'CONNECTOR_UNAVAILABLE',
      });
    });
  });

  /** Puts someone on the work, without going through a page. */
  function assign(work: string, membershipId: string) {
    return assignContributor(db(), owner, { id: work, membershipId });
  }
});
