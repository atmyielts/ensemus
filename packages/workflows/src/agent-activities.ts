// Owned by the spine slice (AGENT-02, AI-13). See docs/06-delivery/m4-slices.md and ADR-028. These run on
// AGENT_TASK_QUEUE, in agent-worker only: lint keeps this module from the web tier and from the base
// worker. Nothing here holds a transaction open across a model call.
import { createChildRun, settleChildRun } from '@ensemus/application/ai-delegation';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { isRunInputFence } from '@ensemus/application/ai-input-ledger';
import { currentRunInputClass, isMainInputDenied } from '@ensemus/application/ai-model-admission';
import type { HaltCheck, UsageLedger } from '@ensemus/application/ai-ports';
import {
  addToCountersInTx,
  claimQueuedRun,
  closeRunWithoutContext,
  closeUnclaimedRun,
  completeTurn,
  contextForRun,
  countToolSteps,
  createTurnStore,
  finishRun,
  listLostAttempts,
  raiseClassification,
  readResumePoint,
  readRunDirective,
  readRunFacts,
  readToolWait,
  reclaimRun,
  setRunStatus,
  stopReason,
  storedTurn,
  storeStepPayload,
  verifyOutput,
  type ClaimedRun,
  type LostAttempt,
  type ResumePoint,
  type RunFacts,
} from '@ensemus/application/ai-runs';
import { storeProposal } from '@ensemus/application/ai-tool-steps';
import { createUsageLedger } from '@ensemus/application/ai-usage';
import {
  TenantAccessDenied,
  withTenantTx,
  type AgentContext,
  type AppDatabase,
} from '@ensemus/database';
import {
  modelLedgerKey,
  STOP_CODES,
  strongestClassification,
  isTerminalAgentRun,
  type StopCode,
} from '@ensemus/domain/ai';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type {
  ClaimInput,
  ClaimResult,
  CreateChildRunInput,
  FinishRunInput,
  ModelTurnResult,
  RunDirective,
  RunRef,
  StepInput,
  ToolCallResult,
  ToolWaitState,
} from './agent-schemas';

const log = createLogger('agent-worker');

/** How often a model call tells Temporal it is alive. A cancel arrives on the answer to one of these. */
const HEARTBEAT_EVERY_MS = 5_000;

/** What an Activity needs from Temporal's own context while a call is out. */
export type ActivityPulse = { heartbeat(): void; signal: AbortSignal };

function temporalPulse(): ActivityPulse {
  const current = Context.current();
  return { heartbeat: () => current.heartbeat(), signal: current.cancellationSignal };
}

/** `purgeEndedRunTranscript` under the worker's own service context, bound by trusted composition. */
export type TranscriptPurgePort = {
  purgeEnded(organizationId: string, runId: string): Promise<'purged' | 'held'>;
};

/**
 * What the end of a run says about its transcript. 'unconfirmed' is the purge's own refusal of this
 * run's state (no such run, a run not yet ended, an unfenced checkpoint, or rows it could not remove):
 * asking again cannot change that answer. The transcript and its unpurged checkpoint stay as debt for
 * the lifecycle purge, and nothing claims they went.
 */
export type TranscriptPurgeAnswer = 'purged' | 'held' | 'unconfirmed';

/** The purge's refusals that describe the run, not an outage. See `purgeEndedRunTranscript`. */
const TERMINAL_PURGE_REFUSALS: ReadonlySet<string> = new Set(['NOT_FOUND', 'INVALID_STATE']);

/**
 * What agent-worker hands these Activities. The wiring slice builds the real objects in agent-main.ts.
 * Each field is typed where its slice owns it, so tests can give a double for any one of them. The optional
 * ones default to the real thing, made on first use, so a part that is not built yet refuses at that moment
 * and no earlier: a stub never starts a run, and a double is only ever passed in.
 */
