import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const readSecret = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('TEST_NO_SECRET_ACCESS');
  }),
);
vi.mock('@ensemus/config', () => ({ readSecret }));
import { eraseCommand, eraseCommandInputSchemas } from './ops-erase';
afterEach(() => vi.clearAllMocks());
describe('operator erasure command refuses before execution', () => {
  it('refuses an existing report path before credential access or irreversible work', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ensemus-erasure-preflight-')),
      file = join(directory, 'input.json'),
      report = join(directory, 'report.json');
    writeFileSync(
      file,
      JSON.stringify({
        organizationId: randomUUID(),
        offboardingId: randomUUID(),
        operatorRef: 'test-operator@example.invalid',
      }),
    );
    writeFileSync(report, 'test retained evidence');
    try {
      expect(
        await eraseCommand(['run', '--file', file, '--report-file', report], {
          agents: {
            haltOffboardingAgents: async () => undefined,
            releaseOffboardingAgents: async () => undefined,
          },
        }),
      ).toBe(2);
      expect(readSecret).not.toHaveBeenCalled();
      expect(readFileSync(report, 'utf8')).toBe('test retained evidence');
    } finally {
      unlinkSync(file);
      unlinkSync(report);
      rmdirSync(directory);
    }
  });
  it.each(
    (
      [
        [],
        ['erase'],
        ['run'],
        ['transition'],
        ['resume'],
        ['run', '--unknown'],
        ['run', '--file', 'missing-test-file'],
      ] as string[][]
    ).map((args) => [args] as const),
  )('rejects invalid arguments %j', async (args) => {
    expect(await eraseCommand(args)).toBe(2);
    expect(readSecret).not.toHaveBeenCalled();
  });
  it('requires explicit identifiers, named operator and contract date without defaults', () => {
    const input = {
      organizationId: randomUUID(),
      offboardingId: randomUUID(),
      operatorRef: 'test-operator@example.invalid',
    };
    expect(eraseCommandInputSchemas.run.parse(input)).toEqual(input);
    for (const body of [
      { ...input, operatorRef: '' },
      { ...input, organizationId: 'bad' },
      { ...input, price: 1 },
    ])
      expect(eraseCommandInputSchemas.run.safeParse(body).success).toBe(false);
    expect(eraseCommandInputSchemas.transition.safeParse(input).success).toBe(false);
    expect(
      eraseCommandInputSchemas.transition.safeParse({
        ...input,
        transitionEndsAt: '2041-02-03T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
