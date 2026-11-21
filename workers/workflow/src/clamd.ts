// ClamAV's clamd over TCP, for the knowledge worker (ADR-029 D4 addendum). clamd runs as its own service on
// an internal network with no route out; this client sends a document's bytes with INSTREAM and reads one
// short verdict. It never sends a file name, a tenant or a title, and treats anything it does not
// recognise, a timeout or a closed socket as "could not scan", never as clean.
import { connect } from 'node:net';
import type { MalwareScanPort } from '@ensemus/knowledge/ports';
import type { ScanPolicy } from '@ensemus/domain/knowledge';

export class ScannerUnavailable extends Error {
  readonly code = 'SCAN_FAILED';
  constructor() {
    super('SCAN_FAILED');
    this.name = 'ScannerUnavailable';
  }
}

export type ClamdOptions = {
  host: string;
  port: number;
  /** For the whole exchange. A 25 MiB stream on a busy scanner can take a while, and never forever. */
  timeoutMs?: number;
  chunkBytes?: number;
};

const MAX_REPLY_BYTES = 1_024;

/** One request, one null-terminated reply. Rejects with ScannerUnavailable on anything unexpected. */
function exchange(
  options: ClamdOptions,
  write: (send: (data: Uint8Array) => void) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: options.host, port: options.port });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (error: boolean, reply?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error || reply === undefined) reject(new ScannerUnavailable());
      else resolve(reply);
    };
    const timer = setTimeout(() => done(true), options.timeoutMs ?? 120_000);
    socket.once('error', () => done(true));
    socket.once('close', () => {
      const reply = Buffer.concat(chunks);
      const end = reply.indexOf(0);
      done(end < 0, end < 0 ? undefined : reply.subarray(0, end).toString('latin1'));
    });
    socket.on('data', (data: Buffer) => {
      size += data.length;
      if (size > MAX_REPLY_BYTES) return done(true);
      chunks.push(data);
      const reply = Buffer.concat(chunks);
      const end = reply.indexOf(0);
      if (end >= 0) done(false, reply.subarray(0, end).toString('latin1'));
    });
    socket.once('connect', () => write((data) => socket.write(data)));
  });
}

export function createClamdScanner(options: ClamdOptions): MalwareScanPort & {
  ping(): Promise<boolean>;
} {
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  return {
    async scan(bytes) {
      const reply = await exchange(options, (send) => {
        send(Buffer.from('zINSTREAM\0', 'latin1'));
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
          const part = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes));
          const length = Buffer.alloc(4);
          length.writeUInt32BE(part.length);
          send(length);
          send(part);
        }
        send(Buffer.alloc(4));
      });
      if (reply === 'stream: OK') return 'clean';
      if (/^stream: \S.* FOUND$/.test(reply)) return 'infected';
      // Size limits, a missing database, and every other ERROR are an unanswered scan.
      throw new ScannerUnavailable();
    },
    async ping() {
      try {
        return (
          (await exchange({ ...options, timeoutMs: 5_000 }, (send) =>
            send(Buffer.from('zPING\0')),
          )) === 'PONG'
        );
      } catch {
        return false;
      }
    },
  };
}

export type MalwareScanConfig = {
  scanner: (MalwareScanPort & { ping(): Promise<boolean> }) | null;
  policy: ScanPolicy;
};

/**
 * `ENSEMUS_CLAMD_ADDRESS` is `host:port`, or empty for no scanner. `ENSEMUS_KNOWLEDGE_SCAN_POLICY` is
 * `required` or `optional`, and defaults to `required` exactly when a scanner is configured. Asking for
 * `required` with no scanner stops the worker at start: it would otherwise index nothing, silently.
 */
export function loadMalwareScanConfig(env: NodeJS.ProcessEnv = process.env): MalwareScanConfig {
  const address = (env.ENSEMUS_CLAMD_ADDRESS ?? '').trim();
  let scanner: MalwareScanConfig['scanner'] = null;
  if (address) {
    const match = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(address);
    const port = Number(match?.[2]);
    if (!match?.[1] || !Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error('CLAMD_ADDRESS_INVALID');
    scanner = createClamdScanner({ host: match[1], port });
  }
  const stated = (env.ENSEMUS_KNOWLEDGE_SCAN_POLICY ?? '').trim();
  if (stated && stated !== 'required' && stated !== 'optional')
    throw new Error('SCAN_POLICY_INVALID');
  const policy: ScanPolicy = stated ? (stated as ScanPolicy) : scanner ? 'required' : 'optional';
  if (policy === 'required' && !scanner) throw new Error('MALWARE_SCANNER_REQUIRED');
  return { scanner, policy };
}
