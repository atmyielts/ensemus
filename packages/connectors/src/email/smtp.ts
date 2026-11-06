// A small SMTP client. It exists because ADR-027 D2 turns on knowing exactly when the terminator was
// written, which a library hides. It sends one message on one connection, and never retries, reads a
// message back or looks anything up. Provider text is parsed here and never leaves: only status numbers
// and fixed codes do. TLS is Node's, with no custom cryptography, and this file wants an outside review.
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import type { AttemptResult, ExternalActionCode } from '@ensemus/domain/external-action';
import { NotSent } from '../index';

/** Unread reply bytes at any moment, more than any real relay sends. Past this it is not SMTP. */
const MAX_REPLY_BYTES = 64 * 1024;
const QUIT_GRACE_MS = 1_000;

export type SmtpDelivery = {
  stream: Duplex;
  signal: AbortSignal;
  /** How long it may take to reach the commit point. See where it is set, in createEmailConnector. */
  beforeCommitMs: number;
  tls: { mode: 'none' } | { mode: 'required'; servername: string; ca?: string };
  /** The name given in EHLO. */
  ehloName: string;
  username: string;
  /**
   * Lends the credential for the login alone. It is asked for only once TLS is up and the relay has
   * offered a way to log in, so a refused relay never gets near it.
   */
  withCredential(use: (secret: Buffer) => Promise<void>): Promise<void>;
  envelopeFrom: string;
  recipients: readonly string[];
  /** Dot-stuffed, with no final CRLF. */
  data: string;
  messageId: string;
};

/** Before the commit point, with a status from the relay. `send` returns it, to keep the status. */
export class RefusedBeforeCommit extends NotSent {
  override name = 'RefusedBeforeCommit';
  constructor(
    code: ExternalActionCode,
    retryable: boolean,
    readonly providerStatus: number,
  ) {
    super(code, retryable);
  }
}

class ConnectionEnded extends Error {
  constructor() {
    super('CONNECTION_ENDED');
  }
}
class DeadlinePassed extends Error {
  constructor() {
    super('DEADLINE_PASSED');
  }
}

/** Reads replies from one stream, and fails every wait the moment the stream or the deadline is gone. */
class ReplyReader {
  private buffer = '';
  private lines: string[] = [];
  private readonly complete: { status: number; lines: string[] }[] = [];
  private capabilities: readonly string[] = [];
  private waiter: (() => void) | null = null;
  private failure: Error | null = null;
  private readonly onFailure = new Set<(error: Error) => void>();
  private detachFrom: (() => void) | null = null;
  private readonly onAbort = () => this.fail(new DeadlinePassed());

  constructor(private readonly signal: AbortSignal) {
    if (signal.aborted) this.onAbort();
    else signal.addEventListener('abort', this.onAbort, { once: true });
  }

  attach(stream: Duplex) {
    this.detach();
    const onData = (chunk: Buffer) => this.receive(chunk.toString('latin1'));
    const onGone = () => this.fail(new ConnectionEnded());
    stream.on('data', onData);
    stream.on('end', onGone);
    stream.on('close', onGone);
    stream.on('error', onGone);
    this.detachFrom = () => {
      stream.off('data', onData);
      stream.off('end', onGone);
      stream.off('close', onGone);
      stream.off('error', onGone);
    };
  }

  detach() {
    this.detachFrom?.();
    this.detachFrom = null;
  }

  dispose() {
    this.detach();
    this.signal.removeEventListener('abort', this.onAbort);
  }

  /** The time before the commit point is up. Only ever called while nothing can have gone. */
  expire() {
    this.fail(new DeadlinePassed());
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const notify of this.onFailure) notify(error);
    this.onFailure.clear();
  }

  /** Bytes after the last reply read, or a whole reply nobody has asked for yet. */
  hasUnread(): boolean {
    return this.buffer.length > 0 || this.lines.length > 0 || this.complete.length > 0;
  }

  /** What the last reply's lines said, upper case. Only EHLO's are ever looked at, and only here. */
  offered(): readonly string[] {
    return this.capabilities;
  }

  private receive(text: string) {
    this.buffer += text;
    if (this.buffer.length > MAX_REPLY_BYTES) {
      this.fail(new ConnectionEnded());
      return;
    }
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      if (!match) {
        this.fail(new ConnectionEnded());
        return;
      }
      this.lines.push((match[3] ?? '').toUpperCase());
      if (match[2] !== '-') {
        this.complete.push({ status: Number(match[1]), lines: this.lines });
        this.lines = [];
        this.waiter?.();
        this.waiter = null;
      }
    }
  }

  /** The next reply's status. A reply already read comes first, even if the stream has since gone. */
  async next(): Promise<number> {
    for (;;) {
      const reply = this.complete.shift();
      if (reply) {
        this.capabilities = reply.lines;
        return reply.status;
      }
      await this.whileAlive(
        new Promise<void>((resolve) => {
          this.waiter = resolve;
        }),
      );
    }
  }

  /** Settles with `work`, or rejects as soon as the stream goes, so a stuck write ends too. */
  whileAlive<T>(work: Promise<T>): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolve, reject) => {
      this.onFailure.add(reject);
      work.then(resolve, reject).finally(() => this.onFailure.delete(reject));
    });
  }
}

