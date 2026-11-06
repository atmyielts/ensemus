// Running a compiled process (AGENT-13, ADR-031 D7). Pure, and owned by the process slice. A workflow's
// decisions live here, as review-wait.ts does for reviews, so a unit test can reach every path.
import { PROCESS_LIMITS, type ProcessSpec, type ProcessStep } from './process-spec';
import type { SimulatedStep, SimulationReport, SimulationScenario } from './simulation';

export type StepStatus = 'pending' | 'ready' | 'waiting' | 'done' | 'failed' | 'skipped';

export type RunDecision =
  | { next: 'start_steps'; stepKeys: readonly string[] }
  | { next: 'wait' }
  | { next: 'completed' }
  | { next: 'failed'; stepKey: string };

/**
 * Which steps can start, given where every step stands. A failed step stops what follows it, and stops the
 * run as a whole: the steps beside it do not go on, because nobody asked for half a process.
 *
 * `completed` is only ever every step done. A step that was skipped or that can never start is not done, so
 * a run holding one ends as failed and names it, once nothing is still out waiting on someone.
 */
export function nextProcessSteps(
  spec: ProcessSpec,
  statuses: Readonly<Record<string, StepStatus>>,
): RunDecision {
  const statusOf = (key: string): StepStatus => statuses[key] ?? 'pending';

  const failed = spec.steps.find((step) => statusOf(step.key) === 'failed');
  if (failed) return { next: 'failed', stepKey: failed.key };
  if (spec.steps.every((step) => statusOf(step.key) === 'done')) return { next: 'completed' };

  // A step out with someone holds up only what is drawn after it, and nothing beside it.
  const startable = spec.steps.filter((step) => {
    const status = statusOf(step.key);
    if (status !== 'pending' && status !== 'ready') return false;
    return step.after.every((before) => statusOf(before) === 'done');
  });
  if (startable.length > 0) {
    return { next: 'start_steps', stepKeys: startable.map((step) => step.key) };
  }
  if (spec.steps.some((step) => statusOf(step.key) === 'waiting')) return { next: 'wait' };

  // Nothing is running and nothing can start. Saying `wait` here would wait for ever.
  const stuck =
    spec.steps.find((step) => statusOf(step.key) === 'skipped') ??
    spec.steps.find((step) => statusOf(step.key) !== 'done');
  return { next: 'failed', stepKey: stuck?.key ?? '' };
}

/** Each step once, every step after all it depends on, and the same order for the same spec. */
function runOrder(spec: ProcessSpec): readonly ProcessStep[] {
  const placed = new Set<string>();
  const known = new Set(spec.steps.map((step) => step.key));
  const order: ProcessStep[] = [];
  const left = [...spec.steps].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  while (left.length > 0) {
    const index = left.findIndex((step) =>
      step.after.every((before) => placed.has(before) || !known.has(before)),
    );
    // A compiled spec is acyclic. A hand-written row may not be, and this has to stay total all the same.
    const [next] = left.splice(index === -1 ? 0 : index, 1);
    if (!next) break;
    placed.add(next.key);
    order.push(next);
  }
  return order;
}

/** Whether every path to this step passes a person's approval. Checked by path, not by count. */
function approvedOnEveryPath(
  byKey: ReadonlyMap<string, ProcessStep>,
  step: ProcessStep,
): boolean {
  const memo = new Map<string, boolean>();
  const visit = (current: ProcessStep): boolean => {
    const known = memo.get(current.key);
    if (known !== undefined) return known;
    memo.set(current.key, false);
    // With a join every `after` has to finish first, so one approval before it is on every way through.
    const result = current.after.some((key) => {
      const before = byKey.get(key);
      return before ? before.kind === 'human_approval' || visit(before) : false;
    });
    memo.set(current.key, result);
    return result;
  };
  return visit(step);
}

