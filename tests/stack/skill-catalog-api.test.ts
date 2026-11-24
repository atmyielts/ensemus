// API-12: a generated declarative package travels through the normal upload and release workflow.
import { createHash, randomUUID } from 'node:crypto';
import { SKILL_BUNDLE_MEDIA_TYPE } from '@ensemus/domain/skill';
import { buildTestBundle, generateTestKey } from '@ensemus/skills/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';

const enabled = process.env.ENSEMUS_SKILL_CATALOG_ENABLED === 'true';

describe('skill catalog and releases (API-12)', () => {
  let owner: Person, admin: Person, member: Person, outsider: Person;
  let organization: string;

  beforeAll(async () => {
    owner = await signUp('Skill publisher');
    organization = await createOrganization(owner, 'Generated skill catalog');
    admin = await join(owner, organization, 'Skill approver', 'admin');
    member = await join(owner, organization, 'Skill reader');
    outsider = await signUp('Skill outsider');
  });

  async function call(
    viewer: Person | null,
    method: 'GET' | 'POST' | 'PATCH',
    suffix: string,
    options: { json?: unknown; bundle?: Buffer; key?: string; version?: number } = {},
  ) {
    const path = `/api/v1/organizations/${organization}/${suffix}`;
    const body = options.bundle ? new Uint8Array(options.bundle) : JSON.stringify(options.json);
    const mediaType = options.bundle ? SKILL_BUNDLE_MEDIA_TYPE : 'application/json';
    const response = await fetch(BASE + path, {
      method,
      headers: {
        ...(viewer ? { cookie: viewer.jar.cookie } : {}),
        ...(method === 'GET' ? {} : { origin: BASE }),
        ...(body === undefined ? {} : { 'content-type': mediaType }),
        ...(options.key ? { 'idempotency-key': options.key } : {}),
        ...(options.version === undefined ? {} : { 'if-match': `"${options.version}"` }),
      },
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    expect(
      contractProblems({ method, path, status: response.status, headers: response.headers, text })
        .problems,
      `${method} ${suffix}`,
    ).toEqual([]);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return { status: response.status, etag: response.headers.get('etag'), body: JSON.parse(text) };
  }

  it('lets members list packages and keeps unauthorized callers out', async () => {
    expect((await call(null, 'GET', 'skill-packages')).status).toBe(401);
    expect((await call(outsider, 'GET', 'skill-packages')).status).toBe(404);
    const listed = await call(member, 'GET', 'skill-packages');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ items: [], next_cursor: null });

    const options = {
      key: randomUUID(),
      json: { name: 'generated-package', display_name: 'Generated package' },
    };
    expect((await call(member, 'POST', 'skill-packages', options)).status).toBe(403);
    if (!enabled) {
      const refused = await call(owner, 'POST', 'skill-packages', options);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('FEATURE_NOT_ENABLED');
    }
  });

  it.runIf(enabled)(
    'uploads a signed bundle, waits for verification, publishes by a second admin and withdraws',
    async () => {
      const name = `catalog-${randomUUID()}`;
      const createOptions = {
        key: randomUUID(),
        json: { name, display_name: 'Generated release package' },
      };
      const created = await call(owner, 'POST', 'skill-packages', createOptions);
      expect(created.status).toBe(201);
      expect(created.etag).toBe('"1"');
      expect(created.body).toMatchObject({ name, origin: 'tenant', state: 'active' });
      expect(await call(owner, 'POST', 'skill-packages', createOptions)).toEqual(created);

      const pkg = `skill-packages/${created.body.id}`;
      expect((await call(member, 'GET', pkg)).body).toEqual(created.body);
      expect((await call(outsider, 'GET', pkg)).status).toBe(404);
      const renamed = await call(owner, 'PATCH', pkg, {
        version: created.body.version,
        json: { display_name: 'Ready for verification' },
      });
      expect(renamed.status).toBe(200);
      expect(renamed.etag).toBe('"2"');
      expect((await call(member, 'GET', 'skill-packages')).body.items).toContainEqual(renamed.body);

      const key = generateTestKey();
      const signer = await call(owner, 'POST', 'skill-signers', {
        key: randomUUID(),
        json: {
          display_name: 'Generated publisher key',
          public_key_base64: key.publicKey.toString('base64'),
        },
      });
      expect(signer.status).toBe(201);
      const { bytes, digest } = buildTestBundle({ name, key });
      const versions = `${pkg}/versions`;
      expect((await call(member, 'POST', versions, { bundle: bytes })).status).toBe(403);

      const uploaded = await call(owner, 'POST', versions, { bundle: bytes });
      expect(uploaded.status).toBe(202);
      expect(uploaded.body).toMatchObject({
        package_id: created.body.id,
        bundle_sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      const replay = await call(owner, 'POST', versions, { bundle: bytes });
      expect(replay.status).toBe(202);
      expect(replay.body.id).toBe(uploaded.body.id);

      const version = `skill-versions/${uploaded.body.id}`;
      await expect
        .poll(async () => (await call(member, 'GET', version)).body.state, {
          timeout: 60_000,
          interval: 500,
        })
        .toBe('verified');

      const verified = await call(member, 'GET', version);
      expect(verified.body).toMatchObject({
        state: 'verified',
        digest,
        execution_kind: 'declarative',
        latest_test: { mode: 'contract', outcome: 'passed', fixtures_passed: 1 },
      });
      expect(await call(member, 'GET', versions)).toMatchObject({
        status: 200,
        body: { items: [verified.body] },
      });
      expect((await call(outsider, 'GET', version)).status).toBe(404);

      const publication = `${version}/publication`;
      const publishOptions = { version: verified.body.version };
      expect((await call(admin, 'POST', publication)).status).toBe(428);
      expect((await call(member, 'POST', publication, publishOptions)).status).toBe(403);
      const selfPublication = await call(owner, 'POST', publication, publishOptions);
      expect(selfPublication.status).toBe(403);
      expect(selfPublication.body.code).toBe('SKILL_PUBLISH_SAME_PERSON');
      const published = await call(admin, 'POST', publication, publishOptions);
      expect(published.status).toBe(200);
      expect(published.body).toMatchObject({
        state: 'published',
        published_at: expect.any(String),
      });

      const withdrawal = await call(owner, 'POST', `${version}/yank`, {
        version: published.body.version,
        json: { code: 'WITHDRAWN_BY_OWNER' },
      });
      expect(withdrawal.status).toBe(200);
      expect(withdrawal.body).toMatchObject({
        state: 'yanked',
        yank_code: 'WITHDRAWN_BY_OWNER',
      });
      expect((await call(member, 'GET', version)).body).toEqual(withdrawal.body);
    },
    90_000,
  );
});
