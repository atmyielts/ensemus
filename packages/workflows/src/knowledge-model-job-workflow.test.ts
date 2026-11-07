import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MODEL_JOB_TIMEOUT_SECONDS } from '@ensemus/domain/knowledge-models';
import { AGENT_TASK_QUEUE, KNOWLEDGE_TASK_QUEUE } from './constants';

const transport = vi.hoisted(() => ({
  options: [] as {
    taskQueue: string;
    startToCloseTimeout: number | string;
    retry: { maximumAttempts: number };
  }[],
  model: vi.fn(),
  answer: vi.fn(),
  fallback: vi.fn(),
  failAnswer: vi.fn(),
}));
vi.mock('@temporalio/workflow', () => ({
  ActivityFailure: class extends Error {},
  TimeoutFailure: class extends Error {},
  proxyActivities(options: (typeof transport.options)[number]) {
    transport.options.push(options);
    return {
      runKnowledgeModelJob: transport.model,
      answerQuestion: transport.answer,
      refuseUnclaimedModelJob: transport.fallback,
      failAnswer: transport.failAnswer,
    };
  },
}));
import { knowledgeModelJobWorkflow } from './knowledge-model-job-workflow';
import { knowledgeAnswerWorkflow } from './knowledge-answer-workflow';

const organizationId = '610b8d13-bc17-4bf2-a350-c2ab6f54da19',
  jobId = 'c0909f38-42c3-4337-a9fa-d64f9c33d35d';
beforeEach(() => {
  transport.options.length = 0;
  transport.model.mockReset();
  transport.answer.mockReset();
  transport.fallback.mockReset();
  transport.failAnswer.mockReset();
});
describe('actual durable Knowledge model Activity transport', () => {
  it('covers the largest explicit caller deadline without granting paid retries or exposing material', async () => {
    transport.model.mockResolvedValue({ state: 'completed', code: null });
    expect(await knowledgeModelJobWorkflow({ organizationId, jobId })).toEqual({
      state: 'completed',
      code: null,
    });
    expect(transport.model).toHaveBeenCalledExactlyOnceWith({ organizationId, jobId });
    expect(
      transport.options.find((options) => options.taskQueue === AGENT_TASK_QUEUE),
    ).toMatchObject({
      startToCloseTimeout: MAX_MODEL_JOB_TIMEOUT_SECONDS * 1000,
      retry: { maximumAttempts: 1 },
    });
    expect(transport.options.some((options) => options.taskQueue === KNOWLEDGE_TASK_QUEUE)).toBe(
      true,
    );
    expect(transport.fallback).not.toHaveBeenCalled();
  });
  it('attempts only metadata refusal after a lost Activity response, without replaying paid work', async () => {
    transport.model.mockRejectedValue(new Error('GENERATED_LOST_ACTIVITY_ACK'));
    expect(await knowledgeModelJobWorkflow({ organizationId, jobId })).toEqual({
      state: 'refused',
      code: 'MODEL_UNAVAILABLE',
    });
    expect(transport.model).toHaveBeenCalledTimes(1);
    expect(transport.fallback).toHaveBeenCalledExactlyOnceWith({ organizationId, jobId });
  });
  it('uses the same technical ceiling for the existing answer transport, with one model attempt', async () => {
    transport.answer.mockResolvedValue({ outcome: 'answered' });
    expect(await knowledgeAnswerWorkflow({ organizationId, answerId: jobId })).toEqual({
      outcome: 'answered',
    });
    expect(
      transport.options.find((options) => options.taskQueue === AGENT_TASK_QUEUE),
    ).toMatchObject({
      startToCloseTimeout: MAX_MODEL_JOB_TIMEOUT_SECONDS * 1000,
      retry: { maximumAttempts: 1 },
    });
    expect(transport.answer).toHaveBeenCalledExactlyOnceWith({ organizationId, answerId: jobId });
    expect(transport.failAnswer).not.toHaveBeenCalled();
  });
});