/**
 * Walks a spec with nothing behind it (ADR-031 D5). A step that would write outside is reported as that, and
 * a report with a missing approval fails. Called by `runSimulationStep` for a process or catalog subject.
 * It holds step keys and tool IDs, and never a label, so a report can go anywhere a code can.
 *
 * `processPath` says how far the scenario expects to get. A step off the end of it is reported as not
 * reached, which is how a catalog workflow with a missing connector is simulated: not as if it worked.
 */
export function simulateProcess(
  spec: ProcessSpec,
  specSha256: string,
  scenario: SimulationScenario,
): SimulationReport {
  const byKey = new Map(spec.steps.map((step) => [step.key, step]));
  const failures: string[] = [];
  const outside: string[] = [];
  const steps: SimulatedStep[] = [];
  let approvals = 0;
  let calls = 0;

  const record = (subject: string, decision: SimulatedStep['decision'], reasonCode: string) => {
    steps.push({ index: steps.length, subject, decision, reasonCode });
  };

  const walk = (step: ProcessStep) => {
    switch (step.kind) {
      case 'human_approval':
        approvals += 1;
        record(step.key, 'needs_approval', 'PERSON_DECIDES');
        return;
      case 'external_action': {
        if (spec.classification === 'restricted') {
          failures.push('RESTRICTED_EFFECT');
          record(step.key, 'denied', 'RESTRICTED_EFFECT');
          return;
        }
        calls += 1;
        // M3 asks for its own approval on the effect, on top of the one drawn before it.
        approvals += 1;
        outside.push(step.toolId ?? step.key);
        if (!approvedOnEveryPath(byKey, step)) failures.push('EFFECT_WITHOUT_APPROVAL');
        record(step.key, 'would_write_outside', 'PROPOSED_FOR_APPROVAL');
        return;
      }
      case 'agent_task':
        record(step.key, 'allowed', 'AGENT_WOULD_RUN_AS_STARTER');
        return;
      case 'evidence_check':
        record(step.key, 'allowed', 'EVIDENCE_WOULD_BE_CHECKED');
        return;
      case 'work_item':
        record(step.key, 'allowed', 'WORK_WOULD_BE_CREATED');
        return;
    }
  };

  const path = scenario.processPath;
  if (path === undefined) {
    for (const step of runOrder(spec)) walk(step);
  } else {
    const walked = new Set<string>();
    for (const key of path) {
      const step = byKey.get(key);
      if (!step) {
        failures.push('PATH_UNKNOWN_STEP');
        continue;
      }
      if (!step.after.every((before) => walked.has(before))) failures.push('PATH_OUT_OF_ORDER');
      walked.add(key);
      walk(step);
    }
    for (const step of runOrder(spec)) {
      if (!walked.has(step.key)) record(step.key, 'denied', 'NOT_REACHED');
    }
  }

  const failureCodes = [...new Set(failures)];
  return {
    schemaVersion: 1,
    scenarioKey: scenario.key,
    subjectSha256: specSha256,
    steps,
    wouldWriteOutside: outside,
    approvalsNeeded: approvals,
    // A process has no model turns, so a step stands for a turn, against what the compiler allows.
    limits: {
      turnsUsed: steps.filter((step) => step.reasonCode !== 'NOT_REACHED').length,
      turnsAllowed: PROCESS_LIMITS.maxNodes,
      toolCallsUsed: calls,
      toolCallsAllowed: PROCESS_LIMITS.maxNodes,
    },
    outcome: failureCodes.length === 0 ? 'passed' : 'failed',
    failureCodes,
  };
}

export type RunStopCode =
  'SPEC_HASH_MISMATCH' | 'STOP_REQUESTED' | 'ROOT_STOPPED' | 'STARTER_INACTIVE';

/**
 * What has to hold just before a run makes anything happen. Read under the run's lock, again before each
 * effect, so someone being disabled or a stop being committed takes effect before the next one.
 */
