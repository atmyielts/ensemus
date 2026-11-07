// ID-05: the way back from confirming a second factor comes from the address bar, so it is untrusted. Run
// here, because the web app has no test runner of its own.
import { describe, expect, it } from 'vitest';
import { safeStepUpReturn, stepUpPath } from '../../apps/web/src/lib/step-up';

const ORG = '6f1c2c6e-1111-4111-8111-111111111111';
const OTHER = '6f1c2c6e-2222-4222-8222-222222222222';
const HOME = `/o/${ORG}`;

describe('the way back from a second factor', () => {
  it('keeps a path inside this organization', () => {
    expect(safeStepUpReturn(ORG, `${HOME}/studio/agents`)).toBe(`${HOME}/studio/agents`);
    expect(safeStepUpReturn(ORG, HOME)).toBe(HOME);
  });

  it.each([
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    `/o/${OTHER}/studio`,
    `${HOME}/../${OTHER}`,
    `${HOME}/studio?x=1`,
    `${HOME}x`,
    '',
    null,
    undefined,
    42,
  ])('sends %s home', (value) => {
    expect(safeStepUpReturn(ORG, value)).toBe(HOME);
  });

  it('encodes what it puts in the address', () => {
    expect(stepUpPath(ORG, `${HOME}/packs`)).toBe(
      `${HOME}/security/confirm?next=${encodeURIComponent(`${HOME}/packs`)}`,
    );
  });
});
