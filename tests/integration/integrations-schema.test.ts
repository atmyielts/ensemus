// ADR-027's database rules on their own: forced RLS, what each role can reach, and the triggers that hold
// the at-most-one-effect rule whatever application code does. Real PostgreSQL, real roles. The slices
// test behaviour on top of this, and each writes its own file.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connections,
  createOrganization,
  externalActionAttempts,
  externalActionReceipts,
  externalActions,
  inboxEvents,
  openAppDatabase,
  resolveTenantContext,
  webhookDeliveries,
  webhookEndpoints,
  withTenantTx,
  withWebhookEndpointTx,
  type TenantContext,
} from '@ensemus/database';
import { createWorkUnit, emit } from '@ensemus/application';
import { actionHash } from '@ensemus/domain/approval';
import {
  EXTERNAL_ACTION_STATUSES,
  EXTERNAL_ACTION_TRANSITIONS,
  idempotencyKeyFor,
  requestHashFor,
  type ExternalActionStatus,
} from '@ensemus/domain/external-action';
import { hashWebhookToken, webhookInboxEventId } from '@ensemus/domain/webhook';
import { eq, sql } from 'drizzle-orm';
import { seedConnection, seedExternalAction, testEmailPayload } from '../helpers/integrations';
import { urls } from '../helpers/stack';

const client = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

const sqlState = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });

