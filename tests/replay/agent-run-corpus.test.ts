// A missing required capture fails. Worker.runReplayHistory in replay.test.ts independently replays
// every JSON history against today's unmodified workflow; these assertions hold the named coverage,
// real terminal decisions, encryption, queues and privacy contract rather than counting files alone.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TASK_QUEUE } from '@ensemus/workflows/constants';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';
import {
  AGENT_CONTINUE_HISTORY,
  AGENT_INPUT,
  AGENT_RUN_HISTORIES,
  AGENT_RUN_ID,
} from './agent-run-paths';
import { CORPUS_DIR } from './corpus';
import { decodeCorpusPayload as decode, type JsonPayload } from './history-payloads';

type Event = {
  eventType: string;
  workflowExecutionStartedEventAttributes?: {
    workflowType?: { name?: string };
    input?: { payloads?: JsonPayload[] };
    originalExecutionRunId?: string;
    continuedExecutionRunId?: string;
  };
  workflowExecutionCompletedEventAttributes?: { result?: { payloads?: JsonPayload[] } };
  workflowExecutionContinuedAsNewEventAttributes?: { newExecutionRunId?: string };
  activityTaskScheduledEventAttributes?: {
    activityType?: { name?: string };
    taskQueue?: { name?: string };
    input?: { payloads?: JsonPayload[] };
  };
};
const readHistory = (name: string) => {
  const file = join(repoRoot, CORPUS_DIR, `${name}.json`);
  expect(
    existsSync(file),
    `${name} needs a real Temporal capture before the M4 replay gate can pass`,
  ).toBe(true);
  return JSON.parse(readFileSync(file, 'utf8')) as { events: Event[] };
};

describe('agent run command histories', () => {
  it.each(AGENT_RUN_HISTORIES)('$name has the expected real terminal outcome', async (path) => {
    const history = readHistory(path.name);
    expect(history.events.length).toBeGreaterThan(3);
    const start = history.events[0]?.workflowExecutionStartedEventAttributes;
    expect(start?.workflowType?.name).toBe('agentRunWorkflow');
    expect(await decode(start!.input!.payloads![0]!)).toEqual(AGENT_INPUT);
    const complete = history.events.find(
      (event) => event.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
    )?.workflowExecutionCompletedEventAttributes;
    const output = await decode(complete!.result!.payloads![0]!);
    expect(output).toEqual({
      workUnitId: AGENT_INPUT.workUnitId,
      agentRunId: path.status === 'nothing_queued' ? null : AGENT_RUN_ID,
      status: path.status,
    });
    const scheduled = history.events.flatMap(
      (event) => event.activityTaskScheduledEventAttributes ?? [],
    );
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled.every((activity) => activity.taskQueue?.name === AGENT_TASK_QUEUE)).toBe(true);
    const finishes = scheduled.filter(
      (activity) => activity.activityType?.name === 'finishAgentRun',
    );
    if (path.status === 'nothing_queued') expect(finishes).toEqual([]);
    else {
      expect(finishes).toHaveLength(1);
      expect(await decode(finishes[0]!.input!.payloads![0]!)).toMatchObject({
        status: path.status,
        stopCode: path.stop,
      });
    }
    const text = JSON.stringify(history);
    if (path.name.endsWith('-in-flight') || path.name === 'agent-run-workflow-cancelled') {
      expect(text).toContain('EVENT_TYPE_ACTIVITY_TASK_CANCEL_REQUESTED');
      expect(text).toContain('EVENT_TYPE_ACTIVITY_TASK_CANCELED');
    }
    if (
      path.name === 'agent-run-pause-resume' ||
      path.name.startsWith('agent-run-tool-approval-')
    ) {
      expect(text).toContain('EVENT_TYPE_TIMER_STARTED');
      expect(text).toContain('EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED');
    }
    if (
      path.name.startsWith('agent-run-delegation-') &&
      path.name !== 'agent-run-delegation-refused'
    ) {
      expect(text).toContain('EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED');
    }
    if (path.name.startsWith('agent-run-resumed-') || path.name === 'agent-run-continued-resume') {
      expect(text).toContain('reclaimAgentRun');
      expect(text).toContain('readResumePoint');
      expect(scheduled.some((activity) => activity.activityType?.name === 'claimAgentRun')).toBe(
        false,
      );
    }
    if (path.name === 'agent-run-tool-approval-done') {
      const tools = scheduled.filter((activity) => activity.activityType?.name === 'runToolCall');
      expect(tools).toHaveLength(2);
      expect(await decode(tools[0]!.input!.payloads![0]!)).toEqual(
        await decode(tools[1]!.input!.payloads![0]!),
      );
    }
    if (path.name === 'agent-run-missing-model-activity')
      expect(text).toContain('EVENT_TYPE_ACTIVITY_TASK_FAILED');
  });

  it('has a genuine server-suggested rollover and a separate resumed execution', async () => {
    const history = readHistory(AGENT_CONTINUE_HISTORY);
    const text = JSON.stringify(history);
    expect(history.events[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name).toBe(
      'agentRunWorkflow',
    );
    expect(text).toContain('EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW');
    expect(text).toMatch(/"suggestContinueAsNew"\s*:\s*true/);
    expect(text).not.toContain('EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED');
    const resumed = readHistory('agent-run-continued-resume');
    const firstStart = history.events[0]!.workflowExecutionStartedEventAttributes!;
    const nextRun = history.events.at(-1)!.workflowExecutionContinuedAsNewEventAttributes!;
    const resumedStart = resumed.events[0]!.workflowExecutionStartedEventAttributes!;
    expect(firstStart.originalExecutionRunId).toEqual(expect.any(String));
    expect(resumedStart.continuedExecutionRunId).toBe(firstStart.originalExecutionRunId);
    expect(resumedStart.originalExecutionRunId).toBe(nextRun.newExecutionRunId);
    const inputs = resumedStart.input?.payloads;
    expect(inputs).toHaveLength(2);
    expect(await decode(inputs![1]!)).toEqual({ agentRunId: AGENT_RUN_ID, nextStepNumber: 0 });
  });
});
