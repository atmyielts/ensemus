// A generated local TLS provider. No certificate, key or token is checked into the repository.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { connect } from 'node:net';
import { createServer, type TLSSocket } from 'node:tls';
import type { ConnectorNetwork } from '@ensemus/connectors';

export type FakeRequest = {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
};
export async function fakeProvider(respond: (request: FakeRequest, socket: TLSSocket) => void) {
  const root = realpathSync(tmpdir()),
    folder = mkdtempSync(join(root, 'ensemus-provider-'));
  let key: Buffer, cert: Buffer;
  try {
    const binary =
      process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
        ? 'C:/Program Files/Git/usr/bin/openssl.exe'
        : 'openssl';
    execFileSync(
      binary,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        join(folder, 'key.pem'),
        '-out',
        join(folder, 'cert.pem'),
        '-subj',
        '/CN=www.googleapis.com',
        '-addext',
        'subjectAltName=DNS:www.googleapis.com,DNS:oauth2.googleapis.com,DNS:graph.microsoft.com,DNS:login.microsoftonline.com,DNS:generated.mcp.invalid,DNS:cdn.example.invalid',
      ],
      { stdio: 'ignore' },
    );
    key = readFileSync(join(folder, 'key.pem'));
    cert = readFileSync(join(folder, 'cert.pem'));
  } finally {
    removeCertificateDirectory(folder, root);
  }
  const sockets = new Set<TLSSocket>(),
    requests: FakeRequest[] = [];
  const server = createServer({ key, cert }, (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0),
      handled = false;
    socket.on('data', (data: Buffer) => {
      if (handled) return;
      pending = Buffer.concat([pending, data]);
      if (pending.length > 1_200_000) {
        socket.destroy();
        return;
      }
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) return;
      const lines = pending.subarray(0, end).toString('latin1').split('\r\n'),
        [method = '', path = ''] = lines.shift()!.split(' '),
        headers: Record<string, string> = {};
      for (const line of lines) {
        const at = line.indexOf(':');
        headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
      }
      const length = Number(headers['content-length'] ?? 0);
      if (pending.length < end + 4 + length) return;
      handled = true;
      const request = {
        method,
        path,
        headers,
        body: Buffer.from(pending.subarray(end + 4, end + 4 + length)),
      };
      requests.push(request);
      respond(request, socket);
    });
  });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MISSING_TEST_ADDRESS');
  const network: ConnectorNetwork = {
    openRelay: ({ signal }) =>
      new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: address.port });
        const abort = () => {
          socket.destroy();
          reject(new Error('ABORTED'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        socket.once('error', reject);
        socket.once('connect', () => {
          signal?.removeEventListener('abort', abort);
          socket.off('error', reject);
          resolve(socket);
        });
        if (signal?.aborted) abort();
      }),
  };
  return {
    network,
    ca: cert,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      key.fill(0);
    },
  };
}
function removeCertificateDirectory(folder: string, root: string) {
  const target = resolve(folder);
  if (
    dirname(target) !== root ||
    !basename(target).startsWith('ensemus-provider-') ||
    lstatSync(target).isSymbolicLink()
  )
    throw new Error('UNSAFE_TEST_CLEANUP');
  rmSync(target, { recursive: true, force: true });
}

export function fakeJson(
  socket: TLSSocket,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
) {
  const bytes = Buffer.from(JSON.stringify(body));
  socket.end(
    `HTTP/1.1 ${status} Generated\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n${Object.entries(
      headers,
    )
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('')}\r\n${bytes.toString()}`,
  );
}