/** Anything but a positive reply, before the commit point. */
function refusal(
  status: number,
  denied: ExternalActionCode = 'REFUSED_BY_PROVIDER',
): RefusedBeforeCommit {
  return status >= 400 && status < 500
    ? new RefusedBeforeCommit('RELAY_BUSY', true, status)
    : new RefusedBeforeCommit(denied, false, status);
}

const isPositive = (status: number) => status >= 200 && status < 300;

function writeTo(stream: Duplex, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (error) => (error ? reject(new ConnectionEnded()) : resolve()));
  });
}

/**
 * Upgrades to TLS, with no way to turn checking off. A plaintext byte still unread at this moment was
 * sent before the handshake, by the relay or by someone in between, so the upgrade is refused rather than
 * letting it be read as if TLS had protected it.
 */
function startTls(
  plain: Duplex,
  reader: ReplyReader,
  tls: { servername: string; ca?: string },
): Promise<Duplex> {
  reader.detach();
  return new Promise((resolve, reject) => {
    const options: ConnectionOptions = {
      socket: plain,
      servername: tls.servername,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ...(tls.ca ? { ca: tls.ca } : {}),
    };
    const secured = tlsConnect(options);
    secured.on('error', () => undefined);
    const onError = (error: NodeJS.ErrnoException) => {
      secured.destroy();
      // The connection dying mid-handshake could pass. A certificate that fails its check will not.
      reject(
        error.code === 'ECONNRESET' || error.code === 'EPIPE'
          ? new ConnectionEnded()
          : new NotSent('TLS_REQUIRED', false),
      );
    };
    secured.once('error', onError);
    secured.once('close', () => reject(new ConnectionEnded()));
    secured.once('secureConnect', () => {
      secured.off('error', onError);
      resolve(secured);
    });
  });
}

/**
 * Writes without waiting for the write to finish, and leaves the reply to say what happened. A relay may
 * answer and hang up before the write's callback runs, and that answer is still the answer.
 */
function writeThenRead(stream: Duplex, reader: ReplyReader, data: string | Buffer) {
  const written = writeTo(stream, data).catch(() => undefined);
  return { written, reply: reader.next() };
}

/** Logs in inside the lease. Nothing from the secret goes into an error or stays in a buffer of ours. */
async function logIn(
  reader: ReplyReader,
  stream: Duplex,
  delivery: SmtpDelivery,
  mechanism: 'PLAIN' | 'LOGIN',
): Promise<void> {
  const sendSecretLine = async (line: Buffer) => {
    const { written, reply } = writeThenRead(stream, reader, line);
    // Only once it has been written: the stream is holding this same buffer until then.
    void written.finally(() => line.fill(0));
    return reply;
  };
  let entered = false;
  let status = 0;
  try {
    await delivery.withCredential(async (secret) => {
      entered = true;
      const user = Buffer.from(delivery.username, 'utf8');
      if (mechanism === 'PLAIN') {
        const token = Buffer.concat([Buffer.from([0]), user, Buffer.from([0]), secret]);
        status = await sendSecretLine(Buffer.from(`AUTH PLAIN ${token.toString('base64')}\r\n`));
        token.fill(0);
        return;
      }
      status = await writeThenRead(stream, reader, 'AUTH LOGIN\r\n').reply;
      if (status !== 334) return;
      status = await writeThenRead(stream, reader, `${user.toString('base64')}\r\n`).reply;
      if (status !== 334) return;
      status = await sendSecretLine(Buffer.from(`${secret.toString('base64')}\r\n`));
    });
  } catch (error) {
    if (!entered) throw new NotSent('CREDENTIAL_UNAVAILABLE', false);
    throw error;
  }
  if (status !== 235) throw refusal(status, 'AUTH_FAILED');
}

