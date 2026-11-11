// oauthExchangeWorkflow's histories, owed until captured on Temporal (capture-oauth-exchange.test.ts). Each
// replays once it exists. Until then this skips it, rather than pass on nothing.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from '@temporalio/worker';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { OAUTH_EXCHANGE_MAX_ATTEMPTS } from '@ensemus/workflows/constants';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from './corpus';

const HISTORIES = [
  'oauth-exchange-connected',
  'oauth-exchange-failed',
  'oauth-exchange-expired',
  'oauth-exchange-already-settled',
  'oauth-exchange-abandoned',
];

describe('OAuth exchange histories owed until captured on Temporal', () => {
  for (const name of HISTORIES) {
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
      60_000,
    );
  }

  it('tries the exchange once, by the shared constant, and never a literal', () => {
    // Read as text, because workflow code is not for loading outside its sandbox.
    const source = readFileSync(
      join(repoRoot, 'packages/workflows/src/oauth-exchange-workflow.ts'),
      'utf8',
    );
    expect(OAUTH_EXCHANGE_MAX_ATTEMPTS).toBe(1);
    expect(source).toContain('retry: { maximumAttempts: OAUTH_EXCHANGE_MAX_ATTEMPTS }');
    expect(source).not.toMatch(/maximumAttempts:\s*\d/);
  });
});
