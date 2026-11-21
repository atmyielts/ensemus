// Refresh-token rotation (ADR-038 D2, 0562): the broker reseals a live connector credential in place, on
// the real secrets role, RLS and 0562's trigger. A refresh that lost a race is refused as stale, and any
// other secret, a revoked one, another tenant's, or a change to what identifies the row is refused.
// Generated values only: no real account, client or token. Owed: not yet run (no Docker).
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receiveCallback, startAuthorization, type OAuthWebSide } from '@ensemus/application';
import type { ProviderHttpClient } from '@ensemus/connectors/knowledge';
import { openAppDatabase, type TenantContext } from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { SUITE_SQLSTATES } from '@ensemus/domain/workspace-suites';
import { FileKeyProvider, SecretBroker, SecretUnavailable } from '@ensemus/secrets/broker';
import { sealSecret, storeSecret } from '@ensemus/secrets/seal';
import {
  createCredentialRotation,
  createOAuthExchangeActivities,
} from '@ensemus/workflows/oauth-exchange-activities';
import { makeTwoTenants } from '../helpers/product';
import { secret, urls } from '../helpers/stack';

const REDIRECT = 'https://ensemus.example.invalid/api/v1/oauth/callback';
const CANARY = `CANARY-${randomBytes(12).toString('hex')}`;
const PLATFORM = {
  client_id: 'generated-platform.apps.googleusercontent.com',
  client_secret: 'generated-platform-secret',
};
const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_METADATA = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const PURPOSE = 'connector_credential';
const EN124 = SUITE_SQLSTATES.credentialResealRefused;

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const jwt = (claims: object) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.generated-signature`;

type SealedRow = {
  organization_id: string;
  id: string;
  purpose: string;
  key_id: string;
  wrapped_key: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  created_at: Date;
  revoked_at: Date | null;
};

describe('refresh-token rotation', () => {
  const app = openAppDatabase(urls.app(), { max: 4 });
  const secretsDb = openSecretsDatabase(urls.secrets());
  const broker = new SecretBroker(
    secretsDb.db,
    new FileKeyProvider([secret('sealing_private_key.pem')]),
  );
  const publicKeyPem = secret('sealing_public_key.pem');
  const observer = new pg.Client({ connectionString: urls.superuser() });
  const secretsRole = new pg.Client({ connectionString: urls.secrets() });
  const rotation = createCredentialRotation(app.db, broker);
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;

  const http: ProviderHttpClient = {
    request: async () => ({
      status: 200,
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          access_token: 'generated-access',
          token_type: 'Bearer',
          expires_in: 3599,
          refresh_token: `${CANARY}-refresh-1`,
          // Every scope the files capability asks for, so the exchange connects.
          scope: `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE} ${DRIVE_METADATA}`,
          id_token: jwt({
            iss: 'https://accounts.google.com',
            aud: PLATFORM.client_id,
            email: 'admin@example.invalid',
            email_verified: true,
          }),
        }),
      ),
    }),
  };
  const exchange = createOAuthExchangeActivities({
    database: app.db,
    secrets: broker,
    http,
    platformClients: { get: (provider) => (provider === 'google' ? PLATFORM : null) },
    seal: (input) => sealSecret({ ...input, publicKeyPem }),
    redirectUri: REDIRECT,
  });

  const webSide = (context: TenantContext): OAuthWebSide => ({
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
  });

  /** A Google connection made the way a real one is, through consent and the exchange. */
  async function connected(context: TenantContext) {
    const started = await startAuthorization(
      app.db,
      context,
      {
        connectorType: 'google_workspace',
        displayName: 'Generated workspace',
        config: {},
        capabilities: ['files'],
        client: { kind: 'platform' },
      },
      webSide(context),
    );
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await receiveCallback(app.db, context, { state, code: 'generated-code' }, webSide(context));
    const outcome = await exchange.exchangeOAuthAuthorization({
      organizationId: context.organizationId,
      authorizationId: started.authorizationId,
    });
    expect(outcome.outcome).toBe('connected');
    const connectionId = outcome.connectionId!;
    const { rows } = await observer.query<{ credential_secret_id: string }>(
      'select credential_secret_id from integrations.connections where id=$1',
      [connectionId],
    );
    return { connectionId, secretId: rows[0]!.credential_secret_id };
  }

  const sealedRow = async (secretId: string) =>
    (
      await observer.query<SealedRow>('select * from secrets.sealed_secrets where id=$1', [
        secretId,
      ])
    ).rows[0]!;
  const read = (organizationId: string, secretId: string) =>
    broker.withSecret({ organizationId, secretId, purpose: PURPOSE }, async (value) =>
      Buffer.from(value),
    );
  const stored = (context: TenantContext, purpose = PURPOSE, plaintext = 'generated-value') =>
    storeSecret(app.db, context, { publicKeyPem, purpose, plaintext }).then((s) => s.secretRef);

  /** A raw UPDATE as the secrets role, bound to a tenant, answering the SQLSTATE or the row count. */
  async function rawUpdate(
    client: pg.Client,
    organizationId: string,
    statement: string,
    values: unknown[],
  ): Promise<string | number> {
    await client.query('begin');
    try {
      await client.query(`select set_config('app.organization_id', $1, true)`, [organizationId]);
      const result = await client.query(statement, values);
      await client.query('commit');
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query('rollback');
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  beforeAll(async () => {
    await observer.connect();
    await secretsRole.connect();
    tenants = await makeTwoTenants(app.db);
  });
  afterAll(async () => {
    await app.close();
    await secretsDb.close();
    await observer.end();
    await secretsRole.end();
  });

  it('reseals the rotated token in place, and the connection still names the same secret', async () => {
    const { connectionId, secretId } = await connected(tenants.a.owner.context);
    const organizationId = tenants.a.organizationId;
    const before = await sealedRow(secretId);
    const current = await read(organizationId, secretId);
    const credential = JSON.parse(current.toString('utf8')) as Record<string, unknown>;
    expect(credential).toMatchObject({ client: 'platform', refresh_token: `${CANARY}-refresh-1` });
    const replacement = Buffer.from(
      JSON.stringify({ ...credential, refresh_token: `${CANARY}-refresh-2` }),
    );

    expect(
      await rotation.persist({
        organizationId,
        connectionId,
        expectedCredentialSha256: sha256(current),
        replacement,
      }),
    ).toBe('stored');

    const after = await sealedRow(secretId);
    expect(after).toMatchObject({
      organization_id: before.organization_id,
      id: before.id,
      purpose: before.purpose,
      created_at: before.created_at,
      revoked_at: null,
    });
    expect(after.iv.equals(before.iv)).toBe(false);
    expect(after.wrapped_key.equals(before.wrapped_key)).toBe(false);
    expect((await read(organizationId, secretId)).toString('utf8')).toBe(
      replacement.toString('utf8'),
    );
    const { rows } = await observer.query<{ credential_secret_id: string }>(
      'select credential_secret_id from integrations.connections where id=$1',
      [connectionId],
    );
    expect(rows[0]!.credential_secret_id).toBe(secretId);
    expect(after.ciphertext.toString('latin1')).not.toContain(CANARY);

    // A second refresh that read the first token lost the race. It must not put its own token back.
    expect(
      await rotation.persist({
        organizationId,
        connectionId,
        expectedCredentialSha256: sha256(current),
        replacement: Buffer.from(
          JSON.stringify({ ...credential, refresh_token: `${CANARY}-refresh-3` }),
        ),
      }),
    ).toBe('stale');
    expect((await read(organizationId, secretId)).toString('utf8')).toBe(
      replacement.toString('utf8'),
    );
  });

  it('answers stale for a connection of another tenant', async () => {
    const { connectionId } = await connected(tenants.b.owner.context);
    expect(
      await rotation.persist({
        organizationId: tenants.a.organizationId,
        connectionId,
        expectedCredentialSha256: sha256('anything'),
        replacement: Buffer.from('generated'),
      }),
    ).toBe('stale');
  });

  it("refuses another tenant's secret through the broker and through SQL", async () => {
    const secretId = await stored(tenants.a.owner.context);
    const binding = { organizationId: tenants.b.organizationId, secretId, purpose: PURPOSE };
    await expect(
      broker.reseal(binding, sha256('generated-value'), Buffer.from('generated-new')),
    ).rejects.toBeInstanceOf(SecretUnavailable);
    // RLS hides the row from tenant B's binding, so nothing is written.
    expect(
      await rawUpdate(
        secretsRole,
        tenants.b.organizationId,
        'update secrets.sealed_secrets set iv=$2, ciphertext=$3, auth_tag=$4 where id=$1',
        [secretId, randomBytes(12), randomBytes(16), randomBytes(16)],
      ),
    ).toBe(0);
    expect((await read(tenants.a.organizationId, secretId)).toString()).toBe('generated-value');
  });

  it('refuses a secret of another purpose', async () => {
    const secretId = await stored(tenants.a.owner.context, 'model.api_key');
    await expect(
      broker.reseal(
        { organizationId: tenants.a.organizationId, secretId, purpose: 'model.api_key' },
        sha256('generated-value'),
        Buffer.from('generated-new'),
      ),
    ).rejects.toBeInstanceOf(SecretUnavailable);
    await expect(
      broker.reseal(
        { organizationId: tenants.a.organizationId, secretId, purpose: PURPOSE },
        sha256('generated-value'),
        Buffer.from('generated-new'),
      ),
    ).rejects.toBeInstanceOf(SecretUnavailable);
    const row = await sealedRow(secretId);
    expect(
      await rawUpdate(
        secretsRole,
        tenants.a.organizationId,
        'update secrets.sealed_secrets set wrapped_key=$2, iv=$3, ciphertext=$4, auth_tag=$5 where id=$1',
        [
          secretId,
          Buffer.from(row.wrapped_key).reverse(),
          randomBytes(12),
          randomBytes(16),
          randomBytes(16),
        ],
      ),
    ).toBe(EN124);
  });

  it('refuses a revoked secret', async () => {
    const secretId = await stored(tenants.a.owner.context);
    await broker.revoke(tenants.a.organizationId, secretId);
    await expect(
      broker.reseal(
        { organizationId: tenants.a.organizationId, secretId, purpose: PURPOSE },
        sha256('generated-value'),
        Buffer.from('generated-new'),
      ),
    ).rejects.toBeInstanceOf(SecretUnavailable);
    const row = await sealedRow(secretId);
    expect(
      await rawUpdate(
        secretsRole,
        tenants.a.organizationId,
        'update secrets.sealed_secrets set wrapped_key=$2, iv=$3, ciphertext=$4, auth_tag=$5 where id=$1',
        [
          secretId,
          Buffer.from(row.wrapped_key).reverse(),
          randomBytes(12),
          randomBytes(16),
          randomBytes(16),
        ],
      ),
    ).toBe(EN124);
    // Un-revoking in the same statement is refused too.
    expect(
      await rawUpdate(
        secretsRole,
        tenants.a.organizationId,
        'update secrets.sealed_secrets set revoked_at=null, wrapped_key=$2, iv=$3, ciphertext=$4, auth_tag=$5 where id=$1',
        [
          secretId,
          Buffer.from(row.wrapped_key).reverse(),
          randomBytes(12),
          randomBytes(16),
          randomBytes(16),
        ],
      ),
    ).toBe(EN124);
  });

  it('keeps the tenant, ID, purpose and creation time fixed, and requires a fresh IV and data key', async () => {
    const secretId = await stored(tenants.a.owner.context);
    const row = await sealedRow(secretId);
    const organizationId = tenants.a.organizationId;
    // The secrets role holds no UPDATE on what identifies a row.
    for (const column of ['id', 'organization_id', 'purpose', 'created_at'])
      expect(
        await rawUpdate(
          secretsRole,
          organizationId,
          `update secrets.sealed_secrets set ${column}=${column}, iv=$2 where id=$1`,
          [secretId, randomBytes(12)],
        ),
      ).toBe('42501');
    // The same IV, or the same wrapped data key, would let one key and nonce seal two values.
    expect(
      await rawUpdate(
        secretsRole,
        organizationId,
        'update secrets.sealed_secrets set ciphertext=$2, auth_tag=$3 where id=$1',
        [secretId, randomBytes(16), randomBytes(16)],
      ),
    ).toBe(EN124);
    expect(
      await rawUpdate(
        secretsRole,
        organizationId,
        'update secrets.sealed_secrets set iv=$2, ciphertext=$3, auth_tag=$4 where id=$1',
        [secretId, randomBytes(12), randomBytes(16), randomBytes(16)],
      ),
    ).toBe(EN124);
    // Not even the owner of the table may replace a sealed value: only the broker reseals.
    expect(
      await rawUpdate(
        observer,
        organizationId,
        'update secrets.sealed_secrets set wrapped_key=$2, iv=$3, ciphertext=$4, auth_tag=$5 where id=$1',
        [
          secretId,
          Buffer.from(row.wrapped_key).reverse(),
          randomBytes(12),
          randomBytes(16),
          randomBytes(16),
        ],
      ),
    ).toBe(EN124);
    expect(await sealedRow(secretId)).toEqual(row);
    // Rewrapping a data key alone, which key rotation does, does not reach the guard.
    expect(
      await rawUpdate(
        secretsRole,
        organizationId,
        'update secrets.sealed_secrets set key_id=key_id, wrapped_key=wrapped_key where id=$1',
        [secretId],
      ),
    ).toBe(1);
  });
});
