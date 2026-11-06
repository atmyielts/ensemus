// A request to a store that has stopped answering must end, or an Activity that timed out would still
// be uploading while its retry runs.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, REQUEST_TIMEOUT_MS, S3ObjectStore } from './index';

const ACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;

describe('a store that accepts a request and never answers', () => {
  let server: Server;
  let endpoint: string;

  beforeAll(async () => {
    server = createServer((request) => {
      request.resume(); // Reads the body, and then says nothing.
    });
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  });

  it('gives up with an error, after every attempt has timed out', async () => {
    const store = new S3ObjectStore({
      endpoint,
      bucket: 'b',
      accessKey: 'k',
      secretKey: 's',
      requestTimeoutMs: 200,
    });
    const started = Date.now();
    await expect(store.put('key', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(200 * MAX_ATTEMPTS);
    expect(took).toBeLessThan(10_000);
  }, 20_000);

  it('uses up much less than an Activity has, by default', () => {
    expect(REQUEST_TIMEOUT_MS * MAX_ATTEMPTS).toBeLessThan(ACTIVITY_TIMEOUT_MS * 0.8);
  });
});
