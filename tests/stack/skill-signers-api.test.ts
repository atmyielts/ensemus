// Publisher trust through the built web tier. Only generated public keys; no provider or runner.
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';

type Signer = { id: string; display_name: string; key_id: string; state: string; version: number };
const catalogEnabled = process.env.ENSEMUS_SKILL_CATALOG_ENABLED === 'true';
describe('publisher trust API', () => {
  let owner: Person, member: Person, outsider: Person, organization: string;
  const path = () => `/api/v1/organizations/${organization}/skill-signers`;
  beforeAll(async () => {
    owner = await signUp('Generated publisher owner');
    outsider = await signUp('Generated publisher outsider');
    organization = await createOrganization(owner, 'Generated publisher company');
    member = await join(owner, organization, 'Generated publisher member');
  });
  async function call(
    person: Person | undefined,
    method = 'GET',
    suffix = '',
    options: {
      body?: unknown;
      key?: string;
      version?: string;
      origin?: string;
    } = {},
  ) {
    const response = await fetch(`${BASE}${path()}${suffix}`, {
      method,
      headers: {
        ...(person ? { cookie: person.jar.cookie } : {}),
        ...(method !== 'GET' ? { origin: options.origin ?? BASE } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.key ? { 'idempotency-key': options.key } : {}),
        ...(options.version ? { 'if-match': options.version } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    expect(
      contractProblems({
        method,
        path: `${path()}${suffix}`,
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  }
  const key = () =>
    generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  it('keeps anonymous callers, outsiders, ordinary members and wrong origins away from administration', async () => {
    expect((await call(undefined)).status).toBe(401);
    expect((await call(outsider)).status).toBe(404);
    const body = {
      display_name: 'Generated publisher',
      public_key_base64: key().toString('base64'),
    };
    expect((await call(member, 'POST', '', { body, key: randomUUID() })).status).toBe(403);
    expect(
      (
        await call(owner, 'POST', '', {
          body,
          key: randomUUID(),
          origin: 'https://outside.example.invalid',
        })
      ).status,
    ).toBe(403);
    expect((await call(member)).body).toEqual({ items: [] });
  });
  it('honors operator admission and exposes only documented public metadata', async () => {
    const publicKey = key();
    const body = {
      display_name: 'Generated publisher',
      public_key_base64: publicKey.toString('base64'),
    };
    const idempotency = randomUUID();
    const added = await call(owner, 'POST', '', { body, key: idempotency });
    if (!catalogEnabled) {
      expect(added.status).toBe(409);
      expect(added.body.code).toBe('FEATURE_NOT_ENABLED');
      expect((await call(owner)).body).toEqual({ items: [] });
      return;
    }
    expect(added.status).toBe(201);
    const signer = added.body as Signer;
    expect(signer).toMatchObject({
      display_name: body.display_name,
      state: 'active',
      version: 1,
      key_id: createHash('sha256').update(publicKey).digest('hex'),
    });
    expect(added.headers.get('etag')).toBe('"1"');
    expect((await call(owner, 'POST', '', { body, key: idempotency })).body).toEqual(signer);
    expect(
      (
        await call(owner, 'POST', '', {
          body: { ...body, display_name: 'Changed' },
          key: idempotency,
        })
      ).body.code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await call(owner, 'POST', '', { body, key: randomUUID() })).body.code).toBe(
      'SKILL_SIGNER_EXISTS',
    );
    const listed = (await call(member)).body.items;
    expect(listed).toContainEqual(signer);
    expect(JSON.stringify(listed)).not.toContain(body.public_key_base64);
    expect((await call(owner, 'DELETE', `/${signer.id}`)).status).toBe(428);
    expect((await call(owner, 'DELETE', `/${signer.id}`, { version: '"2"' })).status).toBe(409);
    expect((await call(member, 'DELETE', `/${signer.id}`, { version: '"1"' })).status).toBe(403);
    expect((await call(outsider, 'DELETE', `/${signer.id}`, { version: '"1"' })).status).toBe(404);
    expect((await call(owner, 'DELETE', `/${signer.id}`, { version: '"1"' })).status).toBe(204);
    expect((await call(owner, 'DELETE', `/${signer.id}`, { version: '"1"' })).status).toBe(204);
    expect((await call(owner)).body.items).toContainEqual({
      ...signer,
      state: 'revoked',
      version: 2,
      revoked_at: expect.any(String),
    });
    expect((await call(owner, 'POST', '', { body, key: randomUUID() })).body.code).toBe(
      'SKILL_SIGNER_EXISTS',
    );
  });
  it('rejects private keys, noncanonical base64 and undeclared fields without echoing their values', async () => {
    for (const public_key_base64 of [
      '-----BEGIN PRIVATE KEY-----',
      key().toString('base64').replace(/=+$/, ''),
    ]) {
      const result = await call(owner, 'POST', '', {
        body: { display_name: 'Invalid', public_key_base64 },
        key: randomUUID(),
      });
      expect(result.status).toBe(400);
      expect(JSON.stringify(result.body)).not.toContain(public_key_base64);
    }
    const result = await call(owner, 'POST', '', {
      body: {
        display_name: 'Invalid',
        public_key_base64: key().toString('base64'),
        private_key: 'generated-private-marker',
      },
      key: randomUUID(),
    });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).not.toContain('generated-private-marker');
  });
});
