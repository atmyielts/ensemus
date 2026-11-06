// TR-022 and the guard half of FAULT-10, on real sockets: local servers and a fake resolver, so a test
// proves where a connection actually went and never leaves this machine.
import { createServer, type RequestListener, type Server } from 'node:http';
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
} from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { VerifiedEndpoint } from '../types';
import {
  createEndpointGuard,
  EndpointRefused,
  EndpointUnreachable,
  ResponseTooLarge,
  type Resolver,
} from './guard';

const open: (Server | TcpServer)[] = [];

const listen = (server: Server | TcpServer, host: string, port = 0) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      open.push(server);
      resolve((server.address() as AddressInfo).port);
    });
  });

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if ('closeAllConnections' in server) server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

type Honest = { port: number; hits: { host?: string; address?: string }[] };

async function startServer(host = '127.0.0.1', handler?: RequestListener, port = 0) {
  const hits: Honest['hits'] = [];
  const server = createServer((req, res) => {
    hits.push({
      ...(req.headers.host ? { host: req.headers.host } : {}),
      ...(req.socket.localAddress ? { address: req.socket.localAddress } : {}),
    });
    if (handler) handler(req, res);
    else res.end('hello');
  });
  return { port: await listen(server, host, port), hits };
}

const resolverOf = (...answers: (readonly { address: string; family: 4 | 6 }[])[]) => {
  const calls: string[] = [];
  const resolve: Resolver = async (host) => {
    calls.push(host);
    const next = answers[calls.length - 1] ?? answers[answers.length - 1];
    return next ?? [];
  };
  return { resolve, calls };
};

const local = (address: string) => [{ address, family: 4 as const }];

const endpoint = (overrides: Partial<VerifiedEndpoint> = {}): VerifiedEndpoint => ({
  host: 'model.example.test',
  port: 80,
  protocol: 'http:',
  viaPrivateAllowlist: true,
  ...overrides,
});

const urlOn = (e: VerifiedEndpoint, path = '/v1/chat') =>
  `${e.protocol}//${e.host}:${e.port}${path}`;

