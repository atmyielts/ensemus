// Owned by the connectors slice (CONNECT-04, CONNECT-05). See docs/06-delivery/m5-slices.md. A small HTTP/1.1
// client over TLS over a gateway's Duplex, because nothing else may open a connection here (lint), and a
// library would bring a way out of its own. Reads a bounded response, and follows no redirect.
import type { ConnectorNetwork } from '../index';
import {
  ProviderHttpFailed,
  ROUTE_TLS_NAMES,
  type ProviderHttpClient,
  type ProviderRoute,
  type ProviderRequest,
  type ProviderResponse,
  type PublicDownloadNetworks,
} from '../knowledge';
import { connect as connectTls, rootCertificates, type TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';

export type ProviderHttpOptions = {
  /** One gateway per route. A route with no gateway answers PROVIDER_ROUTE_UNAVAILABLE. */
  routes: Partial<Readonly<Record<ProviderRoute, ConnectorNetwork>>>;
  /** Only for `mcp_server`, whose name the operator sets with the gateway's target. */
  mcpTlsName?: string;
  /** Extra trust roots, for tests against a local fake only. Never set by a shipped entry point. */
  testCa?: Buffer;
  /** Operator-owned exact CDN names, empty by default. Never read from a connection's settings. */
  downloadHosts?: readonly string[];
  /** Resolves and pins a public target; required even for a name in the operator allowlist. */
  publicDownloads?: PublicDownloadNetworks;
};

export function createProviderHttpClient(options: ProviderHttpOptions): ProviderHttpClient {
  const allowed = new Set((options.downloadHosts ?? []).map((host) => host.toLowerCase()));
  return {
    async request(request) {
      if (request.method === 'DELETE' && request.route !== 'mcp_server')
        throw new ProviderHttpFailed('PROVIDER_RESPONSE_INVALID');
      const network = options.routes[request.route];
      const name =
        request.route === 'mcp_server' ? options.mcpTlsName : ROUTE_TLS_NAMES[request.route];
      if (!network || !name) throw new ProviderHttpFailed('PROVIDER_ROUTE_UNAVAILABLE');
      return exchangeHttpOverRelay(network, name, request, options.testCa);
    },
    async download(request) {
      let target: URL;
      try {
        if (request.url.length > 8192 || unsafeAscii(request.url, 33) || /[\\#]/.test(request.url))
          throw new Error('INVALID_URL');
        target = new URL(request.url);
        if (
          target.protocol !== 'https:' ||
          target.username ||
          target.password ||
          (target.port && target.port !== '443') ||
          !allowed.has(target.hostname.toLowerCase()) ||
          !options.publicDownloads ||
          /^[\d.]+$/.test(target.hostname) ||
          target.hostname.startsWith('[') ||
          /(?:^|\.)(?:localhost|local|internal)$/.test(target.hostname)
        )
          throw new Error('DENIED_TARGET');
      } catch {
        throw new ProviderHttpFailed('PROVIDER_ROUTE_UNAVAILABLE');
      }
      validateLimits(request.timeoutMs, request.maxResponseBytes);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]);
      let network: ConnectorNetwork;
      try {
        network = await abortable(
          options.publicDownloads!.forPublicHost(target.hostname, signal),
          signal,
        );
      } catch (error) {
        throw error instanceof ProviderHttpFailed
          ? error
          : new ProviderHttpFailed(
              signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ROUTE_UNAVAILABLE',
            );
      }
      // This request has no way to inherit Graph's Authorization, cookies or any ambient credential.
      return exchangeHttpOverRelay(
        network,
        target.hostname,
        {
          method: 'GET',
          path: target.pathname + target.search,
          timeoutMs: request.timeoutMs,
          maxResponseBytes: request.maxResponseBytes,
          signal,
        },
        options.testCa,
      );
    },
  };
}

/** Shared bounded TLS transport. Callers supply their own fixed operator-owned route authority. */
export type RelayHttpRequest = Omit<ProviderRequest, 'route'>;
export function exchangeHttpOverRelay(
  network: ConnectorNetwork,
  name: string,
  request: RelayHttpRequest,
  testCa: Buffer | undefined,
): Promise<ProviderResponse> {
  validateLimits(request.timeoutMs, request.maxResponseBytes);
  if (
    !/^[-a-z0-9.]{1,253}$/i.test(name) ||
    !['GET', 'POST', 'DELETE'].includes(request.method) ||
    request.path.length > 8192 ||
    unsafeAscii(request.path, 33) ||
    !/^\/(?!\/)[^\\#]*$/.test(request.path)
  )
    return Promise.reject(new ProviderHttpFailed('PROVIDER_RESPONSE_INVALID'));
  const headers: Record<string, string> = {
    host: name,
    connection: 'close',
    'accept-encoding': 'identity',
  };
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    const lower = key.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) ||
      unsafeAscii(value) ||
      value.length > 16384 ||
      [
        'host',
        'connection',
        'content-length',
        'transfer-encoding',
        'accept-encoding',
        'proxy-authorization',
      ].includes(lower)
    )
      return Promise.reject(new ProviderHttpFailed('PROVIDER_RESPONSE_INVALID'));
    if (headers[lower] !== undefined)
      return Promise.reject(new ProviderHttpFailed('PROVIDER_RESPONSE_INVALID'));
    headers[lower] = value;
  }
  const body = request.body ?? Buffer.alloc(0);
  if (body.length > 1_048_576)
    return Promise.reject(new ProviderHttpFailed('PROVIDER_RESPONSE_TOO_LARGE'));
  headers['content-length'] = String(body.length);
  const head = Buffer.from(
    `${request.method} ${request.path} HTTP/1.1\r\n${Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join('')}\r\n`,
    'latin1',
  );
  if (head.length > 32768)
    return Promise.reject(new ProviderHttpFailed('PROVIDER_RESPONSE_INVALID'));
  return new Promise((resolve, reject) => {
    let relay: Duplex | undefined,
      socket: TLSSocket | undefined,
      finished = false,
      secure = false;
    const cancel = new AbortController(),
      reader = new ResponseReader(request.maxResponseBytes);
    const timer = setTimeout(
      () => finish(new ProviderHttpFailed('PROVIDER_TIMEOUT')),
      request.timeoutMs,
    );
    const abort = () => finish(new ProviderHttpFailed('PROVIDER_TIMEOUT'));
    function finish(error?: ProviderHttpFailed, result?: ProviderResponse) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      cancel.abort();
      socket?.destroy();
      relay?.destroy();
      if (error) reject(error);
      else resolve(result!);
    }
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return;
    }
    let opening: Promise<Duplex>;
    try {
      opening = network.openRelay({ timeoutMs: request.timeoutMs, signal: cancel.signal });
    } catch {
      finish(new ProviderHttpFailed('PROVIDER_CONNECT_FAILED'));
      return;
    }
    opening
      .then((stream) => {
        if (finished) {
          stream.destroy();
          return;
        }
        relay = stream;
        try {
          socket = connectTls({
            socket: stream,
            servername: name,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            ALPNProtocols: ['http/1.1'],
            ...(testCa ? { ca: [...rootCertificates, testCa.toString('utf8')] } : {}),
          });
        } catch {
          finish(new ProviderHttpFailed('PROVIDER_TLS_FAILED'));
          return;
        }
        socket.once('secureConnect', () => {
          secure = true;
          socket!.write(head);
          if (body.length) socket!.write(body);
        });
        socket.on('data', (data: Buffer) => {
          try {
            const result = reader.push(data);
            if (result) finish(undefined, result);
          } catch (error) {
            finish(
              error instanceof ProviderHttpFailed
                ? error
                : new ProviderHttpFailed('PROVIDER_RESPONSE_INVALID'),
            );
          }
        });
        socket.once('end', () => {
          try {
            finish(undefined, reader.end());
          } catch (error) {
            finish(
              error instanceof ProviderHttpFailed
                ? error
                : new ProviderHttpFailed('PROVIDER_RESPONSE_INVALID'),
            );
          }
        });
        socket.once('error', () =>
          finish(
            new ProviderHttpFailed(secure ? 'PROVIDER_RESPONSE_INVALID' : 'PROVIDER_TLS_FAILED'),
          ),
        );
        socket.once('close', () => {
          if (!finished)
            finish(
              new ProviderHttpFailed(secure ? 'PROVIDER_RESPONSE_INVALID' : 'PROVIDER_TLS_FAILED'),
            );
        });
      })
      .catch(() => finish(new ProviderHttpFailed('PROVIDER_CONNECT_FAILED')));
  });
}

