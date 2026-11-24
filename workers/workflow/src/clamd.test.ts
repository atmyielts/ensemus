import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createClamdScanner, loadMalwareScanConfig, ScannerUnavailable } from './clamd';
import { createKnowledgeRuntimePorts } from './knowledge-ports';

// A local stand-in for clamd that speaks INSTREAM, decides on the bytes it was sent, and records them.
// The marker below is a generated string, not a real signature: no malware sample is used anywhere.
const MARKER = 'GENERATED-INFECTION-MARKER';

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function fakeClamd(reply: (body: Buffer, command: string) => string | null) {
  const received: Buffer[] = [];
  server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      const nul = buffer.indexOf(0);
      if (nul < 0) return;
      const command = buffer.subarray(0, nul).toString('latin1');
      if (command === 'zPING') {
        socket.end('PONG\0');
        return;
      }
      // Length-prefixed chunks, ended by a zero length.
      let at = nul + 1;
      const parts: Buffer[] = [];
      while (at + 4 <= buffer.length) {
        const length = buffer.readUInt32BE(at);
        if (length === 0) {
          const body = Buffer.concat(parts);
          received.push(body);
          const answer = reply(body, command);
          if (answer === null) return; // Hang, to exercise the deadline.
          socket.end(`${answer}\0`);
          return;
        }
        if (at + 4 + length > buffer.length) return;
        parts.push(buffer.subarray(at + 4, at + 4 + length));
        at += 4 + length;
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { port: (server!.address() as AddressInfo).port, received };
}

describe('the clamd client', () => {
  it('streams the bytes in chunks and reads clean and infected verdicts', async () => {
    const clamd = await fakeClamd((body) =>
      body.includes(MARKER) ? 'stream: Generated.Test.Marker FOUND' : 'stream: OK',
    );
    const scanner = createClamdScanner({ host: '127.0.0.1', port: clamd.port, chunkBytes: 7 });
    const clean = Buffer.from('An ordinary generated document body.');
    expect(await scanner.scan(clean)).toBe('clean');
    expect(clamd.received[0]).toEqual(clean);
    expect(await scanner.scan(Buffer.from(`prefix ${MARKER} suffix`))).toBe('infected');
    expect(await scanner.ping()).toBe(true);
  });

  it('never reads an error, a size limit, a hang or a dead port as clean', async () => {
    const clamd = await fakeClamd((body) =>
      body.length > 10 ? 'INSTREAM size limit exceeded. ERROR' : body.length ? null : 'garbage',
    );
    const scanner = createClamdScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 300 });
    await expect(scanner.scan(Buffer.alloc(64, 1))).rejects.toBeInstanceOf(ScannerUnavailable);
    await expect(scanner.scan(Buffer.from('tiny'))).rejects.toBeInstanceOf(ScannerUnavailable);
    await expect(scanner.scan(Buffer.alloc(0))).rejects.toBeInstanceOf(ScannerUnavailable);
    const closed = createClamdScanner({ host: '127.0.0.1', port: 1, timeoutMs: 1_000 });
    await expect(closed.scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScannerUnavailable);
    expect(await closed.ping()).toBe(false);
  });
});

describe('the scan policy', () => {
  it('has no scanner and an optional policy by default', () => {
    expect(loadMalwareScanConfig({})).toEqual({ scanner: null, policy: 'optional' });
  });
  it('requires scanning by default once a scanner is configured, and may be told otherwise', () => {
    const required = loadMalwareScanConfig({ ENSEMUS_CLAMD_ADDRESS: '172.30.8.10:3310' });
    expect(required.policy).toBe('required');
    expect(required.scanner).not.toBeNull();
    expect(
      loadMalwareScanConfig({
        ENSEMUS_CLAMD_ADDRESS: 'clamav:3310',
        ENSEMUS_KNOWLEDGE_SCAN_POLICY: 'optional',
      }).policy,
    ).toBe('optional');
  });
  it('refuses to start when scanning is required and nothing can scan, or settings are invalid', () => {
    expect(() => loadMalwareScanConfig({ ENSEMUS_KNOWLEDGE_SCAN_POLICY: 'required' })).toThrow(
      'MALWARE_SCANNER_REQUIRED',
    );
    expect(() => loadMalwareScanConfig({ ENSEMUS_KNOWLEDGE_SCAN_POLICY: 'sometimes' })).toThrow(
      'SCAN_POLICY_INVALID',
    );
    for (const address of ['clamav', 'clamav:0', 'clamav:70000', 'http://clamav:3310', 'a b:1'])
      expect(() => loadMalwareScanConfig({ ENSEMUS_CLAMD_ADDRESS: address })).toThrow(
        'CLAMD_ADDRESS_INVALID',
      );
  });
  it('wires the scanner and its policy into ingestion', () => {
    expect(createKnowledgeRuntimePorts({}).ingest).toMatchObject({ malwareScanRequired: false });
    expect(createKnowledgeRuntimePorts({}).ingest.malware).toBeUndefined();
    const wired = createKnowledgeRuntimePorts({ ENSEMUS_CLAMD_ADDRESS: '127.0.0.1:3310' }).ingest;
    expect(wired.malwareScanRequired).toBe(true);
    expect(wired.malware).toBeDefined();
  });
});
