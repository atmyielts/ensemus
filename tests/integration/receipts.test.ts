// CONNECT-06: reading what happened to an external action, and a person saying what happened when nobody
// else can. Two tenants with the same names, real roles and real triggers. Seeds walk the state machine
// through tests/helpers/integrations.ts, so nothing here reaches a state the rules forbid. Everything
// is a generated test value.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  countUnread,
  createWorkUnit,
  emailPayloadFromConnection,
  emailPayloadForRevision,
  getExternalActionDetail,
  listActionConnections,
  listExternalActions,
  listExternalActionsNeedingReview,
  listMyNotifications,
  listWebhookActivity,
  notify,
  resolveUnknownExternalAction,
} from '@ensemus/application';
import {
  auditEvents,
  connections,
  createOrganization,
  domainEvents,
  externalActionAttempts,
  externalActionReceipts,
  externalActions,
  openAppDatabase,
  outboxEvents,
  resolveTenantContext,
  webhookDeliveries,
  webhookEndpoints,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  EXTERNAL_ACTION_RESOLVED,
  NOTIFY_EXTERNAL_ACTION_UNKNOWN,
  externalActionTargetRef,
} from '@ensemus/domain/integration-events';
import type { ExternalActionStatus } from '@ensemus/domain/external-action';
import { and, eq, sql } from 'drizzle-orm';
import { seedConnection, seedExternalAction, testEmailPayload } from '../helpers/integrations';
import { urls } from '../helpers/stack';

const hasCode = (code: string) =>
  expect.objectContaining({ name: 'AppError', code }) as unknown as AppError;