export type AgentActivityDeps = {
  database: AppDatabase;
  gateway: import('@ensemus/intelligence').InferenceGateway;
  tools: import('@ensemus/agent-runtime/tools').ToolGateway;
  context: import('@ensemus/agent-runtime/context').ContextCompiler;
  usage?: UsageLedger;
  halt?: HaltCheck;
  /** Trusted composition binds metadata accounting; no service context enters agent Activities. */
  modelAccounting?: { reconcileRun(organizationId: string, runId: string): Promise<void> };
  /**
   * Trusted composition binds the native service purge of an ended run's transcript (FD-5, 0515):
   * the initiator's agent transaction can neither see an authority-v1 run's payloads (0417) nor
   * delete them, so the run's end hands them to this port. 'held' (an active legal hold) keeps them.
   * Required: no other path erases an ended run's prompts and answers, so a composition without it
   * would leave every transcript behind. `createAgentActivities` refuses to build without it.
   */
  transcripts: TranscriptPurgePort;
  /** Aborts an in-flight call when a kill switch covers it. See workers/workflow/src/kill-switch.ts. */
  haltWatcher?: {
    signalFor(run: {
      organizationId: string;
      agentVersionId: string;
      providerKind?: string;
    }): AbortSignal;
    release(signal: AbortSignal): void;
  };
  pulse?: () => ActivityPulse;
};

export interface AgentActivities {
  /** Finds the queued run in PostgreSQL, moves it to preparing and claims the Work Unit. */
  claimAgentRun(input: ClaimInput): Promise<ClaimResult>;
  /** The first Activity after continue-as-new: moves the hold to this workflow run's ID. */
  reclaimAgentRun(input: RunRef): Promise<ClaimResult>;
  /** What the last step was, for a run continued as new. Continue-as-new carries only IDs. */
  readResumePoint(input: RunRef): Promise<ResumePoint>;
  /** Reads run_controls and kill switches. The answer for this step comes from here, never a signal. */
  readRunDirective(input: RunRef): Promise<RunDirective>;
  /** One model turn: compile, route, reserve, send, validate, record. */
  runModelTurn(input: StepInput): Promise<ModelTurnResult>;
  /** One tool call, from the proposal the last turn stored. */
  runToolCall(input: StepInput): Promise<ToolCallResult>;
  /** Where a waiting tool step has got to. Reads PostgreSQL only, so it is safe to retry. */
  readToolWait(input: StepInput): Promise<ToolWaitState>;
  /** Moves the run to a waiting or running status with a recorded reason. */
  setRunStatus(
    input: RunRef & {
      status: 'running' | 'paused' | 'waiting_for_approval' | 'waiting_for_child' | 'verifying';
    },
  ): Promise<void>;
  /** Filled in by the delegation slice, in @ensemus/application/ai-delegation. */
  createChildRun(input: CreateChildRunInput): Promise<ToolCallResult>;
  /** Hands back what a finished child did not use. Safe to repeat. */
  settleChildRun(input: StepInput & { childRunId: string }): Promise<void>;
  /** Checks a final output against its criteria. `outcome_unverified` is an honest answer. */
  verifyRunOutput(input: RunRef): Promise<'completed' | 'outcome_unverified'>;
  /** The run's terminal status, settling reservations and purging payloads. Safe to repeat. */
  finishAgentRun(input: FinishRunInput): Promise<void>;
  /** Ends a run nothing ever claimed. It touches a run still queued, and nothing else. */
  closeQueuedRun(
    input: ClaimInput & { stopCode: 'WORKER_UNAVAILABLE' | 'WORK_STOPPED' },
  ): Promise<void>;
}

const STOP_CODE_SET: ReadonlySet<string> = new Set(STOP_CODES);
const asStopCode = (code: string | null | undefined): StopCode | null =>
  code && STOP_CODE_SET.has(code) ? (code as StopCode) : null;