describe('external action rules in the database', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let ctxA: TenantContext;
  let ctxB: TenantContext;
  let approverA: string;
  let workA: string;
  let workB: string;
  let connectionA: string;
  let connectionB: string;

  const makeUser = async (label: string) => {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      `${label}-${id}@example.invalid`,
    ]);
    return id;
  };

  // A Work Unit of its own each time, because one can hold only one open approval.
  const seed = async (status: ExternalActionStatus, payload?: unknown) =>
    seedExternalAction(database.db, ctxA, {
      workUnitId: (
        await createWorkUnit(database.db, ctxA, { title: 'A send', objective: 'Say something.' })
      ).id,
      connectionId: connectionA,
      approverMembershipId: approverA,
      status,
      ...(payload ? { payload } : {}),
    });

  const move = (id: string, status: ExternalActionStatus, extra: object = {}) =>
    withTenantTx(database.db, ctxA, (tx) =>
      tx
        .update(externalActions)
        .set({ status, ...extra })
        .where(eq(externalActions.id, id)),
    );

  const addAttempt = (
    action: { id: string; requestHash: string },
    attemptNo: number,
    overrides: Partial<typeof externalActionAttempts.$inferInsert> = {},
  ) =>
    withTenantTx(database.db, ctxA, (tx) =>
      tx.insert(externalActionAttempts).values({
        organizationId: ctxA.organizationId,
        externalActionId: action.id,
        attemptNo,
        requestHash: action.requestHash,
        idempotencyKey: idempotencyKeyFor(action.id),
        runId: 'test-run',
        ...overrides,
      }),
    );

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = await client(urls.auth());
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
    const approver = await makeUser('approver');
    approverA = randomUUID();
    await withTenantTx(database.db, ctxA, (tx) =>
      tx.execute(
        sql`insert into org.memberships (organization_id, id, user_id, role)
            values (${ctxA.organizationId}, ${approverA}, ${approver}, 'member')`,
      ),
    );
    const draft = { title: 'Send the kickoff note', objective: 'Tell them we started.' };
    workA = (await createWorkUnit(database.db, ctxA, draft)).id;
    workB = (await createWorkUnit(database.db, ctxB, draft)).id;
    connectionA = await seedConnection(database.db, ctxA);
    connectionB = await seedConnection(database.db, ctxB);
  });

  afterAll(async () => {
    await database?.close();
    await auth?.end();
  });

  describe('the state machine', () => {
    it('allows exactly the moves the domain lists, and the two tables stay the same', async () => {
      // Each pair the domain forbids has to be refused by the database too.
      const moves: [ExternalActionStatus, ExternalActionStatus][] = [
        ['awaiting_approval', 'sending'],
        ['awaiting_approval', 'sent'],
        ['ready', 'sent'],
        ['ready', 'unknown'],
        ['sending', 'unknown'],
        ['sending', 'cancelled'],
        ['reconciling', 'sending'],
        ['unknown', 'ready'],
        ['unknown', 'sending'],
        ['unknown', 'cancelled'],
        ['sent', 'sending'],
        ['sent', 'failed'],
        ['failed', 'ready'],
        ['failed', 'sending'],
        ['cancelled', 'ready'],
      ];
      for (const [from, to] of moves) {
        expect(EXTERNAL_ACTION_TRANSITIONS[from], `${from} to ${to}`).not.toContain(to);
        const action = await seed(from);
        await expect(move(action.id, to), `${from} to ${to}`).rejects.toEqual(sqlState('EN003'));
      }
      expect(EXTERNAL_ACTION_STATUSES).toHaveLength(8);
    });

    it('refuses an intent that starts anywhere but its first status', async () => {
      const id = randomUUID();
      const payload = testEmailPayload();
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx.insert(externalActions).values({
            organizationId: ctxA.organizationId,
            id,
            workUnitId: workA,
            connectionId: connectionA,
            toolName: 'email.send',
            toolVersion: '1',
            targetRef: `connection:${connectionA}`,
            payload,
            requestHash: 'x',
            idempotencyKey: idempotencyKeyFor(id),
            classification: 'internal',
            requiresApproval: false,
            status: 'sent',
          }),
        ),
      ).rejects.toEqual(sqlState('EN003'));
    });
  });

  describe('binding to the approved payload (QA-007)', () => {
    it('gives no role a way to edit what an intent will send', async () => {
      const action = await seed('ready');
      for (const set of [
        { payload: testEmailPayload({ to: ['attacker@example.invalid'] }) },
        { requestHash: 'forged' },
        { approvalId: randomUUID() },
        { connectionId: connectionA },
        { idempotencyKey: 'forged' },
      ]) {
        await expect(
          withTenantTx(database.db, ctxA, (tx) =>
            tx.update(externalActions).set(set).where(eq(externalActions.id, action.id)),
          ),
        ).rejects.toEqual(
          expect.objectContaining({
            cause: expect.objectContaining({ message: expect.stringMatching(/permission denied/) }),
          }),
        );
      }
    });

    it('changes the hash when a recipient changes', () => {
      const proposal = {
        toolName: 'email.send',
        toolVersion: '1',
        connectionId: connectionA,
        payload: testEmailPayload(),
      };
      const changed = { ...proposal, payload: testEmailPayload({ to: ['other@example.invalid'] }) };
      expect(requestHashFor(changed)).not.toBe(requestHashFor(proposal));
      expect(
        actionHash({
          toolName: 'email.send',
          toolVersion: '1',
          targetRef: `connection:${connectionA}`,
          payload: testEmailPayload(),
        }),
      ).toBe(requestHashFor(proposal));
    });

    it('refuses an intent whose hash is not what its approval bound', async () => {
      const seeded = await seed('awaiting_approval');
      await withTenantTx(database.db, ctxA, (tx) =>
        tx.execute(
          sql`update work.approvals set status = 'cancelled' where id = ${seeded.approvalId}`,
        ),
      );
      const pendingApproval = randomUUID();
      await withTenantTx(database.db, ctxA, (tx) =>
        tx.execute(
          sql`insert into work.approvals (organization_id, id, work_unit_id, tool_name, action,
                action_hash, approver_membership_id, expires_at)
              values (${ctxA.organizationId}, ${pendingApproval}, ${workA}, 'email.send', '{}'::jsonb,
                'the-bound-hash', ${approverA}, now() + interval '1 hour')`,
        ),
      );
      const id = randomUUID();
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx.insert(externalActions).values({
            organizationId: ctxA.organizationId,
            id,
            workUnitId: workA,
            connectionId: connectionA,
            toolName: 'email.send',
            toolVersion: '1',
            targetRef: `connection:${connectionA}`,
            payload: testEmailPayload(),
            requestHash: 'a-different-hash',
            idempotencyKey: idempotencyKeyFor(id),
            classification: 'internal',
            requiresApproval: true,
            approvalId: pendingApproval,
            status: 'awaiting_approval',
          }),
        ),
      ).rejects.toEqual(sqlState('EN004'));
      await withTenantTx(database.db, ctxA, (tx) =>
        tx.execute(
          sql`update work.approvals set status = 'cancelled' where id = ${pendingApproval}`,
        ),
      );
    });

    it('will not move towards a send without an approved, unexpired approval', async () => {
      const waiting = await seed('awaiting_approval');
      await expect(move(waiting.id, 'ready')).rejects.toEqual(sqlState('EN004'));
      await withTenantTx(database.db, ctxA, (tx) =>
        tx.execute(
          sql`update work.approvals set status = 'cancelled' where id = ${waiting.approvalId}`,
        ),
      );

      const ready = await seed('ready');
      await addAttempt(ready, 1);
      await withTenantTx(database.db, ctxA, (tx) =>
        tx.execute(
          sql`update work.approvals set status = 'cancelled' where id = ${ready.approvalId}`,
        ),
      );
      await expect(move(ready.id, 'sending')).rejects.toEqual(sqlState('EN004'));
    });

    it('lets one approval authorize one intent', async () => {
      const first = await seed('awaiting_approval');
      const [row] = await withTenantTx(database.db, ctxA, (tx) =>
        tx
          .select({ workUnitId: externalActions.workUnitId })
          .from(externalActions)
          .where(eq(externalActions.id, first.id)),
      );
      const id = randomUUID();
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx.insert(externalActions).values({
            organizationId: ctxA.organizationId,
            id,
            workUnitId: row?.workUnitId as string,
            connectionId: connectionA,
            toolName: 'email.send',
            toolVersion: '1',
            targetRef: `connection:${connectionA}`,
            payload: testEmailPayload(),
            requestHash: first.requestHash,
            idempotencyKey: idempotencyKeyFor(id),
            classification: 'internal',
            requiresApproval: true,
            approvalId: first.approvalId,
            status: 'awaiting_approval',
          }),
        ),
      ).rejects.toEqual(sqlState('23505'));
      await withTenantTx(database.db, ctxA, (tx) =>
        tx.execute(
          sql`update work.approvals set status = 'cancelled' where id = ${first.approvalId}`,
        ),
      );
    });
  });

  describe('at most one effect (QA-008, AI-TS-01)', () => {
    it('refuses a second attempt while the first could have sent', async () => {
      const action = await seed('sending');
      await expect(addAttempt(action, 2)).rejects.toEqual(sqlState('EN005'));
    });

    it('refuses another attempt after an indeterminate one, even once it is back at unknown', async () => {
      const action = await seed('unknown');
      await expect(addAttempt(action, 2)).rejects.toEqual(sqlState('EN005'));
      await expect(move(action.id, 'ready')).rejects.toEqual(sqlState('EN003'));
    });

    it('lets two racing workers record only one attempt', async () => {
      const action = await seed('ready');
      const results = await Promise.allSettled([
        withTenantTx(database.db, ctxA, async (tx) => {
          await tx.insert(externalActionAttempts).values({
            organizationId: ctxA.organizationId,
            externalActionId: action.id,
            attemptNo: 1,
            requestHash: action.requestHash,
            idempotencyKey: idempotencyKeyFor(action.id),
            runId: 'one',
          });
          await tx
            .update(externalActions)
            .set({ status: 'sending' })
            .where(eq(externalActions.id, action.id));
        }),
        withTenantTx(database.db, ctxA, async (tx) => {
          await tx.insert(externalActionAttempts).values({
            organizationId: ctxA.organizationId,
            externalActionId: action.id,
            attemptNo: 1,
            requestHash: action.requestHash,
            idempotencyKey: idempotencyKeyFor(action.id),
            runId: 'two',
          });
          await tx
            .update(externalActions)
            .set({ status: 'sending' })
            .where(eq(externalActions.id, action.id));
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const attempts = await withTenantTx(database.db, ctxA, (tx) =>
        tx
          .select()
          .from(externalActionAttempts)
          .where(eq(externalActionAttempts.externalActionId, action.id)),
      );
      expect(attempts).toHaveLength(1);
    });

    it('allows another try only after one that definitely did not send', async () => {
      const action = await seed('sending');
      await expect(move(action.id, 'ready')).rejects.toEqual(sqlState('EN005'));
      await withTenantTx(database.db, ctxA, (tx) =>
        tx
          .update(externalActionAttempts)
          .set({ outcome: 'not_sent', outcomeCode: 'CONNECT_FAILED' })
          .where(eq(externalActionAttempts.externalActionId, action.id)),
      );
      await move(action.id, 'ready');
      await addAttempt(action, 2);
      await move(action.id, 'sending');
    });

    it('will not record sent or failed without the words to back it', async () => {
      const open = await seed('sending');
      await expect(move(open.id, 'sent')).rejects.toEqual(sqlState('EN005'));
      await expect(move(open.id, 'failed')).rejects.toEqual(sqlState('EN005'));

      const unknown = await seed('unknown');
      await expect(move(unknown.id, 'sent')).rejects.toEqual(sqlState('EN005'));
      await expect(move(unknown.id, 'failed')).rejects.toEqual(sqlState('EN005'));
    });

    it('will not record unknown unless an attempt could have sent', async () => {
      const action = await seed('sending');
      await withTenantTx(database.db, ctxA, (tx) =>
        tx
          .update(externalActionAttempts)
          .set({ outcome: 'not_sent' })
          .where(eq(externalActionAttempts.externalActionId, action.id)),
      );
      await move(action.id, 'ready');
      // reconciling needs sending first, so take the honest route to it and try from there.
      await addAttempt(action, 2);
      await move(action.id, 'sending');
      await withTenantTx(database.db, ctxA, (tx) =>
        tx
          .update(externalActionAttempts)
          .set({ outcome: 'not_sent' })
          .where(eq(externalActionAttempts.attemptNo, 2)),
      );
      await move(action.id, 'reconciling');
      await expect(move(action.id, 'unknown')).rejects.toEqual(sqlState('EN005'));
    });

    it('lets a person settle unknown, on the record, once', async () => {
      const action = await seed('unknown');
      const resolved = {
        resolvedByMembershipId: ctxA.membershipId,
        resolution: 'confirmed_sent',
        resolutionReason: 'Found it in the relay log.',
      };
      await move(action.id, 'sent', resolved);
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx
            .update(externalActions)
            .set({ resolutionReason: 'Changed my mind.' })
            .where(eq(externalActions.id, action.id)),
        ),
      ).rejects.toEqual(sqlState('EN003'));
    });

    it('lets a late answer from the provider settle unknown, which sends nothing', async () => {
      const action = await seed('unknown');
      await withTenantTx(database.db, ctxA, (tx) =>
        tx
          .update(externalActionAttempts)
          .set({ outcome: 'accepted', outcomeCode: 'ACCEPTED_BY_RELAY' })
          .where(eq(externalActionAttempts.externalActionId, action.id)),
      );
      await move(action.id, 'sent');
    });

    it('writes an outcome once, and only indeterminate can be settled later', async () => {
      const action = await seed('sending');
      const setOutcome = (outcome: string | null) =>
        withTenantTx(database.db, ctxA, (tx) =>
          tx
            .update(externalActionAttempts)
            .set({ outcome })
            .where(eq(externalActionAttempts.externalActionId, action.id)),
        );
      await setOutcome('indeterminate');
      await expect(setOutcome(null)).rejects.toEqual(sqlState('EN005'));
      await setOutcome('accepted');
      await expect(setOutcome('rejected')).rejects.toEqual(sqlState('EN005'));
      await expect(setOutcome(null)).rejects.toEqual(sqlState('EN005'));
    });

    it('keeps intents, attempts and receipts as records, for the owner too', async () => {
      const action = await seed('sent');
      await withTenantTx(database.db, ctxA, (tx) =>
        tx.insert(externalActionReceipts).values({
          organizationId: ctxA.organizationId,
          externalActionId: action.id,
          attemptId: action.attemptId ?? null,
          outcome: 'sent',
          basis: 'provider',
          requestHash: action.requestHash,
        }),
      );
      const denied = expect.objectContaining({
        cause: expect.objectContaining({ message: expect.stringMatching(/permission denied/) }),
      });
      await expect(
        withTenantTx(database.db, ctxA, (tx) => tx.delete(externalActionReceipts).where(sql`true`)),
      ).rejects.toEqual(denied);
      await expect(
        withTenantTx(database.db, ctxA, (tx) => tx.delete(externalActions).where(sql`true`)),
      ).rejects.toEqual(denied);

      const owner = await client(urls.migrator());
      for (const table of [
        'external_action_receipts',
        'external_actions',
        'external_action_attempts',
      ]) {
        await expect(owner.query(`delete from integrations.${table}`), table).rejects.toThrow(
          /append-only/,
        );
      }
      await expect(
        owner.query(`update integrations.external_action_receipts set code = 'x'`),
      ).rejects.toThrow(/append-only/);
      await owner.end();
    });

    it('will not take a receipt calling a person the basis without naming them', async () => {
      const action = await seed('unknown');
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx.insert(externalActionReceipts).values({
            organizationId: ctxA.organizationId,
            externalActionId: action.id,
            outcome: 'sent',
            basis: 'person',
            requestHash: action.requestHash,
          }),
        ),
      ).rejects.toEqual(sqlState('23514'));
    });
  });

  describe('between tenants', () => {
    it('shows one tenant nothing of another, with the same names', async () => {
      const action = await seed('ready');
      const seen = await withTenantTx(database.db, ctxB, (tx) =>
        tx.select().from(externalActions).where(eq(externalActions.id, action.id)),
      );
      expect(seen).toEqual([]);
      const theirs = await withTenantTx(database.db, ctxB, (tx) =>
        tx.select().from(connections).where(eq(connections.id, connectionA)),
      );
      expect(theirs).toEqual([]);
      const ours = await withTenantTx(database.db, ctxA, (tx) =>
        tx.select().from(connections).where(eq(connections.id, connectionB)),
      );
      expect(ours).toEqual([]);
    });

    it('refuses an intent on another tenant, by row security and by foreign key', async () => {
      const id = randomUUID();
      const values = {
        id,
        toolName: 'email.send',
        toolVersion: '1',
        targetRef: `connection:${connectionA}`,
        payload: testEmailPayload(),
        requestHash: 'x',
        idempotencyKey: idempotencyKeyFor(id),
        classification: 'internal',
        requiresApproval: false,
        status: 'ready',
      };
      // Their tenant's row, from here.
      await expect(
        withTenantTx(database.db, ctxB, (tx) =>
          tx.insert(externalActions).values({
            ...values,
            organizationId: ctxA.organizationId,
            workUnitId: workA,
            connectionId: connectionA,
          }),
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          cause: expect.objectContaining({ message: expect.stringMatching(/row-level security/) }),
        }),
      );
      // This tenant's row, naming their connection.
      await expect(
        withTenantTx(database.db, ctxB, (tx) =>
          tx.insert(externalActions).values({
            ...values,
            organizationId: ctxB.organizationId,
            workUnitId: workB,
            connectionId: connectionA,
          }),
        ),
      ).rejects.toEqual(sqlState('23503'));
    });

    it('refuses a connection naming a secret in another tenant', async () => {
      const secretOfA = randomUUID();
      await withTenantTx(database.db, ctxA, (tx) =>
        tx.execute(
          sql`insert into secrets.sealed_secrets (organization_id, id, purpose, key_id, wrapped_key, iv,
                ciphertext, auth_tag)
              values (${ctxA.organizationId}, ${secretOfA}, 'connector_credential', 'k', '\\x00', '\\x00',
                '\\x00', '\\x00')`,
        ),
      );
      await expect(
        seedConnection(database.db, ctxB, { credentialSecretId: secretOfA }),
      ).rejects.toEqual(sqlState('23503'));
    });

    it('gives the other runtime roles nothing here', async () => {
      const tables = [
        'connections',
        'external_actions',
        'external_action_attempts',
        'external_action_receipts',
        'webhook_endpoints',
        'webhook_deliveries',
        'sync_cursors',
        'external_resources',
        'external_resource_acl',
      ];
      for (const url of [urls.dispatcher(), urls.auth(), urls.secrets()]) {
        const other = await client(url);
        for (const table of tables) {
          await expect(other.query(`select * from integrations.${table}`), table).rejects.toThrow(
            /permission denied/,
          );
        }
        await other.end();
      }
    });

    it('reads nothing with no tenant bound', async () => {
      const raw = await client(urls.app());
      for (const table of ['connections', 'external_actions', 'webhook_endpoints']) {
        const { rows } = await raw.query(`select count(*)::int as n from integrations.${table}`);
        expect(rows[0].n, table).toBe(0);
      }
      await raw.end();
    });
  });

  describe('webhook ingress with no session', () => {
    let endpointId: string;
    let secretId: string;
    const token = `test-token-${randomUUID()}`;
    const tokenHash = hashWebhookToken(token);

    const admit = (bytes: number) =>
      withWebhookEndpointTx(database.db, tokenHash, async (tx, { endpoint }) => {
        const { rows } = await tx.execute(
          sql`select integrations.admit_webhook_delivery(${endpoint.id}::uuid, ${bytes}::integer) as ok`,
        );
        return rows[0]?.ok as boolean;
      });

    beforeAll(async () => {
      secretId = randomUUID();
      endpointId = randomUUID();
      await withTenantTx(database.db, ctxA, async (tx) => {
        await tx.execute(
          sql`insert into secrets.sealed_secrets (organization_id, id, purpose, key_id, wrapped_key, iv,
                ciphertext, auth_tag)
              values (${ctxA.organizationId}, ${secretId}, 'webhook_signing', 'k', '\\x00', '\\x00',
                '\\x00', '\\x00')`,
        );
        await tx.insert(webhookEndpoints).values({
          organizationId: ctxA.organizationId,
          id: endpointId,
          connectionId: connectionA,
          tokenHash,
          signingSecretId: secretId,
          signatureScheme: 'ensemus_hmac_sha256_v1',
          ratePerMinute: 3,
          maxBytesPerMinute: 4096,
          maxBodyBytes: 2048,
          maxPendingBytes: 5000,
        });
      });
    });

    it('finds nothing for a token nobody issued, and does not run the callback', async () => {
      let called = false;
      const result = await withWebhookEndpointTx(
        database.db,
        hashWebhookToken('nobody-issued-this'),
        async () => {
          called = true;
        },
      );
      expect(result).toBeNull();
      expect(called).toBe(false);
    });

    it('binds the tenant from the row, and shows only that tenant', async () => {
      const seen = await withWebhookEndpointTx(database.db, tokenHash, async (tx, scope) => {
        const mine = await tx.select().from(connections);
        return {
          organizationId: scope.context.organizationId,
          actorType: scope.context.actorType,
          organizations: [...new Set(mine.map((row) => row.organizationId))],
        };
      });
      expect(seen).toEqual({
        organizationId: ctxA.organizationId,
        actorType: 'service',
        organizations: [ctxA.organizationId],
      });
    });

    it('stores a delivery and its outbox event in that one transaction', async () => {
      const deliveryId = randomUUID();
      const body = Buffer.from('{"not":"believed"}');
      await withWebhookEndpointTx(database.db, tokenHash, async (tx, { endpoint, context }) => {
        await tx.insert(webhookDeliveries).values({
          organizationId: endpoint.organizationId,
          id: deliveryId,
          endpointId: endpoint.id,
          requestDigest: createHash('sha256').update(body).digest('hex'),
          body,
          bodySha256: createHash('sha256').update(body).digest('hex'),
          sizeBytes: body.length,
          headers: { 'x-ensemus-signature': 'unchecked' },
        });
        await emit(tx, context, {
          eventType: 'webhook.received',
          aggregateType: 'webhook_delivery',
          aggregateId: deliveryId,
          aggregateVersion: 1,
          classification: 'internal',
          payload: { delivery_id: deliveryId },
        });
      });
      const [row] = await withTenantTx(database.db, ctxA, (tx) =>
        tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)),
      );
      expect(row?.state).toBe('received');
      expect(Buffer.from(row?.body ?? []).toString()).toBe('{"not":"believed"}');
      const dispatcher = await client(urls.dispatcher());
      const { rows } = await dispatcher.query(
        `select e.event_type, e.aggregate_type from platform.domain_events e
          where e.aggregate_id = $1`,
        [deliveryId],
      );
      expect(rows).toEqual([
        { event_type: 'webhook.received', aggregate_type: 'webhook_delivery' },
      ]);
      await dispatcher.end();
    });

    it('refuses a body larger than the row or the table allows', async () => {
      expect(await admit(2049)).toBe(false);
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx.insert(webhookDeliveries).values({
            organizationId: ctxA.organizationId,
            endpointId,
            requestDigest: randomUUID(),
            bodySha256: 'x',
            sizeBytes: 1,
            body: Buffer.alloc(1_048_577),
          }),
        ),
      ).rejects.toEqual(sqlState('23514'));
    });

    it('admits up to the rate, then refuses until the window moves', async () => {
      await withTenantTx(database.db, ctxA, (tx) =>
        tx
          .update(webhookEndpoints)
          .set({
            windowDeliveries: 0,
            windowBytes: 0,
            pendingBytes: 0,
            windowStartedAt: sql`now()`,
          })
          .where(eq(webhookEndpoints.id, endpointId)),
      );
      expect(await admit(10)).toBe(true);
      expect(await admit(10)).toBe(true);
      expect(await admit(10)).toBe(true);
      expect(await admit(10)).toBe(false);

      await withTenantTx(database.db, ctxA, (tx) =>
        tx
          .update(webhookEndpoints)
          .set({ windowStartedAt: sql`now() - interval '2 minutes'` })
          .where(eq(webhookEndpoints.id, endpointId)),
      );
      expect(await admit(10)).toBe(true);
    });

    it('refuses once too many bytes wait, and takes them again when given back', async () => {
      await withTenantTx(database.db, ctxA, (tx) =>
        tx
          .update(webhookEndpoints)
          .set({
            windowDeliveries: 0,
            windowBytes: 0,
            pendingBytes: 4990,
            windowStartedAt: sql`now()`,
          })
          .where(eq(webhookEndpoints.id, endpointId)),
      );
      expect(await admit(100)).toBe(false);
      await withTenantTx(database.db, ctxA, (tx) =>
        tx.execute(sql`select integrations.release_webhook_bytes(${endpointId}::uuid, 100)`),
      );
      expect(await admit(100)).toBe(true);
    });

    it('answers nothing for a disabled endpoint', async () => {
      const disabledToken = hashWebhookToken(`disabled-${randomUUID()}`);
      await withTenantTx(database.db, ctxA, (tx) =>
        tx.insert(webhookEndpoints).values({
          organizationId: ctxA.organizationId,
          connectionId: connectionA,
          tokenHash: disabledToken,
          signingSecretId: secretId,
          signatureScheme: 'ensemus_hmac_sha256_v1',
          state: 'disabled',
        }),
      );
      expect(await withWebhookEndpointTx(database.db, disabledToken, async () => 'ran')).toBeNull();
    });

    it('does not let one tenant admit to, or read, another tenant’s endpoint', async () => {
      const refused = await withTenantTx(database.db, ctxB, async (tx) => {
        const { rows } = await tx.execute(
          sql`select integrations.admit_webhook_delivery(${endpointId}::uuid, 1) as ok`,
        );
        return rows[0]?.ok;
      });
      expect(refused).toBe(false);
      const seen = await withTenantTx(database.db, ctxB, (tx) =>
        tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId)),
      );
      expect(seen).toEqual([]);
    });

    it('never lets a token be changed, or a hash read out with none bound', async () => {
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx
            .update(webhookEndpoints)
            .set({ tokenHash: 'forged' })
            .where(eq(webhookEndpoints.id, endpointId)),
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          cause: expect.objectContaining({ message: expect.stringMatching(/permission denied/) }),
        }),
      );
      const raw = await client(urls.app());
      const { rows } = await raw.query('select token_hash from integrations.webhook_endpoints');
      expect(rows).toEqual([]);
      await raw.end();
    });

    it('keeps one inbox row per verified event, per endpoint', async () => {
      const eventId = webhookInboxEventId(endpointId, 'provider-event-1');
      expect(eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(webhookInboxEventId(randomUUID(), 'provider-event-1')).not.toBe(eventId);
      const record = () =>
        withTenantTx(database.db, ctxA, (tx) =>
          tx
            .insert(inboxEvents)
            .values({
              organizationId: ctxA.organizationId,
              consumerId: `webhook:${endpointId}`,
              eventId,
            })
            .onConflictDoNothing()
            .returning({ eventId: inboxEvents.eventId }),
        );
      expect(await record()).toHaveLength(1);
      expect(await record()).toHaveLength(0);
    });
  });
});
