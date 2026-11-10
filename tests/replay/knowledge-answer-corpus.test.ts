// An empty corpus is an outstanding gate, never a passing replay. Capture on real Temporal first.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from './corpus';

describe('knowledge answer replay corpus', () => {
  it.each([
    'knowledge-answer-answered',
    'knowledge-answer-refused',
    'knowledge-answer-no_evidence',
    'knowledge-answer-lost-result',
    'knowledge-answer-model-worker-absent',
  ])(
    'has and replays %s',
    async (name) => {
      const file = join(repoRoot, CORPUS_DIR, `${name}.json`);
      expect(existsSync(file), `Capture owed: ${name}`).toBe(true);
      await Worker.runReplayHistory(
        {
          workflowsPath: WORKFLOWS,
          failureConverterPath: FAILURE_CONVERTER,
          dataConverter: {
            payloadCodecs: [new AesGcmPayloadCodec(REPLAY_KEY)],
            failureConverterPath: FAILURE_CONVERTER,
          },
        } as Parameters<typeof Worker.runReplayHistory>[0],
        JSON.parse(readFileSync(file, 'utf8')),
      );
    },
    60_000,
  );
});
