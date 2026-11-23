import {
  beginMeetingDerivation,
  finishMeetingDerivation,
  MeetingModelRefused,
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
  activity?: () => { temporalRunId: string; signal: AbortSignal };
} & (
  { model: MeetingModelGateway; egress: MeetingEgressGate } | { governedModel: MeetingModelGateway }
);

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

    let { prepared } = first;
    if ('egress' in deps) {
      try {
        const decision = await deps.egress.decide({
          organizationId,
          purpose: prepared.purpose,
          classification: prepared.classification,
          modelProfileId: prepared.modelProfileId,
        });
        if (!decision.allowed) return stop(decision.code, 'refused');
      } catch {
        return stop('EGRESS_DENIED', 'refused');
      }
      const checked = await beginMeetingDerivation(deps.database, context, run);
      if (checked.kind === 'done') return outcome(checked.status);
      if (checked.kind === 'stopped') return 'refused';
      prepared = checked.prepared;
    }

    const model = 'governedModel' in deps ? deps.governedModel : deps.model;
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(90_000)]);
    let answer;
    try {
      signal.throwIfAborted();
      answer = await model.derive({
        organizationId,
        runId: derivationRunId,
        temporalRunId,
        notesSha256: prepared.notesSha256,
        purpose: prepared.purpose,
        modelProfileId: prepared.modelProfileId,
        classification: prepared.classification,
        notes: prepared.notes,
        participantCount: prepared.participants.length,
        signal,
      });
      signal.throwIfAborted();
    } catch (error) {
      if (error instanceof MeetingModelRefused) return stop(error.code, 'refused');
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

/** The agent queue's activity uses a model that commits its own egress decision. */
export function createGovernedMeetingActivities(database: AppDatabase, model: MeetingModelGateway) {
  const { runMeetingDerivation } = createMeetingDerivationActivities({
    database,
    governedModel: model,
  });
  return { runGovernedMeetingDerivation: runMeetingDerivation };
}
export type GovernedMeetingActivities = ReturnType<typeof createGovernedMeetingActivities>;
