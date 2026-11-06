// Better Auth hands its logger whole error objects, and an ORM error quotes its SQL and parameters.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logSafely } from './index';

const CANARY = 'victim@example.invalid';
const ormError = () =>
  Object.assign(new Error(`Failed query: select * from users where email = $1 params: ${CANARY}`), {
    cause: Object.assign(new Error(`duplicate key: ${CANARY}`), { code: '23505' }),
  });

describe('what reaches the logs from the auth library', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const logged = () => lines.join('');

  it('reports an error as a fixed event and a code, with nothing it quoted', () => {
    logSafely('error', `Could not create user ${CANARY}`, ormError());
    expect(logged()).not.toContain(CANARY);
    expect(logged()).not.toContain('Failed query');
    const line = JSON.parse(logged()) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'error', event: 'auth.error', errorCode: '23505' });
  });

  it('reports a warning the same way', () => {
    logSafely('warn', `Something about ${CANARY}`, ormError());
    expect(logged()).not.toContain(CANARY);
    expect(JSON.parse(logged())).toMatchObject({ level: 'warn', event: 'auth.warning' });
  });

  it('drops the message and any other argument when there is no error to reduce', () => {
    logSafely('error', `Sign-in failed for ${CANARY}`, { email: CANARY }, CANARY);
    expect(logged()).not.toContain(CANARY);
    expect(JSON.parse(logged())).toMatchObject({ event: 'auth.error' });
  });

  it('writes nothing at all for lower levels', () => {
    logSafely('info', `Signed in ${CANARY}`);
    logSafely('debug', `Query for ${CANARY}`, ormError());
    expect(lines).toEqual([]);
  });
});
