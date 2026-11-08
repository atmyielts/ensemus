import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const readSecret = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('TEST_NO_SECRET_ACCESS');
  }),
);
vi.mock('@ensemus/config', () => ({
  readSecret,
  loadSaasConfig: () => ({ breakGlass: { enabled: false } }),
}));
import { deskCommand, deskCommandInputSchemas } from './ops-desk';
afterEach(() => vi.clearAllMocks());
describe('support operator commands validate before holding a database credential', () => {
  it.each(
    (
      [
        [],
        ['unknown'],
        ['show'],
        ['reply'],
        ['request'],
        ['authorize'],
        ['queue', '--unknown'],
        ['queue', '--file', 'missing-test-file'],
      ] as string[][]
    ).map((args) => [args] as const),
  )('refuses malformed arguments %j', async (args) => {
    expect(await deskCommand(args)).toBe(2);
    expect(readSecret).not.toHaveBeenCalled();
  });
  it('requires explicit coverage, timezone, roster and operator references without default hours', () => {
    const input = {
      operatorRef: 'test-operator@example.invalid',
      staffedByRef: 'test-roster@example.invalid',
      timezone: 'UTC',
      windows: [{ day: 1, from: '09:00', to: '10:00' }],
    };
    expect(deskCommandInputSchemas['coverage-draft'].safeParse(input).success).toBe(true);
    for (const body of [
      { ...input, windows: [] },
      { ...input, timezone: 'invalid-zone' },
      { ...input, staffedByRef: '' },
      { ...input, windows: [{ day: 7, from: '09:00', to: '10:00' }] },
    ])
      expect(deskCommandInputSchemas['coverage-draft'].safeParse(body).success).toBe(false);
  });
  it('rejects free-text reasons, omitted scope or duration, and queue reads without a bound', () => {
    const request = {
      organizationId: randomUUID(),
      ticketId: randomUUID(),
      requestedBy: 'test-agent@example.invalid',
      reasonCode: 'TEST_DIAGNOSIS',
      scopeType: 'artifact',
      scopeId: randomUUID(),
      requestedMinutes: 3,
    };
    expect(deskCommandInputSchemas.request.safeParse(request).success).toBe(true);
    for (const body of [
      { ...request, reasonCode: 'free text' },
      { ...request, requestedMinutes: 0 },
      { ...request, scopeType: 'organization' },
    ])
      expect(deskCommandInputSchemas.request.safeParse(body).success).toBe(false);
    expect(deskCommandInputSchemas.queue.safeParse({}).success).toBe(false);
  });
});
