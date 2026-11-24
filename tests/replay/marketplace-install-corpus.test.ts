import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { Worker } from '@temporalio/worker';
import { describe, it } from 'vitest';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from './corpus';

describe('marketplace installation replay', () => {
  it.each(['installed', 'failed-attestation', 'failed-verification'])(
    'replays %s',
    async (scenario) => {
      const file = join(repoRoot, CORPUS_DIR, 'marketplace-install-' + scenario + '.json');
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
