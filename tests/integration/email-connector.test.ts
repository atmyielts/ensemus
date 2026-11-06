// The real SMTP client and the real connector over real sockets, against a test relay. Nothing here leaves
// this machine: the sink listens on 127.0.0.1, and every address and secret is generated.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotSent, type ActionRequest, type ConnectorContext } from '@ensemus/connectors';
import { createEmailConnector, type EmailConfig } from '@ensemus/connectors/email';
import { createGatewayNetwork, runSend } from '@ensemus/connectors/runtime';
import { EMAIL_SEND_TOOL, EMAIL_SEND_VERSION } from '@ensemus/domain/external-action';
import { startEgressGateway } from '../../workers/workflow/src/egress-gateway';
import {
  generateTestCertificate,
  startSmtpSink,
  type SinkMode,
  type StartedSink,
} from '../helpers/smtp-sink';

const SECRET = randomBytes(24).toString('hex');
const SENDER = 'sender@example.invalid';
const RELAY_NAME = 'relay.example.invalid';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function sink(mode: SinkMode, options: { tls?: { key: string; cert: string } } = {}) {
  const started = await startSmtpSink({ mode, ...options });
  closers.push(() => started.close());
  return started;
}

const requestFor = (payload: Record<string, unknown> = {}): ActionRequest => {
  const externalActionId = randomUUID();
  return {
    externalActionId,
    attemptId: randomUUID(),
    attemptNo: 1,
    toolName: EMAIL_SEND_TOOL,
    toolVersion: EMAIL_SEND_VERSION,
    idempotencyKey: `ensemus-${externalActionId}`,
    requestHash: 'hash',
    payload: {
      from: { address: SENDER },
      to: ['first@example.invalid'],
      subject: 'Hello',
      text_body: 'Plain text',
      ...payload,
    },
  };
};

function run(
  relay: { port: number },
  options: {
    tls?: 'required' | 'none';
    config?: Partial<EmailConfig>;
    deadlineMs?: number;
    ca?: string;
    request?: ActionRequest;
  } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.deadlineMs ?? 5_000);
  const connector = createEmailConnector({
    tls: options.tls ?? 'none',
    messageIdDomain: 'mail.example.invalid',
    ...(options.ca ? { ca: options.ca } : {}),
  });
  const context: ConnectorContext<EmailConfig> = {
    organizationId: randomUUID(),
    connectionId: randomUUID(),
    config: connector.parseConfig({
      fromAddress: SENDER,
      ...(options.tls === 'required' ? { tlsServerName: RELAY_NAME } : {}),
      ...options.config,
    }),
    signal: controller.signal,
    credentials: { withCredential: (use) => use(Buffer.from(SECRET)) },
    network: createGatewayNetwork(`127.0.0.1:${relay.port}`),
  };
  const request = options.request ?? requestFor();
  return connector
    .actions!.send(context, request)
    .catch((error: unknown) => {
      if (error instanceof NotSent) {
        return { outcome: 'not_sent', code: error.code, retryable: error.retryable };
      }
      throw error;
    })
    .finally(() => clearTimeout(timer));
}

