import { describe, expect, it } from 'vitest';
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import { AppError } from '../errors';
import { getCompanyPulse, getPulseSignal, setPulseSignalState } from './pulse';
import { createPulseMetadataReaders } from './pulse-metadata';
const id = '7f0c1f6e-3a39-4f5e-9d7a-3f4a0a4f1b11';
const readers = createPulseMetadataReaders();

describe('Pulse never treats a worker as the person whose role it carries', () => {
  it.each(['service', 'agent', 'delegated'])(
    'rejects %s before any SQL access',
    async (actorType) => {
      const context = { actorType, role: 'owner', membershipId: id } as unknown as TenantContext;
      const db = {} as AppDatabase,
        tx = {} as Tx;
      await expect(getCompanyPulse(db, context, readers)).rejects.toEqual(
        new AppError('FORBIDDEN'),
      );
      await expect(getPulseSignal(db, context, readers, `work_overdue:${id}`)).rejects.toEqual(
        new AppError('FORBIDDEN'),
      );
      await expect(
        setPulseSignalState(db, context, readers, {
          signalKey: `work_overdue:${id}`,
          state: 'dismissed',
        }),
      ).rejects.toEqual(new AppError('FORBIDDEN'));
      await expect(
        readers.stoppedAgentRuns(tx, context, { workIds: [], limit: 1 }),
      ).rejects.toEqual(new AppError('FORBIDDEN'));
      await expect(
        readers.failedProcessRuns(tx, context, { workIds: [], limit: 1 }),
      ).rejects.toEqual(new AppError('FORBIDDEN'));
    },
  );
});
