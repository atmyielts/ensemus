// FOUND-05, QA-018, SEC-008, SEC-016: secrets through real roles, with a full-database canary scan.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { FileKeyProvider, SecretBroker, SecretUnavailable } from '@ensemus/secrets/broker';
import { storeSecret } from '@ensemus/secrets/seal';
import { compose, secret, urls } from '../helpers/stack';

const CANARY = `CANARY-provider-key-${randomUUID()}`;

describe('secret broker', () => {
  const publicKeyPem = secret('sealing_public_key.pem');
  const provider = new FileKeyProvider([secret('sealing_private_key.pem')]);
  let app: ReturnType<typeof openAppDatabase>;
  let secretsDb: ReturnType<typeof openSecretsDatabase>;
  let broker: SecretBroker;
  let ctxA: TenantContext;
  let ctxB: TenantContext;
  let secretRef: string;

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    secretsDb = openSecretsDatabase(urls.secrets());
    broker = new SecretBroker(secretsDb.db, provider);
    const auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      'owner',
      `${userId}@example.invalid`,
    ]);
    await auth.end();
    const a = await createOrganization(app.db, { userId, name: 'A', commercialMode: 'byom' });
    const b = await createOrganization(app.db, { userId, name: 'B', commercialMode: 'byom' });
    ctxA = await resolveTenantContext(app.db, userId, a.organizationId);
    ctxB = await resolveTenantContext(app.db, userId, b.organizationId);
    ({ secretRef } = await storeSecret(app.db, ctxA, {
      publicKeyPem,
      purpose: 'model.api_key',
      plaintext: CANARY,
    }));
  });

  afterAll(async () => {
    await app?.close();
    await secretsDb?.close();
  });

  const bindingA = () => ({
    organizationId: ctxA.organizationId,
    secretId: secretRef,
    purpose: 'model.api_key',
  });

  it('lets the broker read a secret stored by the application role', async () => {
    const seen = await broker.withSecret(bindingA(), async (s) => s.toString());
    expect(seen).toBe(CANARY);
  });

  it('wipes the secret after use', async () => {
    let kept: Buffer | undefined;
    await broker.withSecret(bindingA(), async (s) => {
      kept = s;
    });
    expect(kept?.every((byte) => byte === 0)).toBe(true);
  });

  it('never lets the application role read back what it stored', async () => {
    const error = await withTenantTx(app.db, ctxA, (tx) =>
      tx.execute('select * from secrets.sealed_secrets'),
    ).catch((e: Error) => e);
    expect((error as Error).cause).toMatchObject({ code: '42501' }); // insufficient_privilege
  });

  it('refuses the same secret ID from another tenant', async () => {
    await expect(
      broker.withSecret({ ...bindingA(), organizationId: ctxB.organizationId }, async () => 'x'),
    ).rejects.toBeInstanceOf(SecretUnavailable);
  });

  it('refuses the wrong purpose', async () => {
    await expect(
      broker.withSecret({ ...bindingA(), purpose: 'connector.oauth' }, async () => 'x'),
    ).rejects.toBeInstanceOf(SecretUnavailable);
  });

  it('stops serving a revoked secret', async () => {
    const stored = await storeSecret(app.db, ctxA, {
      publicKeyPem,
      purpose: 'model.api_key',
      plaintext: 'to-be-revoked',
    });
    const binding = { ...bindingA(), secretId: stored.secretRef };
    await broker.revoke(ctxA.organizationId, stored.secretRef);
    await expect(broker.withSecret(binding, async () => 'x')).rejects.toBeInstanceOf(
      SecretUnavailable,
    );
  });

  it('rotates to a new key without changing the secret', async () => {
    const next = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const stored = await storeSecret(app.db, ctxB, {
      publicKeyPem,
      purpose: 'model.api_key',
      plaintext: 'rotates',
    });
    const rotating = new SecretBroker(
      secretsDb.db,
      new FileKeyProvider([next.privateKey, secret('sealing_private_key.pem')]),
    );
    expect(await rotating.rotateTenant(ctxB.organizationId)).toBeGreaterThan(0);
    const binding = {
      organizationId: ctxB.organizationId,
      secretId: stored.secretRef,
      purpose: 'model.api_key',
    };
    expect(await rotating.withSecret(binding, async (s) => s.toString())).toBe('rotates');
    // The old key alone can no longer open it.
    await expect(broker.withSecret(binding, async () => 'x')).rejects.toBeInstanceOf(
      SecretUnavailable,
    );
  });

  it('leaves no plaintext anywhere in the database, as text or hex', () => {
    const dump = compose('exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', 'ensemus');
    expect(dump.length).toBeGreaterThan(1000);
    expect(dump).toContain('sealed_secrets');
    expect(dump).not.toContain(CANARY);
    expect(dump.toLowerCase()).not.toContain(Buffer.from(CANARY).toString('hex'));
  });
});
