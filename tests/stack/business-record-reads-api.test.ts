// Actual production web reads with generated source records and native database-role fixtures.
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  openAppDatabase,
  withTenantTx,
  externalResources,
  externalResourceAcl,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { applyBusinessRecordPage } from '@ensemus/application';
import { canonicalJson } from '@ensemus/domain/approval';
import { eq } from 'drizzle-orm';
import { BASE, signUp, createOrganization, join, read, type Person } from '../helpers/forms';
import { nativePersonContext, proveSecondFactor } from '../helpers/product';
import { seedConnection } from '../helpers/integrations';
import { urls } from '../helpers/stack';
import { contractProblems } from '../helpers/openapi';

describe('business records through the actual read routes', () => {
  let web: ReturnType<typeof openAppDatabase>,
    connector: ReturnType<typeof openAppDatabase>,
    owner: Person,
    member: Person,
    outsider: Person;
  let organization: string, connectionId: string, recordId: string, resourceId: string;
  let ctx: Awaited<ReturnType<typeof nativePersonContext>>;
  const canary = 'GENERATED-SOURCE-' + randomUUID();
  beforeAll(async () => {
    web = openAppDatabase(urls.app());
    connector = openAppDatabase(urls.connector());
    owner = await signUp('Generated source owner');
    outsider = await signUp('Generated source outsider');
    organization = await createOrganization(owner, 'Generated source records company');
    member = await join(owner, organization, 'Generated source reader');
    const identity = async (person: Person) => {
      const s = (await (
        await fetch(`${BASE}/api/auth/get-session`, { headers: { cookie: person.jar.cookie } })
      ).json()) as { user: { id: string }; session: { id: string } };
      return { userId: s.user.id, sessionId: s.session.id };
    };
    const author = await identity(owner);
    await proveSecondFactor(author);
    ctx = await nativePersonContext(web.db, author, organization);
    const viewer = await nativePersonContext(web.db, await identity(member), organization);
    connectionId = await seedConnection(web.db, ctx, {
      connectorType: 'crm_http',
      displayName: 'Generated CRM source',
      config: { streams: ['crm.accounts'], scopes: ['crm_http.read'] },
      grantedScopes: ['crm_http.read'],
    });
    const fields = { name: canary, status: 'open' },
      sha = createHash('sha256').update(canonicalJson(fields)).digest('hex');
    await applyBusinessRecordPage(connector.db, createServiceContext(organization), {
      connectionId,
      connectorType: 'crm_http',
      stream: 'crm.accounts',
      records: [
        {
          externalId: 'generated-api-account',
          externalVersion: '1',
          displayName: canary,
          fields,
          fieldsSha256: sha,
          classification: 'internal',
        },
      ],
      deletedExternalIds: [],
    });
    await withTenantTx(connector.db, createServiceContext(organization), async (tx) => {
      const [r] = await tx
        .insert(externalResources)
        .values({
          organizationId: organization,
          connectionId,
          stream: 'crm.accounts',
          resourceType: 'crm.accounts',
          externalId: 'generated-api-account',
          externalVersion: '1',
          contentSha256: sha,
          classification: 'internal',
          aclState: 'mapped',
        })
        .returning();
      resourceId = r!.id;
      await tx.insert(externalResourceAcl).values({
        organizationId: organization,
        resourceId,
        principalKind: 'user',
        principalExternalId: 'generated-reader',
        access: 'read',
        membershipId: viewer.membershipId,
      });
    });
  });
  afterAll(async () => {
    await web?.close();
    await connector?.close();
  });
  const path = () => `/api/v1/organizations/${organization}/business-records`;
  async function get(person: Person | undefined, suffix = '') {
    const response = await fetch(BASE + path() + suffix, {
        headers: person ? { cookie: person.jar.cookie } : {},
      }),
      text = await response.text();
    expect(
      contractProblems({
        method: 'GET',
        path: path() + suffix,
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return {
      status: response.status,
      body: JSON.parse(text) as {
        items?: { id: string; fields: unknown }[];
        fields?: unknown;
        code?: string;
      },
      text,
    };
  }
  it('refuses anonymous and foreign requests and returns no records to an ungranted administrator', async () => {
    expect((await get(undefined)).status).toBe(401);
    expect((await get(outsider)).status).toBe(404);
    const ungranted = await get(owner);
    expect(ungranted.body.items).toEqual([]);
    expect(ungranted.text).not.toContain(canary);
    const result = await get(member);
    expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(1);
    recordId = result.body.items![0]!.id;
    expect(result.text).toContain(canary);
    expect((await get(owner, '/' + recordId)).status).toBe(404);
    expect((await get(member, '/' + recordId)).status).toBe(200);
    expect((await get(member, '?cursor=broken')).status).toBe(400);
    expect((await get(member, '?connection_id=broken')).status).toBe(400);
  });
  it('renders a source snapshot without an edit effect, and removes it immediately when the real source grant goes', async () => {
    const record = await read(`/o/${organization}/records/${recordId}`, member.jar);
    expect(record.status).toBe(200);
    expect(record.html).toContain(canary);
    expect(record.html).toContain('Last read from the source');
    expect(record.html).toContain('Generated CRM source');
    expect((await read(`/o/${organization}/records/${recordId}`, owner.jar)).status).toBe(404);
    const listing = await read(`/o/${organization}/records?stream=crm.accounts`, member.jar);
    expect(listing.status).toBe(200);
    expect(listing.html).toContain(canary);
    await withTenantTx(connector.db, createServiceContext(organization), (tx) =>
      tx.delete(externalResourceAcl).where(eq(externalResourceAcl.resourceId, resourceId)),
    );
    expect((await get(member, '/' + recordId)).status).toBe(404);
    expect((await get(member)).body.items).toEqual([]);
    expect((await read(`/o/${organization}/records/${recordId}`, member.jar)).status).toBe(404);
  });
});
