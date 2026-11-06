// The generic signed callback. It only asks for things, and it runs only after the signature has passed,
// so this is the one small schema standing between a body and the rest of the worker (ADR-027 trade-offs).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInboundConnector, INBOUND_CONNECTOR_TYPE } from './index';
import { MalformedWebhook, type ConnectorContext } from '../index';
import { describeConnectorConformance } from '../testing';

const connector = createInboundConnector();
const interpret = connector.webhooks?.interpret;

const refused = async () => {
  throw new Error('This connector has no reason to ask.');
};

const context: ConnectorContext<Record<string, never>> = {
  organizationId: randomUUID(),
  connectionId: randomUUID(),
  config: {},
  credentials: { withCredential: refused },
  network: { openRelay: refused },
  signal: new AbortController().signal,
};

const read = (body: string | Uint8Array) => {
  if (!interpret) throw new Error('Declares webhooks, so it must interpret them.');
  return interpret(context, {
    providerEventId: 'evt-1',
    signedAtSeconds: 1,
    body: typeof body === 'string' ? Buffer.from(body) : body,
  });
};

const email = {
  to: ['recipient@example.invalid'],
  subject: 'A test message',
  text_body: 'Nothing here is real.',
};

describe('what the inbound connector says it is', () => {
  it('needs no network and no credential, and declares only its callback', () => {
    expect(connector.manifest.type).toBe(INBOUND_CONNECTOR_TYPE);
    expect(connector.manifest.credential.required).toBe(false);
    expect(connector.manifest.capabilities).toMatchObject({
      actions: [],
      reconcile: 'none',
      nativeIdempotency: false,
      sync: null,
      aclMapping: false,
      network: 'none',
      webhooks: { scheme: 'ensemus_hmac_sha256_v1' },
    });
    expect(connector.actions).toBeUndefined();
    expect(connector.sync).toBeUndefined();
  });

  it('takes no settings at all, so a host can never be named in one', () => {
    expect(connector.parseConfig({})).toEqual({});
    expect(() => connector.parseConfig({ host: 'evil.example.invalid' })).toThrow();
    expect(() => connector.parseConfig(null)).toThrow();
  });
});

describe('reading a verified body', () => {
  it('turns a proposal into a request for an email, which still needs a person', () => {
    const workUnitId = randomUUID();
    const connectionId = randomUUID();
    const effects = read(
      JSON.stringify({
        type: 'external_action.proposed',
        work_unit_id: workUnitId,
        connection_id: connectionId,
        email,
      }),
    );
    expect(effects).toEqual([
      {
        kind: 'action_proposed',
        workUnitId,
        connectionId,
        toolName: 'email.send',
        toolVersion: '1',
        payload: email,
      },
    ]);
  });

  it('turns a sync request into one, naming nothing', () => {
    expect(read('{"type":"connector.sync_requested"}')).toEqual([{ kind: 'sync_requested' }]);
  });

  it.each([
    ['not JSON', 'hello'],
    ['empty', ''],
    ['a list', '[]'],
    ['a type nobody defined', '{"type":"something.else"}'],
    ['an extra field', '{"type":"connector.sync_requested","connection_id":"x"}'],
    [
      'a proposal naming a sender, which only the connection decides',
      JSON.stringify({
        type: 'external_action.proposed',
        work_unit_id: randomUUID(),
        connection_id: randomUUID(),
        email: { ...email, from: { address: 'attacker@example.invalid' } },
      }),
    ],
    [
      'a line break in a subject',
      JSON.stringify({
        type: 'external_action.proposed',
        work_unit_id: randomUUID(),
        connection_id: randomUUID(),
        email: { ...email, subject: 'Hi\r\nBcc: attacker@example.invalid' },
      }),
    ],
    [
      'an ID that is not one',
      JSON.stringify({
        type: 'external_action.proposed',
        work_unit_id: "' or 1=1",
        connection_id: randomUUID(),
        email,
      }),
    ],
  ])('refuses %s, with no text from the body', (_name, body) => {
    let thrown: unknown;
    try {
      read(body);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MalformedWebhook);
    expect((thrown as Error).message).toBe('MALFORMED_PAYLOAD');
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(() => read(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))).toThrow(MalformedWebhook);
  });
});

// The suite belongs to the sdk slice, and until that lands it is a stub that throws. The guard only ever
// turns that one stub into a pending test, so this runs for real once the slices are merged.
try {
  describeConnectorConformance('inbound_webhook', () => createInboundConnector(), {
    config: {},
  });
} catch (error) {
  if ((error as Error).message !== 'NOT_IMPLEMENTED') throw error;
  describe('inbound_webhook conformance', () => {
    it.todo('runs once the sdk slice lands');
  });
}