describe('every sink mode, against the real client', () => {
  it('accept: one message, with the exact envelope, and a receipt', async () => {
    const relay = await sink('accept');
    const request = requestFor({
      to: ['to@example.invalid'],
      cc: ['cc@example.invalid'],
      bcc: ['bcc@example.invalid'],
      reply_to: 'reply@example.invalid',
    });
    await expect(run(relay, { request })).resolves.toEqual({
      outcome: 'accepted',
      code: 'ACCEPTED_BY_RELAY',
      providerStatus: 250,
      externalId: `<${request.externalActionId}@mail.example.invalid>`,
    });
    const [message, ...rest] = relay.messages();
    expect(rest).toEqual([]);
    expect(message?.mailFrom).toBe(SENDER);
    expect(message?.rcptTo).toEqual([
      'to@example.invalid',
      'cc@example.invalid',
      'bcc@example.invalid',
    ]);
    expect(message?.authenticatedAs).toBe(SENDER);
    expect(message?.raw).toContain(
      `Message-ID: <${request.externalActionId}@mail.example.invalid>`,
    );
    expect(message?.raw).toContain('Reply-To: reply@example.invalid');
    expect(message?.raw).not.toContain('bcc@example.invalid');
    expect(message?.raw.endsWith('\r\n\r\nPlain text')).toBe(true);
  });

  it('accept_then_silent: one message, indeterminate after the deadline, no second connection', async () => {
    const relay = await sink('accept_then_silent');
    const started = Date.now();
    await expect(run(relay, { deadlineMs: 400 })).resolves.toMatchObject({
      outcome: 'indeterminate',
      code: 'TIMEOUT_AFTER_COMMIT',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(relay.messages()).toHaveLength(1);
    // Long enough for anything that meant to come back.
    await new Promise((done) => setTimeout(done, 300));
    expect(relay.messages()).toHaveLength(1);
    expect(relay.connections()).toBe(1);
  });

  it('drop_after_data: one message, indeterminate, no second connection', async () => {
    const relay = await sink('drop_after_data');
    await expect(run(relay)).resolves.toMatchObject({
      outcome: 'indeterminate',
      code: 'CONNECTION_LOST_AFTER_COMMIT',
    });
    expect(relay.messages()).toHaveLength(1);
    expect(relay.connections()).toBe(1);
  });

  it('refuse_recipient: not sent, not retryable, and no data ever goes', async () => {
    const relay = await sink('refuse_recipient');
    await expect(run(relay)).resolves.toMatchObject({
      outcome: 'not_sent',
      code: 'RECIPIENT_REFUSED',
      retryable: false,
      providerStatus: 550,
    });
    expect(relay.messages()).toEqual([]);
  });

  it('refuse_after_data: rejected, with the status', async () => {
    const relay = await sink('refuse_after_data');
    await expect(run(relay)).resolves.toMatchObject({
      outcome: 'rejected',
      code: 'REFUSED_BY_PROVIDER',
      providerStatus: 554,
    });
    expect(relay.messages()).toEqual([]);
  });

  it('busy: not sent, and worth trying again', async () => {
    const relay = await sink('busy');
    await expect(run(relay)).resolves.toMatchObject({
      outcome: 'not_sent',
      code: 'RELAY_BUSY',
      retryable: true,
      providerStatus: 421,
    });
    expect(relay.messages()).toEqual([]);
  });

  it('silent_on_connect: not sent at the deadline, and worth trying again', async () => {
    const relay = await sink('silent_on_connect');
    await expect(run(relay, { deadlineMs: 200 })).resolves.toEqual({
      outcome: 'not_sent',
      code: 'TIMEOUT_BEFORE_COMMIT',
      retryable: true,
    });
    expect(relay.messages()).toEqual([]);
  });

  it('a relay that is not there: not sent, and worth trying again', async () => {
    const gone = await startSmtpSink({ mode: 'accept' });
    const { port } = gone;
    await gone.close();
    await expect(run({ port })).resolves.toEqual({
      outcome: 'not_sent',
      code: 'CONNECT_FAILED',
      retryable: true,
    });
  });

  it('can change mode while running, as the stack tests need', async () => {
    const relay = await sink('accept');
    await expect(run(relay)).resolves.toMatchObject({ outcome: 'accepted' });
    relay.setMode('refuse_recipient');
    await expect(run(relay)).resolves.toMatchObject({ code: 'RECIPIENT_REFUSED' });
    expect(relay.messages()).toHaveLength(1);
  });
});

// runSend is the sdk slice's. These join in once it is merged, and do not pretend to pass before then.
const runSendExists = (() => {
  try {
    void runSend({
      connector: { manifest: {}, parseConfig: () => ({}) },
      context: {},
      request: {},
    } as never);
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(runSendExists)('through the real runSend', () => {
  const through = (relay: { port: number }, deadlineMs: number) => {
    const connector = createEmailConnector({
      tls: 'none',
      messageIdDomain: 'mail.example.invalid',
      beforeCommitMs: 200,
    });
    return runSend({
      connector: connector as never,
      deadlineMs,
      request: requestFor(),
      context: {
        organizationId: randomUUID(),
        connectionId: randomUUID(),
        config: connector.parseConfig({ fromAddress: SENDER }),
        credentials: { withCredential: (use) => use(Buffer.from(SECRET)) },
        network: createGatewayNetwork(`127.0.0.1:${relay.port}`),
      },
    });
  };

  it('silence at connect is not sent, and not a false unknown', async () => {
    const relay = await sink('silent_on_connect');
    await expect(through(relay, 2_000)).resolves.toEqual({
      outcome: 'not_sent',
      code: 'TIMEOUT_BEFORE_COMMIT',
      retryable: true,
    });
  });

  it('silence after the terminator is indeterminate, one message, one connection', async () => {
    const relay = await sink('accept_then_silent');
    await expect(through(relay, 500)).resolves.toMatchObject({
      outcome: 'indeterminate',
      code: 'TIMEOUT_AFTER_COMMIT',
    });
    expect(relay.messages()).toHaveLength(1);
    expect(relay.connections()).toBe(1);
  });

  it('a refused recipient keeps its status, and a good send its Message-ID', async () => {
    const refused = await sink('refuse_recipient');
    await expect(through(refused, 2_000)).resolves.toEqual({
      outcome: 'not_sent',
      code: 'RECIPIENT_REFUSED',
      providerStatus: 550,
      retryable: false,
    });
    const accepted = await sink('accept');
    await expect(through(accepted, 2_000)).resolves.toMatchObject({
      outcome: 'accepted',
      code: 'ACCEPTED_BY_RELAY',
      providerStatus: 250,
      externalId: expect.stringContaining('@mail.example.invalid>'),
    });
  });
});

describe('what arrives is what was approved', () => {
  it('survives an 8-bit body, a dot on its own line and a long line', async () => {
    const relay = await sink('accept');
    const body = `Déjà vu 日本語\n.\n.leading dot\n${'x'.repeat(2000)}\nlast`;
    await run(relay, { request: requestFor({ text_body: body, subject: 'Résumé 日本語' }) });
    const [message] = relay.messages();
    expect(/^[\t\r\n\x20-\x7e]*$/.test(message?.raw ?? '')).toBe(true);
    expect(message?.raw).toContain('Content-Transfer-Encoding: quoted-printable');
    const encoded = message?.raw.slice((message?.raw.indexOf('\r\n\r\n') ?? 0) + 4) ?? '';
    const decoded = Buffer.from(
      encoded
        .replace(/=\r\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        ),
      'latin1',
    ).toString('utf8');
    expect(decoded).toBe(body.replace(/\n/g, '\r\n'));
  });

  it('never lets an injected recipient or header reach the relay', async () => {
    const relay = await sink('accept');
    const injected = 'evil@example.invalid';
    for (const payload of [
      { subject: `Hello\r\nBcc: ${injected}` },
      { to: [`first@example.invalid>\r\nRCPT TO:<${injected}`] },
      { from: { address: SENDER, name: `Name\r\nBcc: ${injected}` } },
      { reply_to: `a@example.invalid\r\nBcc: ${injected}` },
    ]) {
      await expect(run(relay, { request: requestFor(payload) })).resolves.toMatchObject({
        outcome: 'not_sent',
        retryable: false,
      });
    }
    expect(relay.messages()).toEqual([]);
    expect(relay.connections()).toBe(0);
  });

  it('refuses a sender that is not the connection’s, without connecting', async () => {
    const relay = await sink('accept');
    await expect(
      run(relay, { request: requestFor({ from: { address: 'other@example.invalid' } }) }),
    ).resolves.toMatchObject({ outcome: 'not_sent', retryable: false });
    expect(relay.connections()).toBe(0);
  });

  it('sends to the payload’s recipients with the configured login, and no looked-up address', async () => {
    const relay = await sink('accept');
    await run(relay, { config: { username: 'relay-user' } });
    expect(relay.messages()[0]?.authenticatedAs).toBe('relay-user');
    expect(relay.messages()[0]?.rcptTo).toEqual(['first@example.invalid']);
  });
});

describe('TLS, against a real handshake', () => {
  const certificate = generateTestCertificate(RELAY_NAME);

  it('sends over STARTTLS when the certificate checks out', async () => {
    const relay = await sink('accept', { tls: certificate });
    await expect(run(relay, { tls: 'required', ca: certificate.cert })).resolves.toMatchObject({
      outcome: 'accepted',
    });
    const [message] = relay.messages();
    expect(message?.tls).toBe(true);
    expect(message?.authenticatedAs).toBe(SENDER);
  });

  it('refuses a certificate nobody vouches for, and the credential does not go', async () => {
    const relay = await sink('accept', { tls: certificate });
    await expect(run(relay, { tls: 'required' })).resolves.toEqual({
      outcome: 'not_sent',
      code: 'TLS_REQUIRED',
      retryable: false,
    });
    expect(relay.messages()).toEqual([]);
    expect(relay.authAttempts()).toBe(0);
  });

  it('refuses a certificate for another name, even from a trusted issuer', async () => {
    const other = generateTestCertificate('other.example.invalid');
    const relay = await sink('accept', { tls: other });
    await expect(run(relay, { tls: 'required', ca: other.cert })).resolves.toEqual({
      outcome: 'not_sent',
      code: 'TLS_REQUIRED',
      retryable: false,
    });
    expect(relay.messages()).toEqual([]);
    expect(relay.authAttempts()).toBe(0);
  });

  it('refuses a relay that strips STARTTLS, rather than going on in plain text', async () => {
    const relay = await sink('accept');
    await expect(run(relay, { tls: 'required' })).resolves.toEqual({
      outcome: 'not_sent',
      code: 'TLS_REQUIRED',
      retryable: false,
    });
    expect(relay.messages()).toEqual([]);
    expect(relay.authAttempts()).toBe(0);
  });
});

describe('the credential', () => {
  it('is never in a thrown error, a log line or a result, in any mode', async () => {
    const seen: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        seen.push(JSON.stringify(args));
      });
    }
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      seen.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      seen.push(String(chunk));
      return true;
    });
    const modes: SinkMode[] = [
      'accept',
      'accept_then_silent',
      'refuse_recipient',
      'refuse_after_data',
      'busy',
      'silent_on_connect',
      'drop_after_data',
    ];
    for (const mode of modes) {
      const relay = await sink(mode);
      const result = await run(relay, { deadlineMs: 200 }).catch((error: Error) => ({
        ...error,
        message: error.message,
        stack: error.stack,
      }));
      seen.push(JSON.stringify(result));
      for (const message of relay.messages()) seen.push(JSON.stringify(message));
    }
    stdout.mockRestore();
    stderr.mockRestore();
    const everything = seen.join('\n');
    expect(everything).toContain('outcome');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(Buffer.from(SECRET).toString('base64'));
    expect(everything).not.toContain(Buffer.from(`\0${SENDER}\0${SECRET}`).toString('base64'));
  });
});

