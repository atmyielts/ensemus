// The sentences the run page chooses between (Journey B). Run here, because the web app has no test runner
// of its own. The page itself is read in tests/browser/specs/agent-run.spec.ts.
import type { AgentRunView, ExecutionStepView } from '@ensemus/contracts/ai';
import {
  AGENT_RUN_STATUSES,
  AI_REASON_CODES,
  STEP_LABEL_CODES,
  STOP_CODES,
} from '@ensemus/domain/ai';
import { describe, expect, it } from 'vitest';
import {
  costLine,
  decisionNote,
  formatMicros,
  isLiveStatus,
  pendingNote,
  runSignature,
  runStatusWords,
  stepLabel,
  stepNote,
  stepStateWords,
  stopReason,
} from '../../apps/web/src/app/o/[organizationId]/work/[workUnitId]/run/run-view';

const CANARY = 'canary-model-text-do-not-show';

const run: AgentRunView = {
  id: '7f0c1f6e-3a39-4f5e-9d7a-3f4a0a4f1b11',
  work_unit_id: '1a2b3c4d-1111-4222-8333-444455556666',
  agent_version_id: '2b3c4d5e-1111-4222-8333-444455556666',
  parent_run_id: null,
  status: 'running',
  stop_code: null,
  effective_classification: 'internal',
  model_turns: 2,
  tool_calls: 1,
  input_tokens: 300,
  output_tokens: 40,
  cost_micros: 1234,
  cost_is_estimate: true,
  created_at: '2026-11-06T10:00:00.000Z',
  ended_at: null,
};

const step: ExecutionStepView = {
  step_number: 1,
  kind: 'model_turn',
  state: 'completed',
  label_code: 'THINKING',
  outcome: null,
  decision_code: null,
  started_at: '2026-11-06T10:00:00.000Z',
  ended_at: '2026-11-06T10:00:02.000Z',
};

describe('every code has words of its own', () => {
  it.each(STEP_LABEL_CODES)('%s has a label', (code) => {
    expect(stepLabel(code)).not.toBe(stepLabel('SOMETHING_NEW'));
    expect(stepLabel(code).length).toBeGreaterThan(0);
  });

  it.each(STOP_CODES)('%s has a reason', (code) => {
    expect(stopReason(code)).not.toBe(stopReason('SOMETHING_NEW'));
  });

  it.each(AGENT_RUN_STATUSES)('%s has a label and a sentence', (status) => {
    const words = runStatusWords(status);
    expect(words.label).not.toBe(runStatusWords('something_new').label);
    expect(words.note.length).toBeGreaterThan(0);
  });

  it.each(AI_REASON_CODES.filter((code) => code !== 'ALLOWED'))('%s has a sentence', (code) => {
    expect(decisionNote(code)).not.toBe(decisionNote('SOMETHING_NEW'));
  });
});

describe('words from anywhere else never reach the page', () => {
  it('shows a fixed line for a code it does not know, and never the code', () => {
    for (const shown of [
      stepLabel(CANARY),
      stopReason(CANARY),
      runStatusWords(CANARY).label,
      runStatusWords(CANARY).note,
      stepStateWords(CANARY, true),
      decisionNote(CANARY) ?? '',
      stepNote({ ...step, outcome: CANARY, decision_code: CANARY }) ?? '',
    ]) {
      expect(shown).not.toContain(CANARY);
    }
  });

  it('is not fooled by a code named after something every object has', () => {
    for (const code of ['__proto__', 'constructor', 'toString']) {
      expect(typeof stepLabel(code)).toBe('string');
      expect(typeof stopReason(code)).toBe('string');
      expect(typeof runStatusWords(code).label).toBe('string');
      expect(typeof stepStateWords(code, true)).toBe('string');
    }
  });
});

