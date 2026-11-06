import { describe, expect, it } from 'vitest';
import { runKnowledgeAnswer } from './knowledge-answer-step';

describe('durable answer orchestration', () => {
  it('passes through an answered or refused result without another action', async () => {
    for (const outcome of ['answered', 'refused', 'no_evidence'] as const) {
      expect(
        await runKnowledgeAnswer({
          answer: async () => ({ outcome }),
          fail: async () => {
            throw new Error('UNEXPECTED');
          },
          modelWorkerAbsent: () => false,
        }),
      ).toEqual({ outcome });
    }
  });
  it('fails visibly on absent worker or lost model response and never retries the call', async () => {
    for (const absent of [false, true]) {
      let calls = 0,
        failures = 0;
      expect(
        await runKnowledgeAnswer({
          answer: async () => {
            calls++;
            throw new Error('LOST_RESULT');
          },
          fail: async () => {
            failures++;
          },
          modelWorkerAbsent: () => absent,
        }),
      ).toEqual({ outcome: absent ? 'model_worker_absent' : 'failed' });
      expect({ calls, failures }).toEqual({ calls: 1, failures: 1 });
    }
  });
});
