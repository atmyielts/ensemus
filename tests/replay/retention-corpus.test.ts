import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from '@temporalio/worker';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from './corpus';
describe('retention histories owed until captured on Temporal', () => {
  for (const name of ['retention-complete', 'retention-held', 'retention-more']) {
    const file = join(repoRoot, CORPUS_DIR, `${name}.json`);
    it.skipIf(!existsSync(file))(
      `replays ${name}`,
      async () => {
        await expect(
          Worker.runReplayHistory(
            {
              workflowsPath: WORKFLOWS,
              failureConverterPath: FAILURE_CONVERTER,
              dataConverter: {
                payloadCodecs: [new AesGcmPayloadCodec(REPLAY_KEY)],
                failureConverterPath: FAILURE_CONVERTER,
              },
            } as Parameters<typeof Worker.runReplayHistory>[0],
            JSON.parse(readFileSync(file, 'utf8')),
          ),
        ).resolves.toBeUndefined();
      },
      60000,
    );
  }
});
