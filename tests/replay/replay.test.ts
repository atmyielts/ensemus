// WORK-07, ADR-024 D6: replays recorded histories against today's workflow code. A change that would
// break work already in flight fails here. In-flight approvals can wait for days, and Sovereign sites
// may skip releases, so this is the only safe place to find out. Needs no server.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from './corpus';

const directory = join(repoRoot, CORPUS_DIR);
const files = readdirSync(directory).filter((f) => f.endsWith('.json'));

describe('workflow replay corpus', () => {
  it('covers each workflow and path', () => {
    expect(files.sort()).toEqual([
      'platform-probe.json',
      'tenant-reminders.json',
      'work-unit-no-review.json',
      'work-unit-review-approved.json',
      'work-unit-review-denied.json',
    ]);
  });

  it.each(files)(
    'replays %s against the current code',
    async (file) => {
      const history = JSON.parse(readFileSync(join(directory, file), 'utf8'));
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
    60_000,
  );
});
