import {
  beginMeetingDerivation,
  finishMeetingDerivation,
  MeetingModelUnavailable,
  stopMeetingDerivation,
  type MeetingEgressGate,
  type MeetingModelGateway,
} from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import type { DerivationStatus, MeetingStopCode } from '@ensemus/domain/meeting';
import { Context } from '@temporalio/activity';
import {
  meetingDerivationInputSchema,
  type MeetingDerivationInput,
  type MeetingDerivationOutcome,
} from './schemas';

export type MeetingDerivationDeps = {
  database: AppDatabase;
  model: MeetingModelGateway;
  egress: MeetingEgressGate;
  activity?: () => { temporalRunId: string; signal: AbortSignal };
};

function activityIdentity() {
  const activity = Context.current();
  const temporalRunId = activity.info.workflowExecution?.runId;
  if (!temporalRunId) throw new Error('MEETING_ACTIVITY_RUN_REQUIRED');
  return {
    temporalRunId,
    signal: activity.cancellationSignal,
  };
}

function outcome(status: DerivationStatus | 'dropped'): MeetingDerivationOutcome {
  if (status === 'completed' || status === 'failed' || status === 'refused') return status;
  return 'dropped';
}

export function createMeetingDerivationActivities(deps: MeetingDerivationDeps) {
  const activity = deps.activity ?? activityIdentity;
  return {
    async runMeetingDerivation(input: MeetingDerivationInput): Promise<MeetingDerivationOutcome> {
      try {
        return await run(input);
      } catch {
        // SQL bind errors may quote private text. Temporal receives only a fixed retryable failure.
        throw new Error('MEETING_DERIVATION_ACTIVITY_FAILED');
      }
    },
    async stopInterruptedDerivation(
      input: MeetingDerivationInput,
    ): Promise<MeetingDerivationOutcome> {
      const { organizationId, derivationRunId } = meetingDerivationInputSchema.parse(input);
      const { temporalRunId } = activity();
      const status = await stopMeetingDerivation(
        deps.database,
        createServiceContext(organizationId),
        {
          derivationRunId,
          temporalRunId,
          code: 'MODEL_UNAVAILABLE',
          to: 'failed',
        },
      );
      return outcome(status);
    },
  };
  async function run(input: MeetingDerivationInput): Promise<MeetingDerivationOutcome> {
    const { organizationId, derivationRunId } = meetingDerivationInputSchema.parse(input);
    const { temporalRunId, signal: cancellation } = activity();
    const context = createServiceContext(organizationId);
    const run = { derivationRunId, temporalRunId };
    const stop = (code: MeetingStopCode, to: 'failed' | 'refused') =>
      stopMeetingDerivation(deps.database, context, { ...run, code, to }).then(outcome);
    const first = await beginMeetingDerivation(deps.database, context, run);
    if (first.kind === 'done') return outcome(first.status);
    if (first.kind === 'stopped') return 'refused';

    const { purpose, classification, modelProfileId } = first.prepared;
    try {
      const decision = await deps.egress.decide({
        organizationId,
        purpose,
        classification,
        modelProfileId,
      });
      if (!decision.allowed) return stop(decision.code, 'refused');
    } catch {
      return stop('EGRESS_DENIED', 'refused');
    }

    // The policy lookup may have waited. Recheck against consent and approval before sending.
    const checked = await beginMeetingDerivation(deps.database, context, run);
    if (checked.kind === 'done') return outcome(checked.status);
    if (checked.kind === 'stopped') return 'refused';

    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(90_000)]);
    let answer;
    try {
      signal.throwIfAborted();
      answer = await deps.model.derive({
        organizationId,
        runId: derivationRunId,
        purpose,
        modelProfileId,
        classification,
        notes: checked.prepared.notes,
        participantCount: checked.prepared.participants.length,
        signal,
      });
      signal.throwIfAborted();
    } catch (error) {
      const code = signal.aborted
        ? 'MODEL_TIMEOUT'
        : error instanceof MeetingModelUnavailable
          ? error.code
          : 'MODEL_UNAVAILABLE';
      return stop(code, 'failed');
    }
    const result = await finishMeetingDerivation(deps.database, context, { ...run, answer });
    return outcome(result.status);
  }
}
export type MeetingDerivationActivities = ReturnType<typeof createMeetingDerivationActivities>;
