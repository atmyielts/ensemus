// ADR-028 open question 12, lifecycle item 8a: the sweep's typed-record restart claim. One record whose
// proof keeps failing must never stop the claim from reaching the records behind it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@ensemus/application';

const listed = vi.hoisted(() => ({ candidates: vi.fn() }));
vi.mock('@ensemus/application/knowledge/record-closure', () => ({
  listRecordPurgeCandidates: listed.candidates,
}));
vi.mock('@ensemus/database', async (original) => ({
  ...(await original<typeof import('@ensemus/database')>()),
  withTenantTx: async (_db: unknown, _context: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({}),
}));
import { createKnowledgePurgeActivities } from './knowledge-purge-activities';

const organizationId = '00000000-0000-4000-8000-0000000000aa';
const idOf = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const candidate = (i: number, kind = 'work_unit') => ({ kind, id: idOf(i), checked: false });
type Proof = {
  removed: number;
  confirmed: boolean;
  remaining: number;
  controlsRemaining: number;
  unproven: number;
};
const done: Proof = {
  removed: 0,
  confirmed: true,
  remaining: 0,
  controlsRemaining: 0,
  unproven: 0,
};
const open: Proof = {
  removed: 0,
  confirmed: false,
  remaining: 1,
  controlsRemaining: 0,
  unproven: 0,
};

function activities(work: (id: string) => Proof, files: (kind: string) => { remaining: number }) {
  return createKnowledgePurgeActivities({
    database: {} as never,
    store: {} as never,
    ingest: {} as never,
    recordWorks: {
      confirmRecordInTx: async (_tx, _context, input) => work(input.id),
    },
    derivedArtifacts: {
      purgeSource: async () => {
        throw new Error('TEST_UNUSED');
      },
      confirmInTx: async () => {
        throw new Error('TEST_UNUSED');
      },
      confirmRecordInTx: async (_tx, _context, input) => files(input.kind),
    },
  });
}

describe('claimRecordPurgeRestarts', () => {
  beforeEach(() => listed.candidates.mockReset());

  it('counts a record whose file proof refuses as failed and keeps claiming the ones behind it', async () => {
    // The production composition refuses a custom object record's file proof (INVALID_INPUT) once its
    // copied Work is proved; ranked first, it must not abort the pass.
    listed.candidates.mockResolvedValue([
      candidate(1, 'object_record'),
      candidate(2),
      candidate(3),
    ]);
    const claim = activities(
      (id) => (id === idOf(2) ? open : done),
      (kind) => {
        if (kind === 'object_record') throw new AppError('INVALID_INPUT');
        return { remaining: 0 };
      },
    );
    const result = await claim.claimRecordPurgeRestarts({ organizationId });
    expect(result.failed).toBe(1);
    expect(result.due.map((record) => record.id)).toEqual([idOf(2)]);
  });

  it('counts any other thrown proof as failed, never as proved and never as an aborted pass', async () => {
    listed.candidates.mockResolvedValue([candidate(1), candidate(2), candidate(3)]);
    const claim = activities(
      (id) => {
        if (id === idOf(1)) throw new AppError('OBJECT_DELETE_UNCONFIRMED');
        if (id === idOf(2)) throw new Error('TEST_UNEXPECTED');
        return open;
      },
      () => ({ remaining: 0 }),
    );
    const result = await claim.claimRecordPurgeRestarts({ organizationId });
    expect(result).toEqual({
      failed: 2,
      due: [{ organizationId, kind: 'work_unit', id: idOf(3), limit: 25 }],
    });
  });

  it('still restarts a record with no proof yet or a busy lock, and never a proved one', async () => {
    listed.candidates.mockResolvedValue([candidate(1), candidate(2), candidate(3), candidate(4)]);
    const claim = activities(
      (id) => {
        if (id === idOf(1)) throw new AppError('INVALID_STATE');
        if (id === idOf(2)) throw new AppError('VERSION_CONFLICT');
        if (id === idOf(3)) throw new Error('lock', { cause: { code: '55P03' } });
        return done;
      },
      () => ({ remaining: 0 }),
    );
    const result = await claim.claimRecordPurgeRestarts({ organizationId });
    expect(result.failed).toBe(0);
    expect(result.due.map((record) => record.id)).toEqual([idOf(1), idOf(2), idOf(3)]);
  });

  it('claims at most five due records', async () => {
    listed.candidates.mockResolvedValue(Array.from({ length: 9 }, (_, i) => candidate(i)));
    const claim = activities(
      () => open,
      () => ({ remaining: 0 }),
    );
    expect((await claim.claimRecordPurgeRestarts({ organizationId })).due).toHaveLength(5);
  });
});
