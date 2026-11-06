// What `storeProposal` may put where, without a database. `ai.tool_proposals` is readable by the web tier,
// so a model's own words must never reach it. tests/integration/ai-tools.test.ts tries the real rows.
import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_TOOL_ARGS_BYTES,
  proposalKey,
  proposalRecordFor,
  toolWaitFor,
  UNKNOWN_TOOL_ID,
} from '@ensemus/application/ai-tool-steps';
import { EXTERNAL_ACTION_STATUSES } from '@ensemus/domain/external-action';
import { describe, expect, it } from 'vitest';

const RUN = randomUUID();
const record = (toolId: string, args: unknown, stepNumber = 2) =>
  proposalRecordFor({ runId: RUN, stepNumber, toolId, args });

describe('proposalRecordFor', () => {
  it('keeps the tool and version from the manifest', () => {
    expect(record('work.read', { work_unit_id: RUN })).toMatchObject({
      toolId: 'work.read',
      toolVersion: '1',
      status: 'proposed',
      decisionCode: null,
    });
  });

  it('never stores a name a model made up where the web tier can read it', () => {
    const canary = `canary-${randomUUID()}`;
    const stored = record(canary, {});
    expect(stored.toolId).toBe(UNKNOWN_TOOL_ID);
    expect(stored.toolVersion).toBe('0');
    expect(JSON.stringify({ ...stored, content: undefined })).not.toContain(canary);
  });

  it('hashes exactly what it stores', () => {
    const stored = record('work.read', { work_unit_id: RUN });
    expect(stored.content).toBe(JSON.stringify({ work_unit_id: RUN }));
    expect(stored.payloadHash).toBe(
      createHash('sha256')
        .update(stored.content ?? '')
        .digest('hex'),
    );
  });

  it('derives its key from the run and the step, so a retry finds the same proposal', () => {
    expect(record('work.read', {}, 7).idempotencyKey).toBe(
      record('email.send', {}, 7).idempotencyKey,
    );
    expect(record('work.read', {}, 7).idempotencyKey).not.toBe(
      record('work.read', {}, 8).idempotencyKey,
    );
    expect(proposalKey(RUN.toUpperCase(), 7)).toBe(proposalKey(RUN, 7));
  });

  it('refuses arguments too large to store, and keeps no copy', () => {
    const stored = record('email.send', { text: 'x'.repeat(MAX_TOOL_ARGS_BYTES) });
    expect(stored).toMatchObject({
      status: 'denied',
      decisionCode: 'TOOL_ARGS_INVALID',
      content: null,
    });
  });

  it('refuses arguments that cannot be written down', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(record('work.read', circular)).toMatchObject({ status: 'denied', content: null });
  });

  it('stores null for no arguments, which the parse then refuses', () => {
    expect(record('work.read', undefined).content).toBe('null');
  });
});

describe('toolWaitFor', () => {
  it('has an answer for every state M3 has', () => {
    expect(EXTERNAL_ACTION_STATUSES.map((status) => toolWaitFor(status, null))).toEqual([
      'waiting',
      'waiting',
      'waiting',
      'waiting',
      'done',
      'failed',
      'unknown_external_state',
      'denied',
    ]);
  });

  it('tells an expired approval from a declined one', () => {
    expect(toolWaitFor('cancelled', 'expired')).toBe('expired');
    expect(toolWaitFor('cancelled', 'denied')).toBe('denied');
  });

  it('never says failed or sent for a state it does not know', () => {
    expect(toolWaitFor('on_fire', null)).toBe('unknown_external_state');
  });
});
