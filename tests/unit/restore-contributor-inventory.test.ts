import { describe, expect, it } from 'vitest';
import {
  createRestoreContributors,
  missingRestoreContributors,
  REQUIRED_RESTORE_CONTRIBUTORS,
  reconcileAfterRestore,
  type LedgerReader,
  type ObjectStore,
} from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';

describe('restore contributor completeness', () => {
  it('does not qualify an empty or partial contributor inventory', () => {
    expect(missingRestoreContributors([])).toBe(4);
    const reports = REQUIRED_RESTORE_CONTRIBUTORS.map((name) => ({
      name,
      checked: 0,
      changed: 0,
      needsAttention: 0,
    }));
    expect(missingRestoreContributors(reports)).toBe(0);
    expect(missingRestoreContributors(reports.slice(1))).toBe(1);
    expect(missingRestoreContributors([...reports, reports[0]!])).toBe(1);
    expect(
      missingRestoreContributors([{ name: 'unknown', checked: 0, changed: 0, needsAttention: 0 }]),
    ).toBe(5);
  });
  it('registers real audits and never treats invalid counters as proof', () => {
    expect(createRestoreContributors().map((item) => item.name)).toEqual(
      REQUIRED_RESTORE_CONTRIBUTORS,
    );
    expect(
      missingRestoreContributors([
        { name: 'm4-private-transcripts', checked: -1, changed: 0, needsAttention: 0 },
      ]),
    ).toBeGreaterThan(0);
  });
  it('refuses an empty registry even with no restored tenants, before any store or database call', async () => {
    await expect(
      reconcileAfterRestore({} as AppDatabase, {} as ObjectStore & LedgerReader, {
        mode: 'apply',
        organizationIds: [],
        contributors: [],
        probeRun: async () => {
          throw new Error('unexpected probe');
        },
        contextFor: () => {
          throw new Error('unexpected tenant lookup');
        },
      }),
    ).rejects.toThrow('RESTORE_CONTRIBUTOR_INVENTORY_INCOMPLETE');
  });
});