/** Auxiliary calls have already updated these real counters; the main call has not started yet. */
export function mainTurnStop(facts: RunFacts, elapsedMs: number): StopCode | null {
  if (facts.counters.activeMs + elapsedMs >= facts.limits.timeoutSeconds * 1000)
    return 'TIME_LIMIT';
  if (facts.counters.modelTurns >= facts.limits.maxModelTurns) return 'TURN_LIMIT';
  if (facts.counters.inputTokens + facts.counters.outputTokens >= facts.limits.maxTotalTokens)
    return 'TOKEN_LIMIT';
  if (facts.counters.costMicros >= facts.limits.maxCostMicros) return 'COST_LIMIT';
  return null;
}

const refusal = (type: string) =>
  ApplicationFailure.create({ type, message: 'Agent run refused', nonRetryable: true });

/**
 * Only a code crosses Temporal. A raw error can quote a prompt: an SDK's does, and the message would sit in
 * Temporal's history, so nothing thrown below leaves here with its own words. A decision, which can never
 * succeed by trying again, ends the attempts. Anything else may be an outage, and it retries.
 */
function acrossTemporal(error: unknown): unknown {
  if (error instanceof ApplicationFailure) return error;
  if (error instanceof TenantAccessDenied) return refusal('INITIATOR_INACTIVE');
  const code = errorCode(error);
  if (error instanceof Error && error.name === 'AppError') return refusal(code);
  // A stub that is not built yet. It will not get better by being asked again.
  if (error instanceof Error && error.message === 'NOT_IMPLEMENTED')
    return refusal('NOT_IMPLEMENTED');
  log.warn('agent.activity_failed', { errorCode: code });
  return ApplicationFailure.create({ type: code, message: 'Agent activity failed' });
}

