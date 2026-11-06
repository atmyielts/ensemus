// ADR-037 D6, the review's one safety claim. REJECT_DUPLICATE can only stop a second run while Temporal still
// has the first one, and retention takes that away. So what it protects has to hold with no Temporal record at
// all, and this file has none: global-setup starts PostgreSQL alone, and nothing here imports a Temporal client.
// It calls what a second run would call, on real roles, in two tenants with the same names. A path to a second
// effect here is a finding against ADR-027 for the owner, not something to fix in this slice.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyVerifiedDelivery,
  beginAttempt,
  beginReconcile,
  createWebhookEndpoint,
  createWorkUnit,
  ingestWebhookDelivery,
  loadStoredDelivery,
  purgeExpiredWebhookDeliveries,
  rejectDelivery,
  type WebhookEffectHandlers,
} from '@ensemus/application';
import {
  createOrganization,
  domainEvents,
  externalActionAttempts,
  externalActionReceipts,
  externalActions,
  inboxEvents,
  openAppDatabase,
  resolveTenantContext,
  webhookDeliveries,
  webhookEndpoints,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { SECRET_PURPOSE_WEBHOOK_SIGNING } from '@ensemus/domain/connector';
import type { ExternalActionStatus } from '@ensemus/domain/external-action';
import { webhookInboxConsumer, webhookInboxEventId } from '@ensemus/domain/webhook';
import { storeSecret } from '@ensemus/secrets/seal';
import { and, eq, sql } from 'drizzle-orm';
import { seedConnection, seedExternalAction } from '../helpers/integrations';
import { secret, urls } from '../helpers/stack';

const SCHEME = 'ensemus_hmac_sha256_v1' as const;
const SECOND_RUN = 'a-second-run-after-retention';
const notFound = expect.objectContaining({ code: 'NOT_FOUND' });

describe('with no Temporal record of the first run', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let ctxA: TenantContext;
  let ctxB: TenantContext;
  let serviceA: TenantContext;
  let serviceB: TenantContext;
  let approverA: string;
  let connectionA: string;

  const makeUser = async (label: string) => {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      `${label}-${id}@example.invalid`,
    ]);
    return id;
  };

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const orgA = await createOrganization(database.db, {
      userId: alice,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    const orgB = await createOrganization(database.db, {
      userId: bob,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    ctxA = await resolveTenantContext(database.db, alice, orgA.organizationId);
    ctxB = await resolveTenantContext(database.db, bob, orgB.organizationId);
    // The worker's identity, since that is who a second run would be.
    serviceA = createServiceContext(orgA.organizationId);
    serviceB = createServiceContext(orgB.organizationId);
    const approver = await makeUser('approver');
    approverA = randomUUID();
    await withTenantTx(database.db, ctxA, (tx) =>
      tx.execute(
        sql`insert into org.memberships (organization_id, id, user_id, role)
            values (${ctxA.organizationId}, ${approverA}, ${approver}, 'member')`,
      ),
    );
    connectionA = await seedConnection(database.db, ctxA);
  });

  afterAll(async () => {
    await database?.close();
    await auth?.end();
  });

  describe('an external action', () => {
    // A Work Unit of its own each time, because one can hold only one open approval.
    const seed = async (status: ExternalActionStatus) =>
      seedExternalAction(database.db, ctxA, {
        workUnitId: (
          await createWorkUnit(database.db, ctxA, { title: 'A send', objective: 'Say something.' })
        ).id,
        connectionId: connectionA,
        approverMembershipId: approverA,
        status,
      });

    /** Whole rows, so that any write at all, even one that changes only a version, fails the comparison. */
    const recordOf = (id: string) =>
      withTenantTx(database.db, ctxA, async (tx) => ({
        action: await tx.select().from(externalActions).where(eq(externalActions.id, id)),
        attempts: await tx
          .select()
          .from(externalActionAttempts)
          .where(eq(externalActionAttempts.externalActionId, id)),
        receipts: await tx
          .select()
          .from(externalActionReceipts)
          .where(eq(externalActionReceipts.externalActionId, id)),
        events: await tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, id)),
      }));

    it.each(['sent', 'failed', 'unknown'] as const)(
      'that ended %s gets no attempt row and no effect from another run',
      async (status) => {
        const action = await seed(status);
        const before = await recordOf(action.id);
        expect(before.attempts).toHaveLength(1);

        const again = await beginAttempt(database.db, serviceA, {
          externalActionId: action.id,
          runId: SECOND_RUN,
        });

        // Only `send` hands a worker anything to send with, so `stop` is no effect.
        expect(again).toEqual({ kind: 'stop', status });
        expect(await recordOf(action.id)).toEqual(before);
      },
    );

    it.each(['sent', 'failed', 'unknown'] as const)(
      'that ended %s stays that way however many runs come',
      async (status) => {
        const action = await seed(status);
        const before = await recordOf(action.id);
        const runs = await Promise.all(
          ['one', 'two', 'three'].map((run) =>
            beginAttempt(database.db, serviceA, {
              externalActionId: action.id,
              runId: `${SECOND_RUN}-${run}`,
            }),
          ),
        );
        for (const run of runs) expect(run).toEqual({ kind: 'stop', status });
        expect(await recordOf(action.id)).toEqual(before);
      },
    );

    it('that was cancelled before any attempt gets none from another run', async () => {
      const action = await seed('cancelled');
      const before = await recordOf(action.id);
      expect(before.attempts).toHaveLength(0);
      expect(
        await beginAttempt(database.db, serviceA, {
          externalActionId: action.id,
          runId: SECOND_RUN,
        }),
      ).toEqual({ kind: 'stop', status: 'cancelled' });
      expect(await recordOf(action.id)).toEqual(before);
    });

    it.each(['sending', 'reconciling'] as const)(
      'left %s by a run nobody remembers is reconciled, and is not sent again',
      async (status) => {
        const action = await seed(status);
        const before = await recordOf(action.id);
        const again = await beginAttempt(database.db, serviceA, {
          externalActionId: action.id,
          runId: SECOND_RUN,
        });
        expect(again).toEqual({ kind: 'reconcile', attemptId: action.attemptId });
        expect(await recordOf(action.id)).toEqual(before);
      },
    );

    it.each(['sent', 'failed', 'unknown'] as const)(
      'that ended %s is not reopened by a second run reaching for reconciliation',
      async (status) => {
        const action = await seed(status);
        const before = await recordOf(action.id);
        expect(
          await beginReconcile(database.db, serviceA, {
            externalActionId: action.id,
            code: 'WORKER_INTERRUPTED',
          }),
        ).toEqual({ kind: 'settled', status });
        expect(await recordOf(action.id)).toEqual(before);
      },
    );

    it.each(['sent', 'failed', 'unknown', 'ready', 'sending'] as const)(
      'that is %s in this tenant cannot be touched with its ID from another',
      async (status) => {
        const action = await seed(status);
        const before = await recordOf(action.id);
        await expect(
          beginAttempt(database.db, serviceB, { externalActionId: action.id, runId: SECOND_RUN }),
        ).rejects.toEqual(notFound);
        await expect(
          beginAttempt(database.db, ctxB, { externalActionId: action.id, runId: SECOND_RUN }),
        ).rejects.toEqual(notFound);
        await expect(
          beginReconcile(database.db, serviceB, {
            externalActionId: action.id,
            code: 'WORKER_INTERRUPTED',
          }),
        ).rejects.toEqual(notFound);
        expect(await recordOf(action.id)).toEqual(before);
      },
    );
  });

  describe('a webhook delivery', () => {
    type Endpoint = {
      organizationId: string;
      service: TenantContext;
      endpointId: string;
      token: string;
    };
    let endpointA: Endpoint;
    let endpointB: Endpoint;

    const effectCalls: string[] = [];
    const handlers: WebhookEffectHandlers = {
      async proposeAction(_tx, context) {
        effectCalls.push(`propose:${context.organizationId}`);
      },
      async requestSync(_tx, context) {
        effectCalls.push(`sync:${context.organizationId}`);
      },
    };
    const SYNC = [{ kind: 'sync_requested' }] as const;

    const makeEndpoint = async (
      context: TenantContext,
      service: TenantContext,
    ): Promise<Endpoint> => {
      const connectionId = await seedConnection(database.db, context, {
        connectorType: 'inbound_webhook',
        displayName: 'Same name',
        config: {},
      });
      const { secretRef } = await storeSecret(database.db, context, {
        publicKeyPem: secret('sealing_public_key.pem'),
        purpose: SECRET_PURPOSE_WEBHOOK_SIGNING,
        plaintext: randomBytes(32).toString('base64url'),
      });
      const { endpointId, token } = await createWebhookEndpoint(database.db, context, {
        connectionId,
        signingSecretId: secretRef,
        signatureScheme: SCHEME,
      });
      return { organizationId: context.organizationId, service, endpointId, token };
    };

    /** Stored the way the web tier stores anything. The signature is the verifier's, which comes later. */
    const store = async (endpoint: Endpoint) => {
      const body = Buffer.from(`{"nonce":"${randomUUID()}"}`);
      expect(
        await ingestWebhookDelivery(database.db, {
          token: endpoint.token,
          body,
          headers: { 'content-type': 'application/json' },
        }),
      ).toBe('accepted');
      const [row] = await withTenantTx(database.db, endpoint.service, (tx) =>
        tx
          .select({ id: webhookDeliveries.id })
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.endpointId, endpoint.endpointId),
              eq(webhookDeliveries.bodySha256, createHash('sha256').update(body).digest('hex')),
            ),
          ),
      );
      if (!row) throw new Error('Nothing was stored');
      return row.id;
    };

    const apply = (endpoint: Endpoint, deliveryId: string, providerEventId: string) =>
      applyVerifiedDelivery(
        database.db,
        endpoint.service,
        { deliveryId, providerEventId, effects: SYNC },
        handlers,
      );

    const inboxRows = (endpoint: Endpoint) =>
      withTenantTx(database.db, endpoint.service, (tx) =>
        tx
          .select()
          .from(inboxEvents)
          .where(eq(inboxEvents.consumerId, webhookInboxConsumer(endpoint.endpointId))),
      );

    /** Whole rows again, with what a delivery holds against its endpoint's backlog. */
    const recordOf = (endpoint: Endpoint, deliveryId: string) =>
      withTenantTx(database.db, endpoint.service, async (tx) => ({
        delivery: await tx
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, deliveryId)),
        inbox: await tx
          .select()
          .from(inboxEvents)
          .where(eq(inboxEvents.consumerId, webhookInboxConsumer(endpoint.endpointId))),
        events: await tx
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.aggregateId, deliveryId)),
        pending: await tx
          .select({ pending: webhookEndpoints.pendingBytes })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, endpoint.endpointId)),
      }));

    /** Everything a second run could do with this ID, and what each has to answer. */
    const expectSecondRunDoesNothing = async (
      endpoint: Endpoint,
      deliveryId: string,
      providerEventId: string,
      state: 'applied' | 'duplicate' | 'rejected',
    ) => {
      const before = await recordOf(endpoint, deliveryId);
      const effectsBefore = [...effectCalls];

      expect(await loadStoredDelivery(database.db, endpoint.service, { deliveryId })).toBeNull();
      expect(await apply(endpoint, deliveryId, providerEventId)).toBe(state);
      // An ID the inbox has never seen, so only the delivery's own state can be what stops it.
      expect(await apply(endpoint, deliveryId, randomUUID())).toBe(state);
      expect(
        await rejectDelivery(database.db, endpoint.service, { deliveryId, code: 'BAD_SIGNATURE' }),
      ).toBe(state);

      expect(effectCalls).toEqual(effectsBefore);
      expect(await recordOf(endpoint, deliveryId)).toEqual(before);
    };

    beforeEach(async () => {
      effectCalls.length = 0;
      endpointA = await makeEndpoint(ctxA, serviceA);
      endpointB = await makeEndpoint(ctxB, serviceB);
    });

    it('that was applied changes nothing and calls no effect handler when run again', async () => {
      const deliveryId = await store(endpointA);
      const eventId = randomUUID();
      expect(await apply(endpointA, deliveryId, eventId)).toBe('applied');
      expect(effectCalls).toEqual([`sync:${endpointA.organizationId}`]);

      await expectSecondRunDoesNothing(endpointA, deliveryId, eventId, 'applied');

      expect(effectCalls).toHaveLength(1);
      const inbox = await inboxRows(endpointA);
      expect(inbox.map((row) => row.eventId)).toEqual([
        webhookInboxEventId(endpointA.endpointId, eventId),
      ]);
    });

    it('that was a duplicate changes nothing and calls no effect handler when run again', async () => {
      const eventId = randomUUID();
      expect(await apply(endpointA, await store(endpointA), eventId)).toBe('applied');
      effectCalls.length = 0;

      const deliveryId = await store(endpointA);
      expect(await apply(endpointA, deliveryId, eventId)).toBe('duplicate');
      expect(effectCalls).toEqual([]);

      await expectSecondRunDoesNothing(endpointA, deliveryId, eventId, 'duplicate');
      expect(effectCalls).toEqual([]);
    });

    it('that was rejected cannot be brought back by a run that believes it', async () => {
      const deliveryId = await store(endpointA);
      expect(
        await rejectDelivery(database.db, serviceA, { deliveryId, code: 'BAD_SIGNATURE' }),
      ).toBe('rejected');

      await expectSecondRunDoesNothing(endpointA, deliveryId, randomUUID(), 'rejected');

      expect(effectCalls).toEqual([]);
      expect(await inboxRows(endpointA)).toEqual([]);
    });

    it('whose row has since been purged gives a later run nothing to act on', async () => {
      // A redrive can come later than any retention. The row goes a week after it ended, and the inbox stays.
      const deliveryId = await store(endpointA);
      const eventId = randomUUID();
      expect(await apply(endpointA, deliveryId, eventId)).toBe('applied');
      effectCalls.length = 0;

      const eightDaysOn = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
      await purgeExpiredWebhookDeliveries(database.db, serviceA, eightDaysOn);
      const rows = await withTenantTx(database.db, serviceA, (tx) =>
        tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)),
      );
      expect(rows).toEqual([]);

      expect(await loadStoredDelivery(database.db, serviceA, { deliveryId })).toBeNull();
      await expect(apply(endpointA, deliveryId, eventId)).rejects.toEqual(notFound);
      expect(effectCalls).toEqual([]);
    });

    it('in this tenant cannot be touched with its ID from another', async () => {
      const waiting = await store(endpointA);
      const finished = await store(endpointA);
      const eventId = randomUUID();
      expect(await apply(endpointA, finished, eventId)).toBe('applied');
      effectCalls.length = 0;
      // Their own delivery, waiting under the same names, which nothing here should disturb either.
      const theirs = await store(endpointB);
      const before = {
        waiting: await recordOf(endpointA, waiting),
        finished: await recordOf(endpointA, finished),
        theirs: await recordOf(endpointB, theirs),
      };

      for (const deliveryId of [waiting, finished]) {
        expect(await loadStoredDelivery(database.db, serviceB, { deliveryId })).toBeNull();
        await expect(
          applyVerifiedDelivery(
            database.db,
            serviceB,
            { deliveryId, providerEventId: randomUUID(), effects: SYNC },
            handlers,
          ),
        ).rejects.toEqual(notFound);
        await expect(
          rejectDelivery(database.db, serviceB, { deliveryId, code: 'BAD_SIGNATURE' }),
        ).rejects.toEqual(notFound);
      }

      // And the other way round.
      expect(await loadStoredDelivery(database.db, serviceA, { deliveryId: theirs })).toBeNull();
      await expect(
        applyVerifiedDelivery(
          database.db,
          serviceA,
          { deliveryId: theirs, providerEventId: randomUUID(), effects: SYNC },
          handlers,
        ),
      ).rejects.toEqual(notFound);

      expect(effectCalls).toEqual([]);
      expect(await recordOf(endpointA, waiting)).toEqual(before.waiting);
      expect(await recordOf(endpointA, finished)).toEqual(before.finished);
      expect(await recordOf(endpointB, theirs)).toEqual(before.theirs);
      // The refused calls wrote nothing on the side they came from either.
      const seenFromB = await withTenantTx(database.db, serviceB, (tx) =>
        tx
          .select()
          .from(inboxEvents)
          .where(
            and(
              eq(inboxEvents.consumerId, webhookInboxConsumer(endpointA.endpointId)),
              eq(inboxEvents.eventId, webhookInboxEventId(endpointA.endpointId, eventId)),
            ),
          ),
      );
      expect(seenFromB).toEqual([]);
    });
  });
});
