import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAppDatabase } from '@ensemus/database';
import pg from 'pg';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { repoRoot, urls } from '../helpers/stack';
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

// The air-gap gate's hosted phase names a test processor and turns break-glass on for web and web-2, through
// compose.test.yaml (tests/stack/saas-hosted-coverage.test.ts). That must reach nothing else: compose.yaml names
// neither for any service, and with the settings unset, as on every other phase, job and deployment, the test
// overlay leaves them unset too (an empty value would not do: the config refuses it, and web would not start).
describe('a processor and break-glass are named only where an operator names them (ADR-032 D4, D8)', () => {
  const HOSTED_ONLY = [
    'ENSEMUS_PAYMENT_PROCESSOR',
    'ENSEMUS_BREAK_GLASS_ENABLED',
    'ENSEMUS_BREAK_GLASS_MAX_MINUTES',
  ];
  type Resolved = { services: Record<string, { environment?: Record<string, string | null> }> };
  const resolve = (files: string[], settings: Record<string, string>) => {
    const env: NodeJS.ProcessEnv = { ...process.env, COMPOSE_PROFILES: '', ...settings };
    for (const name of HOSTED_ONLY) if (!(name in settings)) delete env[name];
    return JSON.parse(
      execFileSync(
        'docker',
        ['compose', ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'],
        { cwd: repoRoot, encoding: 'utf8', env },
      ),
    ) as Resolved;
  };
  const named = (config: Resolved) =>
    Object.fromEntries(
      Object.entries(config.services).map(([service, { environment = {} }]) => [
        service,
        HOSTED_ONLY.filter((name) => typeof environment[name] === 'string'),
      ]),
    );
  const none = (config: Resolved) =>
    Object.fromEntries(Object.keys(config.services).map((service) => [service, []]));
  const SHIPPED = ['infrastructure/compose/compose.yaml'];
  const TESTED = [...SHIPPED, 'infrastructure/compose/compose.test.yaml'];
  const GATE = {
    ENSEMUS_PAYMENT_PROCESSOR: 'test_scripted',
    ENSEMUS_BREAK_GLASS_ENABLED: 'true',
    ENSEMUS_BREAK_GLASS_MAX_MINUTES: '5',
  };

  it('compose.yaml names neither, even when the settings are in the shell', () => {
    const shipped = resolve(SHIPPED, GATE);
    expect(named(shipped)).toEqual(none(shipped));
  });
  it('the test overlay leaves them unset unless the gate sets them', () => {
    const tested = resolve(TESTED, {});
    expect(named(tested)).toEqual(none(tested));
  });
  it('and when the gate sets them, only web and web-2 receive them', () => {
    const tested = resolve(TESTED, GATE);
    expect(named(tested)).toEqual({ ...none(tested), web: HOSTED_ONLY, 'web-2': HOSTED_ONLY });
    expect(tested.services.web?.environment?.ENSEMUS_PAYMENT_PROCESSOR).toBe('test_scripted');
  });
});