/** Every Activity ends here, so the rule above has no way round it. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw acrossTemporal(error);
  }
}

export function createAgentActivities(deps: AgentActivityDeps): AgentActivities {
  const { database } = deps;
  // The type requires it; this refuses a composition that reaches here without it all the same, at
  // start-up, rather than ending every run with its transcript left behind.
  if (typeof deps.transcripts?.purgeEnded !== 'function')
    throw new Error('AGENT_TRANSCRIPT_PURGE_REQUIRED');
  const transcripts = deps.transcripts;
  const turns = createTurnStore(database);
  const pulse = deps.pulse ?? temporalPulse;

  let usage = deps.usage;
  const ledger = () => (usage ??= createUsageLedger(database));
  let halt = deps.halt;
  const haltCheck = () => (halt ??= createHaltCheck());

  /**
   * FD-5, once the run's end has committed. NOT_FOUND and INVALID_STATE are the purge deciding about
   * this run, and no retry changes them: thrown on, they would fail the closing Activity after the run
   * had already ended. They answer 'unconfirmed' instead, so the run still closes, the transcript and
   * its unpurged checkpoint stay for the lifecycle purge, and nothing claims they went. Anything else
   * (NOWAIT contention, an outage) is thrown on, and the retry repeats a purge that is safe to repeat.
   */
  const purgeEndedTranscript = async (
    organizationId: string,
    runId: string,
  ): Promise<TranscriptPurgeAnswer> => {
    try {
      return await transcripts.purgeEnded(organizationId, runId);
    } catch (error) {
      const code = errorCode(error);
      if (!(
        error instanceof Error &&
        error.name === 'AppError' &&
        TERMINAL_PURGE_REFUSALS.has(code)
      ))
        throw error;
      log.warn('agent.transcript_purge_unconfirmed', { errorCode: code });
      return 'unconfirmed';
    }
  };

  /** A fresh context from PostgreSQL, for every Activity. An initiator who has gone ends the run here. */
  const contextOf = (input: RunRef) =>
    contextForRun(database, { organizationId: input.organizationId, agentRunId: input.agentRunId });

  /** The run as it stands, refusing an old workflow run that is still acting on a run that moved on. */
  const factsOf = async (context: AgentContext, input: RunRef): Promise<RunFacts> => {
    const facts = await readRunFacts(database, context, { agentRunId: input.agentRunId });
    if (!facts || facts.workUnitId !== input.workUnitId) throw refusal('NOT_FOUND');
    if (facts.temporalRunId !== input.temporalRunId) throw refusal('RUN_SUPERSEDED');
    return facts;
  };

  /**
   * FD-12. The provider may have billed this and nobody knows how much, so it is charged at what was
   * reserved. The key is the attempt's, so whichever of a retry and a late answer gets there first is the
   * only one to count, and the cost counter moves in the same transaction.
   */
  const chargeLostAttempt = (context: AgentContext, facts: RunFacts, lost: LostAttempt) =>
    withTenantTx(database, context, async (tx) => {
      const written = await ledger().record(tx, context, {
        idempotencyKey: modelLedgerKey(context.agentRunId, lost.stepNumber, lost.attempt),
        meter: 'model_input_tokens',
        quantity: 0,
        unit: 'token',
        costMicros: lost.amountMicros,
        rateCardId: null,
        rateCardVersion: null,
        reservationId: lost.reservationId,
        workUnitId: facts.workUnitId,
        runId: context.agentRunId,
        stepId: lost.stepId,
        profileId: facts.bound?.profileId ?? null,
        profileVersion: facts.bound?.profileVersion ?? null,
        providerKind: facts.bound?.providerKind ?? null,
        requestHash: null,
        status: 'estimated',
      });
      if (!written) return false;
      await ledger().settle(tx, context, {
        reservationId: lost.reservationId,
        actualMicros: lost.amountMicros,
      });
      await addToCountersInTx(tx, {
        agentRunId: context.agentRunId,
        delta: { costMicros: lost.amountMicros },
      });
      return true;
    });

  const claimed = (run: ClaimedRun | null): ClaimResult =>
    run
      ? {
          kind: 'claimed',
          agentRunId: run.agentRunId,
          limits: run.limits,
          counters: run.counters,
          nextStepNumber: run.nextStepNumber,
        }
      : { kind: 'nothing_queued' };

  return {
    claimAgentRun: (input) => guarded(async () => claimed(await claimQueuedRun(database, input))),

    reclaimAgentRun: (input) =>
      guarded(async () => {
        let context: AgentContext;
        try {
          context = await contextOf(input);
        } catch (error) {
          if (!(error instanceof TenantAccessDenied)) throw error;
          await closeRunWithoutContext(database, {
            organizationId: input.organizationId,
            agentRunId: input.agentRunId,
            status: 'cancelled',
            stopCode: 'INITIATOR_INACTIVE',
          });
          await deps.modelAccounting?.reconcileRun(input.organizationId, input.agentRunId);
          await purgeEndedTranscript(input.organizationId, input.agentRunId);
          return { kind: 'nothing_queued' as const };
        }
        const result = await reclaimRun(database, context, input);
        if (!result) {
          const facts = await readRunFacts(database, context, { agentRunId: input.agentRunId });
          if (facts && isTerminalAgentRun(facts.status))
            await deps.modelAccounting?.reconcileRun(input.organizationId, input.agentRunId);
        }
        return claimed(result);
      }),

    readResumePoint: (input) =>
      guarded(async () =>
        readResumePoint(database, await contextOf(input), { agentRunId: input.agentRunId }),
      ),

    readRunDirective: (input) =>
      guarded(async () =>
        readRunDirective(database, await contextOf(input), {
          agentRunId: input.agentRunId,
          temporalRunId: input.temporalRunId,
          halt: haltCheck,
        }),
      ),

    runModelTurn: (input) =>
      guarded(async () => {
        const startedAt = Date.now();
        const context = await contextOf(input);
        let facts = await factsOf(context, input);
        const { agentRunId } = input;

        const start = await turns.beginTurn(context, {
          runId: agentRunId,
          stepNumber: input.stepNumber,
        });
        // The turn finished, and only its answer was lost. Nothing is sent again.
        if (start.kind === 'already_done') {
          const stored = await storedTurn(database, context, {
            agentRunId,
            stepId: start.stepId,
          });
          return {
            outcome: start.outcome as ModelTurnResult['outcome'],
            stopCode: asStopCode(stored.code),
            counters: stored.counters,
          };
        }

        if (start.lostAttempt) {
          await chargeLostAttempt(context, facts, {
            stepId: start.stepId,
            stepNumber: input.stepNumber,
            ...start.lostAttempt,
            reservationId: start.lostAttempt.reservationId,
          });
          facts = await factsOf(context, input);
          // That may have been the last of what this run was allowed. It does not call again to find out.
          if (facts.counters.costMicros >= facts.limits.maxCostMicros) {
            const counters = await completeTurn(database, context, {
              agentRunId,
              stepId: start.stepId,
              attempt: start.attempt,
              outcome: 'budget_exhausted',
              code: 'COST_LIMIT',
              delta: { activeMs: Date.now() - startedAt },
            });
            return {
              outcome: 'budget_exhausted',
              stopCode: 'COST_LIMIT',
              counters: counters ?? facts.counters,
            };
          }
        }

        const { heartbeat, signal: temporalSignal } = pulse();
        const watched = deps.haltWatcher?.signalFor({
          organizationId: input.organizationId,
          agentVersionId: facts.agentVersionId,
          // Until the first profile is selected, any provider switch must stop this call. An empty
          // string is a different, nonexistent provider and would make the watcher miss that stop.
          ...(facts.bound ? { providerKind: facts.bound.providerKind } : {}),
        });
        const allowedMs = facts.limits.timeoutSeconds * 1000 - facts.counters.activeMs;
        const deadline =
          allowedMs > 0 ? AbortSignal.timeout(allowedMs) : AbortSignal.abort('RUN_TIME_LIMIT');
        const signal = AbortSignal.any([temporalSignal, deadline, ...(watched ? [watched] : [])]);
        let beat: ReturnType<typeof setInterval> | undefined;
        let outcome: Awaited<ReturnType<typeof deps.gateway.turn>>;
        let classification = facts.classification,
          mainStarted = false;
        const noCall = (
          stopCode: StopCode | null,
          budget = false,
        ): Awaited<ReturnType<typeof deps.gateway.turn>> => ({
          outcome: budget ? 'budget_exhausted' : 'stopped',
          stopCode,
          decisionCode: null,
          usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
          profile: null,
          text: null,
          toolCall: null,
        });
        try {
          heartbeat();
          beat = setInterval(heartbeat, HEARTBEAT_EVERY_MS);
          let compiled: Awaited<ReturnType<typeof deps.context.compile>> | undefined;
          if (!signal.aborted)
            try {
              compiled = await deps.context.compile(context, {
                runId: agentRunId,
                workUnitId: input.workUnitId,
                agentVersionId: facts.agentVersionId,
                modelStep: {
                  stepId: start.stepId,
                  stepNumber: input.stepNumber,
                  attempt: start.attempt,
                },
                signal,
              });
            } catch (error) {
              if (!signal.aborted) throw error;
            }
          facts = await factsOf(context, input);
          if (signal.aborted || !compiled)
            outcome = noCall(watched?.aborted ? 'HALTED' : deadline.aborted ? 'TIME_LIMIT' : null);
          else {
            classification = await raiseClassification(database, context, {
              agentRunId,
              atLeast: strongestClassification(
                strongestClassification(facts.classification, compiled.classification),
                await currentRunInputClass(database, context),
              ),
            });
            facts = await factsOf(context, input);
            const elapsedMs = Date.now() - startedAt,
              stop = mainTurnStop(facts, elapsedMs);
            if (facts.status !== 'running') outcome = noCall(null);
            else if (stop) outcome = noCall(stop, stop !== 'TIME_LIMIT');
            else {
              mainStarted = true;
              const remainingMs =
                facts.limits.timeoutSeconds * 1000 - facts.counters.activeMs - elapsedMs;
              outcome = await deps.gateway.turn(
                context,
                {
                  runId: agentRunId,
                  stepId: start.stepId,
                  stepNumber: input.stepNumber,
                  attempt: start.attempt,
                  workUnitId: input.workUnitId,
                  agentVersionId: facts.agentVersionId,
                },
                {
                  ...compiled,
                  // Time left, so one slow call cannot carry a run past its limit (FD-22).
                  timeoutMs: Math.max(1, Math.min(compiled.timeoutMs, remainingMs)),
                  maxOutputTokens: Math.min(
                    compiled.maxOutputTokens,
                    facts.limits.maxTotalTokens -
                      facts.counters.inputTokens -
                      facts.counters.outputTokens,
                  ),
                  task: {
                    ...compiled.task,
                    runId: agentRunId,
                    classification,
                    pinned: facts.bound
                      ? {
                          profileId: facts.bound.profileId,
                          profileVersion: facts.bound.profileVersion,
                        }
                      : null,
                  },
                },
                signal,
              );
            }
          }
        } finally {
          clearInterval(beat);
          if (watched) deps.haltWatcher?.release(watched);
        }

        // Temporal aborts a call for a worker going away as well as for a person. A person's stop reaches
        // the row. Anything else leaves the step in flight for the next attempt, which charges an estimate
        // if a hold is left, and the run carries on: a rolled worker is not a stop.
        const reason = (temporalSignal.reason as { message?: unknown } | undefined)?.message;
        if (temporalSignal.aborted && reason !== 'CANCELLED') {
          throw ApplicationFailure.create({
            type: 'WORKER_INTERRUPTED',
            message: 'Agent activity interrupted',
          });
        }

        // The answer is stored before the step says finished, so a finished step always has one.
        let final = outcome.outcome;
        let inputFenced = false;
        try {
          if (final === 'final_output' || final === 'tool_proposed') {
            const currentClass = await currentRunInputClass(database, context);
            if (strongestClassification(currentClass, classification) !== classification) {
              inputFenced = true;
              final = 'stopped';
            }
          }
          if (final === 'final_output' && outcome.text) {
            await storeStepPayload(database, context, {
              stepId: start.stepId,
              kind: 'completion',
              classification,
              content: outcome.text,
              attempt: start.attempt,
            });
          } else if (final === 'tool_proposed' && outcome.toolCall) {
            await storeProposal(database, context, {
              runId: agentRunId,
              stepNumber: input.stepNumber,
              toolId: outcome.toolCall.toolId,
              args: outcome.toolCall.args,
              originatingModel: {
                stepId: start.stepId,
                attempt: start.attempt,
                ...(outcome.inputSnapshotId ? { inputSnapshotId: outcome.inputSnapshotId } : {}),
              },
            });
          } else if (final === 'final_output' || final === 'tool_proposed') {
            final = 'invalid_output';
          }
        } catch (error) {
          if (!isRunInputFence(error) && !isMainInputDenied(error)) throw error;
          // Usage was settled by the gateway. Preserve its counters while discarding late content;
          // a durable content fence cannot be undone by a response that was already in flight.
          inputFenced = true;
          final = 'stopped';
        }

        const haltedNow = watched?.aborted === true && final === 'stopped';
        const stopCode: StopCode | null = inputFenced
          ? 'POLICY_DENIED'
          : deadline.aborted && final === 'stopped'
            ? 'TIME_LIMIT'
            : haltedNow
              ? 'HALTED'
              : outcome.stopCode;
        const counters = await completeTurn(database, context, {
          agentRunId,
          stepId: start.stepId,
          attempt: start.attempt,
          outcome: final,
          code: stopCode ?? outcome.decisionCode,
          delta: {
            modelTurns: mainStarted ? 1 : 0,
            inputTokens: outcome.usage.inputTokens,
            outputTokens: outcome.usage.outputTokens,
            costMicros: outcome.usage.costMicros,
            activeMs: Date.now() - startedAt,
          },
        });
        // Null means a later attempt has taken this step over. Its answer is the step's answer.
        return {
          outcome: final,
          stopCode,
          counters: counters ?? (await factsOf(context, input)).counters,
        };
      }),

    runToolCall: (input) =>
      guarded(async () => {
        const startedAt = Date.now();
        const context = await contextOf(input);
        const facts = await factsOf(context, input);
        const handled = await deps.tools.handle(context, {
          runId: input.agentRunId,
          stepNumber: input.stepNumber,
          workUnitId: input.workUnitId,
          agentVersionId: facts.agentVersionId,
        });
        const counters = await countToolSteps(database, context, {
          agentRunId: input.agentRunId,
          activeMs: Date.now() - startedAt,
        });
        return {
          outcome: handled.outcome,
          stopCode: asStopCode(handled.decisionCode),
          counters,
          // The asking run for now. `createChildRun` answers with the child's own Work Unit.
          delegation: handled.delegationRequested
            ? { organizationId: input.organizationId, workUnitId: input.workUnitId }
            : null,
        };
      }),

    readToolWait: (input) =>
      guarded(async () =>
        readToolWait(database, await contextOf(input), {
          agentRunId: input.agentRunId,
          stepNumber: input.stepNumber,
        }),
      ),

    setRunStatus: (input) =>
      guarded(async () => {
        const context = await contextOf(input);
        await setRunStatus(database, context, {
          agentRunId: input.agentRunId,
          status: input.status,
        });
      }),

    createChildRun: (input) =>
      guarded(async () => {
        const context = await contextOf(input);
        const created = await createChildRun(database, context, {
          parentRunId: input.agentRunId,
          stepNumber: input.stepNumber,
        });
        const { counters } = await factsOf(context, input);
        if (created.kind === 'denied') {
          return {
            outcome: created.code === 'BUDGET_EXHAUSTED' ? 'budget_exhausted' : 'denied',
            stopCode:
              created.code === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'DELEGATION_DENIED',
            counters,
            delegation: null,
          };
        }
        return {
          outcome: 'done',
          stopCode: null,
          counters,
          delegation: {
            organizationId: input.organizationId,
            workUnitId: created.childWorkUnitId,
          },
        };
      }),

    settleChildRun: (input) =>
      guarded(async () => {
        const context = await contextOf(input);
        await settleChildRun(database, context, {
          parentRunId: input.agentRunId,
          childRunId: input.childRunId,
        });
      }),

    verifyRunOutput: (input) =>
      guarded(async () =>
        verifyOutput(database, await contextOf(input), { agentRunId: input.agentRunId }),
      ),

    finishAgentRun: (input) =>
      guarded(async () => {
        const { agentRunId, organizationId, status } = input;
        let context: AgentContext;
        try {
          context = await contextOf(input);
        } catch (error) {
          if (!(error instanceof TenantAccessDenied)) throw error;
          await closeRunWithoutContext(database, {
            organizationId,
            agentRunId,
            status: status === 'completed' ? 'cancelled' : status,
            stopCode: 'INITIATOR_INACTIVE',
          });
          await deps.modelAccounting?.reconcileRun(organizationId, agentRunId);
          await purgeEndedTranscript(organizationId, agentRunId);
          return;
        }
        const facts = await readRunFacts(database, context, { agentRunId });
        // Not this workflow's to end, or already gone. Repeating this must be harmless.
        if (!facts || facts.temporalRunId !== input.temporalRunId) return;

        for (const lost of await listLostAttempts(database, context, { agentRunId })) {
          await chargeLostAttempt(context, facts, lost);
        }
        const stopCode =
          input.stopCode === 'STOPPED_BY_PERSON'
            ? await stopReason(database, context, { agentRunId })
            : asStopCode(input.stopCode);
        await finishRun(database, context, { agentRunId, status, stopCode });
        await deps.modelAccounting?.reconcileRun(organizationId, agentRunId);
        // finishRun no longer deletes payloads (it cannot under 0417/0515); the service purge does.
        await purgeEndedTranscript(organizationId, agentRunId);
      }),

    closeQueuedRun: (input) =>
      guarded(async () => {
        await closeUnclaimedRun(database, {
          organizationId: input.organizationId,
          workUnitId: input.workUnitId,
          status: input.stopCode === 'WORK_STOPPED' ? 'cancelled' : 'failed',
          stopCode: input.stopCode,
        });
      }),
  };
}
