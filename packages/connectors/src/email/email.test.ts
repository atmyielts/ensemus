// The connector and its SMTP client, over an in-memory stream, so that each byte and each moment is under
// the test's control. Real sockets and TLS are in tests/integration/email-connector.test.ts.
import { duplexPair, type Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_CONNECTOR_TYPE,
  EMAIL_SEND_TOOL,
  EMAIL_SEND_VERSION,
} from '@ensemus/domain/external-action';
import { SECRET_PURPOSE_CONNECTOR_CREDENTIAL } from '@ensemus/domain/connector';
import { NotSent, type ActionRequest, type ConnectorContext } from '../index';
import { createEmailConnector, type EmailConfig } from './index';

const ID = '11111111-1111-4111-8111-111111111111';
const SECRET = Buffer.from('generated-test-secret-value');
const PROVIDER_TEXT = 'canary-provider-text';

const config: EmailConfig = { fromAddress: 'sender@example.invalid' };
const request = (overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  externalActionId: ID,
  attemptId: '22222222-2222-4222-8222-222222222222',
  attemptNo: 1,
  toolName: EMAIL_SEND_TOOL,
  toolVersion: EMAIL_SEND_VERSION,
  idempotencyKey: `ensemus-${ID}`,
  requestHash: 'hash',
  payload: {
    from: { address: 'sender@example.invalid' },
    to: ['first@example.invalid'],
    subject: 'Hello',
    text_body: 'Plain text',
  },
  ...overrides,
});

type Respond = (line: string, relay: Relay) => void;

/** Answers line by line as a script says. Records every line and every chunk it was sent. */
class Relay {
  readonly lines: string[] = [];
  readonly chunks: string[] = [];
  private inData = false;
  private partial = '';
  constructor(
    readonly stream: Duplex,
    private readonly respond: Respond,
    private readonly onData: (relay: Relay) => void,
  ) {
    stream.on('data', (chunk: Buffer) => this.receive(chunk.toString('latin1')));
    stream.on('error', () => undefined);
  }
  say(text: string) {
    this.stream.write(text);
  }
  private receive(chunk: string) {
    this.chunks.push(chunk);
    this.partial += chunk;
    for (;;) {
      if (this.inData) {
        const end = this.partial.indexOf('\r\n.\r\n');
        if (end < 0) return;
        this.partial = this.partial.slice(end + 5);
        this.inData = false;
        this.onData(this);
        continue;
      }
      const end = this.partial.indexOf('\r\n');
      if (end < 0) return;
      const line = this.partial.slice(0, end);
      this.partial = this.partial.slice(end + 2);
      this.lines.push(line);
      if (line === 'DATA') this.inData = true;
      this.respond(line, this);
    }
  }
}

const standard =
  (overrides: Partial<Record<string, string>> = {}): Respond =>
  (line, relay) => {
    const verb = line.split(/[ :]/)[0]?.toUpperCase() ?? '';
    const override = overrides[verb];
    if (override !== undefined) {
      relay.say(override);
      return;
    }
    if (verb === 'EHLO')
      relay.say(`250-relay ${PROVIDER_TEXT}\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n`);
    else if (verb === 'AUTH') relay.say('235 ok\r\n');
    else if (verb === 'MAIL' || verb === 'RCPT') relay.say('250 ok\r\n');
    else if (verb === 'DATA') relay.say('354 go\r\n');
    else if (verb === 'QUIT') relay.say('221 bye\r\n');
    else relay.say('500 what\r\n');
  };

