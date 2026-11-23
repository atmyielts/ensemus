import { updateSecurityPolicy } from '@ensemus/application/security-policy';
// Real connection admission through the production HTTP handler. No provider contact.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAppDatabase, connections, withTenantTx } from '@ensemus/database';
import { eq } from 'drizzle-orm';
import { BASE, signUp, createOrganization, join, type Person } from '../helpers/forms';
import { nativePersonContext, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';
import { contractProblems } from '../helpers/openapi';
const offered = (process.env.ENSEMUS_TEST_BUSINESS_CONNECTORS ?? '').split(',').filter(Boolean);
const enabled = process.env.ENSEMUS_CONNECTORS_ENABLED === 'true';
const types = ['crm_http', 'ticketing_http', 'accounting_http'] as const;
describe('customer business connection setup', () => {
  const web = openAppDatabase(urls.app());
  let owner: Person, member: Person, foreign: Person, org: string;
  let context: Awaited<ReturnType<typeof nativePersonContext>>;
  const token = 'GENERATED-SETUP-CREDENTIAL-' + randomUUID();
  const path = () => `/api/v1/organizations/${org}/connections`;
  const identity = async (person: Person) => {
    const value = (await (
      await fetch(BASE + '/api/auth/get-session', { headers: { cookie: person.jar.cookie } })
    ).json()) as { user: { id: string }; session: { id: string } };
    return { userId: value.user.id, sessionId: value.session.id };
  };
  beforeAll(async () => {
    owner = await signUp('Generated connector administrator');
    org = await createOrganization(owner, 'Generated business setup');
    member = await join(owner, org, 'Generated setup member');
    foreign = await signUp('Generated foreign setup owner');
    await createOrganization(foreign, 'Generated other company');
    const who = await identity(owner);
    await proveSecondFactor(who);
    context = await nativePersonContext(web.db, who, org);
  });
  afterAll(() => web.close());
  async function call(person: Person, body: unknown, key = randomUUID()) {
    const response = await fetch(BASE + path(), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: person.jar.cookie,
        origin: BASE,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    expect(
      contractProblems({
        method: 'POST',
        path: path(),
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    expect(text).not.toContain(token);
    return {
      status: response.status,
      json: JSON.parse(text) as { id?: string; code?: string; has_credential?: boolean },
    };
  }
  const body = (type: string) => ({
    connector_type: type,
    display_name: 'Generated API setup',
    credential: token,
    config: {
      tlsServerName: 'adapter.example.invalid',
      streams: [
        type === 'crm_http'
          ? 'crm.accounts'
          : type === 'ticketing_http'
            ? 'ticketing.tickets'
            : 'accounting.invoices',
      ],
      scopes: [type + '.read'],
    },
  });
  for (const type of types)
    it.runIf(!offered.includes(type))(
      `refuses ${type} unless the operator offered it`,
      async () => {
        const result = await call(owner, body(type));
        expect(result.status).toBe(enabled ? 400 : 503);
        expect(result.json.code).toBe(enabled ? 'INVALID_INPUT' : 'CONNECTOR_NOT_AVAILABLE');
      },
    );
  for (const type of types)
    it.runIf(offered.includes(type))(
      `creates ${type} once with its exact read-only ceiling and seals the credential`,
      async () => {
        const key = randomUUID(),
          request = body(type),
          first = await call(owner, request, key),
          again = await call(owner, request, key);
        expect(first.status).toBe(201);
        expect(again.json).toEqual(first.json);
        expect(first.json.has_credential).toBe(true);
        const rows = await withTenantTx(web.db, context, (tx) =>
          tx
            .select({ scopes: connections.grantedScopes, config: connections.config })
            .from(connections)
            .where(eq(connections.id, first.json.id!)),
        );
        expect(rows).toEqual([{ scopes: [type + '.read'], config: request.config }]);
      },
    );
  it.runIf(offered.includes('crm_http'))(
    'requires authorization and MFA and rejects arbitrary targets or cross-kind scope claims',
    async () => {
      expect((await call(member, body('crm_http'))).json.code).toBe('FORBIDDEN');
      expect((await call(foreign, body('crm_http'))).status).toBe(404);
      for (const config of [
        { ...body('crm_http').config, host: '169.254.169.254' },
        { ...body('crm_http').config, scopes: ['crm_http.read', 'accounting_http.write'] },
      ])
        expect((await call(owner, { ...body('crm_http'), config })).json.code).toBe(
          'INVALID_INPUT',
        );
      const unproved = await signUp('Generated unproved administrator');
      const unprovedOrg = await createOrganization(unproved, 'Generated MFA setup');
      const who = await identity(unproved);
      await proveSecondFactor(who);
      const native = await nativePersonContext(web.db, who, unprovedOrg);
      await updateSecurityPolicy(
        web.db,
        native,
        { sessionId: who.sessionId },
        {
          expectedVersion: 1,
          mfaForAdministration: true,
          mfaMaxAgeSeconds: 900,
          ssoEnforcement: 'optional',
        },
      );
      await proveSecondFactor(who, new Date(Date.now() - 3600000));
      const response = await fetch(BASE + `/api/v1/organizations/${unprovedOrg}/connections`, {
        method: 'POST',
        headers: {
          cookie: unproved.jar.cookie,
          origin: BASE,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify(body('crm_http')),
      });
      expect(((await response.json()) as { code: string }).code).toBe('MFA_REQUIRED');
    },
  );
});