describe('an unknown state is stated, and not smoothed over', () => {
  it('says plainly when a status is one this page does not know', () => {
    const words = runStatusWords('something_new');
    expect(words.label).toBe('Unknown');
    expect(words.note).toMatch(/does not recognise/);
    expect(words.live).toBe(false);
  });

  it('says it cannot tell what happened when the outcome is unverified', () => {
    const words = runStatusWords('outcome_unverified');
    expect(words.label).toBe('Outcome unknown');
    expect(words.note).toMatch(/could not confirm/);
    expect(words.note).toMatch(/will not retry/);
  });

  it('says so of a step with an unknown outside effect', () => {
    expect(stepNote({ ...step, outcome: 'unknown_external_state' })).toMatch(/do not know/);
  });

  it('does not call a step in progress once its run has ended', () => {
    expect(stepStateWords('in_flight', true)).toBe('In progress');
    expect(stepStateWords('in_flight', false)).toMatch(/do not know/);
  });

  it('does not claim the work is done because a run finished', () => {
    expect(runStatusWords('completed').note).toMatch(/does not mark the work done/);
  });
});

describe('which statuses count as live', () => {
  it.each(['queued', 'preparing', 'running', 'paused', 'waiting_for_approval'])('%s', (status) => {
    expect(isLiveStatus(status)).toBe(true);
  });

  it.each(['completed', 'failed', 'cancelled', 'outcome_unverified', 'nonsense'])(
    '%s',
    (status) => {
      expect(isLiveStatus(status)).toBe(false);
    },
  );
});

describe('what a person is told about a request still on its way', () => {
  it('says a stop is recorded, and has not happened yet', () => {
    expect(pendingNote('running', 'stop')).toMatch(/recorded/);
  });

  it('says a pause or a resume is on its way until the worker reaches it', () => {
    expect(pendingNote('running', 'pause')).toMatch(/pause/i);
    expect(pendingNote('paused', 'resume')).toMatch(/resume/i);
  });

  it('says nothing once the run has caught up', () => {
    expect(pendingNote('paused', 'pause')).toBeNull();
    expect(pendingNote('running', 'resume')).toBeNull();
    expect(pendingNote('running', null)).toBeNull();
  });

  it('says nothing about a run that has ended', () => {
    expect(pendingNote('cancelled', 'stop')).toBeNull();
  });
});

describe('money', () => {
  it('shows whole micro-USD exactly, with no float along the way', () => {
    expect(formatMicros(0)).toBe('$0.00');
    expect(formatMicros(1_500_000)).toBe('$1.50');
    expect(formatMicros(1)).toBe('$0.000001');
    expect(formatMicros(1234)).toBe('$0.001234');
    expect(formatMicros(123_456_789_012)).toBe('$123456.789012');
  });

  it('labels an estimate as one', () => {
    const line = costLine(1_500_000, true);
    expect(line.amount).toBe('$1.50');
    expect(line.label).toBe('Estimated cost');
    expect(line.note).toMatch(/not a bill/);
  });

  it('labels a measured cost as measured, and adds nothing', () => {
    const line = costLine(1_500_000, false);
    expect(line.label).toBe('Cost');
    expect(line.note).toBeNull();
  });
});

describe('the signature a page compares to know it is out of date', () => {
  const same = runSignature(run, [step]);

  it('stays the same when nothing has moved', () => {
    expect(runSignature({ ...run }, [{ ...step }])).toBe(same);
  });

  it.each([
    ['status', { status: 'paused' }],
    ['counters', { model_turns: 3 }],
    ['cost', { cost_micros: 9999 }],
    ['class', { effective_classification: 'restricted' }],
    ['stop code', { stop_code: 'HALTED' }],
  ] as const)('moves with the %s', (_name, change) => {
    expect(runSignature({ ...run, ...change }, [step])).not.toBe(same);
  });

  it('moves with a new step, and with a step changing state', () => {
    expect(runSignature(run, [step, { ...step, step_number: 2 }])).not.toBe(same);
    expect(runSignature(run, [{ ...step, state: 'failed' }])).not.toBe(same);
  });
});