function setUp(options: {
  respond?: Respond;
  onData?: (relay: Relay) => void;
  greeting?: string | null;
  tls?: 'required' | 'none';
  config?: EmailConfig;
  deadlineMs?: number;
  beforeCommitMs?: number;
  lease?: ConnectorContext['credentials'];
}) {
  const controller = new AbortController();
  const [client, server] = duplexPair();
  const relay = new Relay(
    server,
    options.respond ?? standard(),
    options.onData ?? ((r) => r.say('250 queued\r\n')),
  );
  let opens = 0;
  let leases = 0;
  const context = {
    organizationId: 'org',
    connectionId: 'connection',
    config: options.config ?? config,
    signal: controller.signal,
    credentials: options.lease ?? {
      withCredential: <T>(use: (secret: Buffer) => Promise<T>) => {
        leases += 1;
        return use(SECRET);
      },
    },
    network: {
      openRelay: async () => {
        opens += 1;
        const greeting = options.greeting === undefined ? '220 relay\r\n' : options.greeting;
        if (greeting !== null) server.write(greeting);
        return client;
      },
    },
  } satisfies ConnectorContext<EmailConfig>;
  const connector = createEmailConnector({
    tls: options.tls ?? 'none',
    messageIdDomain: 'mail.example.invalid',
    ...(options.beforeCommitMs === undefined ? {} : { beforeCommitMs: options.beforeCommitMs }),
  });
  if (options.deadlineMs !== undefined) {
    setTimeout(() => controller.abort(), options.deadlineMs).unref();
  }
  return {
    relay,
    controller,
    context,
    connector,
    opens: () => opens,
    leases: () => leases,
    send: (req: ActionRequest = request()) => connector.actions!.send(context, req),
  };
}

/** What runSend would report: NotSent as a result, and anything else as it came. */
async function outcomeOf(promise: Promise<unknown>) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof NotSent) {
      return { outcome: 'not_sent', code: error.code, retryable: error.retryable };
    }
    throw error;
  }
}

describe('a good send', () => {
  it('reports what the relay said, and the Message-ID to search for', async () => {
    const test = setUp({});
    await expect(test.send()).resolves.toEqual({
      outcome: 'accepted',
      code: 'ACCEPTED_BY_RELAY',
      providerStatus: 250,
      externalId: `<${ID}@mail.example.invalid>`,
    });
    expect(test.opens()).toBe(1);
  });

  it('sends the same Message-ID on every attempt', async () => {
    const first = setUp({});
    await first.send(request({ attemptNo: 1 }));
    const second = setUp({});
    await second.send(request({ attemptNo: 2, attemptId: 'another' }));
    const idOf = (relay: Relay) => /Message-ID: (<[^>]+>)/.exec(relay.chunks.join(''))?.[1];
    expect(idOf(first.relay)).toBe(`<${ID}@mail.example.invalid>`);
    expect(idOf(second.relay)).toBe(idOf(first.relay));
  });

  it('addresses the envelope from the approved payload alone, including Bcc', async () => {
    const test = setUp({});
    await test.send(
      request({
        payload: {
          from: { address: 'sender@example.invalid' },
          to: ['to@example.invalid'],
          cc: ['cc@example.invalid'],
          bcc: ['bcc@example.invalid'],
          subject: 'Hello',
          text_body: 'Body',
        },
      }),
    );
    expect(test.relay.lines.filter((l) => l.startsWith('MAIL'))).toEqual([
      'MAIL FROM:<sender@example.invalid>',
    ]);
    expect(test.relay.lines.filter((l) => l.startsWith('RCPT'))).toEqual([
      'RCPT TO:<to@example.invalid>',
      'RCPT TO:<cc@example.invalid>',
      'RCPT TO:<bcc@example.invalid>',
    ]);
    expect(test.relay.chunks.join('').match(/bcc@example\.invalid/g)).toHaveLength(1);
  });

  it('reads a reply split across chunks, and multi-line replies', async () => {
    const later = (relay: Relay, text: string) => setTimeout(() => relay.say(text), 5);
    const test = setUp({
      greeting: '220-relay\r\n22',
      respond: (line, relay) => {
        if (line.startsWith('EHLO')) {
          relay.say('250-a\r\n250-AUTH PL');
          later(relay, 'AIN\r\n250 b\r\n');
        } else {
          standard()(line, relay);
        }
      },
    });
    const sending = test.send();
    later(test.relay, '0 ready\r\n');
    await expect(sending).resolves.toMatchObject({ outcome: 'accepted' });
  });

  it('dot-stuffs what it sends, so a body cannot end the message', async () => {
    const test = setUp({});
    await test.send(
      request({
        payload: {
          from: { address: 'sender@example.invalid' },
          to: ['to@example.invalid'],
          subject: 'Hello',
          text_body: 'before\n.\nafter',
        },
      }),
    );
    const sent = test.relay.chunks.join('');
    expect(sent).toContain('before\r\n..\r\nafter\r\n.\r\n');
    expect(sent.match(/\r\n\.\r\n/g)).toHaveLength(1);
  });
});

