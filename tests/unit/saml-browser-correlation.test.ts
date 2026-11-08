// Protocol/unit doubles are not signed callback or database-role acceptance. Runtime journeys are
// authored separately; the production resolver always receives Better Auth's actual native adapter.
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createSamlBrowserFlow } from '../../packages/auth/src/saml-browser-flow';
import {
  issueSamlBrowserProof,
  matchesSamlBrowserProof,
  nativeSamlRedirect,
  parseSamlIntent,
  readSamlBrowserProof,
  samlBrowserCookie,
  samlHash,
  SAML_BROWSER_COOKIE,
  SAML_BROWSER_PREFIX,
  type SamlBrowserIntent,
} from '../../packages/auth/src/saml-browser-binding';
import { ssoBoundary } from '../../packages/auth/src/sso-flow';
import type { SsoProviderState } from '../../packages/auth/src/sso';

type SSOSAMLUserResolutionInput = Parameters<
  ReturnType<typeof createSamlBrowserFlow>['resolve']
>[0];
type SSOUserResolutionContext = Parameters<ReturnType<typeof createSamlBrowserFlow>['resolve']>[1];

const key = 'generated-unit-purpose-key-not-a-real-auth-secret',
  url = 'https://ensemus.example.invalid/api/auth/sso/saml2/sp/acs/generated';
function fixture() {
  const config = JSON.stringify({
      issuer: 'https://ensemus.example.invalid/sp',
      wantAssertionsSigned: true,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      entryPoint: 'https://generated-idp.example.invalid/sign-in',
      idpMetadata: {
        entityID: 'https://generated-idp.example.invalid/entity',
        cert: ['unit-only-certificate'],
      },
    }),
    provider: SsoProviderState = {
      providerId: 'generated',
      issuer: 'https://ensemus.example.invalid/sp',
      domain: 'company.invalid',
      domainVerified: true,
      samlConfig: config,
    };
  const intent: SamlBrowserIntent = {
    version: 1,
    mode: 'signin',
    phase: 'prepared',
    requestId: '_actual_generated_request',
    relaySha256: samlHash('native opaque relay'),
    providerId: provider.providerId,
    issuer: 'https://generated-idp.example.invalid/entity',
    domain: provider.domain,
    boundary: ssoBoundary(provider),
    rawConfigSha256: samlHash(config),
    browserProofSha256: samlHash('p'.repeat(43)),
  };
  const id = randomUUID(),
    cookie = issueSamlBrowserProof(key, id, intent, 'p'.repeat(43)).value;
  const row = {
    id,
    identifier: `${SAML_BROWSER_PREFIX}${intent.relaySha256}`,
    value: JSON.stringify(intent),
    expiresAt: new Date(Date.now() + 60000),
  };
  const findOne = vi.fn(async () => row),
    update = vi.fn(
      async (value: { where: { field: string; value: unknown }[]; update: { value: string } }) => {
        if (value.where.find((item) => item.field === 'value')?.value !== row.value) return null;
        row.value = value.update.value;
        return { value: row.value, expiresAt: row.expiresAt };
      },
    );
  const database = { findOne, update } as unknown as SSOUserResolutionContext['database'];
  const flow = createSamlBrowserFlow({
    database: {} as Parameters<typeof createSamlBrowserFlow>[0]['database'],
    secret: key,
    baseURL: 'https://ensemus.example.invalid',
  });
  const input = {
    protocol: 'saml',
    providerId: provider.providerId,
    accountKey: { issuer: intent.issuer, accountId: 'signed-subject' },
    providerUser: { email: 'member@company.invalid', emailVerified: false, name: 'Member' },
    providerAttributes: { role: 'owner' },
    providerReference: {
      providerId: 'generated',
      source: { type: 'persisted', recordId: randomUUID() },
      authenticationConfigurationFingerprint: 'transient-native-reference',
    },
  } satisfies SSOSAMLUserResolutionInput;
  const envelope = {
    issuer: intent.issuer,
    subject: input.accountKey.accountId,
    authenticatedAt: Date.now(),
    bodySha256: 'b'.repeat(64),
    requestId: intent.requestId,
    relaySha256: intent.relaySha256,
  };
  async function resolve(
    overrides: {
      cookie?: string | null;
      envelope?: Partial<typeof envelope>;
      input?: Partial<typeof input>;
      provider?: Partial<SsoProviderState>;
      responseCookies?: boolean;
    } = {},
  ) {
    return flow.run(
      new Request(url, {
        headers:
          overrides.cookie === null
            ? {}
            : { cookie: `${SAML_BROWSER_COOKIE}=${overrides.cookie ?? cookie}` },
      }),
      { ...envelope, ...overrides.envelope },
      async () =>
        Response.json(
          await flow.resolve(
            { ...input, ...overrides.input },
            { database },
            { ...provider, ...overrides.provider },
          ),
          overrides.responseCookies
            ? {
                headers: [
                  [
                    'set-cookie',
                    'native-session=generated; Path=/; Secure; HttpOnly; SameSite=Lax',
                  ],
                  [
                    'set-cookie',
                    'native-challenge=generated; Path=/; Secure; HttpOnly; SameSite=Lax',
                  ],
                ],
              }
            : undefined,
        ),
    );
  }
  return { intent, provider, id, cookie, row, findOne, update, resolve, envelope, input };
}

