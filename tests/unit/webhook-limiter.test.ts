// The door of POST /api/webhooks/{token}, without a server: what a caller hears, in what order, and that
// nothing reaches the database once a limit says no. The real route, behind the real proxy, is covered
// by tests/stack/webhook-route.test.ts.
import { describe, expect, it } from 'vitest';
import {
  createWebhookLimiter,
  handleWebhookRequest,
  readBoundedBody,
  type WebhookDoorDeps,
} from '../../apps/web/src/lib/webhook-limiter';
import {
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_REPLICA_LIMIT_PER_MINUTE,
  WEBHOOK_UNKNOWN_CALLER_LIMIT_PER_MINUTE,
  type WebhookIngressOutcome,
} from '@ensemus/domain/webhook';

const TOKEN = 'a'.repeat(43);
const NOW = 1_800_000_000_000;

function post(
  options: { body?: BodyInit | null; headers?: Record<string, string>; address?: string } = {},
) {
  return new Request(`https://ensemus.example.invalid/api/webhooks/${TOKEN}`, {
    method: 'POST',
    body: options.body === undefined ? '{}' : options.body,
    headers: {
      ...(options.address ? { 'x-forwarded-for': options.address } : {}),
      ...options.headers,
    },
    ...(options.body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
}

function door(overrides: Partial<WebhookDoorDeps> & { outcome?: WebhookIngressOutcome } = {}) {
  const calls: { token: string; body: Uint8Array; headers: Record<string, string> }[] = [];
  const deps: WebhookDoorDeps = {
    enabled: () => true,
    limiter: createWebhookLimiter(),
    now: () => NOW,
    ingest: async (input) => {
      calls.push(input as (typeof calls)[number]);
      return overrides.outcome ?? 'accepted';
    },
    onError: () => undefined,
    ...overrides,
  };
  return { deps, calls };
}

/** A response is all a stranger ever gets, so the two compared have to be the same in every way. */
async function shape(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: [...response.headers.entries()].sort(),
  };
}

describe('what a caller hears', () => {
  it('202 with no body when it was stored', async () => {
    const { deps, calls } = door();
    const response = await handleWebhookRequest(post({ body: 'hello' }), TOKEN, deps);
    expect(await shape(response)).toEqual({
      status: 202,
      body: '',
      headers: [['cache-control', 'no-store']],
    });
    expect(Buffer.from(calls[0]?.body ?? []).toString()).toBe('hello');
    expect(calls[0]?.token).toBe(TOKEN);
  });

  it('the same 404 for a token nobody issued and for one that was disabled', async () => {
    // Both come back from the service as not_found, and this is everything that could differ after it.
    const unknown = await handleWebhookRequest(
      post(),
      'b'.repeat(43),
      door({ outcome: 'not_found' }).deps,
    );
    const disabled = await handleWebhookRequest(post(), TOKEN, door({ outcome: 'not_found' }).deps);
    const first = await shape(unknown);
    expect(first).toEqual({ status: 404, body: '', headers: [['cache-control', 'no-store']] });
    expect(await shape(disabled)).toEqual(first);
  });

  it('413 for a body over its endpoint limit, and 429 with Retry-After when not admitted', async () => {
    const large = await handleWebhookRequest(post(), TOKEN, door({ outcome: 'too_large' }).deps);
    expect(await shape(large)).toEqual({
      status: 413,
      body: '',
      headers: [['cache-control', 'no-store']],
    });
    const limited = await handleWebhookRequest(
      post(),
      TOKEN,
      door({ outcome: 'rate_limited' }).deps,
    );
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.text()).toBe('');
  });

  it('503 with Retry-After during a restore, so the sender retries', async () => {
    const { deps } = door({ ingest: async () => 'restoring' });
    const response = await handleWebhookRequest(post(), TOKEN, deps);
    expect(response.status).toBe(503);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await response.text()).toBe('');
  });

  it('503 with no detail when the database is down, and never the reason', async () => {
    const seen: unknown[] = [];
    const { deps } = door({
      ingest: async () => {
        throw new Error('connection to postgres://secret@host failed');
      },
      onError: (error) => seen.push(error),
    });
    const response = await handleWebhookRequest(post(), TOKEN, deps);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('');
    expect(seen).toHaveLength(1);
  });

  it('404 for everything when connectors are off, with no read and no database', async () => {
    const { deps, calls } = door({ enabled: () => false });
    const response = await handleWebhookRequest(post(), TOKEN, deps);
    expect(await shape(response)).toEqual({
      status: 404,
      body: '',
      headers: [['cache-control', 'no-store']],
    });
    expect(calls).toHaveLength(0);
  });
});

