// Written for built images with the M8 migrations; does not start its own stack.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganization, signUp, join, BASE, type Person } from '../helpers/forms';
import { seedPlan, seedRateCard } from '../helpers/saas';
import { contractProblems } from '../helpers/openapi';
import pg from 'pg';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { setTenantStandingInTx } from '@ensemus/application/saas/standing';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import { urls } from '../helpers/stack';

/**
 * Billing exists only where the stack runs a hosted mode with billing named on (ADR-032 D1). The air-gap gate
 * runs this file twice: once on the Sovereign stack, and once with web, web-2 and the worker recreated with
 * ENSEMUS_MODE=cloud and ENSEMUS_BILLING_ENABLED=true, the same settings it gives this process.
 */
const BILLING_DEPLOYMENT =
  (process.env.ENSEMUS_MODE ?? 'sovereign') !== 'sovereign' &&
  process.env.ENSEMUS_BILLING_ENABLED === 'true';

describe('billing API keeps account access and tenant boundaries', () => {
  let owner: Person;
  let member: Person;
  let outsider: Person;
  let org: string;
  const sql = new pg.Client({ connectionString: urls.superuser() });
  const app = openAppDatabase(urls.app());
  beforeAll(async () => {
    await sql.connect();
    owner = await signUp('Billing owner');
    outsider = await signUp('Billing outsider');
    org = await createOrganization(owner, 'Billing test');
    member = await join(owner, org, 'Billing member');
  });
  afterAll(async () => {
    await sql.end();
    await app.close();
  });
  /** Every answer is held to docs/specifications/openapi.yaml before a test reads it (API-12). */
  async function call(
    person: Person | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const apiPath = `/api/v1/organizations/${org}/billing${path}`;
    const response = await fetch(`${BASE}${apiPath}`, {
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
    const text = await response.text();
    const { problems } = contractProblems({
      method,
      path: apiPath,
      status: response.status,
      headers: response.headers,
      text,
    });
    expect(problems, text).toEqual([]);
    // The body was read to check it, so the test gets the same answer again, unread.
    return new Response(text === '' ? null : text, {
      status: response.status,
      headers: response.headers,
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
    expect(overview.status).toBe(200);
    const text = await overview.text();
    expect(text).not.toMatch(/customer_ref|processor|token|secret/i);
  });
  // ADR-032 D1: a Sovereign deployment can never enable billing (loadSaasConfig refuses it), and the
  // CI stack runs Sovereign (compose ENSEMUS_MODE default). Starting a subscription is then refused
  // as BILLING_NOT_ENABLED and creates nothing; the concurrency contract needs a billing deployment.
  it.runIf(!BILLING_DEPLOYMENT)(
    'refuses every subscription start on a deployment without billing, and creates none',
    async () => {
      const plan = await seedPlan({ mode: 'cloud', rateCard: await seedRateCard() });
      const headers = { 'idempotency-key': randomUUID() };
      const body = { plan_version_id: plan.planVersionId };
      const responses = await Promise.all([
        call(owner, 'POST', '/subscription', body, headers),
        call(owner, 'POST', '/subscription', body, headers),
      ]);
      expect(responses.map((r) => r.status)).toEqual([409, 409]);
      for (const response of responses)
        expect(((await response.json()) as { code?: string }).code).toBe('BILLING_NOT_ENABLED');
      const { rows } = await sql.query(
        'select count(*)::int as n from billing.subscriptions where organization_id=$1',
        [org],
      );
      expect(rows[0].n).toBe(0);
    },
  );
  it.runIf(BILLING_DEPLOYMENT)(
    'concurrent subscription retries start exactly one and a changed payload conflicts',
    async () => {
      const plan = await seedPlan({ mode: 'cloud', rateCard: await seedRateCard() });
      // The approved plan is what a hosted owner is offered, and someone outside the organization sees nothing.
      const plans = await call(owner, 'GET', '/plans');
      expect(plans.status).toBe(200);
      expect(
        ((await plans.json()) as { items: { plan_version_id: string }[] }).items.map(
          (item) => item.plan_version_id,
        ),
      ).toContain(plan.planVersionId);
      expect((await call(outsider, 'GET', '/plans')).status).toBe(404);
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
    },
  );
  it('suspension preserves account read while ordinary writes are refused', async () => {
    // The operator's own path (ops-tenant): the standing row, the lifecycle and the agent stop in one
    // service transaction, as 0511 requires. A raw superuser INSERT has no native standing birth.
    const service = createServiceContext(org);
    await withTenantTx(app.db, service, (tx) =>
      setTenantStandingInTx(
        tx,
        service,
        {
          to: 'suspended',
          reasonCode: 'TEST_TERMS',
          actor: { type: 'operator', ref: 'test-operator@example.invalid' },
        },
        createStandingAgentHaltPort(),
      ),
    );
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