/**
 * Runs one delivery. Everything up to the commit point that goes wrong is NotSent, and from the first
 * byte of the final CRLF.CRLF on, no reply means nobody can know. See ADR-027 D2.
 */
export async function deliver(delivery: SmtpDelivery): Promise<AttemptResult> {
  const reader = new ReplyReader(delivery.signal);
  let stream = delivery.stream;
  let committed = false;
  let answered = false;
  const beforeCommit = setTimeout(() => reader.expire(), delivery.beforeCommitMs);
  stream.on('error', () => undefined);
  try {
    reader.attach(stream);
    const command = (line: string) => writeThenRead(stream, reader, `${line}\r\n`).reply;

    const greeting = await reader.next();
    if (greeting !== 220) throw refusal(greeting);

    let status = await command(`EHLO ${delivery.ehloName}`);
    if (!isPositive(status)) throw refusal(status);

    if (delivery.tls.mode === 'required') {
      if (!reader.offered().includes('STARTTLS')) throw new NotSent('TLS_REQUIRED', false);
      status = await command('STARTTLS');
      if (status !== 220 || reader.hasUnread()) throw new NotSent('TLS_REQUIRED', false);
      const secured = await reader.whileAlive(startTls(stream, reader, delivery.tls));
      secured.on('error', () => undefined);
      stream = secured;
      reader.attach(stream);
      // What the relay said before TLS could have been written by anyone, so ask again.
      status = await command(`EHLO ${delivery.ehloName}`);
      if (!isPositive(status)) throw refusal(status);
    }

    const login = reader.offered().find((line) => line.startsWith('AUTH '));
    const mechanisms = login?.split(' ').slice(1) ?? [];
    const mechanism = mechanisms.includes('PLAIN')
      ? 'PLAIN'
      : mechanisms.includes('LOGIN')
        ? 'LOGIN'
        : null;
    if (!mechanism) throw new NotSent('AUTH_FAILED', false);
    await logIn(reader, stream, delivery, mechanism);

    status = await command(`MAIL FROM:<${delivery.envelopeFrom}>`);
    if (!isPositive(status)) throw refusal(status);
    for (const recipient of delivery.recipients) {
      status = await command(`RCPT TO:<${recipient}>`);
      // An approval names all of them, so one refused means this message cannot go as approved.
      if (!isPositive(status)) throw refusal(status, 'RECIPIENT_REFUSED');
    }
    status = await command('DATA');
    if (status !== 354) throw refusal(status);

    await reader.whileAlive(writeTo(stream, delivery.data));
    // Writing the body may have been answered. The relay has not been told the message is finished, so
    // this is still before the commit point, and anything it said is a refusal.
    await new Promise((resolve) => setImmediate(resolve));
    if (reader.hasUnread()) throw refusal(await reader.next());

    // The commit point. This line runs before the first byte can leave, so a crash or a failed write
    // from here on reads as "may have sent", which is the safe way round.
    committed = true;
    clearTimeout(beforeCommit);
    status = await writeThenRead(stream, reader, '\r\n.\r\n').reply;
    answered = true;
    const externalId = delivery.messageId;
    if (isPositive(status)) {
      return { outcome: 'accepted', code: 'ACCEPTED_BY_RELAY', providerStatus: status, externalId };
    }
    if (status >= 400 && status < 600) {
      return {
        outcome: 'rejected',
        code: 'REFUSED_BY_PROVIDER',
        providerStatus: status,
        externalId,
      };
    }
    return { outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT', externalId };
  } catch (error) {
    if (committed) {
      return {
        outcome: 'indeterminate',
        code:
          error instanceof DeadlinePassed ? 'TIMEOUT_AFTER_COMMIT' : 'CONNECTION_LOST_AFTER_COMMIT',
        externalId: delivery.messageId,
      };
    }
    if (error instanceof NotSent) throw error;
    throw error instanceof DeadlinePassed
      ? new NotSent('TIMEOUT_BEFORE_COMMIT', true)
      : new NotSent('CONNECT_FAILED', true);
  } finally {
    clearTimeout(beforeCommit);
    reader.dispose();
    if (answered) {
      // Says goodbye without waiting for an answer, which by now cannot change anything.
      stream.end('QUIT\r\n');
      setTimeout(() => stream.destroy(), QUIT_GRACE_MS).unref();
    } else {
      stream.destroy();
      delivery.stream.destroy();
    }
  }
}
