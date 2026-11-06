// Owned by the offboarding slice (LIFE-04). See docs/06-delivery/m8-slices.md.
import type { OffboardingActivityDeps } from './saas-deps';
import type { OffboardingInput, OffboardingStepResult } from './saas-schemas';
import { offboardingInputSchema } from './saas-schemas';
import { createServiceContext } from '@ensemus/database/service';
import { advanceOffboarding } from '@ensemus/application/saas/offboarding';
import { AppError } from '@ensemus/application';
import { createLogger } from '@ensemus/telemetry';

const log = createLogger('offboarding-activities');

export function createOffboardingActivities(deps: OffboardingActivityDeps) {
  return {
    /** One idempotent step. It reads what to do from the row, and its answer holds no text. */
    async advanceOffboardingStep(input: OffboardingInput): Promise<OffboardingStepResult> {
      const value = offboardingInputSchema.parse(input);
      try {
        const result = await advanceOffboarding(
          deps.database,
          createServiceContext(value.organizationId),
          deps.ports,
          { offboardingId: value.offboardingId, now: new Date() },
        );
        switch (result.next.kind) {
          case 'done':
            return {
              kind: 'stop',
              outcome: result.state === 'reported' ? 'reported' : 'cancelled',
            };
          case 'blocked_by_hold':
            return { kind: 'stop', outcome: 'blocked_by_hold' };
          case 'await_operator_erasure':
          case 'write_report':
            return { kind: 'stop', outcome: 'awaiting_operator' };
          case 'wait_for_transition':
            return result.wakeAtMs === null
              ? { kind: 'stop', outcome: 'awaiting_operator' }
              : { kind: 'wait', untilMs: result.wakeAtMs };
          case 'settle_pending_actions':
            return result.progressed
              ? { kind: 'continue' }
              : { kind: 'stop', outcome: 'awaiting_operator' };
          default:
            return { kind: 'continue' };
        }
      } catch (error) {
        if (error instanceof AppError && error.code === 'LEGAL_HOLD_ACTIVE')
          return { kind: 'stop', outcome: 'blocked_by_hold' };
        if (
          (error instanceof AppError && error.code === 'PREREQUISITES_INCOMPLETE') ||
          (error instanceof Error && error.message === 'PORT_NOT_WIRED_IN_EXPORT')
        ) {
          log.warn('offboarding.pending', {
            organizationId: value.organizationId,
            reasonCode: 'PORT_OR_PREREQUISITE_UNAVAILABLE',
          });
          return { kind: 'stop', outcome: 'awaiting_operator' };
        }
        throw error;
      }
    },
  };
}
export type OffboardingActivities = ReturnType<typeof createOffboardingActivities>;