describe('an oversized body', () => {
  it('is refused on its declared length, without reading or touching the database', async () => {
    const { deps, calls } = door();
    let pulled = false;
    const stream = new ReadableStream(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await handleWebhookRequest(
      post({
        body: stream,
        headers: { 'content-length': String(WEBHOOK_MAX_BODY_BYTES + 1) },
      }),
      TOKEN,
      deps,
    );
    expect(response.status).toBe(413);
    expect(calls).toHaveLength(0);
    expect(pulled).toBe(false);
  });

  it('is refused when counted, whatever length it claimed', async () => {
    const { deps, calls } = door();
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const stream = new ReadableStream({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent > 32 * 1024 * 1024) controller.close();
      },
    });
    const response = await handleWebhookRequest(
      post({ body: stream, headers: { 'content-length': '10' } }),
      TOKEN,
      deps,
    );
    expect(response.status).toBe(413);
    expect(calls).toHaveLength(0);
    // It stopped reading at the ceiling, and did not take all that was on offer.
    expect(sent).toBeLessThan(WEBHOOK_MAX_BODY_BYTES * 2);
  });

  it('is allowed exactly at the ceiling', async () => {
    const { deps, calls } = door();
    const response = await handleWebhookRequest(
      post({ body: new Uint8Array(WEBHOOK_MAX_BODY_BYTES) }),
      TOKEN,
      deps,
    );
    expect(response.status).toBe(202);
    expect(calls[0]?.body.byteLength).toBe(WEBHOOK_MAX_BODY_BYTES);
  });

  it('ignores a declared length that is not a number, and still counts', async () => {
    const result = await readBoundedBody(
      post({ body: 'hello', headers: { 'content-length': 'many' } }),
      { maxBytes: 10, deadlineMs: 1000 },
    );
    expect(result).toMatchObject({ kind: 'body' });
  });

  it('gives up on a sender that never finishes, and tells it to come back', async () => {
    const never = new ReadableStream({ pull: () => new Promise(() => undefined) });
    const result = await readBoundedBody(post({ body: never }), { maxBytes: 10, deadlineMs: 20 });
    expect(result).toEqual({ kind: 'too_slow' });

    const { deps, calls } = door({ readDeadlineMs: 20 });
    const stuck = new ReadableStream({ pull: () => new Promise(() => undefined) });
    const response = await handleWebhookRequest(post({ body: stuck }), TOKEN, deps);
    expect(response.status).toBe(503);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  it('accepts an empty post, which then fails its signature like anything else', async () => {
    const { deps, calls } = door();
    const response = await handleWebhookRequest(post({ body: null }), TOKEN, deps);
    expect(response.status).toBe(202);
    expect(calls[0]?.body.byteLength).toBe(0);
  });
});

describe('a flood of unknown tokens', () => {
  it('stops reaching the database from one address once its allowance is spent', async () => {
    const { deps, calls } = door({ outcome: 'not_found' });
    for (let i = 0; i < WEBHOOK_UNKNOWN_CALLER_LIMIT_PER_MINUTE; i += 1) {
      const response = await handleWebhookRequest(post({ address: '10.0.0.1' }), TOKEN, deps);
      expect(response.status).toBe(404);
    }
    expect(calls).toHaveLength(WEBHOOK_UNKNOWN_CALLER_LIMIT_PER_MINUTE);

    const limited = await handleWebhookRequest(post({ address: '10.0.0.1' }), TOKEN, deps);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.text()).toBe('');
    expect(calls).toHaveLength(WEBHOOK_UNKNOWN_CALLER_LIMIT_PER_MINUTE);

    // Someone else, at another address, is not held back by that.
    const other = await handleWebhookRequest(post({ address: '10.0.0.2' }), TOKEN, deps);
    expect(other.status).toBe(404);
  });

  it('comes back after the minute', async () => {
    const limiter = createWebhookLimiter({ unknownPerAddress: 1, replica: 100 });
    let now = NOW;
    const { deps } = door({ limiter, outcome: 'not_found', now: () => now });
    expect((await handleWebhookRequest(post({ address: 'x' }), TOKEN, deps)).status).toBe(404);
    const limited = await handleWebhookRequest(post({ address: 'x' }), TOKEN, deps);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    now += 60_000;
    expect((await handleWebhookRequest(post({ address: 'x' }), TOKEN, deps)).status).toBe(404);
  });

  it('holds the replica to its limit across every address, so a spread flood cannot get past', async () => {
    const limiter = createWebhookLimiter({ unknownPerAddress: 2, replica: 5 });
    const { deps, calls } = door({ limiter, outcome: 'not_found' });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push(
        (await handleWebhookRequest(post({ address: `10.0.1.${i}` }), TOKEN, deps)).status,
      );
    }
    expect(statuses).toEqual([404, 404, 404, 404, 404, 429, 429, 429]);
    expect(calls).toHaveLength(5);
  });

  it('defaults to the numbers in the ADR', () => {
    expect(WEBHOOK_UNKNOWN_CALLER_LIMIT_PER_MINUTE).toBe(300);
    expect(WEBHOOK_REPLICA_LIMIT_PER_MINUTE).toBe(3000);
  });

  it('does not charge real traffic against the unknown-token allowance', async () => {
    const limiter = createWebhookLimiter({ unknownPerAddress: 2, replica: 2 });
    const { deps, calls } = door({ limiter, outcome: 'accepted' });
    for (let i = 0; i < 50; i += 1) {
      const response = await handleWebhookRequest(post({ address: 'sender' }), TOKEN, deps);
      expect(response.status).toBe(202);
    }
    expect(calls).toHaveLength(50);
  });

  it('counts a call while it is still running, so a burst cannot race past the check', () => {
    const limiter = createWebhookLimiter({ unknownPerAddress: 2, replica: 100 });
    const first = limiter.admit('x', NOW);
    const second = limiter.admit('x', NOW);
    const third = limiter.admit('x', NOW);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
  });

  it('bounds what it holds, however many addresses arrive', () => {
    const limiter = createWebhookLimiter({ unknownPerAddress: 10, replica: 100, inFlight: 1e6 });
    for (let i = 0; i < 5000; i += 1) {
      const admission = limiter.admit(`addr-${i}`, NOW);
      if (admission.ok) admission.release(true);
    }
    expect(limiter.trackedAddresses()).toBeLessThanOrEqual(100);
    // A new minute starts empty.
    limiter.admit('later', NOW + 60_000);
    expect(limiter.trackedAddresses()).toBe(1);
  });

  it('bounds how many requests can be in progress at once', async () => {
    const limiter = createWebhookLimiter({ inFlight: 2 });
    const held: (() => void)[] = [];
    let holding = true;
    const { deps } = door({
      limiter,
      ingest: async () => {
        if (holding) await new Promise<void>((done) => held.push(done));
        return 'accepted';
      },
    });
    const a = handleWebhookRequest(post(), TOKEN, deps);
    const b = handleWebhookRequest(post(), TOKEN, deps);
    const over = await handleWebhookRequest(post(), TOKEN, deps);
    expect(over.status).toBe(429);
    await expect.poll(() => held.length).toBe(2);
    holding = false;
    for (const done of held) done();
    expect((await a).status).toBe(202);
    expect((await b).status).toBe(202);
    expect((await handleWebhookRequest(post(), TOKEN, deps)).status).toBe(202);
  });

  it('gives its slot back when the call fails', async () => {
    const limiter = createWebhookLimiter({ inFlight: 1 });
    const { deps } = door({
      limiter,
      ingest: async () => {
        throw new Error('down');
      },
    });
    expect((await handleWebhookRequest(post(), TOKEN, deps)).status).toBe(503);
    expect((await handleWebhookRequest(post(), TOKEN, deps)).status).toBe(503);
  });

  it('treats a caller who sends no address as one caller, rather than as nobody', async () => {
    const limiter = createWebhookLimiter({ unknownPerAddress: 1, replica: 100 });
    const { deps } = door({ limiter, outcome: 'not_found' });
    expect((await handleWebhookRequest(post(), TOKEN, deps)).status).toBe(404);
    expect((await handleWebhookRequest(post(), TOKEN, deps)).status).toBe(429);
  });

  it('takes the first address the proxy gave, and caps how much of it is kept', async () => {
    const limiter = createWebhookLimiter({ unknownPerAddress: 1, replica: 100 });
    const { deps } = door({ limiter, outcome: 'not_found' });
    const long = `${'9'.repeat(4000)}, 10.0.0.9`;
    expect((await handleWebhookRequest(post({ address: long }), TOKEN, deps)).status).toBe(404);
    expect((await handleWebhookRequest(post({ address: long }), TOKEN, deps)).status).toBe(429);
  });
});

describe('what reaches the service', () => {
  it('hands over lower-case headers, and the raw bytes exactly as sent', async () => {
    const { deps, calls } = door();
    const bytes = new Uint8Array([0, 255, 13, 10, 46, 13, 10]);
    await handleWebhookRequest(
      post({ body: bytes, headers: { 'X-Ensemus-Signature': 'abc' } }),
      TOKEN,
      deps,
    );
    expect([...(calls[0]?.body ?? [])]).toEqual([...bytes]);
    expect(calls[0]?.headers['x-ensemus-signature']).toBe('abc');
  });
});
