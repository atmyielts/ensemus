import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from '@temporalio/worker';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { describe, it, expect } from 'vitest';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from './corpus';
const owed = [
  'billing-cycle-prepaid',
  'billing-cycle-tax-port',
  'billing-cycle-usage-refused',
  'billing-cycle-tax-refused',
];
describe('billing cycle replay histories, owed until captured on Temporal', () => {
  for (const name of owed) {
    const file = join(repoRoot, CORPUS_DIR, `${name}.json`);
    it.skipIf(!existsSync(file))(
      `replays ${name}`,
      async () => {
        const history = JSON.parse(readFileSync(file, 'utf8'));
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
            history,
          ),
        ).resolves.toBeUndefined();
      },
      60000,
    );
  }
});
