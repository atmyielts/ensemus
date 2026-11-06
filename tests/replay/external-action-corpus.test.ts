// What externalActionWorkflow's recorded histories have to contain. replay.test.ts replays every file by
// itself, and this says which paths must be there, and holds the part that matters most to the history as
// well as to the code: no path sends after an answer it did not get, and no payload ever reached Temporal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR } from './corpus';

type HistoryEvent = {
  eventType?: unknown;
  activityTaskScheduledEventAttributes?: {
    activityType?: { name?: string };
    taskQueue?: { name?: string };
    retryPolicy?: { maximumAttempts?: number };
  };
};

const scheduled = (name: string) => {
  const file = join(repoRoot, CORPUS_DIR, `${name}.json`);
  const raw = readFileSync(file, 'utf8');
  const { events } = JSON.parse(raw) as { events: HistoryEvent[] };
  const activities = events.flatMap((event) => {
    const attributes = event.activityTaskScheduledEventAttributes;
    return attributes ? [attributes] : [];
  });
  return { raw, activities, names: activities.map((a) => a.activityType?.name) };
};

/** Each path, and the Activities it takes in order. A send is the only one with an effect. */
const PATHS: readonly (readonly [string, readonly string[]])[] = [
  ['external-action-sent', ['sendExternalAction']],
  ['external-action-refused', ['sendExternalAction']],
  ['external-action-stopped-by-recheck', ['sendExternalAction']],
  ['external-action-retry-then-sent', ['sendExternalAction', 'sendExternalAction']],
  ['external-action-timeout-after-send', ['sendExternalAction', 'reconcileExternalAction']],
  [
    'external-action-worker-died',
    ['sendExternalAction', 'inspectInterruptedAction', 'reconcileExternalAction'],
  ],
  [
    'external-action-worker-died-before-record',
    ['sendExternalAction', 'inspectInterruptedAction', 'sendExternalAction'],
  ],
  [
    'external-action-answer-lost',
    ['sendExternalAction', 'inspectInterruptedAction', 'settledActionOutcome'],
  ],
  ['external-action-reconcile-found', ['sendExternalAction', 'reconcileExternalAction']],
  [
    'external-action-reconcile-then-retry',
    ['sendExternalAction', 'reconcileExternalAction', 'sendExternalAction'],
  ],
  [
    'external-action-reconcile-never-ran',
    ['sendExternalAction', 'reconcileExternalAction', 'concludeWithoutAnswer'],
  ],
  [
    'external-action-sends-lost-exhausted',
    [
      ...Array.from({ length: 5 }, () => ['sendExternalAction', 'inspectInterruptedAction']).flat(),
      'failUnsentAction',
      'settledActionOutcome',
    ],
  ],
  [
    'external-action-connector-never-came',
    ['sendExternalAction', 'inspectInterruptedAction', 'failUnsentAction', 'settledActionOutcome'],
  ],
];

describe('externalActionWorkflow histories', () => {
  it.each(PATHS)('%s takes exactly the steps it should', (name, expected) => {
    expect(scheduled(name).names).toEqual(expected);
  });

  it.each(PATHS)('%s never retries a send, and sends only on the connector queue', (name) => {
    const sends = scheduled(name).activities.filter(
      (activity) => activity.activityType?.name === 'sendExternalAction',
    );
    for (const send of sends) {
      expect(send.retryPolicy?.maximumAttempts).toBe(1);
      expect(send.taskQueue?.name).toBe('ensemus-connectors');
    }
  });

  it.each([
    'external-action-timeout-after-send',
    'external-action-worker-died',
    'external-action-reconcile-never-ran',
  ])('%s ends on unknown with one send and nothing after the answer', (name) => {
    const { names } = scheduled(name);
    expect(names.filter((step) => step === 'sendExternalAction')).toHaveLength(1);
    expect(names.at(-1)).not.toBe('sendExternalAction');
  });

  it.each(PATHS)('%s carries nothing readable: payloads are sealed by the codec', (name) => {
    const { raw } = scheduled(name);
    expect(raw).not.toMatch(/example\.invalid|text_body|subject/);
  });
});
