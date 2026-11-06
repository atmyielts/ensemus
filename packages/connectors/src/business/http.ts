// A small HTTP/1.1 client over the gateway's stream. It exists for the same reason the SMTP client does
// (ADR-027 D2): whether a repeat is safe turns on knowing exactly when the first byte was written, which a
// library hides, and `node:http` is not allowed here because it opens its own sockets. It sends one request on
// one connection and never retries or follows a redirect. TLS is Node's, with no custom cryptography, and
// this file wants an outside review (ADR-033). A reply's text stays here: only a status and parsed JSON leave.
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import type { ConnectorContext } from '../index';

/** More than any page a protocol-following adapter sends. Past this it is not the protocol. */
export const MAX_ADAPTER_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 32 * 1024;

export type AdapterTransport = {
  tls: 'required' | 'none';
  /** Another certificate authority to trust, such as a site's own. It never turns checking off. */
  ca?: string;
  /** How long to get as far as writing the first byte. */
  beforeCommitMs: number;
  /** How long to wait for the whole answer once the request is written. */
  answerMs: number;
};

export type AdapterRequest = {
  method: 'GET' | 'POST';
  /** Path and query. Always built from fixed parts and encoded IDs, never from a tenant's settings. */
  path: string;
  /** The certificate's name, and the Host header. Null is allowed only when `tls` is `none`. */
  serverName: string | null;
  body?: unknown;
  idempotencyKey?: string;
};

export type AdapterAnswer = { status: number; json: unknown };

/** Nothing was written, so nothing can have reached the adapter. */
export class AdapterNotContacted extends Error {
  override name = 'AdapterNotContacted';
  constructor(
    readonly code:
      | 'CONNECT_FAILED'
      | 'TLS_REQUIRED'
      | 'TIMEOUT_BEFORE_COMMIT'
      | 'AUTH_FAILED'
      | 'CREDENTIAL_UNAVAILABLE',
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

/** The request went out and no usable answer came back, so it may have happened. */
export class AdapterNoAnswer extends Error {
  override name = 'AdapterNoAnswer';
  constructor(readonly code: 'TIMEOUT_AFTER_COMMIT' | 'CONNECTION_LOST_AFTER_COMMIT') {
    super(code);
  }
}

const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

function secureStream(
  raw: Duplex,
  serverName: string,
  transport: AdapterTransport,
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const options: ConnectionOptions = {
      socket: raw,
      servername: serverName,
      // Stated, so that nobody later reads the default as a choice. A failed check is never ignored.
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ...(transport.ca ? { ca: transport.ca } : {}),
    };
    const secured = tlsConnect(options);
    const onError = (error: NodeJS.ErrnoException) => {
      secured.destroy();
      reject(
        error.code === 'ECONNRESET' || error.code === 'EPIPE'
          ? new AdapterNotContacted('CONNECT_FAILED', true)
          : new AdapterNotContacted('TLS_REQUIRED', false),
      );
    };
    secured.once('error', onError);
    secured.once('secureConnect', () => {
      secured.off('error', onError);
      secured.on('error', () => undefined);
      resolve(secured);
    });
  });
}

function decodeChunked(body: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = body.indexOf('\r\n', at);
    if (lineEnd === -1) return null;
    const size = Number.parseInt(body.subarray(at, lineEnd).toString('latin1').split(';')[0] ?? '', 16);
    if (!Number.isInteger(size) || size < 0) return null;
    const start = lineEnd + 2;
    if (size === 0) return Buffer.concat(parts);
    if (start + size > body.length) return null;
    parts.push(body.subarray(start, start + size));
    at = start + size + 2;
  }
}

type Parsed = { status: number; body: Buffer } | null;

