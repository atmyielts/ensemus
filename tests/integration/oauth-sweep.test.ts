// The suite upkeep's consent sweep (ADR-038 D1) on real roles, RLS, 0561's triggers and the secret broker:
// an attempt that ends early, or a start refused after it sealed, leaves nothing sealed behind, and an
// attempt still under way keeps what it needs. Generated values only: no real account, client, code or
// token. Owed: not yet run (no Docker).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  receiveCallback,
  startAuthorization,
  type OAuthWebSide,
  type StartAuthorizationInput,
} from '@ensemus/application';
import { openAppDatabase, type TenantContext } from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { SECRET_PURPOSE_OAUTH_PKCE_VERIFIER } from '@ensemus/domain/workspace-suites';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { storeSecret } from '@ensemus/secrets/seal';
import { createSuiteUpkeepActivities } from '@ensemus/workflows/suite-upkeep-activities';
import { makeTwoTenants, type TestPerson } from '../helpers/product';
import { secret, urls } from '../helpers/stack';

const REDIRECT = 'https://ensemus.example.invalid/api/v1/oauth/callback';
const GOOGLE_CLIENT = 'generated-platform.apps.googleusercontent.com';

describe('the consent sweep', () => {
  const app = openAppDatabase(urls.app(), { max: 4 });
  const secretsDb = openSecretsDatabase(urls.secrets());
  const observer = new pg.Client({ connectionString: urls.superuser() });
  const db = () => app.db;
  const publicKeyPem = secret('sealing_public_key.pem');
  let broker: SecretBroker;
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;

  function webSide(context: TenantContext): OAuthWebSide {
    return {
      async seal(purpose, plaintext) {
        const { secretRef } = await storeSecret(db(), context, {
          publicKeyPem,
          purpose,
          plaintext: plaintext.toString('utf8'),
        });
        return secretRef;
      },
      redirectUri: REDIRECT,
      platformClientId: () => GOOGLE_CLIENT,
    };
  }

  const googleStart = (
    overrides: Partial<StartAuthorizationInput> = {},
  ): StartAuthorizationInput => ({
    connectorType: 'google_workspace',
    displayName: 'Generated workspace',
    config: {},
    capabilities: ['files'],
    client: { kind: 'platform' },
    ...overrides,
  });

  async function start(person: TestPerson, overrides: Partial<StartAuthorizationInput> = {}) {
    const started = await startAuthorization(
      db(),
      person.context,
      googleStart(overrides),
      webSide(person.context),
    );
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    return { ...started, state };
  }

  const row = async (id: string) =>
    (
      await observer.query<{
        status: string;
        verifier_secret_id: string;
        code_secret_id: string | null;
        customer_client_secret_id: string | null;
      }>('select * from integrations.oauth_authorizations where id=$1', [id])
    ).rows[0]!;

  const revoked = async (secretId: string) =>
    (
      await observer.query<{ revoked: boolean }>(
        'select revoked_at is not null as revoked from secrets.sealed_secrets where id=$1',
        [secretId],
      )
    ).rows[0]?.revoked;

  /** Moves times into the past, as only a test may: no role can change them otherwise. */
  async function asSuperuser(sqlText: string, params: unknown[]) {
    await observer.query('begin');
    try {
      await observer.query("set local session_replication_role = 'replica'");
      await observer.query(sqlText, params);
      await observer.query('commit');
    } catch (error) {
      await observer.query('rollback');
      throw error;
    }
  }
  const ageOut = (id: string) =>
    asSuperuser(
      `update integrations.oauth_authorizations
          set created_at=now()-interval '11 minutes', expires_at=now()-interval '1 minute'
        where id=$1`,
      [id],
    );

  const sweep = (organizationId: string) =>
    createSuiteUpkeepActivities({ database: db(), secrets: broker }).sweepOAuthAttempts({
      organizationId,
    });

  beforeAll(async () => {
    await observer.connect();
    broker = new SecretBroker(
      secretsDb.db,
      new FileKeyProvider([secret('sealing_private_key.pem')]),
    );
    tenants = await makeTwoTenants(db());
  });

  afterAll(async () => {
    await app.close();
    await secretsDb.close();
    await observer.end();
  });

  it('revokes a denied attempt’s verifier and customer client', async () => {
    const started = await start(tenants.a.owner, {
      client: {
        kind: 'customer',
        clientId: 'generated-customer',
        clientSecret: `CANARY-${randomUUID()}`,
      },
    });
    await receiveCallback(
      db(),
      tenants.a.owner.context,
      { state: started.state, error: 'access_denied' },
      webSide(tenants.a.owner.context),
    );
    const attempt = await row(started.authorizationId);
    expect(attempt.status).toBe('denied');
    // The web tier said so in the same transaction, for the dispatcher.
    const { rows } = await observer.query<{ event_type: string }>(
      'select event_type from platform.domain_events where aggregate_id=$1 order by aggregate_version',
      [started.authorizationId],
    );
    expect(rows.map((event) => event.event_type)).toContain('oauth_authorization.ended');

    await sweep(tenants.a.organizationId);
    expect(await revoked(attempt.verifier_secret_id)).toBe(true);
    expect(await revoked(attempt.customer_client_secret_id!)).toBe(true);
  });

  it('expires an abandoned pending or code_received attempt, then revokes what it sealed', async () => {
    const pending = await start(tenants.a.owner);
    const received = await start(tenants.a.owner);
    await receiveCallback(
      db(),
      tenants.a.owner.context,
      { state: received.state, code: `CANARY-code-${randomUUID()}` },
      webSide(tenants.a.owner.context),
    );
    await ageOut(pending.authorizationId);
    await ageOut(received.authorizationId);

    const result = await sweep(tenants.a.organizationId);
    expect(result.expired).toBeGreaterThanOrEqual(2);
    const p = await row(pending.authorizationId);
    const r = await row(received.authorizationId);
    expect([p.status, r.status]).toEqual(['expired', 'expired']);
    expect(await revoked(p.verifier_secret_id)).toBe(true);
    expect(await revoked(r.verifier_secret_id)).toBe(true);
    expect(await revoked(r.code_secret_id!)).toBe(true);
  });

  it('leaves an attempt under way alone, whatever its age within its window', async () => {
    const live = await start(tenants.a.owner);
    await sweep(tenants.a.organizationId);
    const attempt = await row(live.authorizationId);
    expect(attempt.status).toBe('pending');
    expect(await revoked(attempt.verifier_secret_id)).toBe(false);
  });

  it('revokes a sealed verifier no attempt names once it is old enough, and not before', async () => {
    // What a start refused after sealing leaves behind: a value with no row naming it.
    const { secretRef: young } = await storeSecret(db(), tenants.a.owner.context, {
      publicKeyPem,
      purpose: SECRET_PURPOSE_OAUTH_PKCE_VERIFIER,
      plaintext: 'generated-orphan-verifier-young',
    });
    const { secretRef: old } = await storeSecret(db(), tenants.a.owner.context, {
      publicKeyPem,
      purpose: SECRET_PURPOSE_OAUTH_PKCE_VERIFIER,
      plaintext: 'generated-orphan-verifier-old',
    });
    await asSuperuser(
      "update secrets.sealed_secrets set created_at=now()-interval '16 minutes' where id=$1",
      [old],
    );
    await sweep(tenants.a.organizationId);
    expect(await revoked(old)).toBe(true);
    expect(await revoked(young)).toBe(false);
  });

  it('sweeps one tenant only', async () => {
    const other = await start(tenants.b.owner);
    await ageOut(other.authorizationId);
    await sweep(tenants.a.organizationId);
    const attempt = await row(other.authorizationId);
    expect(attempt.status).toBe('pending');
    expect(await revoked(attempt.verifier_secret_id)).toBe(false);
  });
});
