// M3's whole path with no containers beyond PostgreSQL. A signed callback lands in the inbox, an intent
// waits for a person, the outbox hands it on, and the real connector sends over real TLS through the real
// egress gateway to a relay in this process, with a credential the real broker opened. The receipts then
// read what that left. Temporal and the web server are the two parts not here: the same steps the workflow
// runs stand in for one, and the services the routes call for the other. tests/stack/slice-2.test.ts is
// where they join in. Every address and secret is generated, and nothing leaves 127.0.0.1.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createConnection,
  createWebhookEndpoint,
  createWorkUnit,
  decideApproval,
  getExternalActionDetail,
  getWorkDetail,
  getWorkUnit,
  ingestWebhookDelivery,
  listExternalActions,
  listExternalActionsNeedingReview,
  resolveUnknownExternalAction,
  retryExternalAction,
  revokeConnection,
  reviseExternalAction,
  transitionWorkUnit,
  type ExternalActionGateway,
} from '@ensemus/application';
import { createEmailConnector } from '@ensemus/connectors/email';
import { createInboundConnector } from '@ensemus/connectors/inbound';
import { EMAIL_CONNECTOR_MANIFEST, INBOUND_CONNECTOR_MANIFEST } from '@ensemus/connectors/manifest';
import {
  createConnectorRegistry,
  createGatewayNetwork,
  signWebhook,
} from '@ensemus/connectors/runtime';
import {
  createOrganization,
  domainEvents,
  externalActionAttempts,
  externalActionReceipts,
  externalActions,
  inboxEvents,
  notifications,
  openAppDatabase,
  resolveTenantContext,
  webhookDeliveries,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import {
  dispatchDueEvents,
  openDispatcherDatabase,
  type DispatchableEvent,
} from '@ensemus/database/dispatcher';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { createServiceContext } from '@ensemus/database/service';
import { SECRET_PURPOSE_WEBHOOK_SIGNING } from '@ensemus/domain/connector';
import {
  AGGREGATE_CONNECTION,
  AGGREGATE_EXTERNAL_ACTION,
  AGGREGATE_WEBHOOK_DELIVERY,
  CONNECTION_REVOKED,
  CONNECTOR_SYNC_REQUESTED,
  EXTERNAL_ACTION_READY,
  externalActionTargetRef,
  WEBHOOK_RECEIVED,
} from '@ensemus/domain/integration-events';
import { webhookInboxConsumer, webhookInboxEventId } from '@ensemus/domain/webhook';
import type { WorkState } from '@ensemus/domain/work-unit';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { storeSecret } from '@ensemus/secrets/seal';
import { createConnectorSyncActivities } from '@ensemus/workflows/connector-sync-activities';
import {
  createConnectorGateway,
  createExternalActionActivities,
} from '@ensemus/workflows/external-action-activities';
import {
  connectorSyncInputSchema,
  externalActionInputSchema,
  webhookDeliveryInputSchema,
} from '@ensemus/workflows/schemas';
import { createWebhookActivities } from '@ensemus/workflows/webhook-activities';
import { and, eq, sql } from 'drizzle-orm';
import { runExternalAction } from '../../packages/workflows/src/external-action-step';
import { startEgressGateway, type RunningGateway } from '../../workers/workflow/src/egress-gateway';
import { generateTestCertificate, startSmtpSink, type StartedSink } from '../helpers/smtp-sink';
import { secret, urls } from '../helpers/stack';

const code = (name: string) => expect.objectContaining({ code: name });
const RELAY_NAME = 'relay.example.invalid';
const SENDER = 'sender@example.invalid';
const MESSAGE_ID_DOMAIN = 'mail.example.invalid';
const SILENCE_MS = 3_000;

type Tenant = {
  owner: TenantContext;
  /** Another member, who may be named to approve and can decide nothing else. */
  reviewer: TenantContext;
  /** A member with no part in the work. */
  bystander: TenantContext;
  mail: string;
  inbound: string;
  endpointId: string;
  token: string;
  /** What a sender holds, exactly as the API shows it once. */
  signingSecret: string;
  credential: string;
  credentialSecretId: string;
};

describe('the whole path', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let secretsDb: ReturnType<typeof openSecretsDatabase>;
  let dispatcher: ReturnType<typeof openDispatcherDatabase>;
  let auth: pg.Client;
  let superuser: pg.Client;
  let broker: SecretBroker;
  let sink: StartedSink;
  let gateway: RunningGateway;
  let connectorGateway: ExternalActionGateway;
  let tenant: Tenant;
  let rival: Tenant;

  /** What the broker opened, kept only for this test to compare with what was sealed. */
  const opened: string[] = [];
  /** Which organizations the dispatcher below acts for, and how each thing it started came out. */
  const ours = new Set<string>();
  const results = new Map<string, unknown>();

  const certificate = generateTestCertificate(RELAY_NAME);

  const deps = () => ({
    database: app.db,
    registry: createConnectorRegistry([
      createEmailConnector({
        tls: 'required',
        messageIdDomain: MESSAGE_ID_DOMAIN,
        ca: certificate.cert,
      }),
      createInboundConnector(),
    ]),
    secrets: {
      withSecret: <T>(
        binding: { organizationId: string; secretId: string; purpose: string },
        use: (value: Buffer) => Promise<T>,
      ) =>
        broker.withSecret(binding, (value) => {
          opened.push(value.toString('utf8'));
          return use(value);
        }),
      revoke: (organizationId: string, secretId: string) => broker.revoke(organizationId, secretId),
    },
    network: createGatewayNetwork(`127.0.0.1:${gateway.port}`),
  });

  const activities = (over: ExternalActionGateway = connectorGateway) =>
    createExternalActionActivities(app.db, over);

  /** The workflow's own steps over real Activities, as the fault tests run them. */
  const runWorkflow = (input: { organizationId: string; externalActionId: string }) => {
    const worker = activities();
    const run = { ...input, runId: randomUUID() };
    return runExternalAction({
      send: () => worker.sendExternalAction(run),
      inspect: () => worker.inspectInterruptedAction(input),
      reconcile: (reason) => worker.reconcileExternalAction({ ...input, code: reason }),
      concludeWithoutAnswer: (reason) => worker.concludeWithoutAnswer({ ...input, code: reason }),
      failUnsent: (reason) => worker.failUnsentAction({ ...input, code: reason }),
      outcome: () => worker.settledActionOutcome(input),
      sleep: async () => undefined,
      neverPickedUp: () => false,
    });
  };

  /**
   * What the dispatcher does with each event, by the real outbox and the real dispatcher role. What it
   * starts on Temporal runs right here instead. Only this file's tenants are acted on: other files'
   * leftovers are marked delivered, as a dispatcher with nothing to do for them would.
   */
  const route = async (event: DispatchableEvent) => {
    if (!ours.has(event.organizationId)) return;
    switch (event.eventType) {
      case WEBHOOK_RECEIVED: {
        expect(event.aggregateType).toBe(AGGREGATE_WEBHOOK_DELIVERY);
        const input = webhookDeliveryInputSchema.parse({
          organizationId: event.organizationId,
          deliveryId: event.aggregateId,
        });
        results.set(
          event.aggregateId,
          await createWebhookActivities(deps()).processWebhookDelivery(input),
        );
        return;
      }
      case EXTERNAL_ACTION_READY: {
        expect(event.aggregateType).toBe(AGGREGATE_EXTERNAL_ACTION);
        const input = externalActionInputSchema.parse({
          organizationId: event.organizationId,
          externalActionId: event.aggregateId,
        });
        // An effect belongs to one run ever, which is what REJECT_DUPLICATE gives on Temporal.
        if (!results.has(event.aggregateId)) {
          results.set(event.aggregateId, await runWorkflow(input));
        }
        return;
      }
      case CONNECTOR_SYNC_REQUESTED:
      case CONNECTION_REVOKED: {
        expect(event.aggregateType).toBe(AGGREGATE_CONNECTION);
        const input = connectorSyncInputSchema.parse({
          organizationId: event.organizationId,
          connectionId: event.aggregateId,
        });
        results.set(
          event.aggregateId,
          await createConnectorSyncActivities(deps()).syncConnection(input),
        );
        return;
      }
      default:
        return;
    }
  };

  /** Delivers everything due, until nothing is, and makes a failed delivery fail the test. */
  const dispatch = async () => {
    for (;;) {
      const faults: unknown[] = [];
      const result = await dispatchDueEvents(dispatcher.db, async (event) => {
        try {
          await route(event);
        } catch (error) {
          faults.push(error);
          throw error;
        }
      });
      if (faults.length > 0) throw faults[0];
      if (result.handled === 0) return;
    }
  };

  const makeUser = async (label: string) => {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      `${label}-${id}@example.invalid`,
    ]);
    return id;
  };

  const joinOrg = async (context: TenantContext, label: string) => {
    const user = await makeUser(label);
    await withTenantTx(app.db, context, (tx) =>
      tx.execute(
        sql`insert into org.memberships (organization_id, id, user_id, role)
            values (${context.organizationId}, ${randomUUID()}, ${user}, 'member')`,
      ),
    );
    return resolveTenantContext(app.db, user, context.organizationId);
  };

  /** Everything an administrator does on the connections page, through the services it calls. */
  const setUpTenant = async (label: string): Promise<Tenant> => {
    const user = await makeUser(label);
    const { organizationId } = await createOrganization(app.db, {
      userId: user,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    const owner = await resolveTenantContext(app.db, user, organizationId);
    ours.add(organizationId);
    const publicKeyPem = secret('sealing_public_key.pem');
    const credential = randomBytes(24).toString('hex');
    const sealedCredential = await storeSecret(app.db, owner, {
      publicKeyPem,
      purpose: EMAIL_CONNECTOR_MANIFEST.credential.purpose,
      plaintext: credential,
    });
    const mail = await createConnection(app.db, owner, {
      connectorType: EMAIL_CONNECTOR_MANIFEST.type,
      displayName: 'Same mail',
      config: { fromAddress: SENDER, fromName: 'The Sender', tlsServerName: RELAY_NAME },
      credentialSecretId: sealedCredential.secretRef,
    });
    const inbound = await createConnection(app.db, owner, {
      connectorType: INBOUND_CONNECTOR_MANIFEST.type,
      displayName: 'Same callback',
      config: {},
      credentialSecretId: null,
    });
    const signingSecret = randomBytes(32).toString('base64url');
    const sealedSigning = await storeSecret(app.db, owner, {
      publicKeyPem,
      purpose: SECRET_PURPOSE_WEBHOOK_SIGNING,
      plaintext: signingSecret,
    });
    const { endpointId, token } = await createWebhookEndpoint(app.db, owner, {
      connectionId: inbound.id,
      signingSecretId: sealedSigning.secretRef,
      signatureScheme: 'ensemus_hmac_sha256_v1',
    });
    return {
      owner,
      reviewer: await joinOrg(owner, `${label}-reviewer`),
      bystander: await joinOrg(owner, `${label}-bystander`),
      mail: mail.id,
      inbound: inbound.id,
      endpointId,
      token,
      signingSecret,
      credential,
      credentialSecretId: sealedCredential.secretRef,
    };
  };

  const newWork = async (title: string, extra: Record<string, unknown> = {}) =>
    (
      await createWorkUnit(app.db, tenant.owner, {
        title,
        objective: 'Say it.',
        completionCriteria: [{ kind: 'external_receipt' }],
        ...extra,
      })
    ).id;

  const walk = async (id: string, statuses: WorkState[]) => {
    let current = await getWorkUnit(app.db, tenant.owner, id);
    for (const to of statuses) {
      current = await transitionWorkUnit(app.db, tenant.owner, {
        id,
        expectedVersion: current.version,
        to,
      });
    }
    return current;
  };

  const anEmail = (to: string[], extra: Record<string, unknown> = {}) => ({
    to,
    subject: `Your report ${randomUUID()}`,
    text_body: `The report is ready. ${randomUUID()}`,
    ...extra,
  });
  const proposal = (work: string, email: unknown, connection = tenant.mail) => ({
    type: 'external_action.proposed',
    work_unit_id: work,
    connection_id: connection,
    email,
  });

  const signed = (
    from: Pick<Tenant, 'token' | 'signingSecret'>,
    envelope: unknown,
    options: { eventId?: string; timestampSeconds?: number; key?: string } = {},
  ) => {
    const body = Buffer.from(JSON.stringify(envelope));
    const eventId = options.eventId ?? `event-${randomUUID()}`;
    const timestampSeconds = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
    return {
      token: from.token,
      body,
      headers: {
        'content-type': 'application/json',
        // The UTF-8 of the string the API showed, which is what the web tier sealed.
        'x-ensemus-signature': signWebhook(Buffer.from(options.key ?? from.signingSecret, 'utf8'), {
          timestampSeconds,
          eventId,
          body,
        }),
        'x-ensemus-timestamp': String(timestampSeconds),
        'x-ensemus-event-id': eventId,
      },
    };
  };

  const actionsOn = (work: string, context = tenant.owner) =>
    withTenantTx(app.db, context, (tx) =>
      tx.select().from(externalActions).where(eq(externalActions.workUnitId, work)),
    );
  const attemptsOf = (id: string) =>
    withTenantTx(app.db, tenant.owner, (tx) =>
      tx
        .select()
        .from(externalActionAttempts)
        .where(eq(externalActionAttempts.externalActionId, id)),
    );
  const providerReceipts = (id: string) =>
    withTenantTx(app.db, tenant.owner, (tx) =>
      tx
        .select()
        .from(externalActionReceipts)
        .where(
          and(
            eq(externalActionReceipts.externalActionId, id),
            eq(externalActionReceipts.basis, 'provider'),
          ),
        ),
    );
  const notificationKinds = async (id: string) =>
    (
      await withTenantTx(app.db, tenant.owner, (tx) =>
        tx
          .select({ kind: notifications.kind })
          .from(notifications)
          .where(eq(notifications.targetRef, externalActionTargetRef(id))),
      )
    ).map(({ kind }) => kind);
  const lastDelivery = async (from: Tenant) => {
    const rows = await withTenantTx(app.db, createServiceContext(from.owner.organizationId), (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, from.endpointId)),
    );
    return rows.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime()).at(-1);
  };

  /** From a callback to an intent waiting for a person, with nothing but the outbox in between. */
  const proposeByCallback = async (work: string, email: unknown) => {
    await expect(
      ingestWebhookDelivery(app.db, signed(tenant, proposal(work, email))),
    ).resolves.toBe('accepted');
    await dispatch();
    const [action] = await actionsOn(work);
    if (!action) throw new Error('No intent came of the callback');
    return action;
  };

  const approveAsOwner = async (action: { approvalId: string | null; requestHash: string }) => {
    await decideApproval(app.db, tenant.owner, {
      approvalId: action.approvalId as string,
      decision: 'approve',
      shownHash: action.requestHash,
    });
  };

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    secretsDb = openSecretsDatabase(urls.secrets());
    dispatcher = openDispatcherDatabase(urls.dispatcher());
    broker = new SecretBroker(
      secretsDb.db,
      new FileKeyProvider([secret('sealing_private_key.pem')]),
    );
    auth = new pg.Client({ connectionString: urls.auth() });
    superuser = new pg.Client({ connectionString: urls.superuser() });
    await auth.connect();
    await superuser.connect();
    sink = await startSmtpSink({ mode: 'accept', tls: certificate });
    const quiet = () => undefined;
    gateway = await startEgressGateway({
      target: `127.0.0.1:${sink.port}`,
      listenPort: 0,
      listenHost: '127.0.0.1',
      log: { info: quiet, warn: quiet, error: quiet },
    });
    connectorGateway = createConnectorGateway(deps(), { sendDeadlineMs: SILENCE_MS });
    tenant = await setUpTenant('path');
    rival = await setUpTenant('rival');
    await dispatch();
  });

  afterAll(async () => {
    await gateway?.close();
    await sink?.close();
    await app?.close();
    await secretsDb?.close();
    await dispatcher?.close();
    await auth?.end();
    await superuser?.end();
  });

  beforeEach(() => {
    sink.setMode('accept');
    opened.length = 0;
  });

  describe('Slice 2', () => {
    it('goes from a signed callback to a receipt, one message, and work that can finish', async () => {
      const work = await newWork('Tell the client');
      await walk(work, ['ready', 'running', 'verifying']);
      await expect(walk(work, ['completed'])).rejects.toEqual(code('EVIDENCE_MISSING'));

      // The callback: stored and answered before anything has read it.
      const sentBefore = sink.messages().length;
      const connectionsBefore = sink.connections();
      const email = anEmail(['to@example.invalid'], {
        cc: ['cc@example.invalid'],
        bcc: ['bcc@example.invalid'],
      });
      const request = signed(tenant, proposal(work, email), { eventId: `event-${randomUUID()}` });
      const eventId = request.headers['x-ensemus-event-id'];
      await expect(ingestWebhookDelivery(app.db, request)).resolves.toBe('accepted');
      await expect(lastDelivery(tenant)).resolves.toMatchObject({ state: 'received' });
      expect(await actionsOn(work)).toEqual([]);

      // Delivered by the outbox, verified with the secret the web tier sealed, and in the inbox.
      await dispatch();
      expect(opened).toContain(tenant.signingSecret);
      const delivery = await lastDelivery(tenant);
      expect(delivery).toMatchObject({ state: 'applied', providerEventId: eventId, body: null });
      const inbox = await withTenantTx(app.db, tenant.owner, (tx) =>
        tx
          .select()
          .from(inboxEvents)
          .where(
            and(
              eq(inboxEvents.consumerId, webhookInboxConsumer(tenant.endpointId)),
              eq(inboxEvents.eventId, webhookInboxEventId(tenant.endpointId, eventId)),
            ),
          ),
      );
      expect(inbox).toHaveLength(1);

      // An intent waits, addressed to who answers for the work, and nothing has gone.
      const [action, ...others] = await actionsOn(work);
      expect(others).toEqual([]);
      if (!action) throw new Error('No intent');
      expect(action.status).toBe('awaiting_approval');
      expect(sink.connections()).toBe(connectionsBefore);

      // What the owner reads is exactly what would go, with the sender from the connection.
      const shown = await getExternalActionDetail(app.db, tenant.owner, action.id);
      expect(shown.payload).toEqual({
        ...email,
        from: { address: SENDER, name: 'The Sender' },
      });

      // Only the person named can spend the approval, and only on what they were shown.
      await expect(
        decideApproval(app.db, tenant.bystander, {
          approvalId: action.approvalId as string,
          decision: 'approve',
          shownHash: shown.requestHash,
        }),
      ).rejects.toEqual(code('APPROVAL_WRONG_APPROVER'));
      await expect(
        decideApproval(app.db, tenant.owner, {
          approvalId: action.approvalId as string,
          decision: 'approve',
          shownHash: 'f'.repeat(64),
        }),
      ).rejects.toEqual(code('APPROVAL_HASH_MISMATCH'));
      expect(sink.connections()).toBe(connectionsBefore);

      await approveAsOwner(action);
      await dispatch();

      // One message, over TLS, logged in with what was sealed, to exactly those recipients.
      expect(sink.connections()).toBe(connectionsBefore + 1);
      expect(sink.messages()).toHaveLength(sentBefore + 1);
      const message = sink.messages().at(-1);
      expect(message).toMatchObject({ mailFrom: SENDER, tls: true, authenticatedAs: SENDER });
      expect(opened).toContain(tenant.credential);
      expect([...(message?.rcptTo ?? [])].sort()).toEqual([
        'bcc@example.invalid',
        'cc@example.invalid',
        'to@example.invalid',
      ]);
      expect(message?.raw).toContain(email.subject);
      expect(message?.raw).toContain(email.text_body);
      expect(message?.raw).toContain(`Message-ID: <${action.id}@${MESSAGE_ID_DOMAIN}>`);
      expect(message?.raw.toLowerCase()).not.toContain('bcc');

      // The receipts read the real rows that left.
      const detail = await getExternalActionDetail(app.db, tenant.owner, action.id);
      expect(detail).toMatchObject({
        status: 'sent',
        attemptCount: 1,
        externalId: `<${action.id}@${MESSAGE_ID_DOMAIN}>`,
        canResolve: false,
      });
      expect(detail.receipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            outcome: 'sent',
            basis: 'provider',
            code: 'ACCEPTED_BY_RELAY',
            providerStatus: 250,
          }),
        ]),
      );
      const listed = await listExternalActions(app.db, tenant.owner, { workUnitId: work });
      expect(listed.items.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: action.id, status: 'sent' },
      ]);
      expect(await notificationKinds(action.id)).toContain('external_action.sent');

      // The criterion is met by that receipt, and the work can finish.
      expect((await getWorkDetail(app.db, tenant.owner, work)).evidence).toMatchObject({
        verifiedReceiptCount: 1,
      });
      await expect(walk(work, ['completed'])).resolves.toMatchObject({ status: 'completed' });
    });

    it('shows a member of another tenant, with the same names, nothing of it', async () => {
      const work = await newWork('Nobody else can see this');
      const action = await proposeByCallback(work, anEmail(['to@example.invalid']));
      await expect(getExternalActionDetail(app.db, rival.owner, action.id)).rejects.toEqual(
        code('NOT_FOUND'),
      );
      await expect(
        listExternalActions(app.db, rival.owner, { workUnitId: work }),
      ).resolves.toMatchObject({ items: [] });
      await expect(
        decideApproval(app.db, rival.owner, {
          approvalId: action.approvalId as string,
          decision: 'approve',
          shownHash: action.requestHash,
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
      expect(await actionsOn(work, rival.owner)).toEqual([]);
    });

    it('keeps a recipient, a subject and a body out of events and the outbox, and secrets out of every row', async () => {
      const canary = randomUUID();
      const to = `canary-${canary}@example.invalid`;
      const work = await newWork('A canary');
      const action = await proposeByCallback(
        work,
        anEmail([to], { subject: `Subject ${canary}`, text_body: `Body ${canary}` }),
      );
      await approveAsOwner(action);
      await dispatch();

      const events = await withTenantTx(app.db, tenant.owner, (tx) =>
        tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, action.id)),
      );
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain(canary);
      // The intent itself holds it, for those who can read the work. Nothing around it does.
      const around = await superuser.query(
        `select row_to_json(t)::text as row from (
           select event_type as what, payload::text as held from platform.domain_events where organization_id = $1
           union all select action, target_ref from governance.audit_events where organization_id = $1
           union all select kind, target_ref from platform.notifications where organization_id = $1
         ) t`,
        [tenant.owner.organizationId],
      );
      expect(around.rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(around.rows)).not.toContain(canary);

      // And the secrets are nowhere plain, among what the application can read.
      const held = await superuser.query(
        `select row_to_json(t)::text as row from (
           select config::text as held from integrations.connections where organization_id = $1
           union all select payload::text from integrations.external_actions where organization_id = $1
           union all select headers::text from integrations.webhook_deliveries where organization_id = $1
           union all select payload::text from platform.domain_events where organization_id = $1
         ) t`,
        [tenant.owner.organizationId],
      );
      expect(held.rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(held.rows)).not.toContain(tenant.credential);
      expect(JSON.stringify(held.rows)).not.toContain(tenant.signingSecret);
    });
  });

  describe('QA-019: what a callback cannot do', () => {
    it('makes one intent, whichever way it is replayed', async () => {
      const work = await newWork('Once');
      const envelope = proposal(work, anEmail(['to@example.invalid']));
      const eventId = `event-${randomUUID()}`;
      const now = Math.floor(Date.now() / 1000);
      const original = signed(tenant, envelope, { eventId, timestampSeconds: now });

      await ingestWebhookDelivery(app.db, original);
      await dispatch();
      // The exact request again, and a new signature on the same event, after the first has landed.
      await ingestWebhookDelivery(app.db, original);
      await ingestWebhookDelivery(
        app.db,
        signed(tenant, envelope, {
          eventId,
          timestampSeconds: now - 1,
        }),
      );
      await dispatch();
      expect(await lastDelivery(tenant)).toMatchObject({ state: 'duplicate' });

      // Old, though the signature on it is good.
      await ingestWebhookDelivery(
        app.db,
        signed(tenant, envelope, { timestampSeconds: Math.floor(Date.now() / 1000) - 3_600 }),
      );
      await dispatch();
      expect(await lastDelivery(tenant)).toMatchObject({
        state: 'rejected',
        rejectCode: 'TIMESTAMP_OUTSIDE_WINDOW',
      });
      expect(await actionsOn(work)).toHaveLength(1);
    });

    it('refuses another tenantâ€™s key, an altered body and a tenantâ€™s own key on a strangerâ€™s work', async () => {
      const work = await newWork('Not by a stranger');
      const envelope = proposal(work, anEmail(['to@example.invalid']));
      const connections = sink.connections();

      await ingestWebhookDelivery(app.db, signed(tenant, envelope, { key: rival.signingSecret }));
      await dispatch();
      expect(await lastDelivery(tenant)).toMatchObject({
        state: 'rejected',
        rejectCode: 'BAD_SIGNATURE',
      });

      const altered = signed(tenant, envelope);
      await ingestWebhookDelivery(app.db, {
        ...altered,
        body: Buffer.from(JSON.stringify(proposal(work, anEmail(['thief@example.invalid'])))),
      });
      await dispatch();
      expect(await lastDelivery(tenant)).toMatchObject({
        state: 'rejected',
        rejectCode: 'BAD_SIGNATURE',
      });

      // Signed properly by the rival, at their own address, about this tenant's work and connection.
      await ingestWebhookDelivery(app.db, signed(rival, envelope));
      await dispatch();
      expect(await lastDelivery(rival)).toMatchObject({ state: 'rejected' });

      expect(await actionsOn(work)).toEqual([]);
      expect(sink.connections()).toBe(connections);
    });

    it('ends in a rejection for restricted work, through the real intent service', async () => {
      const work = await newWork('Restricted', {
        classification: 'restricted',
        completionCriteria: [],
      });
      await ingestWebhookDelivery(
        app.db,
        signed(tenant, proposal(work, anEmail(['to@example.invalid']))),
      );
      await dispatch();
      expect(await lastDelivery(tenant)).toMatchObject({ state: 'rejected', body: null });
      expect(await actionsOn(work)).toEqual([]);
    });

    it('reaches the sync Activity from a signed request, which finds nothing to read', async () => {
      await ingestWebhookDelivery(app.db, signed(tenant, { type: 'connector.sync_requested' }));
      await dispatch();
      expect(await lastDelivery(tenant)).toMatchObject({ state: 'applied' });
      expect(results.get(tenant.inbound)).toMatchObject({ outcome: 'nothing_to_do' });
    });
  });

  describe('QA-008: the relay takes it, and the answer never comes', () => {
    it('sends once, ends unknown, tells the owner, and lets them say what they found', async () => {
      sink.setMode('accept_then_silent');
      const before = sink.messages().length;
      const work = await newWork('A silent relay');
      const action = await proposeByCallback(work, anEmail(['to@example.invalid']));
      await approveAsOwner(action);
      const connections = sink.connections();
      await dispatch();

      const input = { organizationId: tenant.owner.organizationId, externalActionId: action.id };
      expect(results.get(action.id)).toBe('unknown');
      expect(sink.messages()).toHaveLength(before + 1);
      expect(sink.connections()).toBe(connections + 1);

      // Nothing automatic will ever try again, with the relay working and the Activity called blind.
      sink.setMode('accept');
      for (let repeat = 0; repeat < 3; repeat += 1) {
        await expect(
          activities().sendExternalAction({ ...input, runId: randomUUID() }),
        ).resolves.toEqual({ step: 'unknown' });
      }
      expect(sink.connections()).toBe(connections + 1);
      expect(await attemptsOf(action.id)).toEqual([
        expect.objectContaining({ outcome: 'indeterminate', outcomeCode: 'TIMEOUT_AFTER_COMMIT' }),
      ]);
      expect(await providerReceipts(action.id)).toEqual([]);

      // The owner is told, it is on their list, and unknown never reads as evidence.
      expect(await notificationKinds(action.id)).toContain('external_action.unknown');
      const queue = await listExternalActionsNeedingReview(app.db, tenant.owner);
      expect(queue.map(({ id }) => id)).toContain(action.id);
      const rivalQueue = await listExternalActionsNeedingReview(app.db, rival.owner);
      expect(rivalQueue.map(({ id }) => id)).not.toContain(action.id);
      expect((await getWorkDetail(app.db, tenant.owner, work)).evidence).toMatchObject({
        verifiedReceiptCount: 0,
      });
      const detail = await getExternalActionDetail(app.db, tenant.owner, action.id);
      expect(detail).toMatchObject({
        status: 'unknown',
        statusReason: 'PROVIDER_CANNOT_ANSWER',
        canResolve: true,
        externalId: null,
      });

      // Who may not resolve it cannot, and whoever does is named.
      const answer = {
        externalActionId: action.id,
        expectedVersion: detail.version,
        resolution: 'confirmed_not_sent' as const,
        reason: 'The relay log shows no such message.',
      };
      await expect(resolveUnknownExternalAction(app.db, rival.owner, answer)).rejects.toEqual(
        code('NOT_FOUND'),
      );
      await expect(
        resolveUnknownExternalAction(
          app.db,
          createServiceContext(rival.owner.organizationId),
          answer,
        ),
      ).rejects.toEqual(code('FORBIDDEN'));
      await expect(resolveUnknownExternalAction(app.db, tenant.bystander, answer)).rejects.toEqual(
        code('FORBIDDEN'),
      );
      await resolveUnknownExternalAction(app.db, tenant.owner, answer);
      const resolved = await getExternalActionDetail(app.db, tenant.owner, action.id);
      expect(resolved).toMatchObject({
        status: 'failed',
        resolution: 'confirmed_not_sent',
        resolutionReason: answer.reason,
      });
      expect(resolved.resolvedByName).toEqual(expect.any(String));
      expect(resolved.receipts).toEqual(
        expect.arrayContaining([expect.objectContaining({ basis: 'person' })]),
      );

      // Asking again takes a new intent and a new approval, and sends nothing until that is given.
      const connectionsAfter = sink.connections();
      const retried = await retryExternalAction(app.db, tenant.owner, {
        externalActionId: action.id,
        approverMembershipId: tenant.reviewer.membershipId,
      });
      expect(retried.externalActionId).not.toBe(action.id);
      await dispatch();
      expect(sink.connections()).toBe(connectionsAfter);
    });
  });

  describe('AI-TS-01: the worker dies during the send', () => {
    it('ends unknown with one message, and a second worker contacts nobody', async () => {
      const before = sink.messages().length;
      const work = await newWork('A dying worker');
      const action = await proposeByCallback(work, anEmail(['to@example.invalid']));
      await approveAsOwner(action);
      // Nothing dispatched: this drives the workflow, so that its worker can die in the middle of it.
      const connections = sink.connections();

      let died: () => void = () => undefined;
      const hasDied = new Promise<void>((resolve) => {
        died = resolve;
      });
      const dying: ExternalActionGateway = {
        ...connectorGateway,
        send: async (organizationId, attempt) => {
          await connectorGateway.send(organizationId, attempt);
          died();
          // The relay has taken it, and whatever it said will never be stored.
          return new Promise(() => undefined);
        },
      };
      const worker = activities(dying);
      const platform = activities();
      const input = { organizationId: tenant.owner.organizationId, externalActionId: action.id };
      const outcome = await runExternalAction({
        send: () =>
          Promise.race([
            worker.sendExternalAction({ ...input, runId: randomUUID() }),
            hasDied.then(() => {
              throw new Error('Temporal timed the Activity out');
            }),
          ]),
        inspect: () => platform.inspectInterruptedAction(input),
        reconcile: (reason) => platform.reconcileExternalAction({ ...input, code: reason }),
        concludeWithoutAnswer: (reason) =>
          platform.concludeWithoutAnswer({ ...input, code: reason }),
        failUnsent: (reason) => platform.failUnsentAction({ ...input, code: reason }),
        outcome: () => platform.settledActionOutcome(input),
        sleep: async () => undefined,
        neverPickedUp: () => false,
      });

      expect(outcome).toBe('unknown');
      expect(sink.messages()).toHaveLength(before + 1);
      expect(sink.connections()).toBe(connections + 1);
      await expect(
        activities().sendExternalAction({ ...input, runId: randomUUID() }),
      ).resolves.toEqual({ step: 'unknown' });
      expect(sink.connections()).toBe(connections + 1);
      await expect(getExternalActionDetail(app.db, tenant.owner, action.id)).resolves.toMatchObject(
        { status: 'unknown', statusReason: 'PROVIDER_CANNOT_ANSWER' },
      );
      expect(await attemptsOf(action.id)).toEqual([
        expect.objectContaining({ outcome: 'indeterminate', outcomeCode: 'WORKER_INTERRUPTED' }),
      ]);
    });
  });

  describe('QA-007: changing the recipients after approval', () => {
    it('leaves the old one unable to send, and only the new recipients ever get anything', async () => {
      const work = await newWork('Changed my mind');
      const action = await proposeByCallback(work, anEmail(['old@example.invalid']));
      await approveAsOwner(action);

      const before = sink.messages().length;
      const connections = sink.connections();
      const changed = anEmail(['new@example.invalid']);
      const revised = await reviseExternalAction(app.db, tenant.owner, {
        externalActionId: action.id,
        expectedVersion: (await getExternalActionDetail(app.db, tenant.owner, action.id)).version,
        payload: { ...changed, from: { address: SENDER } },
        approverMembershipId: tenant.reviewer.membershipId,
      });

      // The ready event was still in the outbox, and its run finds there is nothing it may do.
      await dispatch();
      expect(results.get(action.id)).toBe('cancelled');
      expect(sink.connections()).toBe(connections);
      await expect(getExternalActionDetail(app.db, tenant.owner, action.id)).resolves.toMatchObject(
        { status: 'cancelled', statusReason: 'SUPERSEDED', attemptCount: 0 },
      );

      // The new one waits for its own approval, which the old one's cannot stand in for.
      await expect(
        decideApproval(app.db, tenant.owner, {
          approvalId: action.approvalId as string,
          decision: 'approve',
          shownHash: action.requestHash,
        }),
      ).rejects.toEqual(code('APPROVAL_NOT_PENDING'));
      expect(sink.connections()).toBe(connections);
      await decideApproval(app.db, tenant.reviewer, {
        approvalId: revised.approvalId,
        decision: 'approve',
        shownHash: revised.requestHash,
      });
      await dispatch();

      expect(sink.messages()).toHaveLength(before + 1);
      expect(sink.messages().at(-1)?.rcptTo).toEqual(['new@example.invalid']);
    });
  });

  describe('SEC-06: a connection revoked after approval', () => {
    it('sends nothing, and the sealed credential can no longer be opened', async () => {
      // On a tenant of its own, because revoking the shared one would stop every other test here.
      const shared = tenant;
      tenant = await setUpTenant('revoked');
      try {
        const work = await newWork('Revoked in time');
        const action = await proposeByCallback(work, anEmail(['to@example.invalid']));
        await approveAsOwner(action);
        const connections = sink.connections();
        await revokeConnection(app.db, tenant.owner, {
          connectionId: tenant.mail,
          expectedVersion: 1,
        });
        await dispatch();

        expect(results.get(action.id)).toBe('cancelled');
        expect(sink.connections()).toBe(connections);
        expect(results.get(tenant.mail)).toMatchObject({ outcome: 'revoked' });
        await expect(
          broker.withSecret(
            {
              organizationId: tenant.owner.organizationId,
              secretId: tenant.credentialSecretId,
              purpose: EMAIL_CONNECTOR_MANIFEST.credential.purpose,
            },
            async () => 'opened',
          ),
        ).rejects.toMatchObject({ name: 'SecretUnavailable' });
      } finally {
        tenant = shared;
      }
    });
  });
});
