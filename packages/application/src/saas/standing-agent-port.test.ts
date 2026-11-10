import { randomUUID } from 'node:crypto';
import type { TenantContext, Tx } from '@ensemus/database';
import { describe, expect, it, vi } from 'vitest';
import { createStandingAgentHaltPort } from './standing-agent-port';

const context = { organizationId: randomUUID(), actorType: 'service' } as TenantContext;
const port = createStandingAgentHaltPort();
const fixture = (rows: unknown[]) => {
  const execute = vi.fn().mockResolvedValue({ rows });
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  return { tx: { execute, insert } as unknown as Tx, execute, insert, values };
};

describe('standing stop adapter over the actual SQL receipt port', () => {
  it('refuses non-service actors before reading or mutating SQL', async () => {
    const f = fixture([]);
    await expect(
      port.haltTenantAgents(f.tx, { ...context, actorType: 'user' }, 'TEST_STOP'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([
    { rows: [] },
    { rows: [{ switch_id: null, changed: true }] },
    { rows: [{ switch_id: randomUUID(), changed: 'yes' }] },
  ])('does not report an absent or malformed receipt as a successful halt', async ({ rows }) => {
    const f = fixture(rows);
    await expect(port.haltTenantAgents(f.tx, context, 'TEST_STOP')).rejects.toMatchObject({
      code: 'PREREQUISITES_INCOMPLETE',
    });
    expect(f.insert).not.toHaveBeenCalled();
  });
  it('emits the actual switch and outbox once, while SQL replay emits neither', async () => {
    const id = randomUUID(),
      f = fixture([{ switch_id: id, changed: true }]);
    await port.haltTenantAgents(f.tx, context, 'TEST_STOP');
    expect(f.insert).toHaveBeenCalledTimes(2);
    expect(f.values.mock.calls[0]![0]).toMatchObject({
      aggregateId: id,
      aggregateVersion: 1,
      eventType: 'kill_switch.engaged',
      payload: { reasonCode: 'TENANT_STANDING' },
    });
    f.execute.mockResolvedValue({ rows: [{ switch_id: id, changed: false }] });
    await port.haltTenantAgents(f.tx, context, 'TEST_STOP');
    expect(f.insert).toHaveBeenCalledTimes(2);
  });
  it('propagates SQL refusal instead of inventing an empty success', async () => {
    const f = fixture([]);
    f.execute.mockRejectedValue(new Error('TEST_STANDING_RECEIPT_REFUSED'));
    await expect(port.releaseTenantAgents(f.tx, context, 'TEST_RESUME')).rejects.toThrow(
      'TEST_STANDING_RECEIPT_REFUSED',
    );
    expect(f.insert).not.toHaveBeenCalled();
  });
});
