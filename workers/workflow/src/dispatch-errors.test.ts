import { describe, expect, it } from 'vitest';
import { isTransientDeliveryError } from './dispatch-errors';

const grpc = (code: number) => Object.assign(new Error('rpc'), { code });

describe('telling an outage from a bad event', () => {
  it.each([
    ['UNAVAILABLE', grpc(14)],
    ['DEADLINE_EXCEEDED', grpc(4)],
    ['a refused connection', Object.assign(new Error('x'), { code: 'ECONNREFUSED' })],
    ['an outage wrapped by the client', new Error('Failed', { cause: grpc(14) })],
    ['an outage wrapped twice', new Error('a', { cause: new Error('b', { cause: grpc(4) }) })],
  ])('treats %s as an outage', (_label, error) => {
    expect(isTransientDeliveryError(error)).toBe(true);
  });

  it.each([
    ['a parse failure', new TypeError('Invalid input')],
    ['a bad argument', grpc(3)],
    ['being refused', grpc(7)],
    ['nothing at all', undefined],
    ['a string', 'UNAVAILABLE'],
  ])('treats %s as the event being at fault', (_label, error) => {
    expect(isTransientDeliveryError(error)).toBe(false);
  });

  it('does not loop on an error that causes itself', () => {
    const error = new Error('x') as Error & { cause?: unknown };
    error.cause = error;
    expect(isTransientDeliveryError(error)).toBe(false);
  });
});
