import { describe, it, expect } from 'vitest';
import { AppError } from '@ensemus/application';
import { objectMigrationActivityFailure } from './object-migration-activities';
describe('custom object migration durable failure boundary', () => {
  it.each(['55P03', '40P01', '40001', 'ECONNREFUSED'])(
    'keeps transient %s retryable without private details',
    (code) => {
      const e = objectMigrationActivityFailure(
        Object.assign(new Error('private field content'), { cause: { code } }),
      );
      expect(e.nonRetryable).toBe(false);
      expect(e.details).toEqual([]);
      expect(e.message).not.toContain('private');
    },
  );
  it.each(['FORBIDDEN', 'NOT_FOUND', 'INVALID_STATE'] as const)(
    'ends declared %s refusal',
    (code) => expect(objectMigrationActivityFailure(new AppError(code)).nonRetryable).toBe(true),
  );
  it.each(['VERSION_CONFLICT', 'RESTORE_PENDING'] as const)(
    'rechecks %s with a fresh transaction',
    (code) => expect(objectMigrationActivityFailure(new AppError(code)).nonRetryable).toBe(false),
  );
});
