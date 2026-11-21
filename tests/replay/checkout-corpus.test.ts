// checkoutWorkflow's histories (ADR-032 D4a), owed until captured on Temporal against the isolated capture
// stack. A new workflow type has no running history to keep, so it needed no patched(); a change to its
// waits or steps after the first capture does.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from '@temporalio/worker';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { describe, it, expect } from 'vitest';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from './corpus';
const owed = [
  'checkout-paddle-opened-then-paid-by-lookup',
  'checkout-paddle-not-opened',
  'checkout-paddle-settled-by-notification',
];
describe('checkout replay histories, owed until captured on Temporal', () => {
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