describe('addresses the guard refuses on a DNS answer', () => {
  it.each([
    ['cloud metadata', '169.254.169.254', 4],
    ['link-local', '169.254.10.10', 4],
    ['RFC1918 10/8', '10.0.0.1', 4],
    ['RFC1918 172.16/12', '172.16.0.1', 4],
    ['RFC1918 192.168/16', '192.168.0.1', 4],
    ['loopback', '127.0.0.1', 4],
    ['IPv6 loopback', '::1', 6],
    ['IPv6-mapped loopback', '::ffff:127.0.0.1', 6],
    ['IPv6-mapped RFC1918', '::ffff:10.0.0.1', 6],
    ['IPv6-mapped metadata', '::ffff:169.254.169.254', 6],
    ['IPv6 link-local', 'fe80::1', 6],
    ['IPv6 unique-local', 'fd00::1', 6],
    ['unspecified', '0.0.0.0', 4],
  ] as const)('%s, %s, with no operator listing', async (_label, address, family) => {
    const guard = createEndpointGuard(resolverOf([{ address, family }]));
    const e = endpoint({ protocol: 'https:', port: 443, viaPrivateAllowlist: false });
    await expect(guard.fetchFor(e)(urlOn(e))).rejects.toBeInstanceOf(EndpointRefused);
  });

  it.each([
    ['cloud metadata', '169.254.169.254', 4],
    ['IPv6 link-local', 'fe80::1', 6],
    ['IPv6-mapped metadata', '::ffff:169.254.169.254', 6],
    ['unspecified', '0.0.0.0', 4],
  ] as const)('%s even when the operator listed the name', async (_label, address, family) => {
    const guard = createEndpointGuard(resolverOf([{ address, family }]));
    const e = endpoint();
    await expect(guard.fetchFor(e)(urlOn(e))).rejects.toBeInstanceOf(EndpointRefused);
  });

  it('refuses when any answer is bad, even if a good one came first', async () => {
    const { port, hits } = await startServer();
    const guard = createEndpointGuard(
      resolverOf([
        { address: '127.0.0.1', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
    );
    const e = endpoint({ port });
    await expect(guard.fetchFor(e)(urlOn(e))).rejects.toBeInstanceOf(EndpointRefused);
    expect(hits).toHaveLength(0);
  });

  it('refuses a public-looking name answering with loopback, with no connection made', async () => {
    const { port, hits } = await startServer();
    const guard = createEndpointGuard(resolverOf(local('127.0.0.1')));
    const e = endpoint({ port, protocol: 'https:', viaPrivateAllowlist: false });
    await expect(guard.fetchFor(e)(urlOn(e))).rejects.toBeInstanceOf(EndpointRefused);
    expect(hits).toHaveLength(0);
  });
});

describe('address literals', () => {
  it.each([
    ['127.0.0.1'],
    ['10.0.0.1'],
    ['169.254.169.254'],
    ['[::1]'],
    ['[::ffff:127.0.0.1]'],
    ['[fe80::1]'],
  ])('%s is refused with no operator listing, without asking DNS', async (host) => {
    const { resolve, calls } = resolverOf(local('93.184.216.34'));
    const guard = createEndpointGuard({ resolve });
    const e = endpoint({ host, port: 443, protocol: 'https:', viaPrivateAllowlist: false });
    await expect(guard.fetchFor(e)(`https://${host}/v1`)).rejects.toBeInstanceOf(EndpointRefused);
    expect(calls).toHaveLength(0);
  });

  it('a listed loopback literal connects, with no DNS', async () => {
    const { port, hits } = await startServer();
    const { resolve, calls } = resolverOf();
    const e = endpoint({ host: '127.0.0.1', port });
    const response = await createEndpointGuard({ resolve }).fetchFor(e)(urlOn(e));
    expect(await response.text()).toBe('hello');
    expect(hits).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('metadata stays refused as a literal even with the flag set', async () => {
    const e = endpoint({ host: '169.254.169.254', port: 80 });
    await expect(createEndpointGuard({}).fetchFor(e)(urlOn(e))).rejects.toBeInstanceOf(
      EndpointRefused,
    );
  });
});

describe('DNS is resolved once and pinned', () => {
  it('reaches only the first answer when the name changes between requests', async () => {
    const honest = await startServer('127.0.0.1');
    // The rebinding target: the same port on another loopback address.
    const attacker = await startServer('127.0.0.2', undefined, honest.port);
    const { resolve, calls } = resolverOf(local('127.0.0.1'), local('127.0.0.2'));
    const e = endpoint({ port: honest.port });
    const guardedFetch = createEndpointGuard({ resolve }).fetchFor(e);

    expect(await (await guardedFetch(urlOn(e))).text()).toBe('hello');
    expect(await (await guardedFetch(urlOn(e))).text()).toBe('hello');

    expect(calls).toEqual(['model.example.test']);
    expect(honest.hits).toHaveLength(2);
    expect(honest.hits.every((hit) => hit.address === '127.0.0.1')).toBe(true);
    expect(attacker.hits).toHaveLength(0);
  });

  it('control: the two servers really are separate, so the test above can fail', async () => {
    const honest = await startServer('127.0.0.1');
    const attacker = await startServer('127.0.0.2', undefined, honest.port);
    const e = endpoint({ port: honest.port });
    const guardedFetch = createEndpointGuard(resolverOf(local('127.0.0.2'))).fetchFor(e);
    await (await guardedFetch(urlOn(e))).text();
    expect(attacker.hits).toHaveLength(1);
    expect(honest.hits).toHaveLength(0);
  });

  it('uses the pin on a new connection, since each request gets its own socket', async () => {
    const sockets = new Set<unknown>();
    const honest = await startServer('127.0.0.1', (req, res) => {
      sockets.add(req.socket);
      res.end('hello');
    });
    const e = endpoint({ port: honest.port });
    const guardedFetch = createEndpointGuard(resolverOf(local('127.0.0.1'))).fetchFor(e);
    await (await guardedFetch(urlOn(e))).text();
    await (await guardedFetch(urlOn(e))).text();
    expect(sockets.size).toBe(2);
  });

  it('a later guarded fetch resolves afresh, and is judged afresh', async () => {
    const { port, hits } = await startServer('127.0.0.1');
    const guard = createEndpointGuard(resolverOf(local('127.0.0.1'), local('169.254.169.254')));
    const e = endpoint({ port });
    await (await guard.fetchFor(e)(urlOn(e))).text();
    await expect(guard.fetchFor(e)(urlOn(e))).rejects.toBeInstanceOf(EndpointRefused);
    expect(hits).toHaveLength(1);
  });

  it('remembers a refusal, so a retry cannot hope for a friendlier answer', async () => {
    const { port, hits } = await startServer('127.0.0.1');
    const { resolve, calls } = resolverOf(local('169.254.169.254'), local('127.0.0.1'));
    const e = endpoint({ port });
    const guardedFetch = createEndpointGuard({ resolve }).fetchFor(e);
    await expect(guardedFetch(urlOn(e))).rejects.toBeInstanceOf(EndpointRefused);
    await expect(guardedFetch(urlOn(e))).rejects.toBeInstanceOf(EndpointRefused);
    expect(calls).toHaveLength(1);
    expect(hits).toHaveLength(0);
  });

  it('pins an HTTPS connection too, keeping the name for TLS', async () => {
    // A plain TCP listener is enough to see where the TLS handshake was aimed. The handshake then fails,
    // which also shows the guard has not turned certificate checking off.
    let toHonest = 0;
    let toAttacker = 0;
    const honest = createTcpServer((socket) => {
      toHonest += 1;
      socket.destroy();
    });
    const port = await listen(honest, '127.0.0.1');
    const attacker = createTcpServer((socket) => {
      toAttacker += 1;
      socket.destroy();
    });
    await listen(attacker, '127.0.0.2', port);
    const { resolve, calls } = resolverOf(local('127.0.0.1'), local('127.0.0.2'));
    const e = endpoint({ port, protocol: 'https:' });
    await expect(createEndpointGuard({ resolve }).fetchFor(e)(urlOn(e))).rejects.toBeDefined();
    expect(toHonest).toBe(1);
    expect(toAttacker).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('keeps the name in the Host header, so the provider sees what it should', async () => {
    const { port, hits } = await startServer('127.0.0.1');
    const e = endpoint({ port });
    await (await createEndpointGuard(resolverOf(local('127.0.0.1'))).fetchFor(e)(urlOn(e))).text();
    expect(hits[0]?.host).toBe(`model.example.test:${port}`);
  });

  it('reports a name that does not resolve as unreachable, not as a refusal', async () => {
    const e = endpoint();
    const failing = createEndpointGuard({
      resolve: () => Promise.reject(new Error('ENOTFOUND model.example.test')),
    }).fetchFor(e);
    await expect(failing(urlOn(e))).rejects.toBeInstanceOf(EndpointUnreachable);
    const empty = createEndpointGuard(resolverOf([])).fetchFor(e);
    await expect(empty(urlOn(e))).rejects.toBeInstanceOf(EndpointUnreachable);
  });
});

describe('redirects are refused', () => {
  it.each([301, 302, 303, 307, 308])('%i reaches nothing further', async (status) => {
    const bait = await startServer('127.0.0.1');
    const origin = await startServer('127.0.0.1', (_req, res) => {
      res.writeHead(status, { location: `http://127.0.0.1:${bait.port}/stolen` });
      res.end();
    });
    const e = endpoint({ host: '127.0.0.1', port: origin.port });
    const refusal = await createEndpointGuard({})
      .fetchFor(e)(urlOn(e), { method: 'POST', body: '{}', headers: { authorization: 'Bearer x' } })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(EndpointRefused);
    expect((refusal as EndpointRefused).afterRequest).toBe(true);
    expect(origin.hits).toHaveLength(1);
    expect(bait.hits).toHaveLength(0);
  });

  it('cannot be turned back on by a caller', async () => {
    const bait = await startServer('127.0.0.1');
    const origin = await startServer('127.0.0.1', (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${bait.port}/stolen` });
      res.end();
    });
    const e = endpoint({ host: '127.0.0.1', port: origin.port });
    await expect(
      createEndpointGuard({}).fetchFor(e)(urlOn(e), { redirect: 'follow' }),
    ).rejects.toBeInstanceOf(EndpointRefused);
    expect(bait.hits).toHaveLength(0);
  });
});

describe('plain HTTP', () => {
  it('is refused without the operator listing, even to a public answer', async () => {
    const guard = createEndpointGuard(resolverOf(local('93.184.216.34')));
    const e = endpoint({ viaPrivateAllowlist: false });
    await expect(guard.fetchFor(e)(urlOn(e))).rejects.toBeInstanceOf(EndpointRefused);
  });

  it('goes out when the operator listed it', async () => {
    const { port, hits } = await startServer();
    const e = endpoint({ port });
    await (await createEndpointGuard(resolverOf(local('127.0.0.1'))).fetchFor(e)(urlOn(e))).text();
    expect(hits).toHaveLength(1);
  });
});

describe('a guarded fetch only reaches its own endpoint', () => {
  const e = endpoint({ host: '127.0.0.1', port: 8080 });
  it.each([
    ['another host', 'http://127.0.0.2:8080/v1'],
    ['another port', 'http://127.0.0.1:8081/v1'],
    ['another scheme', 'https://127.0.0.1:8080/v1'],
    ['credentials in the URL', 'http://user:pass@127.0.0.1:8080/v1'],
    ['not a URL', '/v1/chat'],
  ])('%s is refused', async (_label, url) => {
    await expect(createEndpointGuard({}).fetchFor(e)(url)).rejects.toBeInstanceOf(EndpointRefused);
  });

  it('refuses a Request object, which could carry its own settings', async () => {
    await expect(
      createEndpointGuard({}).fetchFor(e)(new Request('http://127.0.0.1:8080/v1')),
    ).rejects.toBeInstanceOf(EndpointRefused);
  });

  it('ignores a dispatcher from the caller', async () => {
    const { port, hits } = await startServer();
    const pinned = endpoint({ host: '127.0.0.1', port });
    const init = { dispatcher: { dispatch: () => false } } as unknown as RequestInit;
    await (await createEndpointGuard({}).fetchFor(pinned)(urlOn(pinned), init)).text();
    expect(hits).toHaveLength(1);
  });
});

describe('responses', () => {
  it('reads a large body to the end, after the connection pool has started closing', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'a');
    const { port } = await startServer('127.0.0.1', (_req, res) => {
      res.writeHead(200);
      for (let i = 0; i < 16; i += 1) res.write(chunk);
      res.end();
    });
    const e = endpoint({ host: '127.0.0.1', port });
    const response = await createEndpointGuard({}).fetchFor(e)(urlOn(e));
    expect((await response.arrayBuffer()).byteLength).toBe(16 * chunk.length);
  });

  it('passes status and headers through, with a null body where one is required', async () => {
    const { port } = await startServer('127.0.0.1', (_req, res) => {
      res.writeHead(204, { 'x-test': 'yes' });
      res.end();
    });
    const e = endpoint({ host: '127.0.0.1', port });
    const response = await createEndpointGuard({}).fetchFor(e)(urlOn(e));
    expect(response.status).toBe(204);
    expect(response.headers.get('x-test')).toBe('yes');
    expect(await response.text()).toBe('');
  });

  it('refuses a declared body over the limit, before reading it', async () => {
    const { port } = await startServer('127.0.0.1', (_req, res) => {
      res.writeHead(200, { 'content-length': String(1024 * 1024 * 1024) });
      res.write('x');
    });
    const e = endpoint({ host: '127.0.0.1', port });
    await expect(createEndpointGuard({}).fetchFor(e)(urlOn(e))).rejects.toBeInstanceOf(
      ResponseTooLarge,
    );
  });

  it('stops an undeclared body at the limit, without holding it all', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 'a');
    const { port } = await startServer('127.0.0.1', (_req, res) => {
      res.writeHead(200);
      let sent = 0;
      const pump = () => {
        while (sent < 40 && res.write(chunk)) sent += 1;
        if (sent < 40) res.once('drain', pump);
        else res.end();
      };
      pump();
    });
    const e = endpoint({ host: '127.0.0.1', port });
    const response = await createEndpointGuard({}).fetchFor(e)(urlOn(e));
    await expect(response.arrayBuffer()).rejects.toBeInstanceOf(ResponseTooLarge);
  });

  it('honours the signal it was given', async () => {
    const { port } = await startServer('127.0.0.1', () => {
      // Never answers.
    });
    const e = endpoint({ host: '127.0.0.1', port });
    const controller = new AbortController();
    const pending = createEndpointGuard({}).fetchFor(e)(urlOn(e), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