describe('external action receipts', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let orgOwner: TenantContext;
  let admin: TenantContext;
  let workOwner: TenantContext;
  let assignee: TenantContext;
  let outsider: TenantContext;
  let approver: TenantContext;
  let rival: TenantContext;
  let connection: string;
  let rivalConnection: string;

  const makeUser = async (label: string) => {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      `${label}-${id}@example.invalid`,
    ]);
    return id;
  };

  const addMember = async (organizationId: string, label: string, role: 'admin' | 'member') => {
    const user = await makeUser(label);
    await withTenantTx(database.db, orgOwner, (tx) =>
      tx.execute(
        sql`insert into org.memberships (organization_id, user_id, role)
            values (${organizationId}, ${user}, ${role})`,
      ),
    );
    return resolveTenantContext(database.db, user, organizationId);
  };

  /** A Work Unit of its own each time, because one can hold only one open approval. */
  const makeWork = async (
    classification: 'internal' | 'confidential' | 'restricted' = 'internal',
    assigned = true,
  ) => {
    const work = await createWorkUnit(database.db, workOwner, {
      title: `Work ${randomUUID()}`,
      objective: 'Say something.',
      classification,
    });
    if (assigned) {
      await withTenantTx(database.db, workOwner, (tx) =>
        tx.execute(
          sql`insert into work.work_assignments (organization_id, work_unit_id, membership_id, responsibility)
              values (${workOwner.organizationId}, ${work.id}, ${assignee.membershipId}, 'contributor')`,
        ),
      );
    }
    return work.id;
  };

  const seed = async (
    status: ExternalActionStatus,
    classification: 'internal' | 'confidential' | 'restricted' = 'internal',
    payload?: unknown,
  ) => {
    const workUnitId = await makeWork(classification);
    const action = await seedExternalAction(database.db, workOwner, {
      workUnitId,
      connectionId: connection,
      approverMembershipId: approver.membershipId,
      status,
      ...(payload ? { payload } : {}),
    });
    return { ...action, workUnitId };
  };

  const resolve = (
    context: TenantContext,
    id: string,
    overrides: Partial<{
      expectedVersion: number;
      resolution: 'confirmed_sent' | 'confirmed_not_sent';
      reason: string;
    }> = {},
  ) =>
    resolveUnknownExternalAction(database.db, context, {
      externalActionId: id,
      expectedVersion: 1,
      resolution: 'confirmed_sent',
      reason: 'I searched the log and it was there.',
      ...overrides,
    });

  const rowOf = async (id: string) => {
    const [row] = await withTenantTx(database.db, orgOwner, (tx) =>
      tx.select().from(externalActions).where(eq(externalActions.id, id)),
    );
    if (!row) throw new Error('No such action');
    return row;
  };

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const ownerUser = await makeUser('org-owner');
    const rivalUser = await makeUser('rival');
    const orgA = await createOrganization(database.db, {
      userId: ownerUser,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    const orgB = await createOrganization(database.db, {
      userId: rivalUser,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    orgOwner = await resolveTenantContext(database.db, ownerUser, orgA.organizationId);
    rival = await resolveTenantContext(database.db, rivalUser, orgB.organizationId);
    admin = await addMember(orgA.organizationId, 'admin', 'admin');
    workOwner = await addMember(orgA.organizationId, 'work-owner', 'member');
    assignee = await addMember(orgA.organizationId, 'assignee', 'member');
    outsider = await addMember(orgA.organizationId, 'outsider', 'member');
    approver = await addMember(orgA.organizationId, 'approver', 'member');
    connection = await seedConnection(database.db, orgOwner, {
      config: { fromAddress: 'sender@example.invalid', fromName: 'The sender' },
    });
    rivalConnection = await seedConnection(database.db, rival, {
      config: { fromAddress: 'rival@example.invalid' },
    });
  });

  afterAll(async () => {
    await auth.end();
    await database.close();
  });

  describe('reading', () => {
    it('shows the exact payload and the receipts to someone who can read the work', async () => {
      const payload = testEmailPayload({ to: ['first@example.invalid'], subject: 'Exact words' });
      const action = await seed('sent', 'internal', payload);
      const detail = await getExternalActionDetail(database.db, workOwner, action.id);
      expect(detail.status).toBe('sent');
      expect(detail.payload).toEqual(payload);
      expect(detail.requestHash).toBe(action.requestHash);
      expect(detail.approvalId).toBe(action.approvalId);
      expect(detail.connectionName).toBe('Test mail');
      expect(detail.attemptCount).toBe(1);
      expect(detail.subject).toBe('Exact words');
    });

    it('lists receipts with whose word each rests on, and names only a person', async () => {
      const action = await seed('unknown');
      await resolve(workOwner, action.id);
      const detail = await getExternalActionDetail(database.db, outsider, action.id);
      expect(detail.receipts).toEqual([
        expect.objectContaining({
          outcome: 'sent',
          basis: 'person',
          code: 'PERSON_CONFIRMED_SENT',
          actorName: 'work-owner',
        }),
      ]);
      expect(detail.resolution).toBe('confirmed_sent');
      expect(detail.resolutionReason).toBe('I searched the log and it was there.');
      expect(detail.resolvedByName).toBe('work-owner');
    });

    it('answers not found for another tenant, with the same words as a missing one', async () => {
      const action = await seed('unknown');
      await expect(getExternalActionDetail(database.db, rival, action.id)).rejects.toEqual(
        hasCode('NOT_FOUND'),
      );
      await expect(getExternalActionDetail(database.db, rival, randomUUID())).rejects.toEqual(
        hasCode('NOT_FOUND'),
      );
      const page = await listExternalActions(database.db, rival, {});
      expect(page.items.map((item) => item.id)).not.toContain(action.id);
      expect(await listExternalActionsNeedingReview(database.db, rival)).toEqual([]);
    });

    it('refuses a malformed ID as not found, not as a database error', async () => {
      await expect(getExternalActionDetail(database.db, workOwner, 'nonsense')).rejects.toEqual(
        hasCode('NOT_FOUND'),
      );
    });

    it('answers not found for someone with no access to confidential work', async () => {
      const action = await seed('unknown', 'confidential');
      await expect(getExternalActionDetail(database.db, outsider, action.id)).rejects.toEqual(
        hasCode('NOT_FOUND'),
      );
      const page = await listExternalActions(database.db, outsider, {});
      expect(page.items.map((item) => item.id)).not.toContain(action.id);
      // An organization admin may read confidential work, so the same action is there for them.
      expect((await getExternalActionDetail(database.db, admin, action.id)).id).toBe(action.id);
    });

    it('hides an action on restricted work from an organization admin who is not on it', async () => {
      const action = await seed('unknown', 'restricted');
      for (const context of [admin, orgOwner, outsider]) {
        await expect(getExternalActionDetail(database.db, context, action.id)).rejects.toEqual(
          hasCode('NOT_FOUND'),
        );
        const page = await listExternalActions(database.db, context, {
          workUnitId: action.workUnitId,
        });
        expect(page.items).toEqual([]);
        const review = await listExternalActionsNeedingReview(database.db, context);
        expect(review.map((item) => item.id)).not.toContain(action.id);
      }
    });

    it('filters by work and by status, and pages without skipping or repeating', async () => {
      const first = await seed('sent');
      const second = await seed('failed');
      const byWork = await listExternalActions(database.db, workOwner, {
        workUnitId: first.workUnitId,
      });
      expect(byWork.items.map((item) => item.id)).toEqual([first.id]);
      const failed = await listExternalActions(database.db, workOwner, { status: 'failed' });
      expect(failed.items.map((item) => item.id)).toContain(second.id);
      expect(failed.items.every((item) => item.status === 'failed')).toBe(true);

      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 200; page += 1) {
        const result = await listExternalActions(database.db, workOwner, {
          limit: 2,
          ...(after ? { after } : {}),
        });
        seen.push(...result.items.map((item) => item.id));
        if (!result.next) break;
        after = result.next;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining([first.id, second.id]));
    });

    it('refuses a forged cursor, and a limit cannot ask for more than a page', async () => {
      await expect(
        listExternalActions(database.db, workOwner, { after: 'forged' }),
      ).rejects.toEqual(hasCode('INVALID_INPUT'));
      const page = await listExternalActions(database.db, workOwner, { limit: 100_000 });
      expect(page.items.length).toBeLessThanOrEqual(50);
    });

    it('lists a service context nothing to review', async () => {
      const service = createServiceContext(workOwner.organizationId);
      expect(await listExternalActionsNeedingReview(database.db, service)).toEqual([]);
    });
  });

  describe('who may say what happened', () => {
    it('offers resolving to who answers for the work, and only while it is unknown', async () => {
      const action = await seed('unknown');
      const allowed = async (context: TenantContext) =>
        (await getExternalActionDetail(database.db, context, action.id)).canResolve;
      expect(await allowed(workOwner)).toBe(true);
      expect(await allowed(admin)).toBe(true);
      expect(await allowed(orgOwner)).toBe(true);
      expect(await allowed(assignee)).toBe(false);
      expect(await allowed(outsider)).toBe(false);

      const sent = await seed('sent');
      const detail = await getExternalActionDetail(database.db, workOwner, sent.id);
      expect(detail.canResolve).toBe(false);
    });

    it('lists what needs review only for those who may resolve it, oldest first', async () => {
      const older = await seed('unknown');
      const newer = await seed('unknown');
      const ids = (await listExternalActionsNeedingReview(database.db, workOwner)).map((a) => a.id);
      expect(ids.indexOf(older.id)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
      for (const context of [admin, orgOwner]) {
        const seen = (await listExternalActionsNeedingReview(database.db, context)).map(
          (a) => a.id,
        );
        expect(seen).toContain(older.id);
      }
      for (const context of [assignee, outsider, approver]) {
        const seen = (await listExternalActionsNeedingReview(database.db, context)).map(
          (a) => a.id,
        );
        expect(seen).not.toContain(older.id);
      }
    });

    it('refuses a service context, whatever a model or workflow asks', async () => {
      const action = await seed('unknown');
      const service = createServiceContext(workOwner.organizationId);
      await expect(resolve(service, action.id)).rejects.toEqual(hasCode('FORBIDDEN'));
      expect((await rowOf(action.id)).status).toBe('unknown');
    });

    it('refuses a member who is only assigned, and leaves it unknown', async () => {
      const action = await seed('unknown');
      await expect(resolve(assignee, action.id)).rejects.toEqual(hasCode('FORBIDDEN'));
      expect((await rowOf(action.id)).status).toBe('unknown');
    });

    it('answers not found to someone who cannot read the work', async () => {
      const action = await seed('unknown', 'confidential');
      await expect(resolve(outsider, action.id)).rejects.toEqual(hasCode('NOT_FOUND'));
      expect((await rowOf(action.id)).status).toBe('unknown');
    });

    it('answers not found to an admin who cannot read restricted work', async () => {
      const action = await seed('unknown', 'restricted');
      await expect(resolve(admin, action.id)).rejects.toEqual(hasCode('NOT_FOUND'));
      await expect(resolve(orgOwner, action.id)).rejects.toEqual(hasCode('NOT_FOUND'));
      expect((await rowOf(action.id)).status).toBe('unknown');
    });

    it('answers not found to another tenant, and changes nothing', async () => {
      const action = await seed('unknown');
      await expect(resolve(rival, action.id)).rejects.toEqual(hasCode('NOT_FOUND'));
      expect((await rowOf(action.id)).status).toBe('unknown');
    });

    it('refuses every status but unknown', async () => {
      for (const status of [
        'awaiting_approval',
        'ready',
        'sending',
        'reconciling',
        'sent',
        'failed',
        'cancelled',
      ] as const) {
        const action = await seed(status);
        await expect(resolve(workOwner, action.id)).rejects.toEqual(
          hasCode('EXTERNAL_ACTION_NOT_RESOLVABLE'),
        );
        expect((await rowOf(action.id)).status).toBe(status);
      }
    });

    it('refuses a stale version', async () => {
      const action = await seed('unknown');
      await expect(resolve(workOwner, action.id, { expectedVersion: 99 })).rejects.toEqual(
        hasCode('VERSION_CONFLICT'),
      );
      expect((await rowOf(action.id)).status).toBe('unknown');
    });

    it('answers the same for the second of two people answering', async () => {
      const action = await seed('unknown');
      await resolve(workOwner, action.id);
      await expect(resolve(admin, action.id)).rejects.toEqual(
        hasCode('EXTERNAL_ACTION_NOT_RESOLVABLE'),
      );
    });

    it('requires a reason of a sensible length and a known answer', async () => {
      const action = await seed('unknown');
      await expect(resolve(workOwner, action.id, { reason: '   ' })).rejects.toEqual(
        hasCode('REASON_REQUIRED'),
      );
      await expect(resolve(workOwner, action.id, { reason: 'x'.repeat(2001) })).rejects.toEqual(
        hasCode('INVALID_INPUT'),
      );
      await expect(
        resolve(workOwner, action.id, { resolution: 'probably' as 'confirmed_sent' }),
      ).rejects.toEqual(hasCode('INVALID_INPUT'));
      await expect(
        resolveUnknownExternalAction(database.db, workOwner, {
          externalActionId: 'nonsense',
          expectedVersion: 1,
          resolution: 'confirmed_sent',
          reason: 'A reason.',
        }),
      ).rejects.toEqual(hasCode('NOT_FOUND'));
      expect((await rowOf(action.id)).status).toBe('unknown');
    });
  });

  describe('saying what happened', () => {
    it('records confirmed sent as this person, with a receipt, an audit row and an event', async () => {
      const action = await seed('unknown');
      const result = await resolve(workOwner, action.id);
      expect(result).toEqual({ status: 'sent', version: 2 });

      const row = await rowOf(action.id);
      expect(row).toMatchObject({
        status: 'sent',
        statusReason: 'PERSON_CONFIRMED_SENT',
        resolution: 'confirmed_sent',
        resolvedByMembershipId: workOwner.membershipId,
        resolutionReason: 'I searched the log and it was there.',
        version: 2,
      });
      expect(row.settledAt).not.toBeNull();

      const receipts = await withTenantTx(database.db, orgOwner, (tx) =>
        tx
          .select()
          .from(externalActionReceipts)
          .where(eq(externalActionReceipts.externalActionId, action.id)),
      );
      expect(receipts).toEqual([
        expect.objectContaining({
          outcome: 'sent',
          basis: 'person',
          code: 'PERSON_CONFIRMED_SENT',
          actorMembershipId: workOwner.membershipId,
          requestHash: action.requestHash,
        }),
      ]);

      const events = await withTenantTx(database.db, orgOwner, (tx) =>
        tx
          .select()
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.aggregateId, action.id),
              eq(domainEvents.eventType, EXTERNAL_ACTION_RESOLVED),
            ),
          ),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.aggregateType).toBe('external_action');
      expect(events[0]?.aggregateVersion).toBe(2);
      const eventId = events[0]?.id as string;
      const outbox = await withTenantTx(database.db, orgOwner, (tx) =>
        tx.select().from(outboxEvents).where(eq(outboxEvents.eventId, eventId)),
      );
      expect(outbox).toHaveLength(1);

      const audit = await withTenantTx(database.db, orgOwner, (tx) =>
        tx
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.targetRef, externalActionTargetRef(action.id))),
      );
      expect(audit).toEqual([
        expect.objectContaining({
          action: EXTERNAL_ACTION_RESOLVED,
          actorId: workOwner.membershipId,
          safeReason: 'PERSON_CONFIRMED_SENT',
        }),
      ]);
    });

    it('never puts what a person wrote, or the email, in an event or the audit log', async () => {
      const canary = `canary-${randomUUID()}`;
      const action = await seed(
        'unknown',
        'internal',
        testEmailPayload({ subject: `Subject ${canary}`, text_body: `Body ${canary}` }),
      );
      await resolve(workOwner, action.id, { reason: `Reason ${canary}` });
      const haystack = await withTenantTx(database.db, orgOwner, async (tx) => {
        const events = await tx
          .select({ payload: domainEvents.payload })
          .from(domainEvents)
          .where(eq(domainEvents.aggregateId, action.id));
        const audit = await tx
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.targetRef, externalActionTargetRef(action.id)));
        return JSON.stringify({ events, audit });
      });
      expect(haystack).not.toContain(canary);
    });

    it('records confirmed not sent as failed, and that sends nothing and opens nothing', async () => {
      const action = await seed('unknown');
      const result = await resolve(admin, action.id, {
        resolution: 'confirmed_not_sent',
        reason: 'Not in the log for that day.',
      });
      expect(result).toEqual({ status: 'failed', version: 2 });
      const row = await rowOf(action.id);
      expect(row).toMatchObject({
        status: 'failed',
        statusReason: 'PERSON_CONFIRMED_NOT_SENT',
        resolution: 'confirmed_not_sent',
        resolvedByMembershipId: admin.membershipId,
      });
      const attempts = await withTenantTx(database.db, orgOwner, (tx) =>
        tx
          .select()
          .from(externalActionAttempts)
          .where(eq(externalActionAttempts.externalActionId, action.id)),
      );
      // The one attempt the seed made, and no other: a person's answer contacts nobody.
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.outcome).toBe('indeterminate');
      const ready = await withTenantTx(database.db, orgOwner, (tx) =>
        tx
          .select()
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.aggregateId, action.id),
              eq(domainEvents.eventType, 'external_action.ready'),
            ),
          ),
      );
      expect(ready).toEqual([]);
      const detail = await getExternalActionDetail(database.db, workOwner, action.id);
      expect(detail.canResolve).toBe(false);
      expect(detail.canRetry).toBe(true);
    });

    it('offers asking again only for a failed action, and only to someone who can change the work', async () => {
      const failed = await seed('failed');
      const retry = async (context: TenantContext, id = failed.id) =>
        (await getExternalActionDetail(database.db, context, id)).canRetry;
      expect(await retry(workOwner)).toBe(true);
      expect(await retry(assignee)).toBe(true);
      expect(await retry(admin)).toBe(true);
      expect(await retry(outsider)).toBe(false);
      for (const status of ['sent', 'unknown', 'cancelled', 'awaiting_approval'] as const) {
        const action = await seed(status);
        expect(await retry(workOwner, action.id)).toBe(false);
      }
    });

    it('does not offer asking again through a connection that has gone', async () => {
      const gone = await seedConnection(database.db, orgOwner, {
        state: 'revoked',
        config: { fromAddress: 'gone@example.invalid' },
      });
      const workUnitId = await makeWork();
      // An action made while it was active, which is the only way to have one on it.
      await withTenantTx(database.db, orgOwner, (tx) =>
        tx.update(connections).set({ state: 'active' }).where(eq(connections.id, gone)),
      );
      const action = await seedExternalAction(database.db, workOwner, {
        workUnitId,
        connectionId: gone,
        approverMembershipId: approver.membershipId,
        status: 'failed',
      });
      await withTenantTx(database.db, orgOwner, (tx) =>
        tx.update(connections).set({ state: 'revoked' }).where(eq(connections.id, gone)),
      );
      const detail = await getExternalActionDetail(database.db, workOwner, action.id);
      expect(detail.canRetry).toBe(false);
    });

    it('offers changing an action only before any attempt exists', async () => {
      const waiting = await seed('awaiting_approval');
      const ready = await seed('ready');
      const failed = await seed('failed');
      const can = async (context: TenantContext, id: string) =>
        (await getExternalActionDetail(database.db, context, id)).canRevise;
      expect(await can(workOwner, waiting.id)).toBe(true);
      expect(await can(workOwner, ready.id)).toBe(true);
      expect(await can(assignee, waiting.id)).toBe(true);
      expect(await can(outsider, waiting.id)).toBe(false);
      expect(await can(workOwner, failed.id)).toBe(false);
    });

    it('settles the unread question for everyone it was asked of, and tells them the answer', async () => {
      const action = await seed('unknown');
      const target = externalActionTargetRef(action.id);
      await withTenantTx(database.db, orgOwner, (tx) =>
        notify(
          tx,
          // A service tells people, so nobody is left out for being the one acting.
          createServiceContext(workOwner.organizationId),
          [workOwner.membershipId, admin.membershipId],
          NOTIFY_EXTERNAL_ACTION_UNKNOWN,
          target,
        ),
      );
      const before = await countUnread(database.db, workOwner);
      await resolve(admin, action.id);
      const mine = await listMyNotifications(database.db, workOwner);
      const about = mine.filter((notification) => notification.targetRef === target);
      expect(about.find((n) => n.kind === NOTIFY_EXTERNAL_ACTION_UNKNOWN)?.readAt).not.toBeNull();
      expect(about.find((n) => n.kind === 'external_action.sent')?.readAt).toBeNull();
      expect(await countUnread(database.db, workOwner)).toBe(before);
    });

    it('holds even if the row moves between reading and writing', async () => {
      const action = await seed('unknown');
      const results = await Promise.allSettled([
        resolve(workOwner, action.id),
        resolve(admin, action.id, { resolution: 'confirmed_not_sent', reason: 'Not there.' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const row = await rowOf(action.id);
      const receipts = await withTenantTx(database.db, orgOwner, (tx) =>
        tx
          .select()
          .from(externalActionReceipts)
          .where(eq(externalActionReceipts.externalActionId, action.id)),
      );
      expect(receipts).toHaveLength(1);
      expect(row.status).toBe(receipts[0]?.outcome);
    });
  });

  describe('recent callbacks', () => {
    const seedDelivery = async (context: TenantContext, connectionId: string) => {
      const secretId = randomUUID();
      const endpointId = randomUUID();
      const id = randomUUID();
      const canary = `canary-${randomUUID()}`;
      await withTenantTx(database.db, context, async (tx) => {
        await tx.execute(
          sql`insert into secrets.sealed_secrets (organization_id, id, purpose, key_id, wrapped_key, iv,
                ciphertext, auth_tag)
              values (${context.organizationId}, ${secretId}, 'webhook_signing', 'k', '\\x00', '\\x00',
                '\\x00', '\\x00')`,
        );
        await tx.insert(webhookEndpoints).values({
          organizationId: context.organizationId,
          id: endpointId,
          connectionId,
          tokenHash: randomUUID(),
          signingSecretId: secretId,
          signatureScheme: 'ensemus_hmac_sha256_v1',
        });
        await tx.insert(webhookDeliveries).values({
          organizationId: context.organizationId,
          id,
          endpointId,
          requestDigest: randomUUID(),
          body: Buffer.from(canary),
          bodySha256: 'x',
          sizeBytes: canary.length,
          headers: { 'x-canary': canary },
          state: 'rejected',
          rejectCode: 'BAD_SIGNATURE',
        });
      });
      return { id, canary };
    };

    it('shows who manages connections how each ended, and never what it held', async () => {
      const delivery = await seedDelivery(orgOwner, connection);
      const found = await listWebhookActivity(database.db, admin);
      expect(found.find((row) => row.id === delivery.id)).toMatchObject({
        connectionId: connection,
        state: 'rejected',
        rejectCode: 'BAD_SIGNATURE',
      });
      expect(JSON.stringify(found)).not.toContain(delivery.canary);
    });

    it('refuses a member and a service, and never shows another tenant', async () => {
      const delivery = await seedDelivery(orgOwner, connection);
      await expect(listWebhookActivity(database.db, workOwner)).rejects.toEqual(
        hasCode('FORBIDDEN'),
      );
      await expect(
        listWebhookActivity(database.db, createServiceContext(workOwner.organizationId)),
      ).rejects.toEqual(hasCode('FORBIDDEN'));
      const theirs = await listWebhookActivity(database.db, rival);
      expect(theirs.map((row) => row.id)).not.toContain(delivery.id);
    });
  });

  describe('connections a person can choose from', () => {
    it('lists only active ones that can act, in this tenant, with no credential', async () => {
      const inbound = await seedConnection(database.db, orgOwner, {
        connectorType: 'inbound_webhook',
        displayName: 'A callback',
      });
      const revoked = await seedConnection(database.db, orgOwner, {
        state: 'revoked',
        displayName: 'Gone',
      });
      for (const context of [workOwner, outsider]) {
        const found = await listActionConnections(database.db, context);
        const ids = found.map((item) => item.id);
        expect(ids).toContain(connection);
        expect(ids).not.toContain(inbound);
        expect(ids).not.toContain(revoked);
        expect(ids).not.toContain(rivalConnection);
        expect(found.find((item) => item.id === connection)).toEqual({
          id: connection,
          displayName: 'Test mail',
          connectorType: 'email_smtp',
          fromAddress: 'sender@example.invalid',
          fromName: 'The sender',
        });
      }
    });

    it('freezes the sender from the connection, and takes nothing about it from the caller', async () => {
      const email = { to: ['a@example.invalid'], subject: 'Hi', text_body: 'Hello.' };
      const payload = await emailPayloadFromConnection(database.db, workOwner, connection, email);
      expect(payload).toEqual({
        ...email,
        from: { address: 'sender@example.invalid', name: 'The sender' },
      });
    });

    it('refuses a sender from another tenant, or from a connection that cannot act', async () => {
      const email = { to: ['a@example.invalid'], subject: 'Hi', text_body: 'Hello.' };
      await expect(
        emailPayloadFromConnection(database.db, workOwner, rivalConnection, email),
      ).rejects.toEqual(hasCode('NOT_FOUND'));
      await expect(
        emailPayloadFromConnection(database.db, workOwner, randomUUID(), email),
      ).rejects.toEqual(hasCode('NOT_FOUND'));
      const revoked = await seedConnection(database.db, orgOwner, {
        state: 'revoked',
        config: { fromAddress: 'gone@example.invalid' },
      });
      await expect(
        emailPayloadFromConnection(database.db, workOwner, revoked, email),
      ).rejects.toEqual(hasCode('CONNECTION_NOT_ACTIVE'));
      const inbound = await seedConnection(database.db, orgOwner, {
        connectorType: 'inbound_webhook',
      });
      await expect(
        emailPayloadFromConnection(database.db, workOwner, inbound, email),
      ).rejects.toEqual(hasCode('INVALID_INPUT'));
    });

    it('takes a revision through the same connection, for someone who can read the action', async () => {
      const email = { to: ['b@example.invalid'], subject: 'Changed', text_body: 'New words.' };
      const action = await seed('awaiting_approval', 'confidential');
      const payload = await emailPayloadForRevision(database.db, workOwner, action.id, email);
      expect(payload.from.address).toBe('sender@example.invalid');
      expect(payload.to).toEqual(['b@example.invalid']);
      await expect(
        emailPayloadForRevision(database.db, outsider, action.id, email),
      ).rejects.toEqual(hasCode('NOT_FOUND'));
      await expect(emailPayloadForRevision(database.db, rival, action.id, email)).rejects.toEqual(
        hasCode('NOT_FOUND'),
      );
    });
  });
});
