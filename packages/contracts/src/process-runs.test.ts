import { describe, expect, it } from 'vitest';
import {
  startProcessRunSchema,
  processRunViewSchema,
  processRunsQuerySchema,
  processStopBodySchema,
} from './studio';
const id = 'a1000000-0000-4000-8000-00000000000b';
const view = {
  id,
  spec_id: id,
  title: 'Generated workflow work',
  process_name: 'Reviewed definition',
  root_work_unit_id: id,
  status: 'waiting',
  stop_code: 'ROOT_CONFIRMATION_REQUIRED',
  steps: [
    {
      key: 'first',
      label: 'Actual first task',
      after: [],
      kind: 'work_item',
      tool_id: null,
      status: 'done',
      stop_code: null,
      work_unit_id: id,
      approval_id: null,
      external_action_id: null,
      agent_run_id: null,
    },
  ],
  cost: null,
  can_manage: true,
  version: 1,
  created_at: '2026-11-08T00:00:00.000Z',
  finished_at: null,
};
describe('strict actual workflow transport', () => {
  it('requires a canonical UUID, title and valid optional instant on start', () => {
    expect(
      startProcessRunSchema.parse({ spec_id: id.toUpperCase(), title: ' Generated work ' }),
    ).toEqual({ spec_id: id, title: 'Generated work' });
    for (const value of [
      { spec_id: 'bad', title: 'Work' },
      { spec_id: id, title: '' },
      { spec_id: id, title: 'Work', due_at: '2026-99-99' },
      { spec_id: id, title: 'Work', agent_run_id: id },
    ])
      expect(startProcessRunSchema.safeParse(value).success).toBe(false);
  });
  it('preserves unknown cost separately from a measured zero and an estimate', () => {
    expect(processRunViewSchema.parse(view).cost).toBeNull();
    expect(
      processRunViewSchema.parse({ ...view, cost: { cost_micros: 0, is_estimate: false } }).cost,
    ).toEqual({ cost_micros: 0, is_estimate: false });
    expect(
      processRunViewSchema.parse({ ...view, cost: { cost_micros: 100, is_estimate: true } }).cost
        ?.is_estimate,
    ).toBe(true);
  });
  it('rejects absent invented inventory, transcripts, arbitrary output and unsafe costs', () => {
    for (const value of [
      { ...view, steps: [] },
      { ...view, steps: [{ ...view.steps[0], transcript: 'private' }] },
      { ...view, title: undefined },
      { ...view, cost: { cost_micros: -1, is_estimate: false } },
      { ...view, private_body: 'secret' },
    ])
      expect(processRunViewSchema.safeParse(value).success).toBe(false);
  });
  it('accepts only supported filters and a bounded cursor', () => {
    expect(processRunsQuerySchema.parse({})).toEqual({});
    expect(processRunsQuerySchema.safeParse({ status: 'done' }).success).toBe(false);
    expect(processRunsQuerySchema.safeParse({ after: 'x'.repeat(1025) }).success).toBe(false);
    expect(processRunsQuerySchema.safeParse({ membership_id: id }).success).toBe(false);
  });
  it('the stop body cannot choose a role, action, version or authority', () => {
    expect(processStopBodySchema.parse({})).toEqual({});
    expect(processStopBodySchema.safeParse({ role: 'owner' }).success).toBe(false);
  });
});
