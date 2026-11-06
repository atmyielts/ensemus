import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEgressTarget, startEgressGateway, type GatewayLog } from './egress-gateway';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** An upstream that echoes, or does whatever the test says with each connection. */
async function upstream(onConnection?: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    if (onConnection) onConnection(socket);
    else socket.pipe(socket);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(
    () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  );
  return { port: (server.address() as AddressInfo).port, sockets };
}

function recordingLog() {
  const lines: unknown[][] = [];
  const log: GatewayLog = {
    info: (...args) => lines.push(args),
    warn: (...args) => lines.push(args),
    error: (...args) => lines.push(args),
  };
  return { lines, log };
}

async function gateway(
  target: string,
  options: { maxConnections?: number; idleMs?: number; connectTimeoutMs?: number } = {},
) {
  const { lines, log } = recordingLog();
  const running = await startEgressGateway({
    target,
    listenHost: '127.0.0.1',
    listenPort: 0,
    log,
    ...options,
  });
  closers.push(() => running.close());
  return { ...running, lines };
}

function dial(port: number) {
  const socket = connect({ host: '127.0.0.1', port });
  const received: Buffer[] = [];
  socket.on('data', (chunk) => received.push(chunk));
  socket.on('error', () => undefined);
  const closed = new Promise<void>((done) => socket.once('close', () => done()));
  closers.push(() => void socket.destroy());
  return { socket, received: () => Buffer.concat(received), closed };
}

describe('parseEgressTarget', () => {
  it('takes one host and one port', () => {
    expect(parseEgressTarget('relay.example.invalid:587')).toEqual({
      host: 'relay.example.invalid',
      port: 587,
    });
    expect(parseEgressTarget('192.0.2.10:25')).toEqual({ host: '192.0.2.10', port: 25 });
  });

  it('refuses anything else, so nothing can start with no target or a list of them', () => {
    for (const value of [
      undefined,
      '',
      'relay',
      ':25',
      'relay:',
      'relay:0',
      'relay:70000',
      'relay:abc',
      'smtp://relay:25',
      'a:25,b:25',
      'a b:25',
      'relay:25/path',
    ]) {
      expect(() => parseEgressTarget(value), String(value)).toThrow('NO_EGRESS_TARGET');
    }
  });
});

describe('the gateway', () => {
  it('forwards bytes both ways, exactly, including every byte value', async () => {
    const up = await upstream();
    const { port } = await gateway(`127.0.0.1:${up.port}`);
    const client = dial(port);
    const payload = randomBytes(256 * 1024);
    client.socket.write(payload);
    await expect.poll(() => client.received().length, { timeout: 10_000 }).toBe(payload.length);
    expect(client.received().equals(payload)).toBe(true);
  });

  it('connects only to its one target, whatever the client sends', async () => {
    const up = await upstream();
    const other = await upstream();
    const { port } = await gateway(`127.0.0.1:${up.port}`);
    const client = dial(port);
    client.socket.write(`CONNECT 127.0.0.1:${other.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await expect.poll(() => client.received().length).toBeGreaterThan(0);
    expect(up.sockets.size).toBe(1);
    expect(other.sockets.size).toBe(0);
  });

  it('closes the client when the target closes, and the target when the client closes', async () => {
    const up = await upstream();
    const { port } = await gateway(`127.0.0.1:${up.port}`);
    const first = dial(port);
    first.socket.write('x');
    await expect.poll(() => up.sockets.size).toBe(1);
    for (const socket of up.sockets) socket.destroy();
    await first.closed;

    const second = dial(port);
    second.socket.write('x');
    await expect.poll(() => up.sockets.size).toBe(1);
    second.socket.destroy();
    await expect.poll(() => up.sockets.size).toBe(0);
  });

  it('closes the client when the target cannot be reached, and logs a code with no address', async () => {
    const dead = await upstream();
    const deadPort = dead.port;
    await closers.pop()?.();
    const running = await gateway(`127.0.0.1:${deadPort}`);
    const client = dial(running.port);
    await client.closed;
    expect(running.lines.map(([event]) => event)).toContain('egress_gateway.target_unreachable');
    const logged = JSON.stringify(running.lines);
    expect(logged).not.toContain('127.0.0.1');
    expect(logged).not.toContain(String(deadPort));
  });

  it('bounds connections, refusing the one over the limit and serving again after', async () => {
    const up = await upstream();
    const running = await gateway(`127.0.0.1:${up.port}`, { maxConnections: 2 });
    const first = dial(running.port);
    const second = dial(running.port);
    first.socket.write('a');
    second.socket.write('b');
    await expect.poll(() => up.sockets.size).toBe(2);
    const third = dial(running.port);
    await third.closed;
    expect(up.sockets.size).toBe(2);
    expect(running.lines.map(([event]) => event)).toContain('egress_gateway.at_capacity');

    first.socket.destroy();
    await expect.poll(() => up.sockets.size).toBe(1);
    const fourth = dial(running.port);
    fourth.socket.write('d');
    await expect.poll(() => fourth.received().length).toBe(1);
  });

  it('closes a connection that goes idle, on both sides', async () => {
    const up = await upstream(() => undefined);
    const running = await gateway(`127.0.0.1:${up.port}`, { idleMs: 80 });
    const client = dial(running.port);
    await expect.poll(() => up.sockets.size).toBe(1);
    await client.closed;
    await expect.poll(() => up.sockets.size).toBe(0);
    expect(running.lines.map(([event]) => event)).toContain('egress_gateway.idle_closed');
  });

  it('never logs who connected or what they sent', async () => {
    const up = await upstream();
    const running = await gateway(`127.0.0.1:${up.port}`);
    const client = dial(running.port);
    client.socket.write('canary-content');
    await expect.poll(() => client.received().length).toBeGreaterThan(0);
    client.socket.destroy();
    await expect.poll(() => up.sockets.size).toBe(0);
    const logged = JSON.stringify(running.lines);
    expect(logged).not.toContain('canary-content');
    expect(logged).not.toContain('127.0.0.1');
    expect(logged).not.toContain(String(client.socket.localPort));
  });

  it('stops listening and drops what it holds when closed', async () => {
    const up = await upstream();
    const running = await startEgressGateway({
      target: `127.0.0.1:${up.port}`,
      listenHost: '127.0.0.1',
      listenPort: 0,
      log: recordingLog().log,
    });
    const client = dial(running.port);
    client.socket.write('x');
    await expect.poll(() => up.sockets.size).toBe(1);
    await running.close();
    await client.closed;
    await expect.poll(() => up.sockets.size).toBe(0);
    const late = dial(running.port);
    await late.closed;
    expect(late.received().length).toBe(0);
  });
});