describe('purpose-bound SAML browser correlation', () => {
  it.each([
    'missing',
    'duplicate-cookie',
    'other-browser',
    'tampered',
    'expired',
    'invalid-expiry',
    'consumed',
    'wrong-request',
    'wrong-relay',
    'wrong-provider',
    'wrong-issuer',
    'wrong-subject',
    'changed-config',
    'unreviewed',
    'unknown-mode',
    'unknown-field',
  ] as const)('refuses %s without falling through to continue', async (kind) => {
    const f = fixture();
    let options: Parameters<typeof f.resolve>[0] = {};
    if (kind === 'missing') options = { cookie: null };
    if (kind === 'duplicate-cookie')
      options = { cookie: `${f.cookie}; ${SAML_BROWSER_COOKIE}=${f.cookie}` };
    if (kind === 'other-browser') options = { cookie: fixture().cookie };
    if (kind === 'tampered') options = { cookie: `${f.cookie.slice(0, -1)}!` };
    if (kind === 'expired') f.row.expiresAt = new Date(Date.now() - 1);
    if (kind === 'invalid-expiry') f.row.expiresAt = new Date('invalid');
    if (kind === 'consumed') f.row.value = JSON.stringify({ ...f.intent, phase: 'consumed' });
    if (kind === 'wrong-request') options = { envelope: { requestId: '_another_request' } };
    if (kind === 'wrong-relay') options = { envelope: { relaySha256: 'a'.repeat(64) } };
    if (kind === 'wrong-provider') options = { input: { providerId: 'another-provider' } };
    if (kind === 'wrong-issuer')
      options = {
        input: { accountKey: { ...f.input.accountKey, issuer: 'https://other.invalid' } },
      };
    if (kind === 'wrong-subject') options = { envelope: { subject: 'different-subject' } };
    if (kind === 'changed-config')
      options = { provider: { samlConfig: f.provider.samlConfig + ' ' } };
    if (kind === 'unreviewed') options = { provider: { domainVerified: false } };
    if (kind === 'unknown-mode') f.row.value = JSON.stringify({ ...f.intent, mode: 'self_link' });
    if (kind === 'unknown-field')
      f.row.value = JSON.stringify({ ...f.intent, selectedUserId: randomUUID() });
    const response = await f.resolve(options);
    expect(await response.json()).toEqual({ action: 'reject', code: 'SSO_REFUSED' });
    expect(f.update).not.toHaveBeenCalled();
  });
  it('returns only continue and consumes through the supplied native transaction adapter', async () => {
    const f = fixture(),
      response = await f.resolve();
    expect(await response.json()).toEqual({ action: 'continue' });
    expect(f.update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        model: 'verification',
        where: [
          { field: 'id', value: f.id },
          { field: 'value', value: JSON.stringify(f.intent) },
          { field: 'expiresAt', value: f.row.expiresAt },
        ],
      }),
    );
    expect(parseSamlIntent(f.row.value)?.phase).toBe('consumed');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await (await f.resolve()).json()).toEqual({ action: 'reject', code: 'SSO_REFUSED' });
  });
  it('does not clear another valid browser attempt after a mismatched callback', async () => {
    const f = fixture(),
      response = await f.resolve({ cookie: fixture().cookie });
    expect(await response.json()).toEqual({ action: 'reject', code: 'SSO_REFUSED' });
    expect(response.headers.has('set-cookie')).toBe(false);
  });
  it('preserves every native session/challenge cookie when expiring only its own purpose cookie', async () => {
    const f = fixture(),
      response = await f.resolve({ responseCookies: true }),
      cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    expect(cookies).toContain('native-session=generated; Path=/; Secure; HttpOnly; SameSite=Lax');
    expect(cookies).toContain('native-challenge=generated; Path=/; Secure; HttpOnly; SameSite=Lax');
    expect(cookies.filter((value) => value.startsWith(`${SAML_BROWSER_COOKIE}=`))).toEqual([
      samlBrowserCookie('', 0),
    ]);
  });
  it('checks expiry after an UPDATE lock wait before returning continue', async () => {
    const f = fixture();
    f.update.mockImplementationOnce(async () => {
      f.row.expiresAt = new Date(Date.now() - 1);
      return {
        value: JSON.stringify({ ...f.intent, phase: 'consumed' }),
        expiresAt: f.row.expiresAt,
      };
    });
    await expect(f.resolve()).rejects.toMatchObject({ body: { code: 'SSO_REFUSED' } });
  });
  it('uses a Secure HttpOnly SameSite=None purpose cookie without changing session cookies', () => {
    const f = fixture(),
      header = samlBrowserCookie(f.cookie);
    expect(header).toContain(`${SAML_BROWSER_COOKIE}=`);
    expect(header).toContain('Path=/; Max-Age=300; Secure; HttpOnly; SameSite=None');
    const proof = readSamlBrowserProof(key, f.cookie);
    expect(readSamlBrowserProof('different-generated-key', f.cookie)).toBeNull();
    expect(proof && matchesSamlBrowserProof(proof, f.intent, f.id)).toBe(true);
    expect(
      proof && matchesSamlBrowserProof(proof, { ...f.intent, providerId: 'another' }, f.id),
    ).toBe(false);
  });
  it('parses a bounded real native AuthnRequest redirect and rejects unsafe alternatives', () => {
    const request = deflateRawSync(
      Buffer.from(
        '<s:AuthnRequest xmlns:s="urn:oasis:names:tc:SAML:2.0:protocol" ID="_generated"/>',
      ),
    ).toString('base64');
    const redirect = new URL('https://generated-idp.example.invalid/sign-in');
    redirect.searchParams.set('SAMLRequest', request);
    redirect.searchParams.set('RelayState', 'opaque');
    expect(nativeSamlRedirect(redirect.href)).toEqual({
      url: redirect.href,
      requestId: '_generated',
      relaySha256: samlHash('opaque'),
    });
    for (const value of [
      redirect.href.replace('https:', 'http:'),
      redirect.href + '&RelayState=duplicate',
      redirect.href + '#fragment',
      'https://generated-idp.example.invalid/no-request',
    ])
      expect(nativeSamlRedirect(value)).toBeNull();
  });
});
