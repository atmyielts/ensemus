// What the corpus has to hold for the activation probe (ADR-028 FD-23). The histories are recorded on a real
// Temporal by capture-model-probe.test.ts, and tests/replay/replay.test.ts replays every file it finds. A
// history not captured yet fails here: an absent path cannot silently count as replayed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR } from './corpus';
import { decodeCorpusPayload, type JsonPayload } from './history-payloads';

const HISTORIES = [
  'model-probe-passed',
  'model-probe-failed',
  'model-probe-skipped',
  'model-probe-activity-failed',
] as const;

const fileOf = (name: string) => join(repoRoot, CORPUS_DIR, `${name}.json`);

describe('the model probe in the replay corpus', () => {
  for (const name of HISTORIES) {
    it(`${name} is a history of the probe, on the agent queue`, async () => {
      expect(existsSync(fileOf(name)), 'A real Temporal capture is required').toBe(true);
      const history = readFileSync(fileOf(name), 'utf8');
      expect(history).toContain('modelProbeWorkflow');
      expect(history).toContain('ensemus-agent');
      expect(history).toContain('runModelProbe');
      const parsed = JSON.parse(history) as {
        events: {
          workflowExecutionCompletedEventAttributes?: { result?: { payloads?: JsonPayload[] } };
        }[];
      };
      const result = parsed.events.find((event) => event.workflowExecutionCompletedEventAttributes)
        ?.workflowExecutionCompletedEventAttributes?.result?.payloads?.[0];
      expect(result).toBeDefined();
      expect(await decodeCorpusPayload(result!)).toBe(
        name === 'model-probe-passed'
          ? 'passed'
          : name === 'model-probe-skipped'
            ? 'skipped'
            : 'failed',
      );
    });
  }

  it('the workflow file imports only what the sandbox may load', () => {
    const source = readFileSync(join(repoRoot, 'packages/workflows/src/model-probe.ts'), 'utf8');
    const values = [...source.matchAll(/^import (?!type )[^;]*? from '([^']+)'/gm)].map(
      (match) => match[1],
    );
    expect(values.sort()).toEqual(['./constants', '@temporalio/workflow']);
  });

  it('the bundle the replayer loads exports the probe', () => {
    const source = readFileSync(join(repoRoot, 'packages/workflows/src/workflows.ts'), 'utf8');
    expect(source).toContain("export { modelProbeWorkflow } from './model-probe'");
  });
});
