// FD-23: what the probe's Activity does around a prober. The version it read is the version it writes,
// and nothing but an exact pass can ever be written as one. The store's own stale check is proven against
// real roles in tests/integration/ai-model-profiles.test.ts.
import { randomUUID } from 'node:crypto';
import { loadProfileForProbe, recordProbeResult } from '@ensemus/application/ai-model-probe-store';
import type { AppDatabase } from '@ensemus/database';
import type { ProfileProber } from '@ensemus/intelligence';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { modelProbeInputSchema } from './agent-schemas';
import { createModelProbeActivities } from './model-probe-activities';

vi.mock('@ensemus/application/ai-model-probe-store', () => ({
  loadProfileForProbe: vi.fn(),
  recordProbeResult: vi.fn(),
}));

const load = vi.mocked(loadProfileForProbe);
const record = vi.mocked(recordProbeResult);
const database = {} as AppDatabase;
const input = { organizationId: randomUUID(), modelProfileId: randomUUID() };
const target = { organizationId: input.organizationId, profileId: input.modelProfileId };
const loaded = { id: input.modelProfileId, version: 7 } as Awaited<
  ReturnType<typeof loadProfileForProbe>
>;

const prober = (probe: ProfileProber['probe']) => ({ probe: vi.fn(probe) });

beforeEach(() => {
  load.mockReset();
  record.mockReset();
  record.mockResolvedValue();
});

describe('runModelProbe', () => {
  it('writes a pass at the version it read', async () => {
    load.mockResolvedValue(loaded);
    const probe = prober(async () => 'passed');
    const { runModelProbe } = createModelProbeActivities({ database, probe });
    await expect(runModelProbe(input)).resolves.toBe('passed');
    expect(probe.probe).toHaveBeenCalledWith(target);
    expect(record).toHaveBeenCalledWith(database, { ...target, profileVersion: 7, passed: true });
  });

  it('writes a failure at the version it read', async () => {
    load.mockResolvedValue(loaded);
    const { runModelProbe } = createModelProbeActivities({
      database,
      probe: prober(async () => 'failed'),
    });
    await expect(runModelProbe(input)).resolves.toBe('failed');
    expect(record).toHaveBeenCalledWith(database, { ...target, profileVersion: 7, passed: false });
  });

  it('counts a prober that throws as a failure, and writes that', async () => {
    load.mockResolvedValue(loaded);
    const { runModelProbe } = createModelProbeActivities({
      database,
      probe: prober(() => Promise.reject(new Error('a bug'))),
    });
    await expect(runModelProbe(input)).resolves.toBe('failed');
    expect(record).toHaveBeenCalledWith(database, { ...target, profileVersion: 7, passed: false });
  });

  it('counts anything but an exact pass as a failure', async () => {
    load.mockResolvedValue(loaded);
    const { runModelProbe } = createModelProbeActivities({
      database,
      probe: prober((async () => 'PASSED') as unknown as ProfileProber['probe']),
    });
    await expect(runModelProbe(input)).resolves.toBe('failed');
    expect(record).toHaveBeenCalledWith(database, { ...target, profileVersion: 7, passed: false });
  });

  it('skips a profile that is no longer waiting: no call and no write', async () => {
    load.mockResolvedValue(null);
    const probe = prober(async () => 'passed');
    const { runModelProbe } = createModelProbeActivities({ database, probe });
    await expect(runModelProbe(input)).resolves.toBe('skipped');
    expect(probe.probe).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('lets a failed write throw, so Temporal tries again instead of reporting a result nobody saved', async () => {
    load.mockResolvedValue(loaded);
    record.mockRejectedValue(new Error('database gone'));
    const { runModelProbe } = createModelProbeActivities({
      database,
      probe: prober(async () => 'passed'),
    });
    await expect(runModelProbe(input)).rejects.toThrow();
  });

  it.each([
    ['free text in an ID', { organizationId: 'CANARY', modelProfileId: randomUUID() }],
    ['an extra field', { ...input, note: 'CANARY' }],
  ])('refuses %s before doing anything', async (_name, bad) => {
    const probe = prober(async () => 'passed');
    const { runModelProbe } = createModelProbeActivities({ database, probe });
    await expect(runModelProbe(bad as typeof input)).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
    expect(probe.probe).not.toHaveBeenCalled();
  });
});

describe('what crosses Temporal', () => {
  it('is two IDs', () => {
    expect(modelProbeInputSchema.safeParse(input).success).toBe(true);
    expect(Object.keys(modelProbeInputSchema.shape).sort()).toEqual([
      'modelProfileId',
      'organizationId',
    ]);
  });
});
