import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR } from './corpus';
import { decodeCorpusPayload, type JsonPayload } from './history-payloads';

type Envelope = { payloads?: JsonPayload[] };
type HistoryEvent = {
  workflowExecutionStartedEventAttributes?: { input?: Envelope };
  activityTaskScheduledEventAttributes?: { input?: Envelope };
  activityTaskCompletedEventAttributes?: { result?: Envelope };
  workflowExecutionCompletedEventAttributes?: { result?: Envelope };
};

describe('meeting import history privacy', () => {
  it.each(['completed', 'fallback'])(
    'keeps the %s history to encrypted identifiers and enums',
    async (capture) => {
      const file = join(repoRoot, CORPUS_DIR, `meeting-import-${capture}.json`);
      const { events } = JSON.parse(readFileSync(file, 'utf8')) as { events: HistoryEvent[] };
      const first = events[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
      expect(first).toBeDefined();
      const input = await decodeCorpusPayload(first!);
      const uuid = expect.stringMatching(/^[0-9a-f-]{36}$/);
      expect(input).toEqual({ organizationId: uuid, importRequestId: uuid });
      for (const event of events) {
        const activityInput = event.activityTaskScheduledEventAttributes?.input?.payloads;
        if (activityInput) {
          expect(activityInput).toHaveLength(1);
          expect(await decodeCorpusPayload(activityInput[0]!)).toEqual(input);
        }
        const result =
          event.activityTaskCompletedEventAttributes?.result ??
          event.workflowExecutionCompletedEventAttributes?.result;
        if (result?.payloads) {
          expect(result.payloads).toHaveLength(1);
          expect(await decodeCorpusPayload(result.payloads[0]!)).toBe(
            capture === 'completed' ? 'completed' : 'failed',
          );
        }
      }
    },
  );
});
