import { readFileSync } from 'node:fs';
import { TOMBSTONE_RECORDED } from '@ensemus/domain/tombstone-ledger';
import { describe, expect, it } from 'vitest';
import { classifyDeliveryError, needsOnlyTheStore } from './dispatch-errors';
import { openDispatcherConnection } from './temporal-connection';

// Nothing listens here, so this is Temporal being down when the dispatcher starts.
const NOBODY = '127.0.0.1:1';

describe('the dispatcher and a Temporal outage', () => {
  it('starts without Temporal, because tombstones only need the object store', async () => {
    const connection = openDispatcherConnection(NOBODY);
    try {
      // Not a promise to wait on, and so not a connection attempt that can end the process.
      expect(connection).not.toBeInstanceOf(Promise);

      // A call that does need Temporal fails as an outage, which costs its event nothing.
      const failure = await connection
        .withDeadline(Date.now() + 2_000, () => connection.workflowService.getSystemInfo({}))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(classifyDeliveryError(failure)).toBe('outage');
    } finally {
      await connection.close();
    }
  });

  it('is what the dispatcher actually opens', () => {
    const source = readFileSync(new URL('./dispatcher.ts', import.meta.url), 'utf8');
    expect(source).toContain('openDispatcherConnection(');
    expect(source).not.toContain('Connection.connect(');
    expect(source).toContain('needsOnlyTheStore');
  });

  it('counts a tombstone as needing nothing Temporal provides, and nothing else', () => {
    expect(needsOnlyTheStore({ eventType: TOMBSTONE_RECORDED })).toBe(true);
    expect(needsOnlyTheStore({ eventType: 'approval.resolved' })).toBe(false);
    expect(needsOnlyTheStore({ eventType: 'work.execution_requested' })).toBe(false);
  });
});
