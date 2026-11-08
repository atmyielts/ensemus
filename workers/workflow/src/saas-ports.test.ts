import { randomUUID } from 'node:crypto';
import type { TenantContext, Tx } from '@ensemus/database';
import { describe, expect, it, vi } from 'vitest';
import { createSaasPorts } from './saas-ports';

describe('joined SaaS worker ports', () => {
  it('queries the actual M4 ledger reader instead of returning successful empty usage', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { execute } as unknown as Tx;
    const context = { organizationId: randomUUID(), actorType: 'service' } as TenantContext;
    await expect(
      createSaasPorts({}).usage.listSince(tx, context, { after: null, limit: 1 }),
    ).resolves.toEqual({ entries: [], nextCursor: null, more: false });
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockRejectedValue(new Error('TEST_LEDGER_UNAVAILABLE'));
    await expect(
      createSaasPorts({}).usage.listSince(tx, context, { after: null, limit: 1 }),
    ).rejects.toThrow('USAGE_UNAVAILABLE');
  });
  it('requires an actual SQL standing receipt for a worker halt', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const context = { organizationId: randomUUID(), actorType: 'service' } as TenantContext;
    await expect(
      createSaasPorts({}).agents.haltTenantAgents(
        { execute } as unknown as Tx,
        context,
        'TEST_STOP',
      ),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
