import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAppDatabase } from '@ensemus/database';
import pg from 'pg';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { urls } from '../helpers/stack';
import { seedTaxTreatment } from '../helpers/saas';
import { paymentFixture } from '../integration/saas-payment-fixture';

describe('payment API preserves account authority and the unconfigured deployment state', () => {
  let owner: Person, member: Person, outsider: Person, org: string;
  const database = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() });
  beforeAll(async () => {
    await auth.connect();
    owner = await signUp('Payment API owner');
    outsider = await signUp('Payment API outsider');
    org = await createOrganization(owner, 'Payment API account');
    member = await join(owner, org, 'Payment API member');
    await seedTaxTreatment();
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  function post(
    person: Person,
    organizationId = org,
    invoiceId: string = randomUUID(),
    origin = BASE,
  ) {
    return fetch(
      `${BASE}/api/v1/organizations/${organizationId}/billing/invoices/${invoiceId}/payments`,
      {
        method: 'POST',
        headers: { cookie: person.jar.cookie, origin, 'idempotency-key': randomUUID() },
      },
    );
  }
  it('a member or outsider cannot discover billing or request a charge', async () => {
    for (const person of [member, outsider]) expect((await post(person)).status).toBe(404);
  });
  it('cross-origin writes are refused before an intent can be written', async () => {
    expect((await post(owner, org, randomUUID(), 'https://test.invalid')).status).toBe(403);
  });
  it('the deployment has no selected processor, and an exact refusal contains no customer data', async () => {
    const response = await post(owner);
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toMatch(/BILLING_NOT_ENABLED|PAYMENT_PROCESSOR_NOT_CONFIGURED/);
    expect(body).not.toContain(owner.email);
    // The role-backed fixture also verifies this endpoint cannot reach another account's invoice.
    const other = await paymentFixture(database.db, auth);
    expect((await post(outsider, other.owner.organizationId, other.invoice.id)).status).toBe(404);
  });
});
