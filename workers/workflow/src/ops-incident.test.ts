import { afterEach, describe, expect, it, vi } from 'vitest';
const readSecret = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('TEST_NO_SECRET_ACCESS');
  }),
);
vi.mock('@ensemus/config', () => ({ readSecret }));
import { incidentCommand, incidentCommandInputSchemas } from './ops-incident';
afterEach(() => vi.clearAllMocks());
describe('incident command input precedes secret access', () => {
  it.each(
    (
      [
        [],
        ['missing'],
        ['open'],
        ['update'],
        ['drill'],
        ['vulnerability'],
        ['move'],
        ['open', '--unknown'],
        ['open', '--file', 'missing-test-file'],
      ] as string[][]
    ).map((args) => [args] as const),
  )('refuses malformed arguments %j', async (args) => {
    expect(await incidentCommand(args)).toBe(2);
    expect(readSecret).not.toHaveBeenCalled();
  });
  it('requires an actor and accepts only explicit offset timestamps', () => {
    const input = {
      operatorRef: 'test-operator@example.invalid',
      severity: 'medium',
      origin: 'unknown',
      providerKind: null,
      publicTitle: 'Test',
      commanderRef: 'test-commander@example.invalid',
      isDrill: true,
      startedAt: '2026-01-01T00:00:00Z',
    };
    expect(incidentCommandInputSchemas.open.safeParse(input).success).toBe(true);
    for (const value of [
      { ...input, operatorRef: undefined },
      { ...input, startedAt: '2026-01-01' },
      { ...input, privateBody: 'test' },
    ])
      expect(incidentCommandInputSchemas.open.safeParse(value).success).toBe(false);
  });
});
