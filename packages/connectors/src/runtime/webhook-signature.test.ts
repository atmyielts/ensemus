// ADR-027 D4's scheme, on its own. The integration tests prove the same refusals through the real path.
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from './webhook-signature';

const SCHEME = 'ensemus_hmac_sha256_v1' as const;
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const secret = randomBytes(32);
const body = Buffer.from('{"type":"connector.sync_requested"}');

function request(
  overrides: {
    secret?: Buffer;
    timestamp?: number;
    eventId?: string;
    body?: Uint8Array;
    headers?: Record<string, string | undefined>;
  } = {},
) {
  const timestamp = overrides.timestamp ?? NOW;
  const eventId = overrides.eventId ?? 'evt-1';
  const signature = signWebhook(overrides.secret ?? secret, {
    timestampSeconds: timestamp,
    eventId,
    body: overrides.body ?? body,
  });
  const headers: Record<string, string> = {};
  const all = {
    'x-ensemus-signature': signature,
    'x-ensemus-timestamp': String(timestamp),
    'x-ensemus-event-id': eventId,
    ...overrides.headers,
  };
  for (const [name, value] of Object.entries(all)) if (value !== undefined) headers[name] = value;
  return { scheme: SCHEME, body, headers, nowMs: NOW_MS, toleranceSeconds: 300 };
}

describe('verifying a signature', () => {
  it('accepts a good one and hands back what the signature covers', () => {
    expect(verifyWebhookSignature(secret, request())).toEqual({
      ok: true,
      providerEventId: 'evt-1',
      signedAtSeconds: NOW,
    });
  });

  it('signs exactly {timestamp}.{event id}.{body} with HMAC-SHA-256, in lower-case hex', () => {
    const expected = createHmac('sha256', secret)
      .update(`${NOW}.evt-1.`)
      .update(body)
      .digest('hex');
    expect(signWebhook(secret, { timestampSeconds: NOW, eventId: 'evt-1', body })).toBe(expected);
  });

  it('refuses a missing signature, and says so', () => {
    const input = request({ headers: { 'x-ensemus-signature': undefined } });
    expect(verifyWebhookSignature(secret, input)).toEqual({ ok: false, code: 'SIGNATURE_MISSING' });
  });

  it('refuses a missing or malformed time', () => {
    for (const value of [undefined, '', 'soon', '-5', '1.5', '1e9', ' 1', '9'.repeat(40)]) {
      const input = request({ headers: { 'x-ensemus-timestamp': value } });
      expect(verifyWebhookSignature(secret, input), String(value)).toEqual({
        ok: false,
        code: 'TIMESTAMP_MISSING',
      });
    }
  });

  it('refuses another secret', () => {
    expect(verifyWebhookSignature(randomBytes(32), request())).toEqual({
      ok: false,
      code: 'BAD_SIGNATURE',
    });
  });

  it('refuses an altered body', () => {
    const input = { ...request(), body: Buffer.from('{"type":"something.else"}') };
    expect(verifyWebhookSignature(secret, input)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('refuses a time changed on a valid signature, rather than calling it too old', () => {
    const input = request({ headers: { 'x-ensemus-timestamp': String(NOW + 1) } });
    expect(verifyWebhookSignature(secret, input)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('refuses an event ID changed on a valid signature', () => {
    const input = request({ headers: { 'x-ensemus-event-id': 'evt-2' } });
    expect(verifyWebhookSignature(secret, input)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('refuses a missing event ID', () => {
    const input = request({ headers: { 'x-ensemus-event-id': undefined } });
    expect(verifyWebhookSignature(secret, input)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('closes the door on moving bytes between the event ID and the body', () => {
    // Without a rule on the ID, {id: "evt"} over "x.{...}" and {id: "evt.x"} over "{...}" sign the same
    // bytes, so anyone holding a request could mint a new event ID from it and shorten its body.
    const long = Buffer.from('x.{"type":"connector.sync_requested"}');
    const signature = createHmac('sha256', secret).update(`${NOW}.evt.`).update(long).digest('hex');
    const shifted = {
      scheme: SCHEME,
      body: Buffer.from('{"type":"connector.sync_requested"}'),
      headers: {
        'x-ensemus-signature': signature,
        'x-ensemus-timestamp': String(NOW),
        'x-ensemus-event-id': 'evt.x',
      },
      nowMs: NOW_MS,
      toleranceSeconds: 300,
    };
    expect(verifyWebhookSignature(secret, shifted)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(() =>
      signWebhook(secret, { timestampSeconds: NOW, eventId: 'evt.x', body: long }),
    ).toThrow();
  });

  it('checks the signature before the time, so nobody learns a window without a secret', () => {
    const forged = request({ secret: randomBytes(32), timestamp: NOW - 86_400 });
    expect(verifyWebhookSignature(secret, forged)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('refuses a valid signature outside the window, on either side', () => {
    for (const timestamp of [NOW - 301, NOW + 301]) {
      expect(verifyWebhookSignature(secret, request({ timestamp }))).toEqual({
        ok: false,
        code: 'TIMESTAMP_OUTSIDE_WINDOW',
      });
    }
  });

  it('accepts a time at the edge of the window', () => {
    expect(verifyWebhookSignature(secret, request({ timestamp: NOW - 300 })).ok).toBe(true);
  });

  it('refuses a signature in any other spelling, without comparing it', () => {
    const good = request().headers['x-ensemus-signature'] as string;
    for (const value of [good.toUpperCase(), `${good}00`, good.slice(2), 'not-hex', `v1=${good}`]) {
      const input = request({ headers: { 'x-ensemus-signature': value } });
      expect(verifyWebhookSignature(secret, input), value).toEqual({
        ok: false,
        code: 'BAD_SIGNATURE',
      });
    }
  });

  it('fails closed on a scheme it does not know', () => {
    const input = { ...request(), scheme: 'nobody_v9' as typeof SCHEME };
    expect(verifyWebhookSignature(secret, input)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });
});