describe('the commit point', () => {
  it('writes the terminator on its own, after the body has gone', async () => {
    const test = setUp({});
    await test.send();
    const chunks = test.relay.chunks;
    const terminator = chunks.findIndex((c) => c === '\r\n.\r\n');
    expect(terminator).toBeGreaterThan(0);
    expect(chunks[terminator - 1]).toContain('Plain text');
    expect(chunks[terminator - 1]).not.toContain('\r\n.\r\n');
  });

  it('calls an abort before the terminator not sent, and nothing was committed', async () => {
    const test = setUp({
      deadlineMs: 50,
      respond: (line, relay) => {
        // Waits for ever on the answer to DATA, so the terminator is never written.
        if (line !== 'DATA') standard()(line, relay);
      },
    });
    await expect(outcomeOf(test.send())).resolves.toEqual({
      outcome: 'not_sent',
      code: 'TIMEOUT_BEFORE_COMMIT',
      retryable: true,
    });
    expect(test.relay.chunks.join('')).not.toContain('\r\n.\r\n');
  });

  it('calls a connection lost before the terminator not sent', async () => {
    const test = setUp({
      respond: (line, relay) => {
        if (line === 'DATA') relay.stream.end();
        else standard()(line, relay);
      },
    });
    await expect(outcomeOf(test.send())).resolves.toEqual({
      outcome: 'not_sent',
      code: 'CONNECT_FAILED',
      retryable: true,
    });
  });

  it('does not write the terminator if the relay already spoke during the body', async () => {
    const test = setUp({
      respond: (line, relay) => {
        if (line === 'DATA') relay.say('354 go\r\n421 going away\r\n');
        else standard()(line, relay);
      },
    });
    await expect(outcomeOf(test.send())).resolves.toMatchObject({
      outcome: 'not_sent',
      code: 'RELAY_BUSY',
      retryable: true,
    });
    expect(test.relay.chunks.join('')).not.toContain('\r\n.\r\n');
  });

  it('calls silence after the terminator indeterminate, at the deadline and not before', async () => {
    const started = Date.now();
    const test = setUp({ deadlineMs: 120, onData: () => undefined });
    await expect(test.send()).resolves.toEqual({
      outcome: 'indeterminate',
      code: 'TIMEOUT_AFTER_COMMIT',
      externalId: `<${ID}@mail.example.invalid>`,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(test.opens()).toBe(1);
  });

  it('calls a connection lost after the terminator indeterminate', async () => {
    const test = setUp({ onData: (relay) => relay.stream.end() });
    await expect(test.send()).resolves.toMatchObject({
      outcome: 'indeterminate',
      code: 'CONNECTION_LOST_AFTER_COMMIT',
    });
  });

  it('calls nonsense after the terminator indeterminate', async () => {
    for (const reply of ['nonsense\r\n', '354 go on\r\n']) {
      const test = setUp({
        onData: (relay) => {
          relay.say(reply);
          relay.stream.end();
        },
      });
      await expect(test.send(), reply).resolves.toMatchObject({
        outcome: 'indeterminate',
        code: 'CONNECTION_LOST_AFTER_COMMIT',
      });
    }
  });

  it('calls a refusal after the terminator rejected, keeping the status and not the text', async () => {
    for (const [reply, status] of [
      [`554 ${PROVIDER_TEXT}\r\n`, 554],
      [`451 ${PROVIDER_TEXT}\r\n`, 451],
    ] as const) {
      const test = setUp({ onData: (relay) => relay.say(reply) });
      const result = await test.send();
      expect(result).toMatchObject({
        outcome: 'rejected',
        code: 'REFUSED_BY_PROVIDER',
        providerStatus: status,
      });
      expect(JSON.stringify(result)).not.toContain(PROVIDER_TEXT);
    }
  });

  it('gives up on a stalled relay in time to say for certain that nothing went', async () => {
    // No overall deadline here at all: its own limit has to end this, before runSend's would.
    const test = setUp({ greeting: null, beforeCommitMs: 30 });
    await expect(outcomeOf(test.send())).resolves.toEqual({
      outcome: 'not_sent',
      code: 'TIMEOUT_BEFORE_COMMIT',
      retryable: true,
    });
    const atData = setUp({
      beforeCommitMs: 30,
      respond: (line, relay) => {
        if (line !== 'DATA') standard()(line, relay);
      },
    });
    await expect(outcomeOf(atData.send())).resolves.toMatchObject({ outcome: 'not_sent' });
    expect(atData.relay.chunks.join('')).not.toContain('\r\n.\r\n');
  });

  it('keeps waiting for the reply once past the commit point, whatever that limit was', async () => {
    const started = Date.now();
    const test = setUp({ beforeCommitMs: 30, deadlineMs: 200, onData: () => undefined });
    await expect(test.send()).resolves.toMatchObject({
      outcome: 'indeterminate',
      code: 'TIMEOUT_AFTER_COMMIT',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  it('believes a reply that came just before the connection closed', async () => {
    const test = setUp({
      onData: (relay) => {
        relay.say('250 queued\r\n');
        relay.stream.end();
      },
    });
    await expect(test.send()).resolves.toMatchObject({ outcome: 'accepted' });
  });
});

describe('refusals before the commit point', () => {
  const cases: [string, Parameters<typeof setUp>[0], string, boolean, number?][] = [
    ['a busy greeting', { greeting: '421 busy\r\n' }, 'RELAY_BUSY', true, 421],
    ['a refusing greeting', { greeting: '554 no\r\n' }, 'REFUSED_BY_PROVIDER', false, 554],
    [
      'EHLO refused',
      { respond: standard({ EHLO: '502 no\r\n' }) },
      'REFUSED_BY_PROVIDER',
      false,
      502,
    ],
    ['AUTH refused', { respond: standard({ AUTH: '535 no\r\n' }) }, 'AUTH_FAILED', false, 535],
    ['AUTH busy', { respond: standard({ AUTH: '454 later\r\n' }) }, 'RELAY_BUSY', true, 454],
    [
      'MAIL refused',
      { respond: standard({ MAIL: '550 no\r\n' }) },
      'REFUSED_BY_PROVIDER',
      false,
      550,
    ],
    ['MAIL busy', { respond: standard({ MAIL: '451 later\r\n' }) }, 'RELAY_BUSY', true, 451],
    [
      'RCPT refused',
      { respond: standard({ RCPT: '550 no\r\n' }) },
      'RECIPIENT_REFUSED',
      false,
      550,
    ],
    ['RCPT busy', { respond: standard({ RCPT: '450 later\r\n' }) }, 'RELAY_BUSY', true, 450],
    [
      'DATA refused',
      { respond: standard({ DATA: '554 no\r\n' }) },
      'REFUSED_BY_PROVIDER',
      false,
      554,
    ],
    ['DATA busy', { respond: standard({ DATA: '451 later\r\n' }) }, 'RELAY_BUSY', true, 451],
  ];
  for (const [name, options, code, retryable, status] of cases) {
    it(`reports ${name} as ${code}, retryable ${retryable}`, async () => {
      const test = setUp(options);
      await expect(outcomeOf(test.send())).resolves.toEqual({
        outcome: 'not_sent',
        code,
        retryable,
        providerStatus: status,
      });
    });
  }

  it('sends to nobody if any one recipient is refused: an approval names all of them', async () => {
    const test = setUp({
      respond: (line, relay) => {
        if (line === 'RCPT TO:<second@example.invalid>') relay.say('550 no\r\n');
        else standard()(line, relay);
      },
    });
    await expect(
      outcomeOf(
        test.send(
          request({
            payload: {
              from: { address: 'sender@example.invalid' },
              to: ['first@example.invalid', 'second@example.invalid'],
              subject: 'Hello',
              text_body: 'Body',
            },
          }),
        ),
      ),
    ).resolves.toMatchObject({ outcome: 'not_sent', code: 'RECIPIENT_REFUSED' });
    expect(test.relay.lines).not.toContain('DATA');
    expect(test.relay.chunks.join('')).not.toContain('Body');
  });

  it('calls silence at connect a timeout', async () => {
    const test = setUp({ greeting: null, deadlineMs: 30 });
    await expect(outcomeOf(test.send())).resolves.toEqual({
      outcome: 'not_sent',
      code: 'TIMEOUT_BEFORE_COMMIT',
      retryable: true,
    });
  });

  it('calls a relay that will not connect a connection failure', async () => {
    const test = setUp({});
    test.context.network.openRelay = async () => {
      throw new Error(`refused by ${PROVIDER_TEXT}`);
    };
    await expect(outcomeOf(test.send())).resolves.toEqual({
      outcome: 'not_sent',
      code: 'CONNECT_FAILED',
      retryable: true,
    });
  });

  it('does not read past a garbled or endless reply', async () => {
    const test = setUp({ greeting: `${'x'.repeat(70_000)}\r\n` });
    await expect(outcomeOf(test.send())).resolves.toMatchObject({
      outcome: 'not_sent',
      code: 'CONNECT_FAILED',
    });
  });

  it('puts no provider text in anything it reports', async () => {
    const test = setUp({ greeting: `554 ${PROVIDER_TEXT}\r\n` });
    const seen = await outcomeOf(test.send());
    expect(JSON.stringify(seen)).not.toContain(PROVIDER_TEXT);
    const thrown = setUp({});
    thrown.context.network.openRelay = async () => {
      throw new Error(PROVIDER_TEXT);
    };
    await thrown.send().catch((error: Error) => {
      expect(`${error.message} ${String(error.stack)}`).not.toContain(PROVIDER_TEXT);
    });
  });
});

describe('refused before any contact', () => {
  const refusedBeforeContact = async (test: ReturnType<typeof setUp>, req: ActionRequest) => {
    await expect(outcomeOf(test.send(req))).resolves.toMatchObject({
      outcome: 'not_sent',
      retryable: false,
    });
    expect(test.opens()).toBe(0);
    expect(test.leases()).toBe(0);
  };

  it('refuses a sender that is not the connection’s', async () => {
    await refusedBeforeContact(
      setUp({}),
      request({
        payload: {
          from: { address: 'someone-else@example.invalid' },
          to: ['first@example.invalid'],
          subject: 'Hello',
          text_body: 'Body',
        },
      }),
    );
  });

  it('refuses a payload the contract would not accept', async () => {
    for (const payload of [
      null,
      {},
      {
        from: { address: 'sender@example.invalid' },
        to: ['first@example.invalid'],
        subject: 'Hello\r\nBcc: evil@example.invalid',
        text_body: 'Body',
      },
      {
        from: { address: 'sender@example.invalid' },
        to: ['first@example.invalid\r\nRCPT TO:<evil@example.invalid>'],
        subject: 'Hello',
        text_body: 'Body',
      },
      {
        from: { address: 'sender@example.invalid' },
        to: ['first@example.invalid'],
        subject: 'Hello',
        text_body: 'Body',
        extra: 'unexpected',
      },
    ]) {
      await refusedBeforeContact(setUp({}), request({ payload }));
    }
  });

  it('refuses a tool it did not declare, or another version of its own', async () => {
    await refusedBeforeContact(setUp({}), request({ toolName: 'slack.post' }));
    await refusedBeforeContact(setUp({}), request({ toolVersion: '999' }));
  });

  it('refuses an action ID that could not make a clean Message-ID', async () => {
    await refusedBeforeContact(setUp({}), request({ externalActionId: 'x>\r\nBcc: e@x.invalid' }));
  });

  it('honours a signal already aborted, and contacts nobody', async () => {
    const test = setUp({});
    test.controller.abort();
    await expect(outcomeOf(test.send())).resolves.toEqual({
      outcome: 'not_sent',
      code: 'TIMEOUT_BEFORE_COMMIT',
      retryable: true,
    });
    expect(test.opens()).toBe(0);
  });
});

describe('TLS, with no silent downgrade', () => {
  const withName: EmailConfig = { ...config, tlsServerName: 'relay.example.invalid' };

  it('refuses a relay that does not offer STARTTLS, before lending the credential', async () => {
    const test = setUp({ tls: 'required', config: withName });
    await expect(outcomeOf(test.send())).resolves.toEqual({
      outcome: 'not_sent',
      code: 'TLS_REQUIRED',
      retryable: false,
    });
    expect(test.leases()).toBe(0);
    expect(test.relay.lines.some((l) => l.startsWith('AUTH'))).toBe(false);
    expect(test.relay.lines.some((l) => l.startsWith('MAIL'))).toBe(false);
  });

  it('refuses a relay that offers STARTTLS and then declines', async () => {
    const test = setUp({
      tls: 'required',
      config: withName,
      respond: standard({
        EHLO: '250-relay\r\n250 STARTTLS\r\n',
        STARTTLS: '454 not now\r\n',
      }),
    });
    await expect(outcomeOf(test.send())).resolves.toMatchObject({
      outcome: 'not_sent',
      code: 'TLS_REQUIRED',
      retryable: false,
    });
    expect(test.leases()).toBe(0);
  });

  it('refuses plaintext hidden after the STARTTLS reply, which an attacker could have injected', async () => {
    const test = setUp({
      tls: 'required',
      config: withName,
      respond: standard({
        EHLO: '250-relay\r\n250 STARTTLS\r\n',
        STARTTLS: '220 go\r\n250 injected\r\n',
      }),
    });
    await expect(outcomeOf(test.send())).resolves.toMatchObject({
      outcome: 'not_sent',
      code: 'TLS_REQUIRED',
      retryable: false,
    });
    expect(test.leases()).toBe(0);
  });

  it('refuses to run with no name to check the certificate against', async () => {
    const test = setUp({ tls: 'required' });
    await expect(outcomeOf(test.send())).resolves.toEqual({
      outcome: 'not_sent',
      code: 'TLS_REQUIRED',
      retryable: false,
    });
    expect(test.opens()).toBe(0);
  });

  it('does not try STARTTLS when an operator set TLS to none', async () => {
    const test = setUp({
      tls: 'none',
      respond: (line, relay) => {
        if (line.startsWith('EHLO')) relay.say('250-relay\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n');
        else standard()(line, relay);
      },
    });
    await expect(test.send()).resolves.toMatchObject({ outcome: 'accepted' });
    expect(test.relay.lines).not.toContain('STARTTLS');
  });
});

describe('the credential', () => {
  const decoded = (line: string | undefined) =>
    Buffer.from(line?.split(' ').at(-1) ?? '', 'base64').toString('utf8');

  it('authenticates with PLAIN, as the configured user or the sender', async () => {
    const asSender = setUp({});
    await asSender.send();
    expect(decoded(asSender.relay.lines.find((l) => l.startsWith('AUTH PLAIN')))).toBe(
      `\0sender@example.invalid\0${SECRET.toString()}`,
    );
    const asUser = setUp({ config: { ...config, username: 'relay-user' } });
    await asUser.send();
    expect(decoded(asUser.relay.lines.find((l) => l.startsWith('AUTH PLAIN')))).toBe(
      `\0relay-user\0${SECRET.toString()}`,
    );
  });

  it('falls back to LOGIN when PLAIN is not offered', async () => {
    let step = 0;
    const test = setUp({
      respond: (line, relay) => {
        if (line.startsWith('EHLO')) relay.say('250-relay\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') relay.say('334 VXNlcm5hbWU6\r\n');
        else if (step === 0 && !/^[A-Z]{4}\b/.test(line)) {
          step = 1;
          expect(Buffer.from(line, 'base64').toString()).toBe('sender@example.invalid');
          relay.say('334 UGFzc3dvcmQ6\r\n');
        } else if (step === 1) {
          step = 2;
          expect(Buffer.from(line, 'base64').toString()).toBe(SECRET.toString());
          relay.say('235 ok\r\n');
        } else standard()(line, relay);
      },
    });
    await expect(test.send()).resolves.toMatchObject({ outcome: 'accepted' });
    expect(step).toBe(2);
  });

  it('refuses a relay offering no way to authenticate, and lends nothing', async () => {
    const test = setUp({
      respond: (line, relay) => {
        if (line.startsWith('EHLO')) relay.say('250 relay\r\n');
        else standard()(line, relay);
      },
    });
    await expect(outcomeOf(test.send())).resolves.toEqual({
      outcome: 'not_sent',
      code: 'AUTH_FAILED',
      retryable: false,
    });
    expect(test.leases()).toBe(0);
    expect(test.relay.lines.some((l) => l.startsWith('MAIL'))).toBe(false);
  });

  it('says so when the lease cannot give a credential, and sends nothing', async () => {
    const test = setUp({
      lease: {
        withCredential: async () => {
          throw new Error(`broker says ${SECRET.toString()}`);
        },
      },
    });
    await expect(outcomeOf(test.send())).resolves.toEqual({
      outcome: 'not_sent',
      code: 'CREDENTIAL_UNAVAILABLE',
      retryable: false,
    });
    expect(test.relay.lines.some((l) => l.startsWith('MAIL'))).toBe(false);
  });

  it('never puts the credential in a result or an error, whatever goes wrong', async () => {
    const encoded = Buffer.from(`\0sender@example.invalid\0${SECRET.toString()}`).toString(
      'base64',
    );
    const scenarios: Parameters<typeof setUp>[0][] = [
      {},
      { respond: standard({ AUTH: `535 ${encoded}\r\n` }) },
      { onData: () => undefined, deadlineMs: 20 },
      {
        respond: (line, relay) => {
          if (line.startsWith('AUTH')) relay.stream.end();
          else standard()(line, relay);
        },
      },
    ];
    for (const scenario of scenarios) {
      const seen = await setUp(scenario)
        .send()
        .catch((error: Error) => ({ ...error, message: error.message, stack: error.stack }));
      const text = JSON.stringify(seen);
      expect(text).not.toContain(SECRET.toString());
      expect(text).not.toContain(encoded);
    }
  });
});

describe('reconcile', () => {
  it('answers cannot_answer, and touches neither the network nor the credential', async () => {
    const test = setUp({});
    await expect(test.connector.actions!.reconcile(test.context, request())).resolves.toEqual({
      answer: 'cannot_answer',
    });
    expect(test.opens()).toBe(0);
    expect(test.leases()).toBe(0);
    expect(test.relay.chunks).toEqual([]);
  });
});

describe('the manifest and settings', () => {
  const connector = createEmailConnector({ tls: 'required', messageIdDomain: 'x.example.invalid' });

  it('declares what ADR-027 says, and nothing else', () => {
    expect(connector.manifest).toMatchObject({
      type: EMAIL_CONNECTOR_TYPE,
      capabilities: {
        actions: [EMAIL_SEND_TOOL],
        reconcile: 'none',
        nativeIdempotency: false,
        sync: null,
        aclMapping: false,
        webhooks: null,
        network: 'egress_gateway',
      },
      credential: { required: true, purpose: SECRET_PURPOSE_CONNECTOR_CREDENTIAL },
    });
    expect(connector.actions).toBeDefined();
    expect(connector.sync).toBeUndefined();
    expect(connector.webhooks).toBeUndefined();
  });

  it('accepts the settings it knows', () => {
    const none = createEmailConnector({ tls: 'none', messageIdDomain: 'x.example.invalid' });
    expect(none.parseConfig({ fromAddress: 'a@example.invalid' })).toEqual({
      fromAddress: 'a@example.invalid',
    });
    expect(
      connector.parseConfig({
        fromAddress: 'a@example.invalid',
        fromName: 'A',
        tlsServerName: 'relay.example.invalid',
        username: 'user',
      }),
    ).toMatchObject({ tlsServerName: 'relay.example.invalid' });
  });

  it('refuses settings that could name a host, or anything else it does not know', () => {
    const base = { fromAddress: 'a@example.invalid', tlsServerName: 'relay.example.invalid' };
    for (const raw of [
      null,
      'text',
      {},
      { ...base, host: 'attacker.example.invalid' },
      { ...base, port: 25 },
      { ...base, relay: 'attacker.example.invalid:25' },
      { ...base, fromAddress: 'not-an-address' },
      { ...base, fromAddress: 'a@example.invalid\r\nBcc: e@example.invalid' },
      { ...base, fromName: 'x\r\ny' },
      { ...base, username: 'x\0y' },
      { ...base, username: 'x\r\ny' },
      { ...base, tlsServerName: 'http://attacker.example.invalid/' },
      { ...base, tlsServerName: 'name with space' },
      { ...base, tlsServerName: '10.0.0.1' },
    ]) {
      expect(() => connector.parseConfig(raw), JSON.stringify(raw)).toThrow();
    }
  });

  it('asks for a certificate name when TLS is required', () => {
    expect(() => connector.parseConfig({ fromAddress: 'a@example.invalid' })).toThrow();
  });

  it('refuses a setting without echoing it', () => {
    try {
      connector.parseConfig({ fromAddress: 'canary-setting', password: 'canary-password' });
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('canary');
    }
  });

  it('refuses to be built with a bad Message-ID domain', () => {
    for (const messageIdDomain of ['', 'a b', 'x\r\nBcc: e', 'a>b', '@x']) {
      expect(() => createEmailConnector({ tls: 'none', messageIdDomain })).toThrow();
    }
  });
});
