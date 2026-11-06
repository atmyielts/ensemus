// Owned by the intents slice (WORK-08). See docs/06-delivery/m3-slices.md and ADR-027 D2.
import type { AppDatabase } from '@ensemus/database';
import type { ConnectorActivityDeps } from './connector-deps';
import type {
  ExternalActionInput,
  InterruptedStep,
  ReconcileStepResult,
  SendStep,
} from './schemas';

/** Reads PostgreSQL and contacts nobody, so it runs on the platform queue. */
export function createExternalActionPlatformActivities(_deps: { database: AppDatabase }) {
  return {
    /** What to do after a send Activity failed or timed out. Safe to retry. */
    async inspectInterruptedAction(_input: ExternalActionInput): Promise<InterruptedStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
    /** Ends an intent that never got anywhere, with what was tried. Safe to retry. */
    async failUnsentAction(
      _input: ExternalActionInput & { code: 'ATTEMPTS_EXHAUSTED' | 'CONNECTOR_UNAVAILABLE' },
    ): Promise<void> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type ExternalActionPlatformActivities = ReturnType<
  typeof createExternalActionPlatformActivities
>;

/** These hold a credential, so they run on the connector queue. */
export function createExternalActionConnectorActivities(_deps: ConnectorActivityDeps) {
  return {
    /**
     * One recheck, one recorded attempt and one send. The workflow calls this with no retries: a lost
     * answer goes through inspectInterruptedAction, never through calling this again blind. If it is
     * called anyway, the trigger on the attempts table refuses a second attempt that could send.
     */
    async sendExternalAction(_input: ExternalActionInput & { runId: string }): Promise<SendStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
    /** Asks the provider. Read-only, retried freely, and sends nothing whatever it finds. */
    async reconcileExternalAction(
      _input: ExternalActionInput & { code: 'WORKER_INTERRUPTED' | 'TIMEOUT_AFTER_COMMIT' },
    ): Promise<ReconcileStepResult> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type ExternalActionConnectorActivities = ReturnType<
  typeof createExternalActionConnectorActivities
>;
