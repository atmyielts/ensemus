// NEXT-03: these require the integrated Knowledge API and two built web replicas. Not run by builders.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSource } from '@ensemus/application/knowledge/sources';
import { openAppDatabase, resolveTenantContext, type TenantContext } from '@ensemus/database';
import { BASE, createOrganization, onReplica, signUp, visit, type Person } from '../helpers/forms';
import { knowledgeCanary, seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('Knowledge never serves a stale permission result across replicas', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let person: Person;
  let context: TenantContext;
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    person = await signUp(`Knowledge ${randomUUID()}`);
    const org = await createOrganization(person, `Generated ${randomUUID()}`);
    const { rows } = await auth.query<{ id: string }>(
      'select id from identity.users where email=$1',
      [person.email],
    );
    context = await resolveTenantContext(database.db, rows[0]!.id, org);
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  const api = () => `/api/v1/organizations/${context.organizationId}`;
  const pagePayload = async (path: string, mode: 'html' | 'rsc' | 'prefetch') => {
    let target = new URL(path, BASE);
    for (let redirects = 0; redirects < 3; redirects++) {
      const response = await fetch(target, {
        redirect: 'manual',
        headers: {
          cookie: person.jar.cookie,
          'x-ensemus-test-replica': '2',
          ...(mode === 'html' ? {} : { rsc: '1' }),
          ...(mode === 'prefetch' ? { 'next-router-prefetch': '1' } : {}),
        },
      });
      const location = response.headers.get('location');
      if (response.status === 307 && location && /[?&]_rsc\b/.test(location)) {
        target = new URL(location, BASE);
        expect(target.origin).toBe(new URL(BASE).origin);
        continue;
      }
      if (mode !== 'html' && response.status === 200)
        expect(response.headers.get('content-type')).toContain('text/x-component');
      expect(response.headers.get('cache-control')).toContain('no-store');
      return response.text();
    }
    throw new Error('RSC_REDIRECT_LIMIT');
  };
  const postSearch = async (replica: 'web' | 'web-2', word: string) => {
    const response = await fetch(`${BASE}${api()}/knowledge/search`, {
      method: 'POST',
      headers: {
        cookie: person.jar.cookie,
        origin: BASE,
        'content-type': 'application/json',
        ...(replica === 'web-2' ? { 'x-ensemus-test-replica': '2' } : {}),
      },
      body: JSON.stringify({ query: word }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ensemus-served-by')).toBe(replica);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return response.text();
  };
  it('warms the other replica, removes the ACL on the first, and immediately sees no passage or company hit', async () => {
    const word = knowledgeCanary();
    const source = await seedSearchableSource(database.db, context, {
      title: word,
      passages: [word],
      grants: [{ kind: 'membership', membershipId: context.membershipId }],
    });
    expect(await postSearch('web-2', word)).toContain(word);
    const detailPage = `/o/${context.organizationId}/knowledge/sources/${source.sourceId}`;
    expect(await pagePayload(detailPage, 'rsc')).toContain(word);
    const company = `${api()}/search?q=${encodeURIComponent(word)}`;
    const before = await onReplica('web-2', () => visit(company, person.jar));
    expect(before.status).toBe(200);
    expect(before.headers.get('cache-control')).toContain('no-store');
    expect(await before.text()).toContain(word);
    const detail = await getSource(database.db, context, source.sourceId);
    const revoked = await fetch(`${BASE}${api()}/knowledge/sources/${source.sourceId}/grants`, {
      method: 'PATCH',
      headers: {
        cookie: person.jar.cookie,
        origin: BASE,
        'content-type': 'application/json',
        'if-match': '"1"',
      },
      body: JSON.stringify({ add: [], remove_grant_ids: detail.grants.map((grant) => grant.id) }),
    });
    expect(revoked.status).toBe(204);
    expect(revoked.headers.get('x-ensemus-served-by')).toBe('web');
    expect(await postSearch('web-2', word)).not.toContain(word);
    const after = await onReplica('web-2', () => visit(company, person.jar));
    expect(after.status).toBe(200);
    expect(after.headers.get('cache-control')).toContain('no-store');
    expect(await after.text()).not.toContain(word);
    for (const mode of ['html', 'rsc', 'prefetch'] as const)
      for (const page of [
        detailPage,
        `/o/${context.organizationId}/knowledge`,
        `/o/${context.organizationId}/knowledge/facts`,
        `/o/${context.organizationId}/knowledge/answers`,
      ])
        expect(await pagePayload(page, mode)).not.toContain(word);
  });
  it('marks Knowledge pages and source details as no-store on either replica', async () => {
    const source = await seedSearchableSource(database.db, context, {
      passages: [knowledgeCanary()],
      grants: [{ kind: 'organization' }],
    });
    for (const replica of ['web', 'web-2'] as const) {
      for (const path of [
        `/o/${context.organizationId}/knowledge`,
        `/o/${context.organizationId}/knowledge/sources/${source.sourceId}`,
        `${api()}/knowledge/sources/${source.sourceId}`,
      ]) {
        const response = await onReplica(replica, () => visit(path, person.jar));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(response.headers.get('cache-control')).not.toMatch(/(?:s-maxage|max-age)=[1-9]/);
        expect(await response.text()).not.toContain('NOT_IMPLEMENTED');
      }
    }
  });
});
