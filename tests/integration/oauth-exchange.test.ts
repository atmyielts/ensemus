// CONNECT-07, the worker half (ADR-038 D1 to D3): the code exchange on real roles, RLS, 0561's triggers and
// the real secret broker, against a scripted token endpoint. A canary is planted in the code, the
// verifier's neighbours, the client secrets and the tokens, and nothing may carry it to a log line, an
// error, a row or the Activity's answer, which is what crosses Temporal. Generated values only: no real
// account, client, code or token. Owed: not yet run (no Docker).
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  receiveCallback,
  startAuthorization,
  type OAuthWebSide,
  type StartAuthorizationInput,
} from '@ensemus/application';
import type { ProviderHttpClient, ProviderRequest } from '@ensemus/connectors/knowledge';
import { openAppDatabase, type TenantContext } from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { sealSecret, storeSecret } from '@ensemus/secrets/seal';
import { createOAuthExchangeActivities } from '@ensemus/workflows/oauth-exchange-activities';
import { makeTwoTenants, type TestPerson } from '../helpers/product';
import { secret, urls } from '../helpers/stack';

const REDIRECT = 'https://ensemus.example.invalid/api/v1/oauth/callback';
const CANARY = `CANARY-${randomBytes(12).toString('hex')}`;
const PLATFORM = {
  client_id: 'generated-platform.apps.googleusercontent.com',
  client_secret: `${CANARY}-platform-secret`,
};
const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_METADATA = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const DIRECTORY = 'https://www.googleapis.com/auth/admin.directory.group.readonly';

