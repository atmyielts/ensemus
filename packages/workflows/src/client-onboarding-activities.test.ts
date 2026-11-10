import { describe, expect, it } from 'vitest';
import { AppError } from '@ensemus/application';
import { TenantAccessDenied } from '@ensemus/database';
import { ApplicationFailure } from '@temporalio/common';
import { onboardingActivityFailure } from './client-onboarding-activities';

describe('onboarding activity failure boundary', () => {
  it.each([
    'FORBIDDEN',
    'INVALID_INPUT',
    'MODEL_PROFILE_NOT_ACTIVE',
    'BUDGET_NOT_CONFIGURED',
  ] as const)('does not keep retrying declared %s refusals', (code) => {
    const result = onboardingActivityFailure(new AppError(code));
    expect(result.type).toBe(code);
    expect(result.nonRetryable).toBe(true);
  });
  it.each(['RESTORE_PENDING', 'VERSION_CONFLICT'] as const)(
    'rechecks temporary %s state with a fresh transaction',
    (code) => {
      expect(onboardingActivityFailure(new AppError(code)).nonRetryable).toBe(false);
    },
  );
  it('treats a missing current tenant membership as a permanent refusal', () => {
    expect(onboardingActivityFailure(new TenantAccessDenied()).nonRetryable).toBe(true);
  });
  it.each(['55P03', '40P01', '40001', '08006', 'ECONNREFUSED'])(
    'keeps %s retryable without carrying database text',
    (code) => {
      const text = 'generated-private-database-value';
      const result = onboardingActivityFailure(Object.assign(new Error(text), { cause: { code } }));
      expect(result.nonRetryable).toBe(false);
      expect(result.message).not.toContain(text);
      expect(result.type).toBe('ONBOARDING_RETRYABLE');
      expect(result.details).toEqual([]);
    },
  );
  it('preserves a declared terminal boundary without retaining its message or details', () => {
    const result = onboardingActivityFailure(
      ApplicationFailure.create({
        message: 'generated-private-message',
        type: 'private-type',
        details: ['generated-private-detail'],
        nonRetryable: true,
      }),
    );
    expect(result.nonRetryable).toBe(true);
    expect(result.message).not.toContain('generated-private');
    expect(result.details).toEqual([]);
  });
});
