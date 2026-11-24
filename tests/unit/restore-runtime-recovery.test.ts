// ADR-026 / ADR-030 D11: the M4 and M5 restore contributors, with each runtime operation replaced and the
// SQL they send recorded. What each one does against real roles and rows is in
// tests/integration/restore-runtime-recovery.test.ts.
import { randomUUID } from 'node:crypto';
import {
  createRestoreContributors,
  transcriptRestoreProofAttention,
  type RestoreRunInputCounts,
} from '@ensemus/application';
import {
  createRuntimeRestoreRecoveryBindings,
  type RecoveryOperations,
} from '@ensemus/application/saas/restore-recovery';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import { createLifecycleRestoreContributors } from '../../workers/workflow/src/restore-contributors';

type Answer = (text: string) => Record<string, unknown>[] | null;

/** An AppDatabase whose transactions run over a recording client. Raw SQL answers come from `answer`. */
function recordingDatabase(answer: Answer) {
  const sent: string[] = [];
  const client = {
    query: async (config: string | { text: string }) => {
      const text = typeof config === 'string' ? config : config.text;
      sent.push(text);
      return { rows: answer(text) ?? [], rowCount: 0, fields: [], command: '' };
    },
  };
  const db = drizzle({ client: client as never, casing: 'snake_case' });
  const database = {
    transaction: (_bindings: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as AppDatabase;
  return { database, sent };
}

const operations = (overrides: Partial<RecoveryOperations> = {}): RecoveryOperations => ({
  closeStranded: vi.fn(async () => undefined),
  closeWithoutContext: vi.fn(async () => undefined),
  fenceAndPurge: vi.fn(async (_database, _context, runIds) => ({
    removed: runIds.length * 2,
    remaining: 0,
  })),
  recoverDocuments: vi.fn(async () => undefined),
  closeOrphans: vi.fn(async () => ({ closed: 0 })),
  ...overrides,
});

const store = { exists: async () => false } as never;
const userContext = { organizationId: randomUUID(), actorType: 'user' } as TenantContext;

describe('runtime restore bindings (ADR-030 D11)', () => {
  it('binds nothing it lacks the means for, so a missing binding still reports attention', () => {
    expect(Object.keys(createRuntimeRestoreRecoveryBindings({}))).toEqual([]);
    const { database } = recordingDatabase(() => null);
    expect(
      Object.keys(
        createRuntimeRestoreRecoveryBindings({ agentDatabase: database, knowledgeStore: store }),
      ),
    ).toEqual(['m4-private-transcripts', 'm5-sources-and-indexes']);
    expect(
      Object.keys(
        createRuntimeRestoreRecoveryBindings({
          agentDatabase: database,
          probeRun: async () => 'unknown',
          knowledgeStore: store,
        }),
      ).sort(),
    ).toEqual(['m4-private-transcripts', 'm4-runs-and-budgets', 'm5-sources-and-indexes']);
    // The composition keeps all five names, each once, with the lifecycle's two beside these three.
    expect(createLifecycleRestoreContributors(store).map(({ name }) => name)).toHaveLength(5);
  });

  it('refuses anything but a service context', async () => {
    const { database, sent } = recordingDatabase(() => null);
    const bindings = createRuntimeRestoreRecoveryBindings(
      { agentDatabase: database, probeRun: async () => 'closed', knowledgeStore: store },
      operations(),
    );
    for (const port of Object.values(bindings))
      await expect(port.reconcile(database, userContext)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    expect(sent).toHaveLength(0);
  });
});

describe('m4-runs-and-budgets', () => {
  const [closed, open, unknown, unclaimed] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const live = [
    { id: closed, workUnitId: randomUUID(), temporalRunId: 'run-closed', status: 'running' },
    { id: open, workUnitId: randomUUID(), temporalRunId: 'run-open', status: 'running' },
    { id: unknown, workUnitId: randomUUID(), temporalRunId: 'run-unknown', status: 'paused' },
    { id: unclaimed, workUnitId: randomUUID(), temporalRunId: null, status: 'queued' },
  ];
  const answer = (left: number) => (text: string) => {
    if (/from ai\.agent_runs where/i.test(text)) return live;
    if (/join platform\.budget_reservations/i.test(text)) return [{ id: closed, held: 3 }];
    if (/as held from platform\.budget_reservations/i.test(text)) return [{ held: left }];
    return null;
  };

  it('closes only a run Temporal says is closed, and releases what that run held', async () => {
    const { database } = recordingDatabase(answer(1));
    const ops = operations();
    const probe = vi.fn(async ({ runId }: { runId: string }) => {
      if (runId === 'run-unknown') throw new Error('TEMPORAL_DOWN');
      return runId === 'run-closed' ? ('closed' as const) : ('open' as const);
    });
    const context = createServiceContext(randomUUID());
    const port = createRuntimeRestoreRecoveryBindings(
      { agentDatabase: database, probeRun: probe },
      ops,
    )['m4-runs-and-budgets']!;
    const report = await port.reconcile(database, context);
    // A run with no workflow is never probed, and a failed probe is never read as closed.
    expect(probe).toHaveBeenCalledTimes(3);
    expect(ops.closeStranded).toHaveBeenCalledTimes(1);
    expect(ops.closeStranded).toHaveBeenCalledWith(database, context, {
      workUnitId: live[0]!.workUnitId,
      temporalRunId: 'run-closed',
    });
    // Once as the stranded close, once as an ended run still holding budget.
    expect(ops.closeWithoutContext).toHaveBeenCalledTimes(2);
    expect(ops.closeWithoutContext).toHaveBeenCalledWith(database, {
      organizationId: context.organizationId,
      agentRunId: closed,
      status: 'failed',
      stopCode: 'STRANDED',
    });
    // One run closed and two of its three holds released. The one that may have reached a provider stays
    // held, and the metadata read afterwards reports it.
    expect(report).toEqual({ checked: 5, changed: 3, needsAttention: 0 });
  });

  it('counts a close that failed as attention, never as done', async () => {
    const { database } = recordingDatabase(answer(3));
    const ops = operations({
      closeWithoutContext: vi.fn(async () => {
        throw new Error('NOWAIT');
      }),
    });
    const port = createRuntimeRestoreRecoveryBindings(
      { agentDatabase: database, probeRun: async () => 'closed' },
      ops,
    )['m4-runs-and-budgets']!;
    const report = await port.reconcile(database, createServiceContext(randomUUID()));
    expect(report.changed).toBe(0);
    expect(report.needsAttention).toBe(4);
  });
});

describe('m4-private-transcripts', () => {
  const [due, certified, live, missing] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const page = [
    { id: due, status: 'completed', checkpoint: true, certified: false },
    { id: certified, status: 'failed', checkpoint: true, certified: true },
    { id: live, status: 'running', checkpoint: true, certified: false },
    { id: missing, status: 'cancelled', checkpoint: false, certified: false },
  ];
  const counts: RestoreRunInputCounts = {
    runs: 4,
    checkpoints: 3,
    observations: 0,
    missingCheckpoints: 1,
    legacyHistoryUnknown: 0,
    unfencedTerminalRuns: 0,
    uncertifiedFences: 0,
    certifiedFences: 2,
    unsupportedProtocols: 0,
  };
  const answer = (remaining: number) => (text: string) => {
    if (/left join ai\.run_input_checkpoints/i.test(text)) return page;
    if (/as certified/i.test(text)) return [{ certified: 2, remaining }];
    return null;
  };

  it('fences and purges only ended, uncertified runs, and proves it from the private rows', async () => {
    const { database, sent } = recordingDatabase(answer(0));
    const ops = operations();
    const context = createServiceContext(randomUUID());
    const port = createRuntimeRestoreRecoveryBindings({ agentDatabase: database }, ops)[
      'm4-private-transcripts'
    ]!;
    const report = await port.reconcile(database, context);
    expect(ops.fenceAndPurge).toHaveBeenCalledTimes(1);
    expect(ops.fenceAndPurge).toHaveBeenCalledWith(database, context, [due]);
    expect(sent.some((text) => /from ai\.step_payloads/i.test(text))).toBe(true);
    expect(report.transcriptProof).toEqual({
      protocol: 'ai.run_inputs/v1',
      fenceGeneration: 1,
      checkedRuns: 4,
      certifiedRuns: 2,
      remainingPayloads: 0,
    });
    expect(report.changed).toBe(2);
    expect(report.needsAttention).toBe(0);
    expect(transcriptRestoreProofAttention(report.transcriptProof, counts)).toBe(0);
  });

  it('keeps a held transcript, and the proof says payloads remain', async () => {
    const { database } = recordingDatabase(answer(0));
    const hold = Object.assign(new Error('refused'), {
      cause: Object.assign(new Error('MATERIAL_DELETE_HOLD_UNCONFIRMED'), { code: 'EN119' }),
    });
    const ops = operations({
      fenceAndPurge: vi.fn(async () => {
        throw hold;
      }),
    });
    const port = createRuntimeRestoreRecoveryBindings({ agentDatabase: database }, ops)[
      'm4-private-transcripts'
    ]!;
    const report = await port.reconcile(database, createServiceContext(randomUUID()));
    expect(report.needsAttention).toBe(1);
    expect(report.transcriptProof?.remainingPayloads).toBe(1);
    expect(transcriptRestoreProofAttention(report.transcriptProof, counts)).toBe(1);
  });

  it('lets any other failure through rather than reporting a proof', async () => {
    const { database } = recordingDatabase(answer(0));
    const ops = operations({
      fenceAndPurge: vi.fn(async () => {
        throw new Error('RUN_INPUT_FENCE_AUTHORITY');
      }),
    });
    const port = createRuntimeRestoreRecoveryBindings({ agentDatabase: database }, ops)[
      'm4-private-transcripts'
    ]!;
    await expect(port.reconcile(database, createServiceContext(randomUUID()))).rejects.toThrow(
      'RUN_INPUT_FENCE_AUTHORITY',
    );
  });
});

describe('m5-sources-and-indexes', () => {
  it('runs the sweep recovery and closes orphaned sources a page at a time', async () => {
    let reads = 0;
    const { database } = recordingDatabase((text) =>
      /knowledge\.object_writers/i.test(text)
        ? [reads++ === 0 ? { writers: 2, received: 1 } : { writers: 0, received: 0 }]
        : null,
    );
    const closeOrphans = vi
      .fn<RecoveryOperations['closeOrphans']>()
      .mockResolvedValueOnce({ closed: 100 })
      .mockResolvedValueOnce({ closed: 4 });
    const ops = operations({ closeOrphans });
    const context = createServiceContext(randomUUID());
    const port = createRuntimeRestoreRecoveryBindings({ knowledgeStore: store }, ops)[
      'm5-sources-and-indexes'
    ]!;
    const report = await port.reconcile(database, context);
    expect(ops.recoverDocuments).toHaveBeenCalledWith(database, store, context);
    expect(closeOrphans).toHaveBeenCalledTimes(2);
    expect(report).toEqual({ checked: 3, changed: 107, needsAttention: 0 });
  });

  it('reports a recovery it could not run as attention', async () => {
    const { database } = recordingDatabase((text) =>
      /knowledge\.object_writers/i.test(text) ? [{ writers: 1, received: 0 }] : null,
    );
    const ops = operations({
      recoverDocuments: vi.fn(async () => {
        throw new Error('CAPABILITY_UNAVAILABLE');
      }),
    });
    const port = createRuntimeRestoreRecoveryBindings({ knowledgeStore: store }, ops)[
      'm5-sources-and-indexes'
    ]!;
    const report = await port.reconcile(database, createServiceContext(randomUUID()));
    expect(report).toEqual({ checked: 1, changed: 0, needsAttention: 1 });
  });
});

describe('the contributor wrapper around a bound port', () => {
  it('still adds what the metadata finds afterwards, so a port alone cannot make a tenant clean', async () => {
    const { database } = recordingDatabase((text) => {
      if (/from knowledge\.sources where/i.test(text)) return [{ checked: 5, attention: 2 }];
      if (/knowledge\.object_writers where organization_id/i.test(text) && /as writers/i.test(text))
        return [{ writers: 0, received: 0 }];
      return null;
    });
    const [contributor] = createRestoreContributors(
      createRuntimeRestoreRecoveryBindings({ knowledgeStore: store }, operations()),
    ).filter(({ name }) => name === 'm5-sources-and-indexes');
    const report = await contributor!.reconcile(database, createServiceContext(randomUUID()));
    expect(report).toMatchObject({ name: 'm5-sources-and-indexes', checked: 5, needsAttention: 2 });
  });
});
