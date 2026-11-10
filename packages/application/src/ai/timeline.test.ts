// What a person may see of a run, in the parts that need no database. The rest is in
// tests/integration/ai-timeline.test.ts, which runs under the real roles.
import { readFileSync } from 'node:fs';
import { agentRunViewSchema, executionStepViewSchema } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { costIsEstimate, getAgentRun, listRunSteps, toAgentRunView, toStepView } from './timeline';

const RUN = '7f0c1f6e-3a39-4f5e-9d7a-3f4a0a4f1b11';
const WORK = '1a2b3c4d-1111-4222-8333-444455556666';
const VERSION = '2b3c4d5e-1111-4222-8333-444455556666';
const at = new Date('2026-11-06T10:00:00.000Z');

const runRow = {
  id: RUN,
  workUnitId: WORK,
  agentVersionId: VERSION,
  parentRunId: null,
  status: 'running',
  stopCode: null,
  effectiveClassification: 'internal',
  modelTurns: 2,
  toolCalls: 1,
  inputTokens: 300,
  outputTokens: 40,
  costMicros: 1234,
  createdAt: at,
  endedAt: null,
};

const stepRow = {
  stepNumber: 3,
  kind: 'model_turn',
  state: 'in_flight',
  labelCode: 'THINKING',
  outcome: null,
  decisionCode: null,
  startedAt: at,
  endedAt: null,
};

/** A database nothing should reach: refusals that need no query fail if one is tried. */
const unreachable = {
  transaction() {
    throw new Error('This should have been refused before reaching the database');
  },
} as unknown as AppDatabase;

const someone = {
  organizationId: 'a1a2a3a4-1111-4222-8333-444455556666',
  membershipId: 'b1b2b3b4-1111-4222-8333-444455556666',
  role: 'owner',
  actorType: 'user',
} as unknown as TenantContext;

describe('a run as a person sees it', () => {
  it('matches the contract', () => {
    const view = toAgentRunView(runRow, true);
    expect(agentRunViewSchema.parse(view)).toEqual(view);
    expect(view.created_at).toBe('2026-11-06T10:00:00.000Z');
    expect(view.ended_at).toBeNull();
  });

  it('carries only the listed fields, whatever else the row holds', () => {
    const view = toAgentRunView(
      {
        ...runRow,
        // None of these may reach a browser, and a row read with `select()` has them all.
        temporalRunId: 'workflow-run',
        delegatedScopes: { tools: ['work.read'] },
        initiatorMembershipId: 'someone',
        content: 'model text',
      } as typeof runRow,
      false,
    );
    expect(Object.keys(view).sort()).toEqual(
      [
        'agent_version_id',
        'cost_is_estimate',
        'cost_micros',
        'created_at',
        'effective_classification',
        'ended_at',
        'id',
        'input_tokens',
        'model_turns',
        'output_tokens',
        'parent_run_id',
        'status',
        'stop_code',
        'tool_calls',
        'work_unit_id',
      ].sort(),
    );
  });

  it('refuses a status outside the vocabulary rather than passing it on', () => {
    expect(() => toAgentRunView({ ...runRow, status: 'something new' }, true)).toThrow();
  });
});

describe('a step as a person sees it', () => {
  it('matches the contract', () => {
    const view = toStepView(stepRow);
    expect(executionStepViewSchema.parse(view)).toEqual(view);
  });

  it('carries codes and times, and no field that could hold words', () => {
    const view = toStepView({ ...stepRow, content: 'model text' } as typeof stepRow);
    expect(JSON.stringify(view)).not.toContain('model text');
    expect(Object.keys(view).sort()).toEqual(
      [
        'decision_code',
        'ended_at',
        'kind',
        'label_code',
        'outcome',
        'started_at',
        'state',
        'step_number',
      ].sort(),
    );
  });
});

describe('whether a cost is an estimate', () => {
  it('is an estimate when nothing backs it yet', () => {
    expect(costIsEstimate(undefined)).toBe(true);
    expect(costIsEstimate({ costing: 0, unbacked: 0 })).toBe(true);
  });

  it('is an estimate when any entry is not backed by an Ensemus rate card', () => {
    expect(costIsEstimate({ costing: 3, unbacked: 1 })).toBe(true);
  });

  it('is firm only when every costing entry is', () => {
    expect(costIsEstimate({ costing: 3, unbacked: 0 })).toBe(false);
  });
});

describe('reads that need no database to refuse', () => {
  const missing = (promise: Promise<unknown>) =>
    expect(promise).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND',
    );

  it('calls something that is not an ID not found, as it would any other', async () => {
    await missing(getAgentRun(unreachable, someone, 'not-an-id'));
    await missing(listRunSteps(unreachable, someone, "'; drop table ai.agent_runs; --"));
  });
});

describe('what this file can reach', () => {
  it.each(['./timeline.ts', './run-control.ts'])(
    '%s never names the table of model text',
    (file) => {
      // Web's role has no grant on it either. This keeps the mistake from being written at all.
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/stepPayloads|step_payloads/);
    },
  );
});
