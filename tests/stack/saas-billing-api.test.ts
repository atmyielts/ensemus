// Written for built images with the M8 migrations; does not start its own stack.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganization, signUp, join, BASE, type Person } from '../helpers/forms';
import { seedPlan, seedRateCard } from '../helpers/saas';
import { contractProblems } from '../helpers/openapi';
import pg from 'pg';
import { urls } from '../helpers/stack';

describe('billing API keeps account access and tenant boundaries', () => {
  let owner: Person;
  let member: Person;
  let outsider: Person;
  let org: string;
  const sql = new pg.Client({ connectionString: urls.superuser() });
  beforeAll(async () => {
    await sql.connect();
    owner = await signUp('Billing owner');
    outsider = await signUp('Billing outsider');
    org = await createOrganization(owner, 'Billing test');
    member = await join(owner, org, 'Billing member');
  });
  afterAll(async () => {
    await sql.end();
  });
  async function call(
    person: Person | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${BASE}/api/v1/organizations/${org}/billing${path}`, {
      method,
      headers: {
        ...(person ? { cookie: person.jar.cookie } : {}),
        ...(method === 'GET'
          ? {}
          : { origin: new URL(BASE).origin, 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });
  }
  it('anonymous, member and outsider cannot read billing', async () => {
    expect((await call(null, 'GET', '')).status).toBe(401);
    for (const person of [member, outsider])
      expect((await call(person, 'GET', '')).status).toBe(404);
  });
  it('account create/update honor If-Match and expose only the public schema', async () => {
    const account = {
      billing_name: 'Test payer',
      billing_email: 'billing@example.invalid',
      country_code: 'XX',
      region_code: '',
      postal_code: null,
      tax_id: null,
    };
    const created = await call(owner, 'PUT', '/account', account);
    expect(created.status).toBe(200);
    expect(created.headers.get('etag')).toBe('"1"');
    expect((await call(owner, 'PUT', '/account', account)).status).toBe(409);
    expect((await call(owner, 'PUT', '/account', account, { 'if-match': '"1"' })).status).toBe(200);
    const overview = await call(owner, 'GET', '');
    const text = await overview.text();
    expect(
      contractProblems({
        method: 'GET',
        path: `/organizations/${org}/billing`,
        status: overview.status,
        headers: overview.headers,
        text,
      }).problems,
    ).toEqual([]);
    expect(text).not.toMatch(/customer_ref|processor|token|secret/i);
  });
  it('concurrent subscription retries start exactly one and a changed payload conflicts', async () => {
    const plan = await seedPlan({ mode: 'cloud', rateCard: await seedRateCard() });
    const headers = { 'idempotency-key': randomUUID() };
    const body = { plan_version_id: plan.planVersionId };
    const responses = await Promise.all([
      call(owner, 'POST', '/subscription', body, headers),
      call(owner, 'POST', '/subscription', body, headers),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    expect(
      (await call(owner, 'POST', '/subscription', { plan_version_id: randomUUID() }, headers))
        .status,
    ).toBe(409);
    const { rows } = await sql.query(
      'select count(*)::int as n from billing.subscriptions where organization_id=$1',
      [org],
    );
    expect(rows[0].n).toBe(1);
  });
  it('suspension preserves account read while ordinary writes are refused', async () => {
    await sql.query('begin');
    try {
      await sql.query(
        "insert into billing.standing_changes(organization_id,from_lifecycle,to_lifecycle,reason_code,actor_type,actor_ref) values ($1,'active','suspended','TEST_TERMS','operator','test-operator')",
        [org],
      );
      await sql.query("update org.organizations set lifecycle='suspended' where id=$1", [org]);
      await sql.query('commit');
    } catch (error) {
      await sql.query('rollback');
      throw error;
    }
    expect((await call(owner, 'GET', '')).status).toBe(200);
    const refused = await fetch(`${BASE}/api/v1/organizations/${org}/work-units`, {
      method: 'POST',
      headers: {
        cookie: owner.jar.cookie,
        origin: new URL(BASE).origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Refused', objective: 'Must stay unchanged' }),
    });
    expect(refused.status).toBe(403);
  });
});
