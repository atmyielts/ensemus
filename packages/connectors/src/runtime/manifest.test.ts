// The manifests are data the web tier reads, written with literals to keep them free of Node's crypto.
// So the literals have to be held to the constants everything else uses.
import {
  configMatchesFields,
  isSafeConnectorConfig,
  isValidSyncPage,
  MAX_SYNC_PAGE_RESOURCES,
  safeSyncErrorCode,
  SECRET_PURPOSE_CONNECTOR_CREDENTIAL,
  SECRET_PURPOSE_WEBHOOK_SIGNING,
  SHIPPED_CONNECTOR_RULES,
  type SyncedResource,
  type SyncPage,
} from '@ensemus/domain/connector';
import { EMAIL_CONNECTOR_TYPE, EMAIL_SEND_TOOL } from '@ensemus/domain/external-action';
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_MANIFESTS,
  EMAIL_CONNECTOR_MANIFEST,
  INBOUND_CONNECTOR_MANIFEST,
  manifestFor,
} from '../manifest';
import { createConnectorRegistry } from './registry';
import { createFakeConnector } from '../testing';

describe('shipped manifests', () => {
  it('say what the domain says', () => {
    expect(EMAIL_CONNECTOR_MANIFEST.type).toBe(EMAIL_CONNECTOR_TYPE);
    expect(EMAIL_CONNECTOR_MANIFEST.capabilities.actions).toEqual([EMAIL_SEND_TOOL]);
    expect(EMAIL_CONNECTOR_MANIFEST.credential.purpose).toBe(SECRET_PURPOSE_CONNECTOR_CREDENTIAL);
    expect(INBOUND_CONNECTOR_MANIFEST.credential.purpose).toBe(SECRET_PURPOSE_WEBHOOK_SIGNING);
  });

  it('match the rules the service accepts a connection by', () => {
    expect(
      CONNECTOR_MANIFESTS.map((manifest) => ({
        type: manifest.type,
        required: manifest.credential.required,
      })),
    ).toEqual(
      SHIPPED_CONNECTOR_RULES.map((rule) => ({
        type: rule.type,
        required: rule.credential.required,
      })),
    );
  });

  it('are found by type, and nothing else is', () => {
    expect(manifestFor('email_smtp')).toBe(EMAIL_CONNECTOR_MANIFEST);
    expect(manifestFor('nothing_real')).toBeUndefined();
  });
});

describe('what a sync page may hold', () => {
  const resource = (overrides: Partial<SyncedResource> = {}): SyncedResource => ({
    externalId: 'one',
    resourceType: 'files',
    externalVersion: '1',
    acl: [],
    ...overrides,
  });
  const page = (overrides: Partial<SyncPage> = {}): SyncPage => ({
    resources: [resource()],
    deletedExternalIds: [],
    nextCursor: 'next',
    hasMore: false,
    ...overrides,
  });

  it('takes a page its stream could have produced', () => {
    expect(isValidSyncPage('files', page())).toBe(true);
    expect(isValidSyncPage('files', page({ nextCursor: null, resources: [] }))).toBe(true);
  });

  // Which stream found a resource is stored apart from what kind of thing it is, so this is no refusal.
  it('takes a kind of thing named differently from its stream', () => {
    expect(
      isValidSyncPage('files', page({ resources: [resource({ resourceType: 'document' })] })),
    ).toBe(true);
  });

  it('refuses a stream that could not exist', () => {
    expect(isValidSyncPage('Not a Stream!', page())).toBe(false);
  });

  it.each<[string, SyncPage]>([
    ['a type that is not one', page({ resources: [resource({ resourceType: 'Not a Type!' })] })],
    ['no type', page({ resources: [resource({ resourceType: undefined as never })] })],
    ['an empty ID', page({ resources: [resource({ externalId: '' })] })],
    ['a repeated ID', page({ resources: [resource(), resource()] })],
    ['an ID both present and gone', page({ deletedExternalIds: ['one'] })],
    ['a digest that is not one', page({ resources: [resource({ contentSha256: 'nope' })] })],
    ['an unknown class', page({ resources: [resource({ classification: 'x' as never })] })],
    [
      'too many resources',
      page({ resources: Array(MAX_SYNC_PAGE_RESOURCES + 1).fill(resource()) }),
    ],
    ['a very long cursor', page({ nextCursor: 'x'.repeat(8193) })],
    ['an empty cursor', page({ nextCursor: '' })],
    [
      'an unknown principal kind',
      page({
        resources: [
          resource({
            acl: [{ principalKind: 'robot' as never, principalExternalId: 'x', access: 'read' }],
          }),
        ],
      }),
    ],
    [
      'an unknown access',
      page({
        resources: [
          resource({
            acl: [{ principalKind: 'user', principalExternalId: 'x', access: 'admin' as never }],
          }),
        ],
      }),
    ],
  ])('refuses %s', (_label, invalid) => {
    expect(isValidSyncPage('files', invalid)).toBe(false);
  });
});

describe('what a connection may show', () => {
  it('reduces any code off the list to a failure', () => {
    expect(safeSyncErrorCode('SYNC_TIMEOUT')).toBe('SYNC_TIMEOUT');
    for (const code of ['SECRETVALUE', '550 mailbox', '', null, undefined, 7]) {
      expect(safeSyncErrorCode(code)).toBe('SYNC_FAILED');
    }
  });

  it.each([
    [{ host: 'x' }],
    [{ HOSTNAME: 'x' }],
    [{ port: 1 }],
    [{ smtpPassword: 'x' }],
    [{ apiKey: 'x' }],
    [{ api_key: 'x' }],
    [{ nested: { accessToken: 'x' } }],
    [{ list: [{ clientSecret: 'x' }] }],
    [{ baseUrl: 'x' }],
    [{ large: 'x'.repeat(5000) }],
    [null],
    [[]],
    ['text'],
  ])('refuses %j as settings', (config) => {
    expect(isSafeConnectorConfig(config)).toBe(false);
  });

  it('takes the settings of the connectors we ship', () => {
    const [email, inbound] = SHIPPED_CONNECTOR_RULES;
    const fields = email?.configFields ?? {};
    const config = {
      fromAddress: 'sender@example.invalid',
      fromName: 'Sender',
      tlsServerName: 'relay.example.invalid',
    };
    expect(isSafeConnectorConfig(config)).toBe(true);
    expect(configMatchesFields(config, fields)).toBe(true);
    expect(configMatchesFields({ fromAddress: 'a b@example.invalid' }, fields)).toBe(false);
    expect(configMatchesFields({ ...config, extra: 'x' }, fields)).toBe(false);
    expect(configMatchesFields({}, inbound?.configFields ?? {})).toBe(true);
    // Not fooled by what every object inherits.
    expect(configMatchesFields({ toString: 'x' }, {})).toBe(false);
  });
});

describe('the registry', () => {
  it('holds only what it was given', () => {
    const fake = createFakeConnector({});
    const registry = createConnectorRegistry([fake]);
    expect(registry.get(fake.manifest.type)).toBe(fake);
    expect(registry.get('email_smtp')).toBeUndefined();
    expect(registry.manifests()).toEqual([fake.manifest]);
  });

  it('refuses two connectors of one type', () => {
    expect(() =>
      createConnectorRegistry([createFakeConnector({}), createFakeConnector({})]),
    ).toThrow();
  });
});
