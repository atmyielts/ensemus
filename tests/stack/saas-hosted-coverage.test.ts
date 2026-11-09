// API-12 coverage for hosted billing operations no other suite tests: changing plan and buying a top-up. Both
// exist only where billing is on (ADR-032 D1), so the air-gap gate runs this file in its hosted phase (web,
// web-2, the worker and the agent-worker recreated with ENSEMUS_MODE=cloud and ENSEMUS_BILLING_ENABLED=true,
// the same settings it gives this process). On the Sovereign stack it has nothing to test. Every answer is
// matched against docs/specifications/openapi.yaml before a test reads it. No payment processor is set, so a
// top-up makes an invoice and nothing leaves.
import { randomUUID } from 'node:crypto';
import { openAppDatabase, resolveTenantContext } from '@ensemus/database';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';
import {
  seedBillingAccount,
  seedPlan,
  seedRateCard,
  seedTaxTreatment,
  type SeededPlan,
} from '../helpers/saas';
import { urls } from '../helpers/stack';

const BILLING_DEPLOYMENT =
  (process.env.ENSEMUS_MODE ?? 'sovereign') !== 'sovereign' &&
  process.env.ENSEMUS_BILLING_ENABLED === 'true';

type Answer = { status: number; text: string; json: Record<string, unknown>; headers: Headers };

describe.runIf(BILLING_DEPLOYMENT)('hosted billing operations over HTTP (API-12)', () => {
  let owner: Person, member: Person, outsider: Person, organization: string;
  let first: SeededPlan, second: SeededPlan;
  const app = openAppDatabase(urls.app());
  const auth = new pg.Client({ connectionString: urls.auth() });

  async function call(
    person: Person,
    method: string,
    suffix: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Answer> {
    const path = `/api/v1/organizations/${organization}/billing${suffix}`;
    const response = await fetch(BASE + path, {
      method,
      headers: {
        cookie: person.jar.cookie,
        ...(method === 'GET' ? {} : { origin: BASE }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });
    const text = await response.text();
    expect(
      contractProblems({ method, path, status: response.status, headers: response.headers, text })
        .problems,
      text,
    ).toEqual([]);
    return {
      status: response.status,
      text,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      headers: response.headers,
    };
  }

  beforeAll(async () => {
    await auth.connect();
    owner = await signUp('Hosted coverage owner');
    outsider = await signUp('Hosted coverage outsider');
    organization = await createOrganization(owner, 'Hosted coverage account');
    await createOrganization(outsider, 'Hosted coverage other account');
    member = await join(owner, organization, 'Hosted coverage member');
    const user = await auth.query<{ id: string }>('select id from identity.users where email=$1', [
      owner.email,
    ]);
    const context = await resolveTenantContext(app.db, user.rows[0]!.id, organization);
    await seedBillingAccount(app.db, context);
    await seedTaxTreatment();
    // Two plans on one approved card with a top-up offer, so the second is a plan to change to and both can
    // be topped up (explicit_top_up is seedPlan's default for Cloud).
    const card = await seedRateCard();
    first = await seedPlan({ mode: 'cloud', rateCard: card });
    second = await seedPlan({ mode: 'cloud', rateCard: card });
    const started = await call(
      owner,
      'POST',
      '/subscription',
      { plan_version_id: first.planVersionId },
      { 'idempotency-key': randomUUID() },
    );
    expect(started.status, started.text).toBe(201);
  }, 120_000);
  afterAll(async () => {
    await auth.end();
    await app.close();
  });

  it('changes plan against the version it read, and refuses a stale one', async () => {
    const overview = await call(owner, 'GET', '');
    expect(overview.status, overview.text).toBe(200);
    const subscription = overview.json.subscription as { version: number; plan_version_id: string };
    expect(subscription.plan_version_id).toBe(first.planVersionId);
    const body = { plan_version_id: second.planVersionId };
    const stale = await call(owner, 'PATCH', '/subscription', body, {
      'if-match': `"${subscription.version + 1000}"`,
    });
    expect(stale.status, stale.text).toBe(409);
    expect((await call(owner, 'PATCH', '/subscription', body)).status).toBe(428);
    const changed = await call(owner, 'PATCH', '/subscription', body, {
      'if-match': `"${subscription.version}"`,
    });
    expect(changed.status, changed.text).toBe(200);
    expect(['now', 'period_end']).toContain(changed.json.effective);
    expect(changed.json.excess).toEqual({});
    for (const person of [member, outsider])
      expect(
        (
          await call(person, 'PATCH', '/subscription', body, {
            'if-match': `"${subscription.version + 1}"`,
          })
        ).status,
      ).toBe(404);
  });

  it('buys a top-up once from the offer it was quoted, and refuses a quote that changed', async () => {
    const offers = await call(owner, 'GET', '/top-ups');
    expect(offers.status, offers.text).toBe(200);
    const offer = (offers.json.offers as { offer_id: string; quote_hash: string }[])[0];
    if (!offer) throw new Error('TEST_TOP_UP_OFFER_MISSING');
    const changed = await call(owner, 'POST', '/top-ups', {
      offer_id: offer.offer_id,
      quote_hash: 'f'.repeat(64),
      request_key: `generated-${randomUUID()}`,
    });
    expect(changed.status, changed.text).toBe(409);
    expect(changed.json.code).toBe('QUOTE_CHANGED');
    const request = {
      offer_id: offer.offer_id,
      quote_hash: offer.quote_hash,
      request_key: `generated-${randomUUID()}`,
    };
    const bought = await call(owner, 'POST', '/top-ups', request);
    expect(bought.status, bought.text).toBe(201);
    expect(bought.json.top_up_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(bought.json.invoice_id).toMatch(/^[0-9a-f-]{36}$/);
    // The same request again is the same top-up and the same invoice, not a second charge.
    const again = await call(owner, 'POST', '/top-ups', request);
    expect(again.status, again.text).toBe(201);
    expect(again.json).toEqual(bought.json);
    expect((await call(outsider, 'POST', '/top-ups', request)).status).toBe(404);
  });
});
