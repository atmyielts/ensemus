// The IDs that decide what a duplicate start does. They hold tenant and aggregate IDs, and nothing else.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { connectorRevokeWorkflowIdFor, connectorSyncWorkflowIdFor } from './schemas';

describe('workflow IDs for a connection', () => {
  const input = { organizationId: randomUUID(), connectionId: randomUUID() };

  it('keeps a revoke apart from a sync, so an open sync run cannot swallow it', () => {
    expect(connectorRevokeWorkflowIdFor(input)).not.toBe(connectorSyncWorkflowIdFor(input));
  });

  it('gives one connection one revoke run, and another tenant its own', () => {
    expect(connectorRevokeWorkflowIdFor(input)).toBe(connectorRevokeWorkflowIdFor({ ...input }));
    expect(connectorRevokeWorkflowIdFor(input)).not.toBe(
      connectorRevokeWorkflowIdFor({ ...input, organizationId: randomUUID() }),
    );
  });
});
