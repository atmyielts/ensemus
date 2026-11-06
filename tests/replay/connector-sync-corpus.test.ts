// Which histories connectorSyncWorkflow's corpus must hold. tests/replay/replay.test.ts replays every file
// in that folder, so this only stops one being lost, and holds two numbers that live apart.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYNC_PAGES_PER_PASS } from '@ensemus/workflows/connector-sync-activities';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR } from './corpus';

const HISTORIES = [
  'connector-sync-synced',
  'connector-sync-more-pages',
  'connector-sync-pass-limit',
  'connector-sync-revoked',
  'connector-sync-nothing-to-do',
  'connector-sync-failed',
  'connector-sync-activity-failed',
];

describe('connector sync corpus', () => {
  it.each(HISTORIES)('holds %s', (name) => {
    expect(existsSync(join(repoRoot, CORPUS_DIR, `${name}.json`))).toBe(true);
  });

  it('holds the same page limit in the workflow as in the Activity', () => {
    // Read as text, because workflow code is not for loading outside its sandbox.
    const source = readFileSync(
      join(repoRoot, 'packages/workflows/src/connector-sync-workflow.ts'),
      'utf8',
    );
    expect(source).toContain(`export const PAGES_PER_PASS = ${SYNC_PAGES_PER_PASS};`);
  });
});
