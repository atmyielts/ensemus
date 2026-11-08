// A request to a store that has stopped answering must end, or an Activity that timed out would still
// be uploading while its retry runs.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, REQUEST_TIMEOUT_MS, S3ObjectStore } from './index';

const ACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;

// Generated local protocol fixture only. These observations do not qualify a real S3 provider.
describe('a future native raw PUT owns exactly one mutation transport', () => {
  let server: Server;
  let endpoint: string;
  let requests: { body: Buffer; md5: string | undefined }[];
  let mode: 'written' | 'server_error' | 'no_etag' | 'disconnect';
  const stores: S3ObjectStore[] = [];
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      requests.push({ body: Buffer.concat(chunks), md5: request.headers['content-md5'] });
      if (mode === 'disconnect') { request.socket.destroy(); return; }
      response.statusCode = mode === 'server_error' ? 503 : 200;
      if (mode === 'written') response.setHeader('ETag', '"generated-test-etag"');
      response.end(mode === 'server_error' ? '<Error><Code>SlowDown</Code></Error>' : '');
    });
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => { requests = []; mode = 'written'; });
  afterEach(() => { for (const store of stores.splice(0)) store.close(); });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(closed => server.close(() => closed())); });
  const makeStore = () => {
    const store = new S3ObjectStore({ endpoint, bucket: 'b', accessKey: 'generated-k', secretKey: 'generated-s', maxAttempts: 5, requestTimeoutMs: 500 });
    stores.push(store); return store;
  };
  it('copies exact bytes and sends their Content-MD5 before observing a known success', async () => {
    const body = Buffer.from('generated raw bytes'), expected = Buffer.from(body);
    const pending = makeStore().putSingleAttempt('raw', body, 'text/plain');
    body.fill(0);
    await expect(pending).resolves.toEqual({ transport: 'written' });
    expect(requests).toEqual([{ body: expected, md5: createHash('md5').update(expected).digest('base64') }]);
  });
  it.each(['server_error', 'disconnect'] as const)('retains %s as UNKNOWN without an SDK retry despite maxAttempts5', async failure => {
    mode = failure;
    await expect(makeStore().putSingleAttempt('raw', Buffer.from('x'), 'text/plain')).resolves.toEqual({ transport: 'unknown' });
    expect(requests).toHaveLength(1);
  });
  it('refuses to qualify an otherwise successful response with no native ETag', async () => {
    mode = 'no_etag';
    await expect(makeStore().putSingleAttempt('raw', Buffer.from('x'), 'text/plain')).resolves.toEqual({ transport: 'unknown' });
    expect(requests).toHaveLength(1);
  });
});

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

