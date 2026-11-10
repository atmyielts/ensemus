// Capture only against the isolated capture stack, with every product worker stopped. Histories owed.
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import type { KnowledgeAnswerResult } from '@ensemus/workflows/knowledge-schemas';
import { capturing, withCaptureWorkers } from './capture-support';

const input = {
  organizationId: '00000000-0000-4000-8000-000000000a01',
  answerId: '00000000-0000-4000-8000-000000000a02',
};
describe.skipIf(!capturing)('capture durable knowledge answers', () => {
  it('records success, refusal, no evidence and lost model result', async () => {
    let outcome: KnowledgeAnswerResult['outcome'] = 'answered';
    let fail = false;
    await withCaptureWorkers(
      {
        queues: [`capture-answer-${randomUUID()}`, 'ensemus-knowledge', 'ensemus-agent'],
        activities: {
          answerQuestion: async () => {
            if (fail) throw new Error('MODEL_UNAVAILABLE');
            return { outcome };
          },
          failAnswer: async () => undefined,
        },
      },
      async ({ record }) => {
        for (const next of ['answered', 'refused', 'no_evidence'] as const) {
          outcome = next;
          await record(`knowledge-answer-${next}`, {
            workflowType: 'knowledgeAnswerWorkflow',
            args: [input],
          });
        }
        fail = true;
        await record('knowledge-answer-lost-result', {
          workflowType: 'knowledgeAnswerWorkflow',
          args: [input],
        });
      },
    );
  }, 180_000);
  it('records a deployment with no model worker', async () => {
    await withCaptureWorkers(
      {
        queues: [`capture-answer-absent-${randomUUID()}`, 'ensemus-knowledge'],
        activities: { failAnswer: async () => undefined },
      },
      async ({ record }) => {
        await record('knowledge-answer-model-worker-absent', {
          workflowType: 'knowledgeAnswerWorkflow',
          args: [input],
        });
      },
    );
  }, 90_000);
});