/** No connection is reused. Framing and buffering are bounded separately from decoded body bytes. */
class ResponseReader {
  #pending = Buffer.alloc(0);
  #headers: Record<string, string> | null = null;
  #status = 0;
  #mode: 'headers' | 'length' | 'close' | 'size' | 'chunk' | 'crlf' | 'trailers' | 'done' =
    'headers';
  #remaining = 0;
  #bytes = 0;
  #chunks = 0;
  #blocks: Buffer[] = [];
  #blockOffset = 0;
  constructor(readonly max: number) {}
  push(data: Buffer): ProviderResponse | null {
    this.#pending = Buffer.concat([this.#pending, data]);
    for (;;) {
      if (this.#mode === 'headers') {
        const at = this.#pending.indexOf('\r\n\r\n');
        if (at < 0) {
          if (this.#pending.length > 32768) this.#invalid();
          return null;
        }
        if (at > 32768) this.#invalid();
        const lines = this.#pending.subarray(0, at).toString('latin1').split('\r\n');
        const match = /^HTTP\/1\.[01] ([2-5]\d\d)(?: [\x20-\x7e]*)?$/.exec(lines.shift() ?? '');
        if (!match) this.#invalid();
        this.#status = Number(match![1]);
        this.#headers = {};
        for (const line of lines) {
          const colon = line.indexOf(':'),
            key = line.slice(0, colon).toLowerCase(),
            value = line.slice(colon + 1).trim();
          if (colon < 1 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) || unsafeAscii(value))
            this.#invalid();
          if (this.#headers[key] !== undefined) {
            if (['content-length', 'transfer-encoding', 'content-encoding'].includes(key))
              this.#invalid();
            this.#headers[key] += ', ' + value;
          } else this.#headers[key] = value;
        }
        this.#pending = this.#pending.subarray(at + 4);
        const length = this.#headers['content-length'],
          encoding = this.#headers['transfer-encoding'];
        if (length !== undefined && encoding !== undefined) this.#invalid();
        if (
          this.#headers['content-encoding'] &&
          this.#headers['content-encoding']!.toLowerCase() !== 'identity'
        )
          this.#invalid();
        if (encoding !== undefined) {
          if (encoding.toLowerCase() !== 'chunked') this.#invalid();
          this.#mode = 'size';
        } else if (length !== undefined) {
          if (!/^\d{1,16}$/.test(length)) this.#invalid();
          this.#remaining = Number(length);
          if (!Number.isSafeInteger(this.#remaining)) this.#invalid();
          if (this.#remaining > this.max) this.#large();
          this.#mode = this.#remaining ? 'length' : 'done';
        } else this.#mode = this.#status === 204 || this.#status === 304 ? 'done' : 'close';
      } else if (this.#mode === 'length' || this.#mode === 'chunk') {
        const size = Math.min(this.#pending.length, this.#remaining);
        this.#append(this.#pending.subarray(0, size));
        this.#pending = this.#pending.subarray(size);
        this.#remaining -= size;
        if (this.#remaining) return null;
        this.#mode = this.#mode === 'chunk' ? 'crlf' : 'done';
      } else if (this.#mode === 'close') {
        this.#append(this.#pending);
        this.#pending = Buffer.alloc(0);
        return null;
      } else if (this.#mode === 'size') {
        const at = this.#pending.indexOf('\r\n');
        if (at < 0) {
          if (this.#pending.length > 1024) this.#invalid();
          return null;
        }
        if (at > 1024) this.#invalid();
        const line = this.#pending.subarray(0, at).toString('latin1');
        if (!/^[0-9a-f]{1,16}(?:;[\x20-\x7e]*)?$/i.test(line)) this.#invalid();
        this.#remaining = parseInt(line.split(';')[0]!, 16);
        if (!Number.isSafeInteger(this.#remaining)) this.#invalid();
        if (this.#remaining > this.max - this.#bytes) this.#large();
        if (++this.#chunks > 20000) this.#large();
        this.#pending = this.#pending.subarray(at + 2);
        this.#mode = this.#remaining ? 'chunk' : 'trailers';
      } else if (this.#mode === 'crlf') {
        if (this.#pending.length < 2) return null;
        if (this.#pending[0] !== 13 || this.#pending[1] !== 10) this.#invalid();
        this.#pending = this.#pending.subarray(2);
        this.#mode = 'size';
      } else if (this.#mode === 'trailers') {
        if (this.#pending.length >= 2 && this.#pending[0] === 13 && this.#pending[1] === 10) {
          this.#pending = this.#pending.subarray(2);
          this.#mode = 'done';
          continue;
        }
        const at = this.#pending.indexOf('\r\n\r\n');
        if (at < 0) {
          if (this.#pending.length > 32768) this.#invalid();
          return null;
        }
        if (at > 32768) this.#invalid();
        for (const line of this.#pending.subarray(0, at).toString('latin1').split('\r\n')) {
          if (
            !/^[!#$%&'*+.^_`|~0-9a-z-]+: [\x20-\x7e]*$/i.test(line) ||
            /^(?:content-length|transfer-encoding|host|authorization|cookie):/i.test(line)
          )
            this.#invalid();
        }
        this.#pending = this.#pending.subarray(at + 4);
        this.#mode = 'done';
      } else {
        if (this.#pending.length) this.#invalid();
        return this.#result();
      }
    }
  }
  end(): ProviderResponse {
    if (this.#mode !== 'close' && this.#mode !== 'done') this.#invalid();
    return this.#result();
  }
  #append(data: Buffer) {
    if (this.#bytes + data.length > this.max) this.#large();
    let offset = 0;
    while (offset < data.length) {
      if (!this.#blocks.length || this.#blockOffset === this.#blocks.at(-1)!.length) {
        this.#blocks.push(Buffer.allocUnsafe(Math.min(65536, this.max - this.#bytes)));
        this.#blockOffset = 0;
      }
      const block = this.#blocks.at(-1)!,
        size = Math.min(block.length - this.#blockOffset, data.length - offset);
      data.copy(block, this.#blockOffset, offset, offset + size);
      this.#blockOffset += size;
      this.#bytes += size;
      offset += size;
    }
  }
  #result(): ProviderResponse {
    return {
      status: this.#status,
      headers: this.#headers!,
      body: Buffer.concat(
        this.#blocks.map((block, index) =>
          index === this.#blocks.length - 1 ? block.subarray(0, this.#blockOffset) : block,
        ),
        this.#bytes,
      ),
    };
  }
  #invalid(): never {
    throw new ProviderHttpFailed('PROVIDER_RESPONSE_INVALID');
  }
  #large(): never {
    throw new ProviderHttpFailed('PROVIDER_RESPONSE_TOO_LARGE');
  }
}
function validateLimits(timeout: number, max: number) {
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 120000 ||
    !Number.isInteger(max) ||
    max < 1 ||
    max > 33554432
  )
    throw new ProviderHttpFailed('PROVIDER_RESPONSE_INVALID');
}
function unsafeAscii(value: string, min = 32) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < min || code > 126) return true;
  }
  return false;
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProviderHttpFailed('PROVIDER_TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
