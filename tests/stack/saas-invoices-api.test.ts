import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createOrganization, join, signUp, BASE, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';
import { seedBillingAccount, seedPlan, seedRateCard, seedTaxTreatment } from '../helpers/saas';
import { openAppDatabase, resolveTenantContext } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { startSubscription, getBillingOverview } from '@ensemus/application/saas/subscriptions';
import {
  draftDuePeriodInvoices,
  issueInvoice,
  listInvoices,
} from '@ensemus/application/saas/invoices';
import pg from 'pg';
import { urls } from '../helpers/stack';

/**
 * The web tier creates an organization in the deployment's own mode, and a Sovereign organization can
 * never start a subscription (startSubscriptionInTx, ADR-032 D1), so no invoice can exist there. The CI
 * stack runs Sovereign (compose ENSEMUS_MODE default); the invoice facts need a hosted deployment.
 */
const HOSTED_DEPLOYMENT = (process.env.ENSEMUS_MODE ?? 'sovereign') !== 'sovereign';

/**
 * One read of the invoice API, held to docs/specifications/openapi.yaml before a test looks at it (API-12).
 * The air-gap gate runs this file on the Sovereign stack and again on a hosted one, with ENSEMUS_MODE=cloud.
 */
async function readInvoices(person: Person, org: string, path: string) {
  const apiPath = `/api/v1/organizations/${org}/billing/invoices${path}`;
  const response = await fetch(`${BASE}${apiPath}`, { headers: { cookie: person.jar.cookie } });
  const text = await response.text();
  const { problems } = contractProblems({
    method: 'GET',
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

describe.runIf(!HOSTED_DEPLOYMENT)('invoice API on a Sovereign deployment', () => {
  let owner: Person, member: Person, outsider: Person, org: string;
  const database = openAppDatabase(urls.app());
  const auth = new pg.Client({ connectionString: urls.auth() });
  beforeAll(async () => {
    await auth.connect();
    owner = await signUp('Sovereign invoice owner');
    outsider = await signUp('Sovereign invoice outsider');
    org = await createOrganization(owner, 'Sovereign invoice account');
    member = await join(owner, org, 'Sovereign invoice member');
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  const call = (person: Person, path = '') => readInvoices(person, org, path);

  it('refuses to start a subscription, so there is never an invoice to show', async () => {
    const user = await auth.query('select id from identity.users where email=$1', [owner.email]);
    const context = await resolveTenantContext(database.db, user.rows[0].id, org);
    await seedBillingAccount(database.db, context);
    await seedTaxTreatment();
    const plan = await seedPlan({ mode: 'cloud', rateCard: await seedRateCard() });
    await expect(startSubscription(database.db, context, plan)).rejects.toMatchObject({
      code: 'BILLING_NOT_ENABLED',
    });
    const response = await call(owner);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: unknown[] }).items).toEqual([]);
  });
  it('member, outsider and unknown IDs still share the ordinary missing response', async () => {
    for (const person of [member, outsider]) expect((await call(person)).status).toBe(404);
    expect((await call(owner, `/${randomUUID()}`)).status).toBe(404);
  });
});

describe.runIf(HOSTED_DEPLOYMENT)(
  'invoice API exposes exact public facts in every standing',
  () => {
    let owner: Person, member: Person, outsider: Person, org: string, invoiceId: string;
    const database = openAppDatabase(urls.app());
    const auth = new pg.Client({ connectionString: urls.auth() });
    beforeAll(async () => {
      await auth.connect();
      owner = await signUp('Invoice API owner');
      outsider = await signUp('Invoice API outsider');
      org = await createOrganization(owner, 'Invoice API account');
      member = await join(owner, org, 'Invoice API member');
      const user = await auth.query('select id from identity.users where email=$1', [owner.email]);
      const context = await resolveTenantContext(database.db, user.rows[0].id, org);
      const service = createServiceContext(org);
      await seedBillingAccount(database.db, context);
      await seedTaxTreatment();
      const plan = await seedPlan({ mode: 'cloud', rateCard: await seedRateCard() });
      await startSubscription(database.db, context, plan);
      const end = (await getBillingOverview(database.db, context, { billingEnabled: true }))
        .subscription!.currentPeriodEnd;
      await draftDuePeriodInvoices(
        database.db,
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
      invoiceId = (await listInvoices(database.db, context, {})).items[0]!.id;
      await issueInvoice(database.db, service, {
        invoiceId,
        tax: { taxMicros: 0n, providerRef: null },
      });
    });
    afterAll(async () => {
      await auth.end();
      await database.close();
    });
    const call = (person: Person, path = '') => readInvoices(person, org, path);

    it('member, outsider and unknown IDs share the ordinary missing response', async () => {
      for (const person of [member, outsider]) {
        expect((await call(person)).status).toBe(404);
        expect((await call(person, `/${invoiceId}`)).status).toBe(404);
      }
      expect((await call(owner, `/${randomUUID()}`)).status).toBe(404);
    });
    it('the detail contract carries money strings, line facts and a version without processor data', async () => {
      const response = await call(owner, `/${invoiceId}`);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('etag')).toMatch(/^"[1-9]\d*"$/);
      expect(
        contractProblems({
          method: 'GET',
          path: `/organizations/${org}/billing/invoices/${invoiceId}`,
          status: response.status,
          headers: response.headers,
          text,
        }).problems,
      ).toEqual([]);
      const detail = JSON.parse(text);
      expect(typeof detail.total_micros).toBe('string');
      expect(detail.lines.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/processor|customer_ref|billing_email|secret|token/i);
    });
    it('the list is paginated and invalid cursors are refused safely', async () => {
      const response = await call(owner);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(1);
      expect((await call(owner, '?cursor=invalid')).status).toBe(400);
    });
  },
);
