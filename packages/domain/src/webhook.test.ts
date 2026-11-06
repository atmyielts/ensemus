// The pure rules behind ADR-027 D4: what is kept of a request, how a repeat is recognized, and what the
// replay window means. Everything here runs before anything is believed, on bytes from anyone.
import { describe, expect, it } from 'vitest';
import {
  hashWebhookToken,
  isWebhookEventId,
  isWebhookTokenShape,
  storedWebhookHeaders,
  WEBHOOK_MAX_HEADER_BYTES,
  WEBHOOK_MAX_STORED_HEADERS_BYTES,
  webhookInboxConsumer,
  webhookInboxEventId,
  webhookRequestDigest,
  withinTimestampWindow,
} from './webhook';

const SCHEME = 'ensemus_hmac_sha256_v1';
const ENDPOINT_A = '00000000-0000-4000-8000-00000000000a';
const ENDPOINT_B = '00000000-0000-4000-8000-00000000000b';

describe('the headers kept of a request', () => {
  it('keeps only the allowlist, so a cookie or a forged host never reaches a row', () => {
    const kept = storedWebhookHeaders(SCHEME, {
      'x-ensemus-signature': 'abc',
      'x-ensemus-timestamp': '123',
      'x-ensemus-event-id': 'evt-1',
      'content-type': 'application/json',
      cookie: 'session=stolen',
      authorization: 'Bearer stolen',
      host: 'evil.example.invalid',
    });
    expect(Object.keys(kept).sort()).toEqual([
      'content-type',
      'x-ensemus-event-id',
      'x-ensemus-signature',
      'x-ensemus-timestamp',
    ]);
  });

  it('cuts each one at the limit, counted in bytes and not split inside a character', () => {
    const kept = storedWebhookHeaders(SCHEME, {
      'x-ensemus-signature': 'a'.repeat(WEBHOOK_MAX_HEADER_BYTES + 500),
      'x-ensemus-event-id': 'é'.repeat(WEBHOOK_MAX_HEADER_BYTES),
    });
    expect(Buffer.byteLength(kept['x-ensemus-signature'] as string)).toBe(WEBHOOK_MAX_HEADER_BYTES);
    const multi = kept['x-ensemus-event-id'] as string;
    expect(Buffer.byteLength(multi)).toBeLessThanOrEqual(WEBHOOK_MAX_HEADER_BYTES);
    expect(multi).not.toContain('�');
  });

  it('removes control characters, because jsonb refuses a NUL and a refusal would be a 500', () => {
    const kept = storedWebhookHeaders(SCHEME, { 'x-ensemus-event-id': 'a\u0000b\u0001c\nd' });
    expect(kept['x-ensemus-event-id']).toBe('abcd');
  });

  it('stays under the column limit even when every byte needs escaping in JSON', () => {
    const worst = '"\\'.repeat(WEBHOOK_MAX_HEADER_BYTES);
    const kept = storedWebhookHeaders(SCHEME, {
      'content-type': worst,
      'x-ensemus-signature': worst,
      'x-ensemus-timestamp': worst,
      'x-ensemus-event-id': worst,
    });
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(
      WEBHOOK_MAX_STORED_HEADERS_BYTES,
    );
    // jsonb prints a space after each colon and comma, so the real column has room for that too.
    expect(WEBHOOK_MAX_STORED_HEADERS_BYTES).toBeLessThan(8192 - 16);
  });

  it('keeps nothing for a scheme it does not know', () => {
    expect(storedWebhookHeaders('nobody_v9', { 'x-ensemus-signature': 'abc' })).toEqual({});
  });
});

describe('the digest of a request', () => {
  const body = Buffer.from('{"a":1}');
  const headers = { 'x-ensemus-signature': 'abc', 'x-ensemus-timestamp': '1' };

  it('is the same for the same bytes, whatever order the headers came in', () => {
    const reordered = { 'x-ensemus-timestamp': '1', 'x-ensemus-signature': 'abc' };
    expect(webhookRequestDigest(body, headers)).toBe(webhookRequestDigest(body, reordered));
  });

  it('differs for a changed body, signature or time', () => {
    const base = webhookRequestDigest(body, headers);
    expect(webhookRequestDigest(Buffer.from('{"a":2}'), headers)).not.toBe(base);
    expect(webhookRequestDigest(body, { ...headers, 'x-ensemus-signature': 'abd' })).not.toBe(base);
    expect(webhookRequestDigest(body, { ...headers, 'x-ensemus-timestamp': '2' })).not.toBe(base);
  });
});

describe('the inbox key', () => {
  it('is a UUID, stable, and different per endpoint', () => {
    const id = webhookInboxEventId(ENDPOINT_A, 'evt-1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(webhookInboxEventId(ENDPOINT_A, 'evt-1')).toBe(id);
    expect(webhookInboxEventId(ENDPOINT_B, 'evt-1')).not.toBe(id);
    expect(webhookInboxEventId(ENDPOINT_A, 'evt-2')).not.toBe(id);
  });

  it('cannot be made to collide by moving text between the endpoint and the ID', () => {
    expect(webhookInboxEventId('a', 'b","c')).not.toBe(webhookInboxEventId('a","b', 'c'));
    expect(webhookInboxConsumer(ENDPOINT_A)).toBe(`webhook:${ENDPOINT_A}`);
  });
});

describe('the replay window', () => {
  const NOW = 1_800_000_000_000;

  it('holds on both sides of now, at the edge and past it', () => {
    expect(withinTimestampWindow(NOW / 1000, NOW, 300)).toBe(true);
    expect(withinTimestampWindow(NOW / 1000 - 300, NOW, 300)).toBe(true);
    expect(withinTimestampWindow(NOW / 1000 + 300, NOW, 300)).toBe(true);
    expect(withinTimestampWindow(NOW / 1000 - 301, NOW, 300)).toBe(false);
    expect(withinTimestampWindow(NOW / 1000 + 301, NOW, 300)).toBe(false);
  });

  it('refuses anything that is not a whole number', () => {
    expect(withinTimestampWindow(Number.NaN, NOW, 300)).toBe(false);
    expect(withinTimestampWindow(Number.POSITIVE_INFINITY, NOW, 300)).toBe(false);
    expect(withinTimestampWindow(NOW / 1000 + 0.5, NOW, 300)).toBe(false);
  });
});

describe('shapes', () => {
  it('knows what a token looks like, before spending a query on one', () => {
    expect(isWebhookTokenShape('a'.repeat(43))).toBe(true);
    expect(isWebhookTokenShape('a'.repeat(42))).toBe(false);
    expect(isWebhookTokenShape('a'.repeat(44))).toBe(false);
    expect(isWebhookTokenShape(`${'a'.repeat(42)}/`)).toBe(false);
    expect(isWebhookTokenShape('')).toBe(false);
  });

  it('never lets a token be recovered from its hash column by comparing text', () => {
    expect(hashWebhookToken('a'.repeat(43))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an event ID holding a dot, the separator in the signed bytes', () => {
    expect(isWebhookEventId('evt-1')).toBe(true);
    expect(isWebhookEventId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isWebhookEventId('order:42_b')).toBe(true);
    expect(isWebhookEventId('a.b')).toBe(false);
    expect(isWebhookEventId('')).toBe(false);
    expect(isWebhookEventId('a'.repeat(256))).toBe(false);
    expect(isWebhookEventId('a b')).toBe(false);
  });
});
