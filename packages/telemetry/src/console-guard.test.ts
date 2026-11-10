import { describe, expect, it } from 'vitest';
import { installConsoleGuard } from './console-guard';
import { createLogger } from './index';

const CANARY = 'alice@corp.example';

function setUp() {
  const lines: string[] = [];
  const target = { error: () => undefined, warn: () => undefined } as {
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  const restore = installConsoleGuard(
    createLogger('test', (line) => lines.push(line)),
    target,
  );
  return { lines, target, restore };
}

/** The shape DrizzleQueryError has: its message is the SQL, with the parameters written out. */
const queryError = () =>
  Object.assign(new Error(`Failed query: select 1 params: ${CANARY}`), {
    cause: Object.assign(new Error(`bad value ${CANARY}`), { code: '22P02' }),
    digest: '1234567890',
  });

describe('the console guard', () => {
  it('keeps the code and digest of an error, and none of its message', () => {
    const { lines, target } = setUp();
    target.error('Uncaught', queryError());
    const output = lines.join('\n');
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain('Failed query');
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      event: 'console.error',
      errorCode: '22P02',
      reasonCode: '1234567890',
    });
  });

  it('drops free text passed on its own', () => {
    const { lines, target } = setUp();
    target.error(`Could not process ${CANARY}`);
    target.warn(`Slow request for ${CANARY}`);
    expect(lines.join('\n')).not.toContain(CANARY);
    expect(lines).toHaveLength(2);
  });

  it('does not trust a digest that is not shaped like one', () => {
    const { lines, target } = setUp();
    target.error(Object.assign(new Error('x'), { digest: `forged ${CANARY}` }));
    expect(lines.join('\n')).not.toContain(CANARY);
  });

  it('can be put back', () => {
    const { lines, target, restore } = setUp();
    restore();
    target.error(queryError());
    expect(lines).toEqual([]);
  });
});
