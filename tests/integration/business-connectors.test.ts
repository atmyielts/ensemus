import { updateSecurityPolicy } from '@ensemus/application/security-policy';
// Actual TLS, single-target TCP gateway, native connector role, sealed credentials and sync Activity.
// Everything is generated and loopback-only; no live provider, Temporal poller or commercial acceptance.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { openAppDatabase } from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { createServiceContext } from '@ensemus/database/service';
import {
  createConnection,
  applyBusinessRecordPage,
  listBusinessRecords,
  getBusinessRecord,
  revokeConnection,
} from '@ensemus/application';
import { createCrmConnector } from '@ensemus/connectors/crm';
import { createTicketingConnector } from '@ensemus/connectors/ticketing';
import { createAccountingConnector } from '@ensemus/connectors/accounting';
import { routeConnector } from '@ensemus/connectors/business';
import { createGatewayNetwork, createConnectorRegistry } from '@ensemus/connectors/runtime';
import { createConnectorSyncActivities } from '@ensemus/workflows/connector-sync-activities';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { storeSecret } from '@ensemus/secrets/seal';
import { startEgressGateway } from '../../workers/workflow/src/egress-gateway';
import { generateTestCertificate } from '../helpers/smtp-sink';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { secret, urls } from '../helpers/stack';
const name = 'adapter.example.invalid';
const rows = [
  {
    type: 'crm_http',
    stream: 'crm.accounts',
    make: createCrmConnector,
    fields: { name: 'Generated source account', status: 'open' },
  },
  {
    type: 'ticketing_http',
    stream: 'ticketing.tickets',
    make: createTicketingConnector,
    fields: { subject: 'Generated source ticket', status: 'open' },
  },
  {
    type: 'accounting_http',
    stream: 'accounting.invoices',
    make: createAccountingConnector,
    fields: { number: 'GENERATED-1', total: '100.10', currency: 'USD' },
  },
] as const;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function adapter(
  credentialSources: ReadonlyMap<string, { email: string; fields: Record<string, unknown> }>,
  stream: string,
) {
  const certificate = generateTestCertificate(name);
  let hits = 0;
  const server = createServer(certificate, (req, res) => {
    hits++;
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, ''),
      source = credentialSources.get(token);
    if (!source) {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'https://adapter.invalid');
    if (
      req.method !== 'GET' ||
      url.pathname !== `/ensemus-adapter/v1/streams/${encodeURIComponent(stream)}/records`
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    const records = url.searchParams.get('cursor')
      ? []
      : [
          {
            id: 'same-generated-source-id',
            version: '1',
            fields: { ...source.fields, unknown_secret: 'DROP-GENERATED-CANARY' },
            classification: 'public',
            acl: [{ principal_kind: 'user', principal_external_id: source.email, access: 'read' }],
          },
        ];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ records, deleted: [], next_cursor: '1', has_more: false }));
  });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const gateway = await startEgressGateway({
    target: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    listenHost: '127.0.0.1',
    listenPort: 0,
    log,
  });
  closers.push(() => gateway.close());
  return {
    certificate,
    network: createGatewayNetwork(`127.0.0.1:${gateway.port}`),
    hits: () => hits,
    log,
  };
}
describe('business connectors over actual TLS and native synchronization', () => {
  let web: ReturnType<typeof openAppDatabase>,
    worker: ReturnType<typeof openAppDatabase>,
    secretsDb: ReturnType<typeof openSecretsDatabase>,
    broker: SecretBroker,
    auth: pg.Client,
    people: Awaited<ReturnType<typeof makeTwoTenants>>;
  beforeAll(async () => {
    web = openAppDatabase(urls.app());
    worker = openAppDatabase(urls.connector());
    secretsDb = openSecretsDatabase(urls.secrets());
    broker = new SecretBroker(
      secretsDb.db,
      new FileKeyProvider([secret('sealing_private_key.pem')]),
    );
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    people = await makeTwoTenants(web.db);
    await proveSecondFactor(people.a.owner);
    await proveSecondFactor(people.b.owner);
  });
  afterAll(async () => {
    await web?.close();
    await worker?.close();
    await secretsDb?.close();
    await auth?.end();
  });
  const email = async (userId: string) =>
    (await auth.query<{ email: string }>('select email from identity.users where id=$1', [userId]))
      .rows[0]!.email;
  it('refuses missing native MFA, another tenant credential, arbitrary destinations and cross-kind scopes', async () => {
    const own = people.a.owner.context;
    const { secretRef } = await storeSecret(web.db, own, {
      publicKeyPem: secret('sealing_public_key.pem'),
      purpose: 'connector_credential',
      plaintext: 'GENERATED-SETUP-SECRET',
    });
    const input = {
      connectorType: 'crm_http',
      displayName: 'Generated denied setup',
      credentialSecretId: secretRef,
      config: { tlsServerName: name, streams: ['crm.accounts'], scopes: ['crm_http.read'] },
    };
    const unproved = await makeTwoTenants(web.db);
    await proveSecondFactor(unproved.a.owner);
    await updateSecurityPolicy(
      web.db,
      unproved.a.owner.context,
      { sessionId: unproved.a.owner.sessionId },
      {
        expectedVersion: 1,
        mfaForAdministration: true,
        mfaMaxAgeSeconds: 900,
        ssoEnforcement: 'optional',
      },
    );
    await expect(createConnection(web.db, unproved.a.admin.context, input)).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
    });
    await expect(createConnection(web.db, people.a.member.context, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    for (const config of [
      { ...input.config, host: '169.254.169.254' },
      { ...input.config, credential: 'GENERATED-SECRET' },
      { ...input.config, scopes: ['crm_http.read', 'accounting_http.write'] },
      { ...input.config, streams: ['accounting.invoices'] },
    ])
      await expect(createConnection(web.db, own, { ...input, config })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    await expect(createConnection(web.db, people.b.owner.context, input)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  for (const row of rows) {
    it.each(['wrong_name', 'untrusted_certificate'] as const)(
      row.type + ' refuses %s before any credential lease or HTTP request',
      async (failure) => {
        const token = randomBytes(24).toString('hex'),
          source = await adapter(
            new Map([[token, { email: 'generated@example.invalid', fields: row.fields }]]),
            row.stream,
          ),
          lease = vi.fn();
        const connector = row.make({
          tls: 'required',
          ...(failure === 'wrong_name' ? { ca: source.certificate.cert } : {}),
          beforeCommitMs: 3000,
          answerMs: 3000,
          sink: {
            applyPage: async () => {
              throw Error('UNEXPECTED_SINK');
            },
          },
        });
        const context = {
          organizationId: people.a.owner.context.organizationId,
          connectionId: people.a.owner.context.membershipId,
          config: connector.parseConfig({
            tlsServerName: failure === 'wrong_name' ? 'wrong.example.invalid' : name,
            streams: [row.stream],
            scopes: [row.type + '.read'],
          }),
          grantedScopes: [row.type + '.read'],
          credentials: {
            withCredential: async <T>(use: (bytes: Buffer) => Promise<T>) => {
              lease();
              return use(Buffer.from(token));
            },
          },
          network: source.network,
          signal: new AbortController().signal,
        };
        await expect(
          connector.sync!.readPage(context, {
            stream: row.stream,
            cursor: null,
            fullSync: true,
            pageSize: 1,
          }),
        ).rejects.toMatchObject({ code: 'SYNC_UNAVAILABLE' });
        expect(lease).not.toHaveBeenCalled();
        expect(source.hits()).toBe(0);
      },
    );
    it(
      row.type +
        ' synchronizes two separate tenants with real sealed leases, source mapping, repeat and revocation',
      async () => {
        const ta = randomBytes(24).toString('hex'),
          tb = randomBytes(24).toString('hex'),
          sources = new Map([
            [ta, { email: await email(people.a.member.userId), fields: row.fields }],
            [tb, { email: await email(people.b.member.userId), fields: row.fields }],
          ]),
          source = await adapter(sources, row.stream);
        const connector = routeConnector(
          row.make({
            tls: 'required',
            ca: source.certificate.cert,
            beforeCommitMs: 3000,
            answerMs: 3000,
            sink: {
              applyPage: ({ organizationId, ...page }) =>
                applyBusinessRecordPage(worker.db, createServiceContext(organizationId), page),
            },
          }),
          source.network,
        );
        const activities = createConnectorSyncActivities({
          database: worker.db,
          registry: createConnectorRegistry([connector]),
          secrets: broker,
          network: {
            openRelay: async () => {
              throw Error('UNEXPECTED_DEFAULT_ROUTE');
            },
          },
        });
        const stored: {
          connectionId: string;
          secretId: string;
          organizationId: string;
          recordId: string;
        }[] = [];
        for (const [tenant, token] of [
          [people.a, ta],
          [people.b, tb],
        ] as const) {
          const context = tenant.owner.context,
            { secretRef } = await storeSecret(web.db, context, {
              publicKeyPem: secret('sealing_public_key.pem'),
              purpose: 'connector_credential',
              plaintext: token,
            });
          const { id: connectionId } = await createConnection(web.db, context, {
            connectorType: row.type,
            displayName: 'Generated manually authorized business connection',
            credentialSecretId: secretRef,
            config: { tlsServerName: name, streams: [row.stream], scopes: [row.type + '.read'] },
          });
          expect(
            await activities.syncConnection({
              organizationId: context.organizationId,
              connectionId,
            }),
          ).toMatchObject({ outcome: 'synced', resources: 1 });
          const visible = (
            await listBusinessRecords(web.db, tenant.member.context, { connectionId })
          ).items;
          expect(visible).toHaveLength(1);
          expect(visible[0]!.fields).toEqual(row.fields);
          expect(JSON.stringify(visible)).not.toContain('DROP-GENERATED-CANARY');
          expect(
            (await listBusinessRecords(web.db, tenant.owner.context, { connectionId })).items,
          ).toEqual([]);
          await activities.syncConnection({ organizationId: context.organizationId, connectionId });
          expect(
            (await listBusinessRecords(web.db, tenant.member.context, { connectionId })).items,
          ).toEqual(visible);
          stored.push({
            connectionId,
            secretId: secretRef,
            organizationId: context.organizationId,
            recordId: visible[0]!.id,
          });
        }
        expect(stored[0]!.recordId).not.toBe(stored[1]!.recordId);
        await expect(
          getBusinessRecord(web.db, people.a.member.context, stored[1]!.recordId),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const first = stored[0]!;
        await revokeConnection(web.db, people.a.owner.context, {
          connectionId: first.connectionId,
          expectedVersion: 1,
        });
        await expect(
          getBusinessRecord(web.db, people.a.member.context, first.recordId),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const before = source.hits();
        expect(
          await activities.syncConnection({
            organizationId: first.organizationId,
            connectionId: first.connectionId,
          }),
        ).toMatchObject({ outcome: 'revoked' });
        expect(source.hits()).toBe(before);
        await expect(
          broker.withSecret(
            {
              organizationId: first.organizationId,
              secretId: first.secretId,
              purpose: 'connector_credential',
            },
            async () => true,
          ),
        ).rejects.toThrow();
        expect(JSON.stringify(source.log.info.mock.calls)).not.toContain(ta);
        expect(JSON.stringify(source.log.warn.mock.calls)).not.toContain(tb);
      },
    );
  }
});
