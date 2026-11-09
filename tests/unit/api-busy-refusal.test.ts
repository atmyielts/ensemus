// The API's answer to a busy tenant: 503 TENANT_BUSY, retryable, with Retry-After, in the documented error
// shape, and checked against the spec the way every stack response is (API-12). Lock contention used to
// reach a caller as a 409 VERSION_CONFLICT from custom objects, or as a 500 from anything else.
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@ensemus/application';
import { contractProblems } from '../helpers/openapi';

// Importing the real package from outside a server component throws, which is what it is for.
vi.mock('../../apps/web/node_modules/server-only/index.js', () => ({}));

const { toErrorResponse } = await import('../../apps/web/src/server/api');

const ORG = '6f1c2c6e-1111-4111-8111-111111111111';
const ID = '6f1c2c6e-2222-4222-8222-222222222222';
const relations = `/api/v1/organizations/${ORG}/object-records/${ID}/relations`;
const BUSY =
  'This organization is busy with another change right now, so nothing was changed. Try again in a moment.';

async function answer(error: unknown) {
  const response = toErrorResponse(error, ID),
    text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}
const checked = (observed: { status: number; headers: Headers; text: string }) =>
  contractProblems({
    method: 'POST',
    path: relations,
    status: observed.status,
    headers: observed.headers,
    text: observed.text,
  }).problems;

describe('the API answer to a busy tenant', () => {
  it.each([
    ['a database lock refusal', new Error('Private SQL', { cause: { code: '55P03' } })],
    ['the application refusal', new AppError('TENANT_BUSY')],
  ])('answers %s as a retryable 503 with Retry-After', async (_, error) => {
    const busy = await answer(error);
    expect(busy.status).toBe(503);
    expect(busy.headers.get('content-type')).toContain('application/json');
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(busy.body).toEqual({
      code: 'TENANT_BUSY',
      message: BUSY,
      request_id: ID,
      retryable: true,
    });
    expect(busy.text).not.toContain('Private SQL');
    expect(checked(busy)).toEqual([]);
  });

  it('documents Retry-After as whole seconds', async () => {
    const busy = await answer(new AppError('TENANT_BUSY'));
    busy.headers.set('retry-after', 'soon');
    expect(checked(busy).join()).toContain('Retry-After');
  });

  it('keeps every other refusal as it was: not retryable and with no Retry-After', async () => {
    const conflict = await answer(new AppError('VERSION_CONFLICT'));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'VERSION_CONFLICT', retryable: false });
    expect(conflict.headers.get('retry-after')).toBeNull();

    const unknown = await answer(new Error('Private SQL', { cause: { code: '40001' } }));
    expect(unknown.status).toBe(500);
    expect(unknown.body).toMatchObject({ code: 'INTERNAL_ERROR', retryable: false });
    expect(unknown.headers.get('retry-after')).toBeNull();

    const restoring = await answer(new AppError('RESTORE_PENDING'));
    expect(restoring.status).toBe(503);
    expect(restoring.body).toMatchObject({ code: 'RESTORE_PENDING', retryable: true });
    expect(restoring.headers.get('retry-after')).toBeNull();
  });
});
