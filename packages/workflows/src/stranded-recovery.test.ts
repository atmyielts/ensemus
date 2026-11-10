// The sweep's two writes must share a transaction, and a closed old workflow must never fail a newer
// one. These exercise the real Activity's ordering. Real role/SQL checks are in ai-stranded-recovery.
import { randomUUID } from 'node:crypto';
import {
  expireOverdueApprovals,
  failRun,
  listHeldRuns,
  loadChangeable,
  purgeDueBlobs,
  purgeExpiredWebhookDeliveries,
  purgeExpiredExports,
  reissueStaleRunRequests,
  sendDueReminders,
  type ObjectStore,
} from '@ensemus/application';
import { closeStrandedRunInTx } from '@ensemus/application/ai-runs';
import type { AppDatabase, Tx } from '@ensemus/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActivities, type WorkflowProbe } from './activities';

vi.mock('@ensemus/application', async (original) => ({
  ...(await original<typeof import('@ensemus/application')>()),
  expireOverdueApprovals: vi.fn(),
  failRun: vi.fn(),
  listHeldRuns: vi.fn(),
  loadChangeable: vi.fn(),
  purgeDueBlobs: vi.fn(),
  purgeExpiredWebhookDeliveries: vi.fn(),
  purgeExpiredExports: vi.fn(),
  reissueStaleRunRequests: vi.fn(),
  sendDueReminders: vi.fn(),
}));
vi.mock('@ensemus/application/ai-runs', () => ({ closeStrandedRunInTx: vi.fn() }));

const organizationId = randomUUID();
const workId = randomUUID();
const temporalRunId = randomUUID();
type State = { work: string; agent: string };

function fixture() {
  let stored: State = { work: 'running', agent: 'running' };
  const tx = {} as Tx;
  let pending: State;
  const transaction = vi.fn(
    async (_bindings: Record<string, string>, use: (tx: Tx) => Promise<unknown>) => {
      pending = { ...stored };
      const result = await use(tx);
      stored = pending;
      return result;
    },
  );
  const database = { transaction } as unknown as AppDatabase;
  vi.mocked(failRun).mockImplementation(async (actualTx) => {
    expect(actualTx).toBe(tx);
    pending.work = 'failed';
    return { status: 'failed' } as Awaited<ReturnType<typeof failRun>>;
  });
  vi.mocked(closeStrandedRunInTx).mockImplementation(async (actualTx) => {
    expect(actualTx).toBe(tx);
    pending.agent = 'failed';
  });
  const probeWorkflow = vi.fn<WorkflowProbe>(async () => 'closed');
  const activities = createActivities({ database, store: {} as ObjectStore, probeWorkflow });
  return {
    run: () => activities.sendReminders({ organizationId }),
    transaction,
    probeWorkflow,
    stored: () => stored,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(expireOverdueApprovals).mockResolvedValue(0);
  vi.mocked(reissueStaleRunRequests).mockResolvedValue(0);
  vi.mocked(sendDueReminders).mockResolvedValue(0);
  vi.mocked(purgeDueBlobs).mockResolvedValue({ purged: 0, failed: 0 });
  vi.mocked(purgeExpiredWebhookDeliveries).mockResolvedValue(0);
  vi.mocked(purgeExpiredExports).mockResolvedValue(0);
  vi.mocked(listHeldRuns).mockResolvedValue({
    items: [{ id: workId, runId: temporalRunId }],
    next: null,
  });
  vi.mocked(loadChangeable).mockResolvedValue({
    runId: temporalRunId,
    status: 'running',
  } as Awaited<ReturnType<typeof loadChangeable>>);
});

describe('stranded work and its exact agent run', () => {
  it('commits both changes under the same work lock and transaction', async () => {
    const world = fixture();
    await world.run();
    expect(world.transaction).toHaveBeenCalledTimes(1);
    expect(closeStrandedRunInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId, actorType: 'service' }),
      { workUnitId: workId, temporalRunId },
    );
    expect(world.stored()).toEqual({ work: 'failed', agent: 'failed' });
    expect(vi.mocked(failRun).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(closeStrandedRunInTx).mock.invocationCallOrder[0]!,
    );
  });

  it('leaves an open workflow and its agent run alone', async () => {
    const world = fixture();
    world.probeWorkflow.mockResolvedValue('open');
    await world.run();
    expect(world.transaction).not.toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
    expect(closeStrandedRunInTx).not.toHaveBeenCalled();
  });

  it('ignores an old closed answer when the locked work now holds a newer run', async () => {
    const world = fixture();
    vi.mocked(loadChangeable).mockResolvedValue({
      runId: randomUUID(),
      status: 'running',
    } as Awaited<ReturnType<typeof loadChangeable>>);
    await world.run();
    expect(failRun).not.toHaveBeenCalled();
    expect(closeStrandedRunInTx).not.toHaveBeenCalled();
    expect(world.stored()).toEqual({ work: 'running', agent: 'running' });
  });

  it('rolls work back if closing the matching agent run fails, and still tries the other upkeep', async () => {
    const world = fixture();
    vi.mocked(closeStrandedRunInTx).mockRejectedValue(new Error('RECOVERY_WRITE_FAILED'));
    await expect(world.run()).rejects.toThrow('RECOVERY_WRITE_FAILED');
    expect(world.stored()).toEqual({ work: 'running', agent: 'running' });
    expect(sendDueReminders).toHaveBeenCalled();
    expect(purgeExpiredWebhookDeliveries).toHaveBeenCalled();
  });

  it('does not close the agent run if failing its work was refused', async () => {
    const world = fixture();
    vi.mocked(failRun).mockRejectedValue(new Error('WORK_REFUSED'));
    await expect(world.run()).rejects.toThrow('WORK_REFUSED');
    expect(closeStrandedRunInTx).not.toHaveBeenCalled();
    expect(world.stored()).toEqual({ work: 'running', agent: 'running' });
  });
});