describe('through the real egress gateway', () => {
  async function throughGateway(relay: StartedSink) {
    const gateway = await startEgressGateway({
      target: `127.0.0.1:${relay.port}`,
      listenHost: '127.0.0.1',
      listenPort: 0,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    closers.push(() => gateway.close());
    return gateway;
  }

  it('reaches the one target and sends one message', async () => {
    const relay = await sink('accept');
    const gateway = await throughGateway(relay);
    await expect(run(gateway)).resolves.toMatchObject({ outcome: 'accepted' });
    expect(relay.messages()).toHaveLength(1);
    expect(relay.connections()).toBe(1);
  });

  it('carries a TLS session it cannot read, ending in the same certificate check', async () => {
    const certificate = generateTestCertificate(RELAY_NAME);
    const relay = await sink('accept', { tls: certificate });
    const gateway = await throughGateway(relay);
    await expect(run(gateway, { tls: 'required', ca: certificate.cert })).resolves.toMatchObject({
      outcome: 'accepted',
    });
    expect(relay.messages()[0]?.tls).toBe(true);
  });

  it('keeps silence after the terminator indeterminate, with one message and one connection', async () => {
    const relay = await sink('accept_then_silent');
    const gateway = await throughGateway(relay);
    await expect(run(gateway, { deadlineMs: 300 })).resolves.toMatchObject({
      outcome: 'indeterminate',
      code: 'TIMEOUT_AFTER_COMMIT',
    });
    expect(relay.messages()).toHaveLength(1);
    expect(relay.connections()).toBe(1);
  });

  it('calls a target that is gone not sent, since the relay never spoke', async () => {
    const gone = await startSmtpSink({ mode: 'accept' });
    const gateway = await throughGateway(gone);
    await gone.close();
    await expect(run(gateway)).resolves.toEqual({
      outcome: 'not_sent',
      code: 'CONNECT_FAILED',
      retryable: true,
    });
  });
});
