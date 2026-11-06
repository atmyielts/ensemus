import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OAuthProvider } from 'better-auth';
import { operatorOidcTrust } from './oidc-primary';
const config = {
  providerId: 'generated-operator',
  clientId: 'generated-client',
  discoveryUrl: 'https://operator-idp.example.invalid/.well-known/openid-configuration',
};
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const provider: Pick<OAuthProvider, 'id' | 'idToken' | 'requiresIdTokenNonce'> = {
  id: config.providerId,
  requiresIdTokenNonce: true,
  idToken: {
    issuer: 'https://operator-idp.example.invalid',
    audience: config.clientId,
    algorithms: ['RS256'],
    jwks: async () => publicKey,
  },
};
describe('operator OIDC primary trust boundary', () => {
  it('binds the actual configured provider/source/issuer/audience/policy without token or secret values', () => {
    const trust = operatorOidcTrust(config, provider);
    expect(trust?.sourceConfigSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(trust?.issuer).toBe('https://operator-idp.example.invalid');
    expect(
      operatorOidcTrust(
        { ...config, discoveryUrl: 'https://other.invalid/.well-known/openid-configuration' },
        provider,
      )?.sourceConfigSha256,
    ).not.toBe(trust?.sourceConfigSha256);
  });
  it('refuses absent/replaced provider, opaque/custom verification and missing nonce authority', () => {
    expect(operatorOidcTrust(undefined, provider)).toBeNull();
    expect(operatorOidcTrust(config, { ...provider, id: 'other' })).toBeNull();
    expect(operatorOidcTrust(config, { ...provider, requiresIdTokenNonce: false })).toBeNull();
    expect(
      operatorOidcTrust(config, { ...provider, idToken: { verify: async () => true } }),
    ).toBeNull();
    const policy = provider.idToken!;
    if ('verify' in policy) throw new Error('Fixture policy incorrect');
    expect(
      operatorOidcTrust(config, { ...provider, idToken: { ...policy, allowOpaqueToken: true } }),
    ).toBeNull();
    expect(
      operatorOidcTrust(config, { ...provider, idToken: { ...policy, issuer: undefined } }),
    ).toBeNull();
    expect(
      operatorOidcTrust(config, { ...provider, idToken: { ...policy, audience: 'other' } }),
    ).toBeNull();
    expect(
      operatorOidcTrust(config, {
        ...provider,
        idToken: { ...policy, algorithms: ['none', 'HS256'] },
      }),
    ).toBeNull();
  });
});