/** Whatever has arrived so far, as an answer, or null if it is not complete yet. */
function parseResponse(bytes: Buffer, ended: boolean): Parsed | 'invalid' {
  const headerEnd = bytes.indexOf('\r\n\r\n');
  if (headerEnd === -1) return bytes.length > MAX_HEADER_BYTES ? 'invalid' : null;
  const head = bytes.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const statusLine = /^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '');
  if (!statusLine) return 'invalid';
  const status = Number(statusLine[1]);
  const headers = new Map<string, string>();
  for (const line of head.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const body = bytes.subarray(headerEnd + 4);
  if ((headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
    const decoded = decodeChunked(body);
    if (decoded) return { status, body: decoded };
    return ended ? 'invalid' : null;
  }
  const length = headers.get('content-length');
  if (length !== undefined) {
    const expected = Number(length);
    if (!Number.isSafeInteger(expected) || expected < 0) return 'invalid';
    if (body.length >= expected) return { status, body: body.subarray(0, expected) };
    return ended ? 'invalid' : null;
  }
  return ended ? { status, body } : null;
}

function readAnswer(
  stream: Duplex,
  signal: AbortSignal,
  answerMs: number,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onError);
      run();
    };
    const lost = () => reject(new AdapterNoAnswer('CONNECTION_LOST_AFTER_COMMIT'));
    const check = (ended: boolean) => {
      const parsed = parseResponse(Buffer.concat(chunks), ended);
      if (parsed === 'invalid') finish(lost);
      else if (parsed) finish(() => resolve(parsed));
      else if (ended) finish(lost);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_ADAPTER_RESPONSE_BYTES) finish(lost);
      else check(false);
    };
    const onEnd = () => check(true);
    const onError = () => finish(lost);
    const onAbort = () => finish(() => reject(new AdapterNoAnswer('TIMEOUT_AFTER_COMMIT')));
    const timer = setTimeout(onAbort, answerMs);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    stream.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function requestBytes(request: AdapterRequest, secret: Buffer): Buffer {
  const token = secret.toString('latin1').trim();
  // A credential with a line break in it would be a header of its own, so it never gets that far.
  if (!token || !HEADER_VALUE.test(token)) throw new AdapterNotContacted('AUTH_FAILED', false);
  const body = request.body === undefined ? null : Buffer.from(JSON.stringify(request.body));
  const lines = [
    `${request.method} ${request.path} HTTP/1.1`,
    `Host: ${request.serverName ?? 'adapter.invalid'}`,
    'Connection: close',
    'Accept: application/json',
    `Authorization: Bearer ${token}`,
  ];
  if (request.idempotencyKey !== undefined) {
    if (!HEADER_VALUE.test(request.idempotencyKey)) {
      throw new AdapterNotContacted('CONNECT_FAILED', false);
    }
    lines.push(`Idempotency-Key: ${request.idempotencyKey}`);
  }
  if (body) lines.push('Content-Type: application/json', `Content-Length: ${body.length}`);
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  return body ? Buffer.concat([head, body]) : head;
}

const parseJson = (body: Buffer): unknown => {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
};

/**
 * One request, inside one credential lease, so the secret is wiped as soon as this returns. Throws
 * AdapterNotContacted while nothing has been written, and AdapterNoAnswer after. Anything that comes back
 * with a status is an answer, whatever it says, and what it means is the caller's to decide.
 */
export async function adapterExchange(
  context: Pick<ConnectorContext, 'credentials' | 'network' | 'signal'>,
  transport: AdapterTransport,
  request: AdapterRequest,
): Promise<AdapterAnswer> {
  if (transport.tls === 'required' && !request.serverName) {
    throw new AdapterNotContacted('TLS_REQUIRED', false);
  }
  const { signal } = context;

  // Up to the first byte, on one clock. Past this point silence means it may have happened.
  const stalled = AbortSignal.any([signal, AbortSignal.timeout(transport.beforeCommitMs)]);
  const beforeCommit = <T>(work: Promise<T>, cleanUp?: (value: T) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const onStall = () => {
        work.then((value) => cleanUp?.(value)).catch(() => undefined);
        reject(new AdapterNotContacted('TIMEOUT_BEFORE_COMMIT', true));
      };
      if (stalled.aborted) {
        onStall();
        return;
      }
      stalled.addEventListener('abort', onStall, { once: true });
      work.then(
        (value) => {
          stalled.removeEventListener('abort', onStall);
          resolve(value);
        },
        (error: unknown) => {
          stalled.removeEventListener('abort', onStall);
          reject(error);
        },
      );
    });

  let raw: Duplex;
  try {
    raw = await beforeCommit(
      context.network.openRelay({ timeoutMs: transport.beforeCommitMs, signal }),
      (late) => late.destroy(),
    );
  } catch (error) {
    if (error instanceof AdapterNotContacted) throw error;
    throw new AdapterNotContacted('CONNECT_FAILED', true);
  }
  raw.on('error', () => undefined);
  let stream = raw;
  try {
    if (transport.tls === 'required') {
      stream = await beforeCommit(
        secureStream(raw, request.serverName as string, transport),
        (late) => late.destroy(),
      );
    }
    let lent = false;
    try {
      return await context.credentials.withCredential(async (secret) => {
        lent = true;
        const bytes = requestBytes(request, secret);
        if (stalled.aborted) throw new AdapterNotContacted('TIMEOUT_BEFORE_COMMIT', true);
        // The commit point: from the next line on, the adapter may have it.
        stream.write(bytes);
        const answer = await readAnswer(stream, signal, transport.answerMs);
        return { status: answer.status, json: parseJson(answer.body) };
      });
    } catch (error) {
      // A credential that would not open is ours and not theirs, and nothing has been written.
      if (!lent) throw new AdapterNotContacted('CREDENTIAL_UNAVAILABLE', false);
      throw error;
    }
  } finally {
    stream.destroy();
    raw.destroy();
  }
}
