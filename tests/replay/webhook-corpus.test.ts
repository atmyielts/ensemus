// webhookDeliveryWorkflow's paths have to stay in the corpus. tests/replay/replay.test.ts replays every
// file there by itself, so this only holds the list.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR } from './corpus';

describe('webhook replay corpus', () => {
  it('covers each path through the workflow', () => {
    expect(readdirSync(join(repoRoot, CORPUS_DIR))).toEqual(
      expect.arrayContaining([
        'webhook-applied.json',
        'webhook-duplicate.json',
        'webhook-rejected.json',
        'webhook-skipped.json',
        'webhook-retried-then-applied.json',
      ]),
    );
  });
});
