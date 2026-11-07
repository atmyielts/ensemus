// UX-19, QA-047: the Assistants services and page states on real tenants and real roles. M4's port is a fake
// that keeps M4's rules, because everything here sits on the far side of it: only the person who started a run
// gets it, and anyone else, whatever their role or tenant, gets NOT_FOUND. This file proves that the layer here
// passes those answers on unchanged and adds no filter, no widening and no invented state.
// Written in code-only mode, and never run yet: it needs the stack, and 0400 and 0401 in the journal.
import { randomUUID } from 'node:crypto';
import { AppError } from '@ensemus/application';
import {
  getDelegatedRun,
  listMyDelegatedRuns,
  stopDelegatedRun,
} from '@ensemus/application/assistants';
import type { AgentRunsPort, DelegatedRun } from '@ensemus/application/product-ports';
import { openAppDatabase, type TenantContext } from '@ensemus/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptStop,
  readAssistantsPage,
  readRunPage,
} from '../../apps/web/src/components/assistants/read';
import { fakePorts, makeTwoTenants } from '../helpers/product';
import { urls } from '../helpers/stack';

const CANARY = 'CANARY-model-text-that-must-never-render';

type Stored = DelegatedRun & { organizationId: string; ownerUserId: string };

/** M4's rule, as far as this slice can see it: your own runs, in your own tenant, and nothing else. */
function fakeRuns(stored: Stored[]): Partial<AgentRunsPort> {
  const mine = (context: TenantContext, run: Stored) =>
    run.organizationId === context.organizationId && run.ownerUserId === context.userId;
  const find = (context: TenantContext, runId: string) => {
    const run = stored.find((candidate) => candidate.id === runId);
    if (!run || !mine(context, run)) throw new AppError('NOT_FOUND');
    return run;
  };
  return {
    listMine: async (context) => ({
      items: stored.filter((run) => mine(context, run)),
      next: null,
    }),
    get: async (context, runId) => find(context, runId),
    requestStop: async (context, runId) => {
      const run = find(context, runId);
      if (!run.canStop) throw new AppError('FORBIDDEN');
      // A stop is a request. The run says when it has stopped, which a test decides by changing the row.
    },
  };
}

function aRun(owner: TenantContext, overrides: Partial<DelegatedRun> = {}): Stored {
  return {
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    id: randomUUID(),
    workUnitId: randomUUID(),
    workTitle: 'Same title in both tenants',
    agentName: 'Same agent in both tenants',
    status: 'running',
    stopCode: null,
    turnsUsed: 1,
    toolCallsUsed: 0,
    costMicros: null,
    costIsEstimate: false,
    startedAt: new Date(),
    finishedAt: null,
    canStop: true,
    steps: [{ labelCode: CANARY, state: CANARY, at: new Date() }],
    ...overrides,
  };
}

describe('Assistants on real tenants', () => {
  let close: () => Promise<void>;
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  let stored: Stored[];
  const ports = () => {
    const base = fakePorts();
    return { ...base, agentRuns: { ...base.agentRuns, ...fakeRuns(stored) } };
  };

  beforeAll(async () => {
    const opened = openAppDatabase(urls.app());
    close = opened.close;
    tenants = await makeTwoTenants(opened.db);
  });
  afterAll(() => close());

  const seed = () => {
    const a = aRun(tenants.a.member.context);
    const b = aRun(tenants.b.member.context);
    stored = [a, b];
    return { a, b };
  };

  it('lists only what the port gives this person, with the same names in both tenants', async () => {
    const { a, b } = seed();
    const viewA = await listMyDelegatedRuns(tenants.a.member.context, ports());
    const viewB = await listMyDelegatedRuns(tenants.b.member.context, ports());
    expect(viewA.running.map((run) => run.id)).toEqual([a.id]);
    expect(viewB.running.map((run) => run.id)).toEqual([b.id]);
  });

  it('gives an owner no wider a view of other people’s runs than the port does', async () => {
    seed();
    const view = await listMyDelegatedRuns(tenants.a.owner.context, ports());
    expect(view.running).toEqual([]);
    expect(view.finished).toEqual([]);
  });

  it.each(['owner', 'admin'] as const)(
    'answers NOT_FOUND for someone else’s run when asked by an %s of that tenant',
    async (role) => {
      const { a } = seed();
      await expect(getDelegatedRun(tenants.a[role].context, ports(), a.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(readRunPage(tenants.a[role].context, ports(), a.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(stopDelegatedRun(tenants.a[role].context, ports(), a.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    },
  );

  it('answers NOT_FOUND, and not forbidden, for a run in another tenant', async () => {
    const { b } = seed();
    await expect(readRunPage(tenants.a.owner.context, ports(), b.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const attempt = await attemptStop(tenants.a.owner.context, ports(), b.id, true);
    expect(attempt).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('shows the unavailable state on real tenants, and never an empty list', async () => {
    const context = tenants.a.member.context;
    await expect(readAssistantsPage(context, fakePorts())).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(readRunPage(context, fakePorts(), randomUUID())).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('says it did not stop when the port refuses, and the run reads as it did', async () => {
    const { a } = seed();
    const run = stored.find((candidate) => candidate.id === a.id);
    if (!run) throw new Error('seed');
    run.canStop = false;
    const context = tenants.a.member.context;
    const attempt = await attemptStop(context, ports(), a.id, true);
    expect(attempt).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    const state = await readRunPage(context, ports(), a.id);
    expect(state).toMatchObject({ kind: 'ready', run: { finished: false } });
  });

  it('does not say stopped until the run does', async () => {
    const { a } = seed();
    const context = tenants.a.member.context;
    await expect(attemptStop(context, ports(), a.id, true)).resolves.toEqual({ ok: true });
    const before = await readRunPage(context, ports(), a.id);
    expect(before).toMatchObject({ kind: 'ready', run: { finished: false } });

    const run = stored.find((candidate) => candidate.id === a.id);
    if (!run) throw new Error('seed');
    run.status = 'cancelled';
    run.stopCode = 'STOPPED_BY_PERSON';
    run.finishedAt = new Date();
    const after = await readRunPage(context, ports(), a.id);
    expect(after).toMatchObject({ kind: 'ready', run: { finished: true, canStop: true } });
  });

  it('never lets a canary from a step reach what the page renders', async () => {
    seed();
    const context = tenants.a.member.context;
    const list = await readAssistantsPage(context, ports());
    expect(list.kind).toBe('ready');
    expect(JSON.stringify(list)).not.toContain(CANARY);
    const [first] = stored;
    if (!first) throw new Error('seed');
    const one = await readRunPage(context, ports(), first.id);
    expect(one.kind).toBe('ready');
    expect(JSON.stringify(one)).not.toContain(CANARY);
  });
});