describe('physical absence requires an actual unversioned S3 protocol response', () => {
  const empty = '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>';
  type Reply = {
    status?: number;
    body?: string | Buffer;
    contentType?: string;
    stall?: boolean;
    headers?: Record<string, string>;
  };
  let server: Server;
  let store: S3ObjectStore;
  let versioning: Reply[];
  let deletion: Reply;
  let headStatus: number;
  let requests: string[];

  beforeEach(async () => {
    versioning = [];
    deletion = { status: 204 };
    headStatus = 404;
    requests = [];
    server = createServer((request, response) => {
      request.resume();
      const url = new URL(request.url ?? '', 'http://store');
      const operation =
        request.method === 'GET' && url.searchParams.has('versioning')
          ? 'versioning'
          : (request.method ?? 'unknown');
      requests.push(operation);
      const reply: Reply =
        operation === 'versioning'
          ? (versioning.shift() ?? { body: empty })
          : operation === 'HEAD'
            ? { status: headStatus }
            : deletion;
      response.statusCode = reply.status ?? 200;
      response.setHeader('content-type', reply.contentType ?? 'application/xml');
      for (const [name, value] of Object.entries(reply.headers ?? {}))
        response.setHeader(name, value);
      if (reply.stall) {
        response.write(reply.body ?? '<VersioningConfiguration');
        return;
      }
      response.end(reply.body ?? '');
    });
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    store = new S3ObjectStore({
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      bucket: 'generated-fixture-bucket',
      accessKey: 'generated-fixture-key',
      secretKey: 'generated-fixture-secret',
      maxAttempts: 3,
      requestTimeoutMs: 250,
    });
  });

  afterEach(async () => {
    store.close();
    server.closeAllConnections();
    await new Promise<void>((closed) => server.close(() => closed()));
  });

  it('checks capability around one DELETE and around its independent absence probe', async () => {
    await store.delete('generated-fixture-object');
    expect(await store.isPhysicallyAbsent('generated-fixture-object')).toBe(true);
    expect(requests).toEqual([
      'versioning',
      'DELETE',
      'versioning',
      'versioning',
      'HEAD',
      'versioning',
    ]);
  });

  it('accepts the explicit empty configuration returned by the real operation', async () => {
    versioning.push({
      body: '<?xml version="1.0" encoding="UTF-8"?>\n<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n</VersioningConfiguration>',
    });
    expect(await store.isPhysicallyAbsent('generated-fixture-object')).toBe(true);
    expect(requests).toEqual(['versioning', 'HEAD', 'versioning']);
  });

  it.each([
    [
      'versioning enabled',
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
    ],
    [
      'versioning suspended',
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Suspended</Status></VersioningConfiguration>',
    ],
    [
      'unknown status',
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Unknown</Status></VersioningConfiguration>',
    ],
    [
      'ignored versioning query',
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListBucketResult>',
    ],
    ['empty response', ''],
    ['wrong namespace', '<VersioningConfiguration xmlns="http://unsupported.invalid/"/>'],
    ['missing namespace', '<VersioningConfiguration/>'],
    [
      'unexpected field',
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Unexpected/></VersioningConfiguration>',
    ],
    [
      'duplicate field',
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status/><Status/></VersioningConfiguration>',
    ],
    [
      'unexpected attribute',
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/" Status="Enabled"/>',
    ],
    ['truncated XML', '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'],
    ['multiple roots', `${empty}${empty}`],
    [
      'external declaration',
      `<!DOCTYPE VersioningConfiguration SYSTEM "http://unsupported.invalid/entity">${empty}`,
    ],
    ['oversized response', `${' '.repeat(4097)}${empty}`],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0xff])],
  ])(
    'sends zero DELETEs for %s rather than treating missing native Status as proof',
    async (_label, body) => {
      versioning.push({ body });
      await expect(store.delete('generated-fixture-object')).rejects.toThrow();
      expect(requests).toEqual(['versioning']);
    },
  );

  it.each([403, 404, 500, 501])(
    'refuses a capability operation returning HTTP %s',
    async (status) => {
      versioning.push({ status, body: empty });
      await expect(store.delete('generated-fixture-object')).rejects.toThrow();
      expect(requests).toEqual(['versioning']);
    },
  );

  it('does not interpret an HTML success as a capability response', async () => {
    versioning.push({ body: empty, contentType: 'text/html' });
    await expect(store.delete('generated-fixture-object')).rejects.toThrow();
    expect(requests).toEqual(['versioning']);
  });

  it('bounds a partial response body even after the backend sent HTTP headers', async () => {
    versioning.push({ body: '<VersioningConfiguration', stall: true });
    const started = Date.now();
    await expect(store.delete('generated-fixture-object')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(requests).toEqual(['versioning']);
  });

  it('does not retry a failed destructive transport', async () => {
    deletion = { status: 503, body: '<Error><Code>ServiceUnavailable</Code></Error>' };
    await expect(store.delete('generated-fixture-object')).rejects.toThrow();
    expect(requests).toEqual(['versioning', 'DELETE']);
  });

  it('retains ambiguity when the DELETE endpoint returns an unrelated HTTP 200 response', async () => {
    deletion = { status: 200, body: '<ListBucketResult/>' };
    expect(await store.deleteForPurge('generated-fixture-object')).toEqual({
      transport: 'unknown',
      capabilityVerified: false,
    });
    expect(requests).toEqual(['versioning', 'DELETE']);
  });

  it('keeps known completion separate from a refused post-DELETE capability', async () => {
    versioning.push(
      { body: empty },
      {
        body: '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Suspended</Status></VersioningConfiguration>',
      },
    );
    expect(await store.deleteForPurge('generated-fixture-object')).toEqual({
      transport: 'deleted',
      capabilityVerified: false,
    });
    expect(requests).toEqual(['versioning', 'DELETE', 'versioning']);
  });

  it('raw deletion cannot report success when its capability post-check fails', async () => {
    versioning.push({ body: empty }, { body: '<ListBucketResult/>' });
    await expect(store.delete('generated-fixture-object')).rejects.toThrow(
      'OBJECT_PHYSICAL_ABSENCE_UNPROVEN',
    );
    expect(requests).toEqual(['versioning', 'DELETE', 'versioning']);
  });

  it.each([{ 'x-amz-delete-marker': 'true' }, { 'x-amz-version-id': 'generated-fixture-version' }])(
    'refuses byte qualification when the actual DELETE returned version metadata %j',
    async (headers) => {
      deletion = { status: 204, headers };
      expect(await store.deleteForPurge('generated-fixture-object')).toEqual({
        transport: 'deleted',
        capabilityVerified: false,
      });
      expect(requests).toEqual(['versioning', 'DELETE', 'versioning']);
    },
  );

  it('reports a capability refusal before transport without inventing UNKNOWN', async () => {
    versioning.push({ body: '<ListBucketResult/>' });
    expect(await store.deleteForPurge('generated-fixture-object')).toEqual({
      transport: 'not_attempted',
      capabilityVerified: false,
    });
    expect(requests).toEqual(['versioning']);
  });

  it('refuses physical absence for a now-versioned known-terminal retry before HEAD', async () => {
    versioning.push({
      body: '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
    });
    await expect(store.isPhysicallyAbsent('generated-fixture-object')).rejects.toThrow();
    expect(requests).toEqual(['versioning']);
  });

  it('refuses a versioning change after the independent HEAD', async () => {
    versioning.push(
      { body: empty },
      {
        body: '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Suspended</Status></VersioningConfiguration>',
      },
    );
    await expect(store.isPhysicallyAbsent('generated-fixture-object')).rejects.toThrow();
    expect(requests).toEqual(['versioning', 'HEAD', 'versioning']);
  });

  it('cannot bless a still-present current object', async () => {
    headStatus = 200;
    expect(await store.isPhysicallyAbsent('generated-fixture-object')).toBe(false);
    expect(requests).toEqual(['versioning', 'HEAD', 'versioning']);
  });
});
