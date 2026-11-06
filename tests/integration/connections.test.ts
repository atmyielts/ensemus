// CONNECT-01: managing a connection, on real roles and RLS, with two tenants using the same names. A
// connection holds a reference to a sealed credential, and what it shows an administrator holds no
// credential and no provider text. Generated test values only.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  createConnection,
  createInvitation,
  getConnection,
  listConnections,
  loadConnectionForWorker,
  requestConnectorSync,
  revokeConnection,
} from '@ensemus/application';
import {
  auditEvents,
  connections,
  createOrganization,
  domainEvents,
  openAppDatabase,
  resolveTenantContext,
  webhookEndpoints,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { CONNECTOR_MANIFESTS } from '@ensemus/connectors/manifest';
import { SECRET_PURPOSE_CONNECTOR_CREDENTIAL } from '@ensemus/domain/connector';
import {
  AGGREGATE_CONNECTION,
  CONNECTION_CREATED,
  CONNECTION_REVOKED,
  CONNECTOR_SYNC_REQUESTED,
} from '@ensemus/domain/integration-events';
import { storeSecret } from '@ensemus/secrets/seal';
import { and, eq } from 'drizzle-orm';
import { secret, urls } from '../helpers/stack';

const code = (name: string) => expect.objectContaining({ code: name });
const CANARY = `CANARY-credential-${randomUUID()}`;

describe('connections', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let ownerA: TenantContext;
  let memberA: TenantContext;
  let adminA: TenantContext;
  let ownerB: TenantContext;
  const db = () => app.db;
  const publicKeyPem = secret('sealing_public_key.pem');

  async function makeUser(label: string) {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      email,
    ]);
    return { id, email };
  }

  async function newOrg(label: string) {
    const user = await makeUser(`${label}-owner`);
    const { organizationId } = await createOrganization(db(), {
      userId: user.id,
      name: label,
      commercialMode: 'byom',
    });
    return resolveTenantContext(db(), user.id, organizationId);
  }

  async function join(context: TenantContext, label: string, role: 'admin' | 'member') {
    const user = await makeUser(label);
    const { token } = await createInvitation(db(), context, { email: user.email, role });
    await acceptInvitation(db(), {
      token,
      userId: user.id,
      email: user.email,
      emailVerified: true,
    });
    return resolveTenantContext(db(), user.id, context.organizationId);
  }

  const sealCredential = async (context: TenantContext) =>
    (
      await storeSecret(db(), context, {
        publicKeyPem,
        purpose: SECRET_PURPOSE_CONNECTOR_CREDENTIAL,
        plaintext: CANARY,
      })
    ).secretRef;

  const emailInput = async (context: TenantContext, overrides: object = {}) => ({
    connectorType: 'email_smtp',
    displayName: 'Mail',
    config: { fromAddress: 'sender@example.invalid' },
    credentialSecretId: await sealCredential(context),
    ...overrides,
  });

  const inboundInput = (overrides: object = {}) => ({
    connectorType: 'inbound_webhook',
    displayName: 'Callback',
    config: {},
    credentialSecretId: null,
    ...overrides,
  });

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    ownerA = await newOrg('a');
    ownerB = await newOrg('b');
    memberA = await join(ownerA, 'member', 'member');
    adminA = await join(ownerA, 'admin', 'admin');
  });

  afterAll(async () => {
    await app?.close();
    await auth?.end();
  });

  describe('createConnection', () => {
    it('makes a connection for an owner or an admin, and emits and audits it', async () => {
      const view = await createConnection(db(), adminA, await emailInput(adminA));
      expect(view).toMatchObject({
        connectorType: 'email_smtp',
        displayName: 'Mail',
        state: 'active',
        hasCredential: true,
        lastErrorCode: null,
        version: 1,
      });
      await withTenantTx(db(), adminA, async (tx) => {
        const events = await tx
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.aggregateId, view.id));
        expect(events).toEqual([
          expect.objectContaining({
            eventType: CONNECTION_CREATED,
            aggregateType: AGGREGATE_CONNECTION,
          }),
        ]);
        expect(JSON.stringify(events)).not.toContain('sender@example.invalid');
        const audit = await tx
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.targetRef, `connection:${view.id}`));
        expect(audit.map((row) => row.action)).toEqual(['connection.created']);
      });
    });

    it('refuses a member, and a service with no person behind it', async () => {
      await expect(createConnection(db(), memberA, await emailInput(ownerA))).rejects.toEqual(
        code('FORBIDDEN'),
      );
      await expect(
        createConnection(
          db(),
          createServiceContext(ownerA.organizationId),
          await emailInput(ownerA),
        ),
      ).rejects.toEqual(code('FORBIDDEN'));
    });

    it.each(['Email_SMTP', 'email-smtp', 'x', 'nothing_we_ship', ''])(
      'refuses the connector type %j',
      async (connectorType) => {
        await expect(
          createConnection(db(), ownerA, inboundInput({ connectorType })),
        ).rejects.toEqual(code('INVALID_INPUT'));
      },
    );

    it('takes only a type from the manifests its caller passes', async () => {
      const manifests = [{ type: 'inbound_webhook', credential: { required: false } }];
      await expect(
        createConnection(db(), ownerA, inboundInput({ manifests })),
      ).resolves.toMatchObject({ connectorType: 'inbound_webhook' });
      await expect(
        createConnection(db(), ownerA, { ...(await emailInput(ownerA)), manifests }),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });

    it('takes the manifests the web tier reads, and still holds them to what we ship', async () => {
      await expect(
        createConnection(db(), ownerA, inboundInput({ manifests: CONNECTOR_MANIFESTS })),
      ).resolves.toMatchObject({ connectorType: 'inbound_webhook' });
      await expect(
        createConnection(db(), ownerA, {
          ...(await emailInput(ownerA, {
            config: { fromAddress: 'sender@example.invalid', x: 1 },
          })),
          manifests: CONNECTOR_MANIFESTS,
        }),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });

    it('needs a credential where the connector does, and refuses one where it does not', async () => {
      await expect(
        createConnection(db(), ownerA, await emailInput(ownerA, { credentialSecretId: null })),
      ).rejects.toEqual(code('INVALID_INPUT'));
      await expect(
        createConnection(
          db(),
          ownerA,
          inboundInput({ credentialSecretId: await sealCredential(ownerA) }),
        ),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });

    it("refuses another tenant's sealed credential, the same as one that does not exist", async () => {
      const theirs = await sealCredential(ownerB);
      await expect(
        createConnection(db(), ownerA, await emailInput(ownerA, { credentialSecretId: theirs })),
      ).rejects.toEqual(code('INVALID_INPUT'));
      await expect(
        createConnection(
          db(),
          ownerA,
          await emailInput(ownerA, { credentialSecretId: randomUUID() }),
        ),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });

    it.each([
      ['a host', { fromAddress: 'sender@example.invalid', host: 'relay.example.invalid' }],
      ['a port', { fromAddress: 'sender@example.invalid', port: 25 }],
      ['a password', { fromAddress: 'sender@example.invalid', password: CANARY }],
      ['a nested secret', { fromAddress: 'sender@example.invalid', extra: { api_key: CANARY } }],
      ['a field it does not take', { fromAddress: 'sender@example.invalid', other: 'value' }],
      ['no sender', {}],
      ['a sender that is not an address', { fromAddress: 'nobody' }],
      ['a line break in a name', { fromAddress: 'a@example.invalid', fromName: 'a\r\nBcc: b' }],
      ['an array', []],
      ['nothing', null],
      ['a very large value', { fromAddress: 'sender@example.invalid', fromName: 'x'.repeat(5000) }],
    ])('refuses settings holding %s, and stores nothing', async (_label, config) => {
      const before = (await listConnections(db(), ownerA)).length;
      await expect(
        createConnection(db(), ownerA, await emailInput(ownerA, { config })),
      ).rejects.toEqual(code('INVALID_INPUT'));
      expect(await listConnections(db(), ownerA)).toHaveLength(before);
    });

    it('refuses a key that reads like a host or credential for a connector the caller names', async () => {
      const manifests = [{ type: 'caller_named', credential: { required: false } }];
      await expect(
        createConnection(
          db(),
          ownerA,
          inboundInput({
            connectorType: 'caller_named',
            manifests,
            config: { endpoint: 'https://relay.example.invalid/' },
          }),
        ),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });

    it.each([
      ['empty', '   '],
      ['too long', 'x'.repeat(201)],
      ['with a line break', 'one\ntwo'],
    ])('refuses a display name that is %s', async (_label, displayName) => {
      await expect(createConnection(db(), ownerA, inboundInput({ displayName }))).rejects.toEqual(
        code('INVALID_INPUT'),
      );
    });
  });

  describe('reading', () => {
    it('shows two tenants with the same names only their own', async () => {
      const a = await createConnection(db(), ownerA, inboundInput({ displayName: 'Same name' }));
      const b = await createConnection(db(), ownerB, inboundInput({ displayName: 'Same name' }));
      expect((await listConnections(db(), ownerA)).map((c) => c.id)).toContain(a.id);
      expect((await listConnections(db(), ownerA)).map((c) => c.id)).not.toContain(b.id);
      expect((await listConnections(db(), ownerB)).map((c) => c.id)).toEqual([b.id]);
    });

    it("answers not found for another tenant's connection, and for one that does not exist", async () => {
      const theirs = await createConnection(db(), ownerB, inboundInput());
      await expect(getConnection(db(), ownerA, theirs.id)).rejects.toEqual(code('NOT_FOUND'));
      await expect(getConnection(db(), ownerA, randomUUID())).rejects.toEqual(code('NOT_FOUND'));
      await expect(getConnection(db(), ownerA, 'not-a-uuid')).rejects.toEqual(code('NOT_FOUND'));
    });

    it('never shows a credential or its reference', async () => {
      const input = await emailInput(ownerA);
      const view = await createConnection(db(), ownerA, input);
      for (const shown of [
        view,
        await getConnection(db(), ownerA, view.id),
        ...(await listConnections(db(), ownerA)),
      ]) {
        const printed = JSON.stringify(shown);
        expect(printed).not.toContain(CANARY);
        expect(printed).not.toContain(input.credentialSecretId);
      }
    });

    it('shows settings and errors to those who manage connections, and not to everyone', async () => {
      const view = await createConnection(db(), ownerA, await emailInput(ownerA));
      await withTenantTx(db(), ownerA, (tx) =>
        tx
          .update(connections)
          .set({ lastErrorCode: 'SYNC_TIMEOUT' })
          .where(eq(connections.id, view.id)),
      );
      await expect(getConnection(db(), adminA, view.id)).resolves.toMatchObject({
        config: { fromAddress: 'sender@example.invalid' },
        lastErrorCode: 'SYNC_TIMEOUT',
      });
      await expect(getConnection(db(), memberA, view.id)).resolves.toMatchObject({
        id: view.id,
        config: null,
        lastErrorCode: null,
      });
    });
  });

  describe('revokeConnection', () => {
    it('refuses a member, and leaves the connection as it was', async () => {
      const view = await createConnection(db(), ownerA, inboundInput());
      await expect(
        revokeConnection(db(), memberA, { connectionId: view.id, expectedVersion: 1 }),
      ).rejects.toEqual(code('FORBIDDEN'));
      await expect(getConnection(db(), ownerA, view.id)).resolves.toMatchObject({
        state: 'active',
        version: 1,
      });
    });

    it("answers not found for another tenant's connection, and leaves it alone", async () => {
      const theirs = await createConnection(db(), ownerB, inboundInput());
      await expect(
        revokeConnection(db(), ownerA, { connectionId: theirs.id, expectedVersion: 1 }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(getConnection(db(), ownerB, theirs.id)).resolves.toMatchObject({
        state: 'active',
      });
    });

    it('refuses a stale version', async () => {
      const view = await createConnection(db(), ownerA, inboundInput());
      await expect(
        revokeConnection(db(), ownerA, { connectionId: view.id, expectedVersion: 7 }),
      ).rejects.toEqual(code('VERSION_CONFLICT'));
    });

    it('revokes at once, emits connection.revoked, and audits it', async () => {
      const view = await createConnection(db(), ownerA, await emailInput(ownerA));
      await revokeConnection(db(), ownerA, { connectionId: view.id, expectedVersion: 1 });
      await expect(getConnection(db(), ownerA, view.id)).resolves.toMatchObject({
        state: 'revoked',
        version: 2,
      });
      await withTenantTx(db(), ownerA, async (tx) => {
        const events = await tx
          .select()
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.aggregateId, view.id),
              eq(domainEvents.eventType, CONNECTION_REVOKED),
            ),
          );
        expect(events).toEqual([
          expect.objectContaining({
            aggregateType: AGGREGATE_CONNECTION,
            aggregateVersion: 2,
          }),
        ]);
        const audit = await tx
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.targetRef, `connection:${view.id}`));
        expect(audit.map((row) => row.action).sort()).toEqual([
          'connection.created',
          'connection.revoked',
        ]);
      });
    });

    it('refuses to revoke twice', async () => {
      const view = await createConnection(db(), ownerA, inboundInput());
      await revokeConnection(db(), ownerA, { connectionId: view.id, expectedVersion: 1 });
      await expect(
        revokeConnection(db(), ownerA, { connectionId: view.id, expectedVersion: 2 }),
      ).rejects.toEqual(code('CONNECTION_NOT_ACTIVE'));
    });

    it("closes the connection's webhook endpoints, so its address answers nothing", async () => {
      const view = await createConnection(db(), ownerA, inboundInput());
      const signing = await sealCredential(ownerA);
      const endpointId = randomUUID();
      await withTenantTx(db(), ownerA, (tx) =>
        tx.insert(webhookEndpoints).values({
          organizationId: ownerA.organizationId,
          id: endpointId,
          connectionId: view.id,
          tokenHash: randomUUID(),
          signingSecretId: signing,
          signatureScheme: 'ensemus_hmac_sha256_v1',
        }),
      );
      await revokeConnection(db(), ownerA, { connectionId: view.id, expectedVersion: 1 });
      const [endpoint] = await withTenantTx(db(), ownerA, (tx) =>
        tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId)),
      );
      expect(endpoint?.state).toBe('revoked');
      const loaded = await loadConnectionForWorker(
        db(),
        createServiceContext(ownerA.organizationId),
        view.id,
      );
      expect(loaded?.signingSecretIds).toEqual([signing]);
    });
  });

  describe('requestConnectorSync', () => {
    it('emits for an active connection, carrying only IDs', async () => {
      const view = await createConnection(db(), ownerA, inboundInput());
      await requestConnectorSync(db(), adminA, { connectionId: view.id });
      await withTenantTx(db(), ownerA, async (tx) => {
        const [event] = await tx
          .select()
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.aggregateId, view.id),
              eq(domainEvents.eventType, CONNECTOR_SYNC_REQUESTED),
            ),
          );
        expect(event?.aggregateType).toBe(AGGREGATE_CONNECTION);
        expect(event?.payload).toEqual({ connectionId: view.id });
      });
    });

    it('refuses a member', async () => {
      const view = await createConnection(db(), ownerA, inboundInput());
      await expect(requestConnectorSync(db(), memberA, { connectionId: view.id })).rejects.toEqual(
        code('FORBIDDEN'),
      );
    });

    it("answers not found for another tenant's connection", async () => {
      const theirs = await createConnection(db(), ownerB, inboundInput());
      await expect(requestConnectorSync(db(), ownerA, { connectionId: theirs.id })).rejects.toEqual(
        code('NOT_FOUND'),
      );
    });

    it('refuses a revoked connection', async () => {
      const view = await createConnection(db(), ownerA, inboundInput());
      await revokeConnection(db(), ownerA, { connectionId: view.id, expectedVersion: 1 });
      await expect(requestConnectorSync(db(), ownerA, { connectionId: view.id })).rejects.toEqual(
        code('CONNECTION_NOT_ACTIVE'),
      );
    });
  });

  describe('the worker view', () => {
    it('is only for a worker', async () => {
      const view = await createConnection(db(), ownerA, inboundInput());
      await expect(loadConnectionForWorker(db(), ownerA, view.id)).rejects.toEqual(
        code('FORBIDDEN'),
      );
    });

    it('reads only its own tenant', async () => {
      const input = await emailInput(ownerA);
      const view = await createConnection(db(), ownerA, input);
      await expect(
        loadConnectionForWorker(db(), createServiceContext(ownerB.organizationId), view.id),
      ).resolves.toBeNull();
      await expect(
        loadConnectionForWorker(db(), createServiceContext(ownerA.organizationId), view.id),
      ).resolves.toMatchObject({
        id: view.id,
        connectorType: 'email_smtp',
        credentialSecretId: input.credentialSecretId,
        config: { fromAddress: 'sender@example.invalid' },
      });
    });
  });
});
