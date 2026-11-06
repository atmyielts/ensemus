// A byte-for-byte forwarder from one internal port to the one target the operator configured (ADR-027
// D5). It holds no secret and reaches no database, so taking it over gets an attacker nothing but that
// one target. TLS is end to end through it, so it sees only ciphertext, and it never reads what it carries.
// It logs codes only: who connected, and to what, are not its business to write down.
import { realpathSync, writeFileSync } from 'node:fs';
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createLogger, errorCode } from '@ensemus/telemetry';

const DEFAULT_LISTEN_PORT = 2525;
/** Well over what one connector worker opens, since each send has one connection. */
const DEFAULT_MAX_CONNECTIONS = 32;
/** Longer than a send's deadline, so that this never ends a send the connector is still waiting on. */
const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export type GatewayLog = {
  info(event: string): void;
  warn(event: string): void;
  error(event: string): void;
};

export type GatewayOptions = {
  target: string;
  listenPort: number;
  listenHost?: string;
  maxConnections?: number;
  idleMs?: number;
  connectTimeoutMs?: number;
  log: GatewayLog;
};

export type RunningGateway = { port: number; close(): Promise<void> };

/** One `host:port`, and nothing that could be a list, a URL or a path. */
export function parseEgressTarget(value: string | undefined): { host: string; port: number } {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})):(\d{1,5})$/.exec(value ?? '');
  const port = Number(match?.[2]);
  if (!match?.[1] || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('NO_EGRESS_TARGET');
  }
  return { host: match[1], port };
}

export function startEgressGateway(options: GatewayOptions): Promise<RunningGateway> {
  const { host, port } = parseEgressTarget(options.target);
  const { log } = options;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const open = new Set<Socket>();

  const server: Server = createServer((client) => {
    if (open.size >= maxConnections * 2) {
      log.warn('egress_gateway.at_capacity');
      client.destroy();
      return;
    }
    const upstream = connect({ host, port });
    open.add(client);
    open.add(upstream);
    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer);
      client.destroy();
      upstream.destroy();
      open.delete(client);
      open.delete(upstream);
    };
    const connectTimer = setTimeout(() => {
      log.warn('egress_gateway.target_unreachable');
      closeBoth();
    }, connectTimeoutMs);
    let reached = false;
    upstream.once('connect', () => {
      reached = true;
      clearTimeout(connectTimer);
    });
    upstream.on('error', () => {
      if (!reached) log.warn('egress_gateway.target_unreachable');
      closeBoth();
    });
    client.on('error', closeBoth);
    client.once('close', closeBoth);
    upstream.once('close', closeBoth);
    const onIdle = () => {
      log.info('egress_gateway.idle_closed');
      closeBoth();
    };
    client.setTimeout(idleMs, onIdle);
    upstream.setTimeout(idleMs, onIdle);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.listenPort, options.listenHost ?? '0.0.0.0', () => {
      server.off('error', reject);
      const { port: listening } = server.address() as AddressInfo;
      resolve({
        port: listening,
        close: () =>
          new Promise((done) => {
            for (const socket of open) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Only as its own process: a test imports this file to reach the code above without starting anything. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  const log = createLogger('egress-gateway');
  const target = process.env.ENSEMUS_EGRESS_TARGET;
  try {
    parseEgressTarget(target);
  } catch {
    // Refusing to start is the point: a gateway with no target has nowhere it is allowed to send.
    log.error('egress_gateway.no_target');
    process.exit(1);
  }
  const gateway = await startEgressGateway({
    target: target ?? '',
    listenPort: DEFAULT_LISTEN_PORT,
    log: {
      info: (event) => log.info(event),
      warn: (event) => log.warn(event),
      error: (event) => log.error(event),
    },
  });

  // The image's health check reads this file, as it does for the workers.
  const beat = () => writeFileSync('/tmp/worker-alive', String(Date.now()));
  beat();
  setInterval(beat, 5_000).unref();
  log.info('egress_gateway.started');

  const stop = () => {
    void gateway.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    createLogger('egress-gateway').error('egress_gateway.crashed', {
      errorCode: errorCode(error),
    });
    process.exit(1);
  });
}
