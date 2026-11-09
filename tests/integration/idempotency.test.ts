// API-12: Idempotency-Key against real roles, real RLS and real concurrency.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  createInvitation,
  acceptInvitation,
  createWorkUnit,
  listWorkUnits,
  requestHash,
  runIdempotent,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { urls } from '../helpers/stack';

describe('idempotency keys', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  const db = () => app.db;

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

  async function newOrg() {
    const user = await makeUser('owner');
    const { organizationId } = await createOrganization(db(), {
      userId: user.id,
      name: 'org',
      commercialMode: 'byom',
    });
    return resolveTenantContext(db(), user.id, organizationId);
  }

  async function join(context: TenantContext) {
    const user = await makeUser('member');
    const { token } = await createInvitation(db(), context, { email: user.email, role: 'member' });
    await auth.query('update identity.users set email_verified=true where id=$1', [user.id]);
    await acceptInvitation(db(), {
      token,
      userId: user.id,
      email: user.email,
      emailVerified: true,
    });
    return resolveTenantContext(db(), user.id, context.organizationId);
  }

  const create = (context: TenantContext, key: string, title = 'One') =>
    runIdempotent(
      db(),
      context,
      { key, requestHash: requestHash(['test', title]) },
      (joined: AppDatabase) => createWorkUnit(joined, context, { title }),
      (row) => ({ status: 201, body: { id: row.id, title: row.title } }),
    );

  const count = async (context: TenantContext) => (await listWorkUnits(db(), context)).items.length;

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });

  afterAll(async () => {
    await app?.close();
    await auth?.end();
  });

  it('replays the stored response and creates one Work Unit', async () => {
    const org = await newOrg();
    const key = randomUUID();
    const first = await create(org, key);
    const second = await create(org, key);
    expect(first.kind).toBe('fresh');
    expect(second.kind).toBe('replayed');
    if (first.kind === 'conflict' || second.kind === 'conflict') throw new Error('unexpected');
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(await count(org)).toBe(1);
  });

  it('refuses the same key with a different request, and does nothing', async () => {
    const org = await newOrg();
    const key = randomUUID();
    await create(org, key, 'One');
    expect(await create(org, key, 'Two')).toEqual({ kind: 'conflict' });
    expect(await count(org)).toBe(1);
  });

  it('creates once when requests race on one key', async () => {
    const org = await newOrg();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => create(org, key)));
    const bodies = results.map((r) => (r.kind === 'conflict' ? null : r.body));
    expect(results.filter((r) => r.kind === 'fresh')).toHaveLength(1);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(await count(org)).toBe(1);
  });

  it('stores nothing when the work fails, so the key can be used again', async () => {
    const org = await newOrg();
    const key = randomUUID();
    await expect(
      runIdempotent(
        db(),
        org,
        { key, requestHash: requestHash(['test', 'One']) },
        (joined) =>
          // The service's transaction fails, and the key row must roll back with it.
          joined.transaction({ 'app.organization_id': org.organizationId }, async () => {
            throw new AppError('INVALID_STATE');
          }),
        () => ({ status: 201, body: {} }),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect((await create(org, key)).kind).toBe('fresh');
  });

  it('keeps keys apart between people and between tenants', async () => {
    const org = await newOrg();
    const other = await newOrg();
    const member = await join(org);
    const key = randomUUID();
    expect((await create(org, key)).kind).toBe('fresh');
    expect((await create(member, key)).kind).toBe('fresh');
    expect((await create(other, key)).kind).toBe('fresh');
    expect(await count(org)).toBe(2);
    expect(await count(other)).toBe(1);
  });

  it('refuses a key of the wrong length', async () => {
    const org = await newOrg();
    await expect(create(org, 'short')).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    await expect(create(org, 'k'.repeat(129))).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });
});
