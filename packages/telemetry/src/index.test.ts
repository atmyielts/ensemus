// FOUND-04: secret canaries must not reach default telemetry, whatever a caller passes.
import { describe, expect, it } from 'vitest';
import { createLogger, errorCode } from './index.js';

const CANARY = 'sk-CANARY-1234567890';

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger('test', (line) => lines.push(line)) };
}

describe('logger', () => {
  it('keeps allowlisted identifiers and counts', () => {
    const { lines, log } = capture();
    log.info('run.step', { runId: 'abc-123', durationMs: 12 });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'run.step',
      runId: 'abc-123',
      durationMs: 12,
    });
  });

  it.each([
    ['unknown field', { apiKey: CANARY }],
    ['prompt field', { prompt: `please use ${CANARY}` }],
    ['nested object', { requestId: { value: CANARY } }],
    ['free text under a safe field', { status: `failed because ${CANARY} was rejected` }],
    ['an array', { count: [CANARY] }],
  ])('drops a secret in %s', (_label, fields) => {
    const { lines, log } = capture();
    log.error('thing.failed', fields);
    expect(lines[0]).not.toContain(CANARY);
    expect(JSON.parse(lines[0]!).droppedFields).toBe(1);
  });

  it('refuses free text as an event name', () => {
    const { lines, log } = capture();
    log.info(`user pasted ${CANARY}`);
    expect(lines[0]).not.toContain(CANARY);
  });
});

describe('errorCode', () => {
  it('uses a database error code from the cause, never the message', () => {
    const error = new Error(`Failed query: select $1 params: ${CANARY}`, {
      cause: { code: '42501', message: `denied ${CANARY}` },
    });
    expect(errorCode(error)).toBe('42501');
  });

  it('falls back to the error name', () => {
    expect(errorCode(new TypeError(CANARY))).toBe('TypeError');
  });

  it('copes with values that are not errors', () => {
    expect(errorCode(CANARY)).toBe('UNKNOWN_ERROR');
    expect(errorCode(null)).toBe('UNKNOWN_ERROR');
  });
});
