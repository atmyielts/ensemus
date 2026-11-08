// SDK boundary only. Actual timers/continue-as-new replay and cross-queue runtime remain open.
import { beforeEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({
  modern: true,
  materials: vi.fn(),
  files: vi.fn(),
  confirm: vi.fn(),
  delay: vi.fn(),
  next: vi.fn(),
}));
vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({
    purgeRecordMaterials: sdk.materials,
    purgeRecordFiles: sdk.files,
    confirmRecordPurge: sdk.confirm,
  }),
  patched: () => sdk.modern,
  sleep: sdk.delay,
  continueAsNew: sdk.next,
}));
const { knowledgeRecordPurgeWorkflow } = await import('./knowledge-record-purge-workflow');
const input = {
  organizationId: 'be788148-34e6-4b5f-ae86-8f7e75a79d66',
  kind: 'client' as const,
  id: 'c6234b41-a1db-4134-9467-0edba178283a',
  limit: 25,
};
const work = { confirmed: true, removed: 0, remaining: 0, unproven: 0, controlsRemaining: 0 };
describe('canonical typed-record workflow retry history', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdk.modern = true;
    sdk.materials.mockResolvedValue(work);
    sdk.files.mockResolvedValue({ confirmed: true, removed: 0, remaining: 0, held: 0 });
    sdk.confirm.mockResolvedValue({ work, filesRemaining: 0 });
  });
  it('finishes only after the final real-activity proof and passes metadata to both queues', async () => {
    expect((await knowledgeRecordPurgeWorkflow(input)).state).toBe('completed');
    expect(sdk.materials).toHaveBeenCalledExactlyOnceWith(input);
    expect(sdk.files).toHaveBeenCalledExactlyOnceWith(input);
    expect(sdk.confirm).toHaveBeenCalledExactlyOnceWith(input);
    expect(sdk.delay).not.toHaveBeenCalled();
    expect(sdk.next).not.toHaveBeenCalled();
  });
  it('continues a bounded history with the same identity and capped backoff for unresolved writers/holds', async () => {
    sdk.materials.mockResolvedValue({ ...work, confirmed: false, controlsRemaining: 1 });
    const continued = new Error('TEST_CONTINUED');
    sdk.next.mockRejectedValue(continued);
    await expect(knowledgeRecordPurgeWorkflow({ ...input, retryAttempt: 10 })).rejects.toBe(
      continued,
    );
    expect(sdk.materials).toHaveBeenCalledTimes(20);
    expect(sdk.delay).toHaveBeenCalledTimes(20);
    expect(sdk.delay).toHaveBeenLastCalledWith(60 * 60_000);
    expect(sdk.next).toHaveBeenCalledExactlyOnceWith({ ...input, retryAttempt: 10 });
    expect(sdk.files).not.toHaveBeenCalled();
  });
  it('retains the original one-pass behavior for an older recorded history', async () => {
    sdk.modern = false;
    sdk.materials.mockResolvedValue({ ...work, confirmed: false });
    expect((await knowledgeRecordPurgeWorkflow(input)).state).toBe('unconfirmed');
    expect(sdk.materials).toHaveBeenCalledTimes(1);
    expect(sdk.delay).not.toHaveBeenCalled();
    expect(sdk.next).not.toHaveBeenCalled();
  });
});
