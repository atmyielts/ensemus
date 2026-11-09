// API-12 coverage for hosted operations no other suite tests: changing plan, buying a top-up, asking to charge an
// invoice, and a customer's decision on a break-glass request. They exist only where billing is on (ADR-032 D1),
// and the last two only where an operator also named a payment processor (D4) and turned break-glass on with a
// limit (D8). So the air-gap gate runs this file in its hosted phase: web, web-2, the worker and the agent-worker
// recreated with ENSEMUS_MODE=cloud, ENSEMUS_BILLING_ENABLED=true, ENSEMUS_PAYMENT_PROCESSOR=test_scripted and
// break-glass on, the same settings it gives this process. compose.test.yaml passes those through to web and web-2
// and compose.yaml names none of them, so no other phase and no deployment has them. On the Sovereign stack this
// file has nothing to test. Every answer is matched against docs/specifications/openapi.yaml before a test reads
// it.
//
// Nothing here has a way out. The processor is the generated test processor's name (tests/helpers/native-payment.ts),
// with no credential, connection or adapter behind it, and the main gate runs no connector worker: a charge waits
// in the connector queue, where nothing takes it. A top-up makes an invoice, and nothing leaves.
import { randomUUID } from 'node:crypto';
import { authorizeBreakGlassAsOperator } from '@ensemus/application/saas/break-glass';
import {
  draftDuePeriodInvoices,
  issueInvoice,
  listInvoices,
} from '@ensemus/application/saas/invoices';
import { listInvoicePayments } from '@ensemus/application/saas/payments';
import { getBillingOverview, startSubscription } from '@ensemus/application/saas/subscriptions';
import { requestBreakGlass } from '@ensemus/application/saas/support-desk';
import { loadSaasConfig } from '@ensemus/config';
import { openAppDatabase, resolveTenantContext, type TenantContext } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { drizzle } from 'drizzle-orm/node-postgres';
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
  // The desk and the operator sign in as their own roles in production (workers/workflow/src/ops-desk.ts). Here
  // the superuser takes each role for its session, so the same application functions run under the same grants.
  const supportClient = new pg.Client({ connectionString: urls.superuser() });
  const operatorClient = new pg.Client({ connectionString: urls.superuser() });
  // What this process was given is what the gate gave web and web-2.
  const saas = loadSaasConfig();

  /** One public API call, held to the spec before a test reads it. */
  async function api(
    person: Person,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Answer> {
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
  const call = (
    person: Person,
    method: string,
    suffix: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => api(person, method, `/api/v1/organizations/${organization}/billing${suffix}`, body, headers);

  async function contextOf(person: Person, company: string): Promise<TenantContext> {
    const user = await auth.query<{ id: string }>('select id from identity.users where email=$1', [
      person.email,
    ]);
    return resolveTenantContext(app.db, user.rows[0]!.id, company);
  }

  beforeAll(async () => {
    // Run on its own, the hosted suites would test a deployment with neither setting and only say so here.
    if (!saas.paymentProcessor || !saas.breakGlass.enabled) {
      throw new Error(
        'HOSTED_SETTINGS_MISSING: run this file through infrastructure/scripts/air-gap-gate.mjs, which names the test processor and turns break-glass on for its hosted phase',
      );
    }
    await auth.connect();
    await supportClient.connect();
    await operatorClient.connect();
    await supportClient.query('set role ensemus_support');
    await operatorClient.query('set role ensemus_operator');
    owner = await signUp('Hosted coverage owner');
    outsider = await signUp('Hosted coverage outsider');
    organization = await createOrganization(owner, 'Hosted coverage account');
    await createOrganization(outsider, 'Hosted coverage other account');
    member = await join(owner, organization, 'Hosted coverage member');
    await seedBillingAccount(app.db, await contextOf(owner, organization));
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
    await supportClient.query('reset role').catch(() => undefined);
    await operatorClient.query('reset role').catch(() => undefined);
    await supportClient.end();
    await operatorClient.end();
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

  it('asks once to charge an open invoice, with the processor the deployment named', async () => {
    // An account of its own, with one issued period invoice: the invoicing worker drafts it at the period's end
    // and issues it once tax is known (zero here), as tests/stack/saas-invoices-api.test.ts does.
    const company = await createOrganization(owner, 'Hosted payment account');
    const context = await contextOf(owner, company);
    const service = createServiceContext(company);
    await seedBillingAccount(app.db, context);
    await startSubscription(app.db, context, first);
    const end = (await getBillingOverview(app.db, context, { billingEnabled: true })).subscription!
      .currentPeriodEnd;
    await draftDuePeriodInvoices(
      app.db,
      service,
      {
        usage: {
          listSince: async () => ({ entries: [], nextCursor: null }),
          sumForPeriod: async () => [],
        },
        agents: {
          haltTenantAgents: async () => undefined,
          releaseTenantAgents: async () => undefined,
        },
      },
      end,
    );
    const invoiceId = (await listInvoices(app.db, context, {})).items[0]!.id;
    await issueInvoice(app.db, service, { invoiceId, tax: { taxMicros: 0n, providerRef: null } });
    const companyMember = await join(owner, company, 'Hosted payment member');
    const pay = (person: Person, key: string, invoice = invoiceId) =>
      api(
        person,
        'POST',
        `/api/v1/organizations/${company}/billing/invoices/${invoice}/payments`,
        undefined,
        { 'idempotency-key': key },
      );

    // Only the account's owner may ask, and nobody else learns the invoice is there.
    for (const person of [companyMember, outsider])
      expect((await pay(person, randomUUID())).status).toBe(404);

    const key = randomUUID();
    const asked = await pay(owner, key);
    expect(asked.status, asked.text).toBe(202);
    expect(asked.json).toEqual({
      payment_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'ready',
    });
    // The same key is the same answer, a new key still finds the live payment, and the key on another request
    // is refused before anything is looked up.
    const replayed = await pay(owner, key);
    expect(replayed.status, replayed.text).toBe(202);
    expect(replayed.json).toEqual(asked.json);
    const fresh = await pay(owner, randomUUID());
    expect(fresh.status, fresh.text).toBe(202);
    expect(fresh.json.payment_id).toBe(asked.json.payment_id);
    const reused = await pay(owner, key, randomUUID());
    expect(reused.status, reused.text).toBe(409);
    expect(reused.json.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // One payment for the invoice, still waiting: no connector worker runs here, so nothing was sent.
    const payments = await listInvoicePayments(app.db, context, { invoiceId });
    expect(payments.map((payment) => [payment.id, payment.status])).toEqual([
      [asked.json.payment_id, 'ready'],
    ]);
  });

  it('records the customer’s side of a break-glass request, and only the owner’s', async () => {
    const desk = drizzle(supportClient, { casing: 'snake_case' }) as unknown as Parameters<
      typeof requestBreakGlass
    >[0];
    const operator = drizzle(operatorClient, {
      casing: 'snake_case',
    }) as unknown as Parameters<typeof authorizeBreakGlassAsOperator>[0];
    const support = (suffix: string) => `/api/v1/organizations/${organization}/support${suffix}`;
    const ticket = await api(owner, 'POST', support('/tickets'), {
      subject: 'Generated break-glass ticket',
      category: 'other',
      body: 'Generated text',
    });
    expect(ticket.status, ticket.text).toBe(201);
    const work = await api(
      owner,
      'POST',
      `/api/v1/organizations/${organization}/work-units`,
      { title: `Break-glass scope ${randomUUID()}`, objective: 'Written by a test' },
      { 'idempotency-key': randomUUID() },
    );
    expect(work.status, work.text).toBe(201);
    const minutes = Math.min(3, saas.breakGlass.enabled ? saas.breakGlass.maxMinutes : 1);
    const file = () =>
      requestBreakGlass(
        desk,
        {
          organizationId: organization,
          ticketId: ticket.json.ticket_id as string,
          requestedBy: 'test-requester@example.invalid',
          reasonCode: 'TEST_DIAGNOSIS',
          scopeType: 'work_unit',
          scopeId: work.json.id as string,
          requestedMinutes: minutes,
        },
        saas.breakGlass,
      );
    const agreed = await file();
    const refused = await file();
    const decide = (person: Person, id: string, decision: string, version?: number) =>
      api(
        person,
        'POST',
        support(`/break-glass/${id}/decision`),
        { decision },
        version === undefined ? {} : { 'if-match': `"${version}"` },
      );

    expect((await decide(owner, agreed.requestId, 'authorize')).status).toBe(428);
    const stale = await decide(owner, agreed.requestId, 'authorize', 7);
    expect(stale.status, stale.text).toBe(409);
    expect(stale.json.code).toBe('VERSION_CONFLICT');
    for (const person of [member, outsider])
      expect((await decide(person, agreed.requestId, 'authorize', 1)).status).toBe(404);

    // One signature is the customer's agreement, not access: it waits for the operator's.
    const signed = await decide(owner, agreed.requestId, 'authorize', 1);
    expect(signed.status, signed.text).toBe(200);
    expect(signed.headers.get('etag')).toBe('"2"');
    expect(signed.json).toMatchObject({
      id: agreed.requestId,
      state: 'requested',
      customer_authorized: true,
      operator_authorized: false,
      expires_at: null,
      version: 2,
    });
    // The operator's signature, from the command line's own role, starts the clock the customer agreed to.
    const authorized = await authorizeBreakGlassAsOperator(
      operator,
      {
        organizationId: organization,
        requestId: agreed.requestId,
        operatorRef: 'test-authorizer@example.invalid',
      },
      saas.breakGlass,
      new Date(),
    );
    expect(authorized.state).toBe('authorized');

    const denied = await decide(owner, refused.requestId, 'deny', 1);
    expect(denied.status, denied.text).toBe(200);
    expect(denied.json).toMatchObject({ id: refused.requestId, state: 'denied', version: 2 });
    // Refusing is final.
    const late = await decide(owner, refused.requestId, 'authorize', 2);
    expect(late.status, late.text).toBe(409);
    expect(late.json.code).toBe('BREAK_GLASS_NOT_AUTHORIZABLE');

    const listed = await api(owner, 'GET', support('/break-glass'));
    expect(listed.status, listed.text).toBe(200);
    const states = Object.fromEntries(
      (listed.json.items as { id: string; state: string; operator_authorized: boolean }[]).map(
        (item) => [item.id, [item.state, item.operator_authorized]],
      ),
    );
    expect(states).toEqual({
      [agreed.requestId]: ['authorized', true],
      [refused.requestId]: ['denied', false],
    });
  });
});
