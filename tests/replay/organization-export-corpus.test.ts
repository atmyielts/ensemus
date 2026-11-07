// The organization export's histories (ADR-030 D7, WORK-07). tests/replay/replay.test.ts replays every file in
// the corpus, whoever recorded it, so what this adds is the list of paths an export has to have.
//
// They are owed. Recording one needs a Temporal server, and M6 was written with none running, so each path shows
// as a todo until capture-organization-export.test.ts has recorded it. That is a statement that nothing here has
// proved anything yet, and not a pass. Once a path has a file, it is replayed here against today's code, and a
// change that would break an export in flight fails.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from './corpus';

const PATHS = [
  'organization-export-ready',
  'organization-export-finish-continues',
  'organization-export-already-finished',
  'organization-export-step-failed',
  'organization-export-activity-failed',
  'organization-export-store-unavailable',
] as const;

const fileOf = (name: string) => join(repoRoot, CORPUS_DIR, `${name}.json`);

describe('organization export replay corpus', () => {
  for (const name of PATHS) {
    if (!existsSync(fileOf(name))) {
      it.todo(`history owed: ${name}`);
      continue;
    }
    it(`replays ${name} against the current code`, async () => {
      const history = JSON.parse(readFileSync(fileOf(name), 'utf8'));
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
    }, 60_000);
  }
});