const jwt = (claims: object) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.generated-signature`;

/** A Google token answer granting `scope`, with every secret in it carrying the canary. */
const granted = (scope: string) => ({
  status: 200,
  body: {
    access_token: `${CANARY}-access`,
    token_type: 'Bearer',
    expires_in: 3599,
    refresh_token: `${CANARY}-refresh`,
    scope,
    id_token: jwt({
      iss: 'https://accounts.google.com',
      aud: PLATFORM.client_id,
      email: 'admin@example.invalid',
      email_verified: true,
    }),
  },
});

describe('the OAuth code exchange', () => {
  const app = openAppDatabase(urls.app(), { max: 4 });
  const secretsDb = openSecretsDatabase(urls.secrets());
  const broker = new SecretBroker(
    secretsDb.db,
    new FileKeyProvider([secret('sealing_private_key.pem')]),
  );
  const publicKeyPem = secret('sealing_public_key.pem');
  const observer = new pg.Client({ connectionString: urls.superuser() });
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;

  // What the token endpoint answers next, and every request it saw.
  let answer: { status: number; body: unknown } = granted('');
  let requests: ProviderRequest[] = [];
  const http: ProviderHttpClient = {
    request: async (request) => {
      requests.push(request);
      return {
        status: answer.status,
        headers: {},
        body: Buffer.from(JSON.stringify(answer.body)),
      };
    },
  };
  const activities = createOAuthExchangeActivities({
    database: app.db,
    secrets: broker,
    http,
    platformClients: { get: (provider) => (provider === 'google' ? PLATFORM : null) },
    seal: (input) => sealSecret({ ...input, publicKeyPem }),
    redirectUri: REDIRECT,
  });

  function webSide(context: TenantContext): OAuthWebSide {
    return {
      seal: async (purpose, plaintext) =>
        (
          await storeSecret(app.db, context, {
            publicKeyPem,
            purpose,
            plaintext: plaintext.toString('utf8'),
          })
        ).secretRef,
      redirectUri: REDIRECT,
      platformClientId: (provider) => (provider === 'google' ? PLATFORM.client_id : null),
    };
  }

  /** A consent that reached `code_received` through the web half, as a real one would. */
  async function received(
    person: TestPerson,
    overrides: Partial<StartAuthorizationInput> = {},
  ): Promise<{ organizationId: string; authorizationId: string }> {
    const started = await startAuthorization(
      app.db,
      person.context,
      {
        connectorType: 'google_workspace',
        displayName: 'Generated workspace',
        config: {},
        capabilities: ['files'],
        client: { kind: 'platform' },
        ...overrides,
      },
      webSide(person.context),
    );
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await receiveCallback(
      app.db,
      person.context,
      { state, code: `${CANARY}-code` },
      webSide(person.context),
    );
    return {
      organizationId: person.context.organizationId,
      authorizationId: started.authorizationId,
    };
  }

  const attempt = async (id: string) =>
    (
      await observer.query<{
        status: string;
        error_code: string | null;
        connection_id: string | null;
        code_secret_id: string;
        verifier_secret_id: string;
        customer_client_secret_id: string | null;
      }>('select * from integrations.oauth_authorizations where id=$1', [id])
    ).rows[0]!;

  const revoked = async (ids: readonly (string | null)[]) =>
    (
      await observer.query<{ id: string; revoked: boolean }>(
        'select id, revoked_at is not null as revoked from secrets.sealed_secrets where id = any($1::uuid[])',
        [ids.filter((id): id is string => id !== null)],
      )
    ).rows.every((row) => row.revoked);

  /** Every row this attempt could have touched, as text, for the canary. */
  async function rowsAbout(organizationId: string) {
    const dump = await observer.query(
      `select to_jsonb(a)::text as row from integrations.oauth_authorizations a where a.organization_id=$1
       union all select to_jsonb(c)::text from integrations.connections c where c.organization_id=$1
       union all select to_jsonb(e)::text from platform.domain_events e where e.organization_id=$1
       union all select to_jsonb(g)::text from governance.audit_events g where g.organization_id=$1
       union all select encode(s.ciphertext, 'escape') from secrets.sealed_secrets s where s.organization_id=$1`,
      [organizationId],
    );
    return dump.rows.map((row: { row: string }) => row.row).join('\n');
  }

  let output: string[] = [];
  beforeEach(() => {
    answer = granted(
      `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE} ${DRIVE_METADATA}`,
    );
    requests = [];
    output = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeAll(async () => {
    await observer.connect();
    tenants = await makeTwoTenants(app.db);
  });
  afterAll(async () => {
    await app.close();
    await secretsDb.close();
    await observer.end();
  });

  it('connects with granted ∩ requested, seals the credential, and revokes the code and verifier', async () => {
    const input = await received(tenants.a.owner);
    // The provider grants one scope nobody asked for. It must not reach the connection.
    answer = granted(
      `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE} ${DRIVE_METADATA} ${DIRECTORY}`,
    );
    const outcome = await activities.exchangeOAuthAuthorization(input);
    expect(outcome.outcome).toBe('connected');
    expect(requests).toHaveLength(1);

    const row = await attempt(input.authorizationId);
    expect(row).toMatchObject({ status: 'connected', connection_id: outcome.connectionId });
    const connection = (
      await observer.query(
        'select * from integrations.connections where organization_id=$1 and id=$2',
        [input.organizationId, outcome.connectionId],
      )
    ).rows[0];
    expect(connection).toMatchObject({
      connector_type: 'google_workspace',
      state: 'active',
      owner_membership_id: null,
      created_by_membership_id: tenants.a.owner.context.membershipId,
    });
    expect([...connection.granted_scopes].sort()).toEqual(
      ['email', 'openid', DRIVE, DRIVE_METADATA].sort(),
    );
    expect(connection.granted_scopes).not.toContain(DIRECTORY);

    // The stored credential names the operator's app and holds none of it.
    const stored = await broker.withSecret(
      {
        organizationId: input.organizationId,
        secretId: connection.credential_secret_id,
        purpose: 'connector_credential',
      },
      async (value) => JSON.parse(value.toString('utf8')),
    );
    expect(stored).toEqual({ client: 'platform', refresh_token: `${CANARY}-refresh` });
    expect(await revoked([row.code_secret_id, row.verifier_secret_id])).toBe(true);

    const events = (
      await observer.query<{ event_type: string }>(
        'select event_type from platform.domain_events where organization_id=$1 and aggregate_id = any($2::uuid[])',
        [input.organizationId, [input.authorizationId, outcome.connectionId]],
      )
    ).rows.map((event) => event.event_type);
    expect(events).toEqual(
      expect.arrayContaining([
        'connection.created',
        'connector.sync_requested',
        'oauth_authorization.connected',
      ]),
    );
    expect(JSON.stringify([outcome, output])).not.toContain(CANARY);
    // The sealed credential's ciphertext is in the dump, and the canary is not readable in it.
    expect(await rowsAbout(input.organizationId)).not.toContain(CANARY);
  });

  it('fails a used code once, never retries it, and revokes the code and verifier', async () => {
    const input = await received(tenants.a.owner);
    answer = { status: 400, body: { error: 'invalid_grant', error_description: CANARY } };
    expect(await activities.exchangeOAuthAuthorization(input)).toEqual({
      outcome: 'failed',
      connectionId: null,
    });
    // A second delivery finds the attempt settled and sends nothing.
    expect(await activities.exchangeOAuthAuthorization(input)).toEqual({
      outcome: 'already_settled',
      connectionId: null,
    });
    expect(requests).toHaveLength(1);
    const row = await attempt(input.authorizationId);
    expect(row).toMatchObject({ status: 'failed', error_code: 'OAUTH_EXCHANGE_FAILED' });
    expect(await revoked([row.code_secret_id, row.verifier_secret_id])).toBe(true);
    expect(JSON.stringify(output)).not.toContain(CANARY);
    expect(await rowsAbout(input.organizationId)).not.toContain(CANARY);
  });

  it('refuses a grant missing a chosen capability’s scopes, and stores nothing of it', async () => {
    const input = await received(tenants.a.owner);
    answer = granted(`openid https://www.googleapis.com/auth/userinfo.email ${DRIVE}`);
    const before = await observer.query(
      'select count(*)::int as n from integrations.connections where organization_id=$1',
      [input.organizationId],
    );
    expect(await activities.exchangeOAuthAuthorization(input)).toEqual({
      outcome: 'failed',
      connectionId: null,
    });
    const row = await attempt(input.authorizationId);
    expect(row).toMatchObject({
      status: 'failed',
      error_code: 'OAUTH_SCOPES_INSUFFICIENT',
      connection_id: null,
    });
    expect(await revoked([row.code_secret_id, row.verifier_secret_id])).toBe(true);
    const after = await observer.query(
      'select count(*)::int as n from integrations.connections where organization_id=$1',
      [input.organizationId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(await rowsAbout(input.organizationId)).not.toContain(CANARY);
  });

  it('revokes a customer’s sealed client with the code and verifier when the exchange fails', async () => {
    const input = await received(tenants.a.owner, {
      client: {
        kind: 'customer',
        clientId: 'generated-customer.apps.googleusercontent.com',
        clientSecret: `${CANARY}-customer-secret`,
      },
    });
    answer = { status: 401, body: { error: 'invalid_client', error_description: CANARY } };
    await activities.exchangeOAuthAuthorization(input);
    const row = await attempt(input.authorizationId);
    expect(row).toMatchObject({ status: 'failed', error_code: 'OAUTH_CLIENT_REJECTED' });
    expect(
      await revoked([row.code_secret_id, row.verifier_secret_id, row.customer_client_secret_id]),
    ).toBe(true);
    expect(JSON.stringify(output)).not.toContain(CANARY);
  });

  it('cannot reach another tenant’s attempt, even with its ID', async () => {
    const theirs = await received(tenants.b.owner);
    expect(
      await activities.exchangeOAuthAuthorization({
        organizationId: tenants.a.organizationId,
        authorizationId: theirs.authorizationId,
      }),
    ).toEqual({ outcome: 'already_settled', connectionId: null });
    expect(requests).toHaveLength(0);
    expect((await attempt(theirs.authorizationId)).status).toBe('code_received');
    // Abandoning it from the wrong tenant changes nothing either.
    await activities.abandonOAuthExchange({
      organizationId: tenants.a.organizationId,
      authorizationId: theirs.authorizationId,
    });
    expect((await attempt(theirs.authorizationId)).status).toBe('code_received');
  });

  it('abandons an attempt whose exchange gave no answer, and leaves a connected one alone', async () => {
    const lost = await received(tenants.a.owner);
    await activities.abandonOAuthExchange(lost);
    expect(await attempt(lost.authorizationId)).toMatchObject({
      status: 'failed',
      error_code: 'OAUTH_EXCHANGE_FAILED',
    });

    const done = await received(tenants.a.owner);
    const outcome = await activities.exchangeOAuthAuthorization(done);
    await activities.abandonOAuthExchange(done);
    expect(await attempt(done.authorizationId)).toMatchObject({
      status: 'connected',
      connection_id: outcome.connectionId,
    });
  });

  it('leaves the exchange to the service: the person who started it cannot claim it', async () => {
    const input = await received(tenants.a.owner);
    const client = new pg.Client({ connectionString: urls.app() });
    await client.connect();
    try {
      await client.query('begin');
      for (const [name, value] of [
        ['app.organization_id', input.organizationId],
        ['app.actor_type', 'user'],
        ['app.membership_id', tenants.a.owner.context.membershipId],
        ['ensemus.oauth_exchange', input.authorizationId],
      ])
        await client.query('select set_config($1, $2, true)', [name, value]);
      await expect(
        client.query(
          "update integrations.oauth_authorizations set status='exchanging' where id=$1",
          [input.authorizationId],
        ),
      ).rejects.toMatchObject({ code: 'EN122' });
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
    expect((await attempt(input.authorizationId)).status).toBe('code_received');
  });
});
