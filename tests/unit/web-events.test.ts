// The live status route needs a whole stack to run. tests/integration/web-behaviour.test.ts covers what
// it asks for, and tests/stack/tenant-streams.test.ts what it sends. This pins the one thing neither
// can see: a stream that did not ask about evidence does not pay for it on every poll.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';

const route = readFileSync(
  join(
    repoRoot,
    'apps/web/src/app/api/v1/organizations/[organizationId]/work-units/[workUnitId]/events/route.ts',
  ),
  'utf8',
);

describe('a stream of live status', () => {
  it('asks about evidence only if the client did, on its first read and on every poll', () => {
    expect(route).toContain('const asked = { evidence: withEvidence };');
    const reads = [...route.matchAll(/getWorkFollowState\(([^)]*)\)/g)].map((match) => match[1]);
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(read).toMatch(/, asked$/);
  });
});
