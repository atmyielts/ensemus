// ADR-037 D3: with no provider registered, which is the default, a span changes nothing about the work.
// What a registered provider sends, and that a canary cannot get out, is in tracing-sdk.test.ts.
import { describe, expect, it } from 'vitest';
import { withSpan } from './tracing';

describe('withSpan with tracing off', () => {
  it('returns what the work returned', async () => {
    await expect(withSpan('test.span', { count: 1 }, async () => 'done')).resolves.toBe('done');
  });

  it('passes the same error on, unchanged', async () => {
    const failure = new Error('the original');
    await expect(
      withSpan('test.span', {}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('accepts a name and fields it would refuse, because refusing them must not stop the work', async () => {
    await expect(withSpan('not a safe name', { apiKey: 'sk-CANARY' }, async () => 1)).resolves.toBe(
      1,
    );
  });
});
