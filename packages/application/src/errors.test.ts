// Lock contention is a busy tenant the caller can wait out, never a version conflict and never a 500.
import { describe, expect, it } from 'vitest';
import {
  AppError,
  busyFromDatabase,
  HTTP_STATUS,
  LOCK_NOT_AVAILABLE,
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
