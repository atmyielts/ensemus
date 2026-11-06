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

  it('tries only once when asked to, for a caller with retries of its own', async () => {
    const store = new S3ObjectStore({
      endpoint,
      bucket: 'b',
      accessKey: 'k',
      secretKey: 's',
      requestTimeoutMs: 200,
      maxAttempts: 1,
    });
    const started = Date.now();
    await expect(store.put('key', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(200 * 2);
  }, 20_000);

  it('uses up much less than an Activity has, by default', () => {
    expect(REQUEST_TIMEOUT_MS * MAX_ATTEMPTS).toBeLessThan(ACTIVITY_TIMEOUT_MS * 0.8);
  });
});

describe('listing a prefix', () => {
  let server: Server;
  let endpoint: string;
  const asked: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '', 'http://store');
      asked.push(url.searchParams.get('continuation-token') ?? 'first');
      const second = url.searchParams.get('continuation-token') === 'next';
      response.setHeader('content-type', 'application/xml');
      response.end(
        second
          ? `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a/3</Key></Contents></ListBucketResult>`
          : `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken><Contents><Key>a/1</Key></Contents><Contents><Key>a/2</Key></Contents></ListBucketResult>`,
      );
    });
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  });

  it('follows every page to the end', async () => {
    const store = new S3ObjectStore({ endpoint, bucket: 'b', accessKey: 'k', secretKey: 's' });
    const pages: string[][] = [];
    for await (const page of store.listPages('a/')) pages.push(page);
    expect(pages).toEqual([['a/1', 'a/2'], ['a/3']]);
    expect(asked).toEqual(['first', 'next']);
  });
});

describe('bounded object reads for model context', () => {
  let server: Server;
  let endpoint: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url?.includes('chunked')) {
        response.write('12345');
        response.write('67890');
        response.end('more bytes');
      } else if (request.url?.includes('large')) {
        response.setHeader('content-length', '32');
        response.end('x'.repeat(32));
      } else response.end('safe');
    });
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  });

  it('returns the complete object when it fits', async () => {
    const store = new S3ObjectStore({ endpoint, bucket: 'b', accessKey: 'k', secretKey: 's' });
    expect(await store.get('small', 4)).toEqual(Buffer.from('safe'));
  });

  it.each(['large', 'chunked'])('refuses %s data rather than truncating it', async (key) => {
    const store = new S3ObjectStore({ endpoint, bucket: 'b', accessKey: 'k', secretKey: 's' });
    await expect(store.get(key, 8)).rejects.toThrow('OBJECT_TOO_LARGE');
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])('refuses invalid byte cap %s', async (cap) => {
    const store = new S3ObjectStore({ endpoint, bucket: 'b', accessKey: 'k', secretKey: 's' });
    await expect(store.get('small', cap)).rejects.toThrow('INVALID_OBJECT_LIMIT');
  });
});
