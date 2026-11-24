// ADR-038's lists in the domain, the request contracts and the page's wording must agree, and a sealed
// credential must read as exactly one of its two shapes.
import { AppError, type ErrorCode } from '@ensemus/application';
import { oauthCredentialSchema } from '@ensemus/contracts/knowledge';
import {
  oauthAuthorizationStatusSchema,
  oauthCallbackQuerySchema,
  startOAuthAuthorizationSchema,
  suiteCapabilitySchema,
  suiteConnectorTypeSchema,
} from '@ensemus/contracts/workspace-suites';
import {
  MICROSOFT_TENANT_PATTERN,
  OAUTH_STATUSES,
  SUITE_CAPABILITIES,
  SUITE_CONNECTOR_TYPES,
} from '@ensemus/domain/workspace-suites';
import { describe, expect, it } from 'vitest';
import { messageFor } from '../../apps/web/src/lib/messages';

describe('workspace suites contracts', () => {
  it('list what the domain lists', () => {
    expect(suiteConnectorTypeSchema.options).toEqual([...SUITE_CONNECTOR_TYPES]);
    expect(suiteCapabilitySchema.options).toEqual([...SUITE_CAPABILITIES]);
    expect(oauthAuthorizationStatusSchema.options).toEqual([...OAUTH_STATUSES]);
  });

  it('take a platform or a customer client, and nothing in between', () => {
    const body = {
      connector_type: 'microsoft_365',
      display_name: 'Microsoft 365',
      config: { drive_ids: [] },
      capabilities: ['files', 'directory'],
    };
    expect(
      startOAuthAuthorizationSchema.safeParse({ ...body, client: { kind: 'platform' } }).success,
    ).toBe(true);
    const customer = {
      kind: 'customer',
      client_id: 'generated-client-id',
      client_secret: 'generated-client-secret',
      tenant: 'contoso.example',
    };
    expect(startOAuthAuthorizationSchema.safeParse({ ...body, client: customer }).success).toBe(
      true,
    );
    for (const client of [
      { kind: 'platform', client_secret: 'x' },
      { ...customer, tenant: '../common' },
      { kind: 'customer', client_id: 'x' },
    ])
      expect(startOAuthAuthorizationSchema.safeParse({ ...body, client }).success).toBe(false);
    expect(
      startOAuthAuthorizationSchema.safeParse({
        ...body,
        client: { kind: 'platform' },
        scopes: ['x'],
      }).success,
    ).toBe(false);
  });

  it('hold a tenant to the same shape in the contract and the domain', () => {
    for (const tenant of [
      'contoso.example',
      '6f1c2c6e-1111-4111-8111-111111111111',
      '..',
      'a/b',
      'common',
    ])
      expect(oauthCallbackQuerySchema.shape.tenant.safeParse(tenant).success).toBe(
        MICROSOFT_TENANT_PATTERN.test(tenant),
      );
  });

  it('read only the callback parameters ADR-038 names', () => {
    const parsed = oauthCallbackQuerySchema.parse({
      state: 's',
      code: 'c',
      scope: 'openid',
      session_state: 'x',
    });
    expect(Object.keys(parsed).sort()).toEqual(['code', 'state']);
  });
});

describe('a sealed OAuth credential', () => {
  const refresh_token = 'generated-refresh-token';

  it('is a customer app or the platform app', () => {
    expect(
      oauthCredentialSchema.safeParse({ client_id: 'a', client_secret: 'b', refresh_token })
        .success,
    ).toBe(true);
    expect(oauthCredentialSchema.safeParse({ client: 'platform', refresh_token }).success).toBe(
      true,
    );
    expect(
      oauthCredentialSchema.safeParse({
        client: 'platform',
        refresh_token,
        tenant: 'contoso.example',
      }).success,
    ).toBe(true);
  });

  it('never carries the platform secret, and is never both', () => {
    for (const credential of [
      { client: 'platform', refresh_token, client_secret: 'b' },
      { client: 'platform', refresh_token, client_id: 'a', client_secret: 'b' },
      { client: 'customer', refresh_token, client_id: 'a', client_secret: 'b' },
      { client: 'platform' },
    ])
      expect(oauthCredentialSchema.safeParse(credential).success).toBe(false);
  });
});

describe('the words a person sees', () => {
  it.each([
    'OAUTH_STATE_INVALID',
    'OAUTH_DENIED',
    'OAUTH_EXPIRED',
    'OAUTH_EXCHANGE_FAILED',
    'OAUTH_SCOPES_INSUFFICIENT',
    'OAUTH_CLIENT_NOT_CONFIGURED',
    'OAUTH_CAPABILITY_UNAVAILABLE',
    'DIRECTORY_TEAM_READ_ONLY',
  ] satisfies ErrorCode[])('are the same in the page and the API for %s', (code) => {
    expect(messageFor(code)).toBe(new AppError(code).message);
  });
});
