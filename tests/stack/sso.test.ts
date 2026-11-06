import { describe, expect, it } from 'vitest';
import { BASE, assembled, read, remember, submit, visit } from '../helpers/forms';
import { ssoStackFixture } from '../helpers/sso-stack-fixture';
import { tamperSaml } from '../helpers/saml-idp';

describe('SAML and SCIM through actual built HTTP routes', () => {
  it('uses a real signed browser-carried assertion and refuses its replay without another session', async () => {
    const f = await ssoStackFixture(),
      flow = await f.signIn(),
      signed = await f.idp.response(flow.url, f.spMetadata, f.member.email);
    const send = () =>
      fetch(`${BASE}/api/auth/sso/saml2/sp/acs/${f.connection.provider_id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: flow.jar.cookie,
          origin: 'https://generated-idp.example.invalid',
        },
        body: new URLSearchParams({
          SAMLResponse: signed.SAMLResponse,
          RelayState: signed.RelayState,
        }),
        redirect: 'manual',
      });
    const response = await send();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).not.toContain('error=');
    remember(flow.jar, response);
    expect((await read('/sso/complete', flow.jar)).location).toBe(`/o/${f.organization}`);
    expect((await read(`/o/${f.organization}`, flow.jar)).status).toBe(200);
    const replay = await send();
    expect(replay.headers.get('set-cookie') ?? '').not.toContain('session_token=');
    expect(replay.status >= 400 || (replay.headers.get('location') ?? '').includes('error=')).toBe(
      true,
    );
  });
  it('keeps signed-but-tampered, unsigned and requestless assertions out through the actual proxy', async () => {
    const f = await ssoStackFixture();
    for (const kind of ['tampered', 'unsigned', 'requestless'] as const) {
      const flow = await f.signIn(),
        signed = await f.idp.response(flow.url, f.spMetadata, f.member.email, {
          ...(kind === 'unsigned' ? { unsigned: true } : {}),
          ...(kind === 'requestless' ? { noInResponseTo: true } : {}),
        });
      if (kind === 'tampered')
        signed.SAMLResponse = tamperSaml(signed.SAMLResponse, (xml) =>
          xml.replace(f.member.email, 'outsider@outside.invalid'),
        );
      const response = await fetch(
        `${BASE}/api/auth/sso/saml2/sp/acs/${f.connection.provider_id}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: flow.jar.cookie },
          body: new URLSearchParams({
            SAMLResponse: signed.SAMLResponse,
            RelayState: signed.RelayState,
          }),
          redirect: 'manual',
        },
      );
      expect(response.headers.get('set-cookie') ?? '').not.toContain('session_token=');
      expect(
        response.status >= 400 || (response.headers.get('location') ?? '').includes('error='),
      ).toBe(true);
    }
  });
  it('shows a provisioning token once, scopes deprovisioning to its company, and returns the same401 for absent/unknown/revoked tokens', async () => {
    const f = await ssoStackFixture(),
      flow = await f.signIn(),
      signed = await f.idp.response(flow.url, f.spMetadata, f.member.email),
      response = await fetch(`${BASE}/api/auth/sso/saml2/sp/acs/${f.connection.provider_id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: flow.jar.cookie },
        body: new URLSearchParams({
          SAMLResponse: signed.SAMLResponse,
          RelayState: signed.RelayState,
        }),
        redirect: 'manual',
      });
    remember(flow.jar, response);
    const issued = await submit(f.path, f.owner.jar, /Create provisioning token/);
    expect(issued.status).toBe(200);
    expect(issued.headers.get('cache-control')).toContain('no-store');
    const html = assembled(await issued.text()),
      token = /ens_scim_[A-Za-z0-9_-]{43}/.exec(html)?.[0];
    expect(token).toBeTruthy();
    expect((await read(f.path, f.owner.jar)).html).not.toContain(token!);
    const scim = (method: string, suffix = '', body?: unknown, credential = token) =>
      fetch(`${BASE}/api/scim/v2/Users${suffix}`, {
        method,
        headers: {
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          'content-type': 'application/scim+json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
      });
    const absent = await scim('GET', '', undefined, ''),
      unknown = await scim('GET', '', undefined, `ens_scim_${'x'.repeat(43)}`);
    expect(absent.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await absent.json()).toEqual(await unknown.json());
    const listed = await scim('GET');
    expect(listed.status).toBe(200);
    const users = (await listed.json()) as { Resources: { id: string; active: boolean }[] };
    expect(users.Resources).toHaveLength(1);
    const id = users.Resources[0]!.id;
    expect((await scim('POST', '', {})).status).toBe(501);
    expect(
      (
        await scim('PATCH', `/${id}`, {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'roles', value: ['owner'] }],
        })
      ).status,
    ).toBe(501);
    expect((await scim('DELETE', `/${id}`)).status).toBe(204);
    expect((await read(`/o/${f.organization}`, flow.jar)).status).toBe(404);
    const revoked = await submit(f.path, f.owner.jar, /Revoke token/);
    expect(revoked.status).toBe(303);
    const denied = await scim('GET');
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
      detail: 'A current provisioning token is required.',
    });
  });
  it('requires tenant SSO on the next request while owners retain recovery and public provider mutations stay closed', async () => {
    const f = await ssoStackFixture();
    await f.requireSso();
    expect((await read(`/o/${f.organization}`, f.member.jar)).location).toBe('/sign-in/sso');
    expect((await read(f.path, f.owner.jar)).status).toBe(200);
    for (const path of [
      '/sso/register',
      '/sso/update-provider',
      '/sso/delete-provider',
      '/sso/request-domain-verification',
      '/sso/verify-domain',
    ]) {
      const response = await fetch(`${BASE}/api/auth${path}`, {
        method: 'POST',
        headers: { cookie: f.owner.jar.cookie, origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: f.connection.provider_id }),
      });
      expect(response.status, path).toBe(404);
    }
    const disabled = await submit(f.path, f.owner.jar, /Save connection/, {
      displayName: 'Generated company identity provider',
      state: 'disabled',
    });
    expect(disabled.status).toBe(303);
    expect((await visit(`/o/${f.organization}`, f.member.jar)).status).toBe(200);
  });
});
