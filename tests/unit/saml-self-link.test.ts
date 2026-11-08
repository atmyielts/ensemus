// Protocol doubles only. They cannot qualify native Account/session rollback or SQL authority.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSamlBrowserFlow } from '../../packages/auth/src/saml-browser-flow';
import {
  issueSamlBrowserProof,
  parseSamlIntent,
  readSamlBrowserProof,
  samlHash,
  samlIntentBinding,
  SAML_BROWSER_COOKIE,
  SAML_SELF_LINK_PREFIX,
  type SamlBrowserIntent,
} from '../../packages/auth/src/saml-browser-binding';
import { parseSamlSelfLinkBody, selfLinkCallback } from '../../packages/auth/src/saml-self-link';
import { ssoBoundary } from '../../packages/auth/src/sso-flow';
const key = 'unit-generated-self-link-key-never-a-real-auth-secret';
function fixture() {
  const provider = {
    providerId: 'generated',
    issuer: 'https://ensemus.example.invalid/sp',
    domain: 'company.invalid',
    domainVerified: true,
    samlConfig: JSON.stringify({
      issuer: 'https://ensemus.example.invalid/sp',
      wantAssertionsSigned: true,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      entryPoint: 'https://generated-idp.example.invalid/login',
      idpMetadata: {
        entityID: 'https://generated-idp.example.invalid/entity',
        cert: ['unit-only'],
      },
    }),
  };
  const intent: SamlBrowserIntent = {
    version: 1,
    mode: 'self_link',
    phase: 'prepared',
    requestId: '_generated',
    relaySha256: samlHash('relay'),
    providerId: provider.providerId,
    issuer: 'https://generated-idp.example.invalid/entity',
    domain: provider.domain,
    boundary: ssoBoundary(provider),
    rawConfigSha256: samlHash(provider.samlConfig),
    browserProofSha256: samlHash('p'.repeat(43)),
    source: {
      userId: randomUUID(),
      sessionId: randomUUID(),
      sessionTokenSha256: 'b'.repeat(64),
      email: 'member@company.invalid',
      primary: { kind: 'credential', accountId: randomUUID(), fingerprint: 'c'.repeat(64) },
    },
    organizationId: randomUUID(),
    membershipId: randomUUID(),
    scopeAdmission: 'v1',
  };
  const id = randomUUID(),
    cookie = issueSamlBrowserProof(key, id, intent, 'p'.repeat(43)).value,
    row = {
      id,
      identifier: `${SAML_SELF_LINK_PREFIX}${intent.relaySha256}`,
      value: JSON.stringify(intent),
      expiresAt: new Date(Date.now() + 60000),
    };
  const findOne = vi.fn(async () => row),
    update = vi.fn(async (input: { update: { value: string } }) => ({
      value: JSON.stringify({
        ...JSON.parse(input.update.value),
        finalizationAdmission: 'v1',
        finalizationTransaction: '123',
      }),
      expiresAt: row.expiresAt,
    }));
  const flow = createSamlBrowserFlow({
    database: {} as Parameters<typeof createSamlBrowserFlow>[0]['database'],
    secret: key,
    baseURL: 'https://ensemus.example.invalid',
  });
  const input = {
    protocol: 'saml' as const,
    providerId: provider.providerId,
    accountKey: { issuer: intent.issuer, accountId: 'signed-subject' },
    providerUser: {
      email: intent.source!.email,
      name: 'Untrusted provider name',
      emailVerified: true,
    },
    providerAttributes: { role: 'owner' },
    providerReference: {
      providerId: provider.providerId,
      source: { type: 'persisted' as const, recordId: randomUUID() },
      authenticationConfigurationFingerprint: 'transient',
    },
  };
  const resolve = (otherCookie = cookie) =>
    flow.run(
      new Request('https://ensemus.example.invalid/api/auth/sso/saml2/sp/acs/generated', {
        headers: { cookie: `${SAML_BROWSER_COOKIE}=${otherCookie}` },
      }),
      {
        issuer: intent.issuer,
        subject: input.accountKey.accountId,
        requestId: intent.requestId,
        relaySha256: intent.relaySha256,
        bodySha256: 'd'.repeat(64),
        authenticatedAt: Date.now(),
      },
      async () =>
        Response.json(
          await flow.resolve(
            input,
            {
              database: { findOne, update } as unknown as Parameters<
                typeof flow.resolve
              >[1]['database'],
            },
            provider,
          ),
        ),
    );
  return { intent, id, cookie, row, input, provider, findOne, update, resolve };
}
describe('explicit native SAML self-link protocol', () => {
  it('selects only the source native person with preserved profile through the native adapter', async () => {
    const f = fixture(),
      response = await f.resolve();
    expect(await response.json()).toEqual({
      action: 'link',
      userId: f.intent.source!.userId,
      profile: 'preserve',
    });
    expect(f.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          { field: 'id', value: f.id },
          { field: 'identifier', value: f.row.identifier },
        ],
      }),
    );
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          value: JSON.stringify({
            ...f.intent,
            phase: 'consumed',
            subject: 'signed-subject',
            signedEmail: f.intent.source!.email,
          }),
        },
      }),
    );
  });
  it.each([
    'missing-source',
    'missing-scope',
    'wrong-person-email',
    'wrong-session',
    'wrong-primary',
    'wrong-mode',
    'other-browser',
    'changed-provider',
    'caller-finalization-stamp',
  ] as const)('refuses %s without falling through to ordinary sign-in', async (kind) => {
    const f = fixture();
    let cookie = f.cookie;
    if (kind === 'missing-source') delete f.intent.source;
    if (kind === 'missing-scope') delete f.intent.scopeAdmission;
    if (kind === 'wrong-person-email') f.input.providerUser.email = 'another@company.invalid';
    if (kind === 'wrong-session') f.intent.source!.sessionId = randomUUID();
    if (kind === 'wrong-primary') f.intent.source!.primary.fingerprint = 'e'.repeat(64);
    if (kind === 'wrong-mode') f.intent.mode = 'signin';
    if (kind === 'other-browser') cookie = fixture().cookie;
    if (kind === 'changed-provider') f.provider.domainVerified = false;
    if (kind === 'caller-finalization-stamp') f.intent.finalizationAdmission = 'v1';
    f.row.value = JSON.stringify(f.intent);
    expect(await (await f.resolve(cookie)).json()).toEqual({
      action: 'reject',
      code: 'SSO_REFUSED',
    });
    expect(f.update).not.toHaveBeenCalled();
  });
  it('refuses missing SQL finalization admission rather than accepting an unguarded adapter', async () => {
    const f = fixture();
    f.update.mockImplementationOnce(async (input) => ({
      value: input.update.value,
      expiresAt: f.row.expiresAt,
    }));
    await expect(f.resolve()).rejects.toMatchObject({ body: { code: 'SSO_REFUSED' } });
  });
  it('canonicalizes source tuple across PostgreSQL jsonb key ordering', () => {
    const f = fixture(),
      source = f.intent.source!;
    const reordered = {
      ...f.intent,
      source: {
        primary: {
          fingerprint: source.primary.fingerprint,
          accountId: source.primary.accountId,
          kind: 'credential' as const,
        },
        email: source.email,
        sessionTokenSha256: source.sessionTokenSha256,
        sessionId: source.sessionId,
        userId: source.userId,
      },
    };
    expect(samlIntentBinding(reordered)).toBe(samlIntentBinding(f.intent));
    expect(readSamlBrowserProof(key, f.cookie)?.mode).toBe('self_link');
  });
  it('does not allow source/authority fields on the ordinary sign-in protocol', () => {
    const f = fixture();
    expect(parseSamlIntent(JSON.stringify({ ...f.intent, mode: 'signin' }))).toBeNull();
  });
  it.each([
    {
      password: 'generated',
      callbackURL: 'https://ensemus.example.invalid/sso/complete',
      consent: 'connect',
      userId: randomUUID(),
    },
    {
      password: 'generated',
      callbackURL: 'https://ensemus.example.invalid/sso/complete',
      consent: 'continue',
    },
    {
      password: 'p'.repeat(129),
      callbackURL: 'https://ensemus.example.invalid/sso/complete',
      consent: 'connect',
    },
  ])('rejects extra selection fields, missing consent and oversized proof', (input) =>
    expect(parseSamlSelfLinkBody(input)).toBeNull(),
  );
  it('accepts only the exact own native completion path and safe single return destination', () => {
    const base = 'https://ensemus.example.invalid';
    expect(
      selfLinkCallback(`${base}/sso/complete?next=%2Finvite%2Fgenerated`, base),
    ).not.toBeNull();
    for (const value of [
      'https://outside.invalid/sso/complete',
      `${base}/sso/complete#fragment`,
      `${base}/sso/complete?next=%2F%2Foutside.invalid`,
      `${base}/sso/complete?next=%2Fx&next=%2Fy`,
      `${base}/sso/complete?userId=${randomUUID()}`,
      `${base}/api/auth/sso/link-self`,
    ])
      expect(selfLinkCallback(value, base)).toBeNull();
  });
});