export function recheckRun(facts: {
  stopRequested: boolean;
  rootStatus: string;
  specHashStored: string;
  specHashNow: string;
  starterActive: boolean;
}): RunStopCode | null {
  if (facts.specHashStored !== facts.specHashNow) return 'SPEC_HASH_MISMATCH';
  if (facts.stopRequested) return 'STOP_REQUESTED';
  if (facts.rootStatus === 'cancelled') return 'ROOT_STOPPED';
  if (!facts.starterActive) return 'STARTER_INACTIVE';
  return null;
}

/** The status a run ends with for this code. Being stopped is not the same as having gone wrong. */
export function stopStatusFor(code: string): 'cancelled' | 'failed' {
  return code === 'STOP_REQUESTED' || code === 'ROOT_STOPPED' || code === 'STARTER_INACTIVE'
    ? 'cancelled'
    : 'failed';
}

export type StepOutcome = {
  status: Extract<StepStatus, 'waiting' | 'done' | 'failed'>;
  stopCode: string | null;
};

const stillWaiting: StepOutcome = { status: 'waiting', stopCode: null };
const finished: StepOutcome = { status: 'done', stopCode: null };
const stopped = (stopCode: string): StepOutcome => ({ status: 'failed', stopCode });

/** A step's own Work Unit. A person finishes it, on its page, by the usual rules. */
export function workStepOutcome(status: string): StepOutcome {
  if (status === 'completed') return finished;
  if (status === 'failed') return stopped('WORK_FAILED');
  if (status === 'cancelled') return stopped('WORK_STOPPED');
  return stillWaiting;
}

export function approvalStepOutcome(status: string): StepOutcome {
  if (status === 'approved') return finished;
  if (status === 'denied') return stopped('APPROVAL_DENIED');
  if (status === 'expired') return stopped('APPROVAL_EXPIRED');
  if (status === 'cancelled') return stopped('APPROVAL_CANCELLED');
  return stillWaiting;
}

/**
 * M3's intent. `unknown` may have gone out, so only a person can settle it (ADR-027 D6): this waits with a
 * code and never tries again. An intent a person resolved becomes `sent` or `failed` through M3.
 */
export function externalStepOutcome(status: string): StepOutcome {
  if (status === 'sent') return finished;
  if (status === 'failed') return stopped('EXTERNAL_ACTION_FAILED');
  if (status === 'cancelled') return stopped('EXTERNAL_ACTION_CANCELLED');
  if (status === 'unknown') return { status: 'waiting', stopCode: 'EXTERNAL_ACTION_UNKNOWN' };
  return stillWaiting;
}

export function agentStepOutcome(
  outcome: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown',
): StepOutcome {
  switch (outcome) {
    case 'completed':
      return finished;
    case 'failed':
      return stopped('AGENT_RUN_FAILED');
    case 'stopped':
      return stopped('AGENT_RUN_STOPPED');
    case 'unknown':
      return { status: 'waiting', stopCode: 'AGENT_RUN_UNKNOWN' };
    case 'running':
      return stillWaiting;
  }
}

/** Everything that has to finish before this step, however far back. */
export function ancestorsOf(spec: ProcessSpec, stepKey: string): ReadonlySet<string> {
  const byKey = new Map(spec.steps.map((step) => [step.key, step]));
  const found = new Set<string>();
  const pending = [...(byKey.get(stepKey)?.after ?? [])];
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (found.has(key)) continue;
    found.add(key);
    pending.push(...(byKey.get(key)?.after ?? []));
  }
  return found;
}

export type MeasuredCost = { costMicros: number; isEstimate: boolean };

/**
 * Null means nobody measured it, and is never zero. Part measured and part not is a figure that may be low,
 * so it is labelled an estimate instead of reading as the whole cost.
 */
export function sumMeasuredCost(costs: readonly (MeasuredCost | null)[]): MeasuredCost | null {
  const known = costs.filter((cost): cost is MeasuredCost => cost !== null);
  if (known.length === 0) return null;
  return {
    costMicros: known.reduce((total, cost) => total + cost.costMicros, 0),
    isEstimate: known.length < costs.length || known.some((cost) => cost.isEstimate),
  };
}
