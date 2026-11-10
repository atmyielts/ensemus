// Lock contention is a busy tenant the caller can wait out, never a version conflict and never a 500.
import { describe, expect, it } from 'vitest';
import {
  AppError,
  busyFromDatabase,
  HTTP_STATUS,
  LOCK_NOT_AVAILABLE,
  PG_CAUSE_DEPTH,
  pgCode,
  refusalFromDatabase,
  RETRYABLE_CODES,
  TENANT_BUSY_RETRY_AFTER_SECONDS,
} from './errors';

/** What Drizzle throws: its own error, with PostgreSQL's below it as the cause. */
const fromDatabase = (code: string) =>
  new Error('Failed query: insert into private values ($1)', { cause: { code } });

describe('a busy tenant (55P03, lock_not_available)', () => {
  it('is told as TENANT_BUSY, a retryable 503, in fixed words that echo nothing', () => {
    const refused = refusalFromDatabase(fromDatabase(LOCK_NOT_AVAILABLE));
    expect(refused).toBeInstanceOf(AppError);
    expect(refused?.code).toBe('TENANT_BUSY');
    expect(refused?.message).toBe(
      'This organization is busy with another change right now, so nothing was changed. Try again in a moment.',
    );
    expect(refused?.message).not.toContain('insert');
    expect(HTTP_STATUS.TENANT_BUSY).toBe(503);
    expect(RETRYABLE_CODES.has('TENANT_BUSY')).toBe(true);
    expect(TENANT_BUSY_RETRY_AFTER_SECONDS).toBeGreaterThan(0);
    expect(busyFromDatabase(fromDatabase('55P03'))?.code).toBe('TENANT_BUSY');
  });

  it('is never a version conflict, and a version conflict is never retryable', () => {
    expect(refusalFromDatabase(fromDatabase('55P03'))?.code).not.toBe('VERSION_CONFLICT');
    expect(RETRYABLE_CODES.has('VERSION_CONFLICT')).toBe(false);
    expect(RETRYABLE_CODES.has('RESTORE_PENDING')).toBe(true);
  });

  it.each(['40001', '40P01', '23505', '42501', 'EN407'])(
    'leaves database refusal %s to its own handling',
    (code) => {
      expect(busyFromDatabase(fromDatabase(code))).toBeNull();
      expect(refusalFromDatabase(fromDatabase(code))).toBeNull();
    },
  );

  it('keeps the refusals it already knew', () => {
    expect(refusalFromDatabase(fromDatabase('25006'))?.code).toBe('TENANT_READ_ONLY');
    expect(refusalFromDatabase(fromDatabase('EN804'))?.code).toBe('LEGAL_HOLD_ACTIVE');
    expect(busyFromDatabase(new AppError('VERSION_CONFLICT'))).toBeNull();
    expect(busyFromDatabase(undefined)).toBeNull();
  });
});

/**
 * PostgreSQL's error `depth` links down a cause chain: depth 1 is Drizzle's own shape, and every link
 * above it is one more wrapper, as a transaction helper or the application adds.
 */
const wrapped = (code: string, depth: number): Error => {
  let error = new Error('Failed query: insert into private values ($1)', {
    cause: Object.assign(new Error('could not obtain lock'), { code, severity: 'ERROR' }),
  });
  for (let link = 1; link < depth; link++) error = new Error('wrapped', { cause: error });
  return error;
};

