// API-12 coverage for company sign-in administration over HTTP: a connection made and re-pointed through the
// public API, and a SCIM token issued, listed and revoked. ssoStackFixture enrols a real authenticator for the
// owner (the 'always' MFA tier these need, 0404) and activates its connection through the same API. Every
// answer is matched against the spec by contractProblems, and a stranger gets the ordinary missing answer.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';
import { ssoStackFixture } from '../helpers/sso-stack-fixture';

describe('company sign-in administration over HTTP (API-12)', () => {
  let fixture: Awaited<ReturnType<typeof ssoStackFixture>>, outsider: Person;

  async function call(
    person: Person,
    method: string,
    suffix: string,
    body?: unknown,
    ifMatch?: string,
  ) {
    const path = `${fixture.api}${suffix}`;
    const response = await fetch(BASE + path, {
      method,
      headers: {
        cookie: person.jar.cookie,
        ...(method === 'GET' ? {} : { origin: BASE }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(ifMatch ? { 'if-match': ifMatch } : {}),
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
    expect(response.headers.get('cache-control')).toContain('no-store');
    return {
      status: response.status,
      text,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      headers: response.headers,
    };
  }

  beforeAll(async () => {
    fixture = await ssoStackFixture();
    outsider = await signUp('SSO coverage outsider');
    await createOrganization(outsider, 'Generated other SSO company');
  }, 180_000);

  it('reads a connection, makes another, and re-points it at new provider metadata', async () => {
    const one = await call(fixture.owner, 'GET', `/${fixture.connection.id}`);
    expect(one.status, one.text).toBe(200);
    const domain = `generated-${randomUUID()}.example.invalid`;
    const created = await call(fixture.owner, 'POST', '', {
      display_name: 'Generated second identity provider',
      domain,
      idp_metadata_xml: fixture.idp.metadata,
    });
    expect(created.status, created.text).toBe(201);
    expect(created.json.domain).toBe(domain);
    const repointed = await call(
      fixture.owner,
      'PUT',
      `/${String(created.json.id)}/metadata`,
      { idp_metadata_xml: fixture.idp.metadata },
      `"${String(created.json.version)}"`,
    );
    expect(repointed.status, repointed.text).toBe(200);
    expect((await call(outsider, 'GET', `/${fixture.connection.id}`)).status).toBe(404);
  });

  it('issues a SCIM token once, lists it without its secret, and revokes it', async () => {
    const tokens = `/${fixture.connection.id}/scim-tokens`;
    const issued = await call(fixture.owner, 'POST', tokens, {});
    expect(issued.status, issued.text).toBe(201);
    const id = String(issued.json.token_id);
    const listed = await call(fixture.owner, 'GET', tokens);
    expect(listed.status, listed.text).toBe(200);
    expect((listed.json.items as { id: string }[]).map((item) => item.id)).toContain(id);
    // The secret is shown once, at issue, and never again.
    expect(listed.text).not.toContain(String(issued.json.token));
    const revoked = await call(fixture.owner, 'DELETE', `${tokens}/${id}`);
    expect(revoked.status, revoked.text).toBe(204);
    const after = await call(fixture.owner, 'GET', tokens);
    expect(
      (after.json.items as { id: string; state: string }[]).find((item) => item.id === id)?.state ??
        'gone',
    ).not.toBe('active');
    expect((await call(outsider, 'GET', tokens)).status).toBe(404);
  });
});