describe('the cause chain pgCode reads', () => {
  it.each([1, 2, 3])('finds a busy tenant (55P03) %i link(s) down as TENANT_BUSY', (depth) => {
    const error = wrapped(LOCK_NOT_AVAILABLE, depth);
    expect(pgCode(error)).toBe(LOCK_NOT_AVAILABLE);
    expect(busyFromDatabase(error)?.code).toBe('TENANT_BUSY');
    expect(refusalFromDatabase(error)?.code).toBe('TENANT_BUSY');
  });

  it('reads Drizzle’s own shape exactly as before', () => {
    expect(pgCode(fromDatabase('23505'))).toBe('23505');
    expect(pgCode(fromDatabase('EN850'))).toBe('EN850');
    expect(pgCode(new Error('no cause'))).toBeUndefined();
    expect(pgCode(undefined)).toBeUndefined();
    expect(pgCode(null)).toBeUndefined();
    expect(pgCode('55P03')).toBeUndefined();
  });

  it('reads as far as the bound and no further', () => {
    expect(pgCode(wrapped(LOCK_NOT_AVAILABLE, PG_CAUSE_DEPTH))).toBe(LOCK_NOT_AVAILABLE);
    const beyond = wrapped(LOCK_NOT_AVAILABLE, PG_CAUSE_DEPTH + 1);
    expect(pgCode(beyond)).toBeUndefined();
    expect(busyFromDatabase(beyond)).toBeNull();
    expect(refusalFromDatabase(beyond)).toBeNull();
  });

  it('ends on a cyclic cause chain and finds nothing in it', () => {
    const first = new Error('first'),
      second = new Error('second', { cause: first });
    (first as { cause?: unknown }).cause = second;
    expect(pgCode(first)).toBeUndefined();
    expect(busyFromDatabase(first)).toBeNull();
    expect(refusalFromDatabase(first)).toBeNull();
  });

  it('never takes an AppError’s own code, or the error’s own code, for PostgreSQL’s', () => {
    const appBusy = new Error('wrapped', { cause: new AppError('TENANT_BUSY') });
    expect(pgCode(appBusy)).toBeUndefined();
    expect(busyFromDatabase(appBusy)).toBeNull();
    expect(pgCode(new AppError('TENANT_BUSY'))).toBeUndefined();
    expect(busyFromDatabase(new AppError('TENANT_BUSY'))).toBeNull();
    // The error itself is never read: only what lies below it.
    expect(pgCode(Object.assign(new Error('raw'), { code: LOCK_NOT_AVAILABLE }))).toBeUndefined();
    // An AppError in the chain is passed over, and PostgreSQL's error below it is still found.
    const below = new AppError('VERSION_CONFLICT');
    (below as { cause?: unknown }).cause = { code: LOCK_NOT_AVAILABLE };
    expect(pgCode(new Error('wrapped', { cause: below }))).toBe(LOCK_NOT_AVAILABLE);
  });

  it.each(['ECONNRESET', 'TENANT_BUSY', '55p03', '55P0', '55P033', ''])(
    'takes only a SQLSTATE-shaped code, so %j is passed over',
    (code) => {
      expect(pgCode(fromDatabase(code))).toBeUndefined();
      expect(pgCode(new Error('wrapped', { cause: { code, cause: { code: '23505' } } }))).toBe(
        '23505',
      );
    },
  );

  it('returns the first SQLSTATE walking down', () => {
    const error = new Error('wrapped', {
      cause: { code: '40001', cause: { code: LOCK_NOT_AVAILABLE } },
    });
    expect(pgCode(error)).toBe('40001');
    expect(busyFromDatabase(error)).toBeNull();
  });

  it('maps another refusal two links down as it maps it one link down', () => {
    for (const [code, expected] of [
      ['23505', null],
      ['42501', null],
      ['25006', 'TENANT_READ_ONLY'],
      ['EN804', 'LEGAL_HOLD_ACTIVE'],
      ['EN850', 'OBJECT_DELETE_UNCONFIRMED'],
      ['EN851', 'OBJECT_DELETE_IN_PROGRESS'],
    ] as const) {
      expect(pgCode(wrapped(code, 2))).toBe(code);
      expect(refusalFromDatabase(wrapped(code, 2))?.code ?? null).toBe(expected);
      expect(refusalFromDatabase(fromDatabase(code))?.code ?? null).toBe(expected);
      expect(busyFromDatabase(wrapped(code, 2))).toBeNull();
    }
  });
});
