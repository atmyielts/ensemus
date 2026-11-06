// SEC-06, QA-AI-KILL, ADR-028 FD-15, incident doc section 5. What can run today, with no database: the
// watcher on a fake clock, the check and the services against a double for the transaction, and the
// operator's command against doubles for its writes. Forced RLS, the triggers and the real roles are in
// tests/integration/ai-halt.test.ts.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AppError } from '@ensemus/application';
import {
  createHaltCheck,
  engageKillSwitch,
  listHaltableAgentVersions,
  listKillSwitches,
  releaseKillSwitch,
  switchCovers,
  type LiveSwitch,
} from '@ensemus/application/ai-halt';
import { engageKillSwitchSchema } from '@ensemus/contracts/ai';
import {
  agentRuns,
  agentVersions,
  auditEvents,
  domainEvents,
  killSwitches,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { PROVIDER_KINDS } from '@ensemus/domain/ai';
import { KILL_SWITCH_ENGAGED, KILL_SWITCH_RELEASED } from '@ensemus/domain/ai-events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HALT_REASONS,
  reasonLabel,
  scopeLabel,
} from '../../../apps/web/src/app/o/[organizationId]/settings/safety/safety-view';
import {
  createHaltWatcher,
  HALT_POLL_MS,
  parseHaltCommand,
  runHaltCommand,
  type HaltCommand,
  type SwitchReader,
} from './kill-switch';

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const VERSION = randomUUID();
const OTHER_VERSION = randomUUID();
const RUN = randomUUID();
const MEMBERSHIP = randomUUID();
const SWITCH = randomUUID();

const person = (role: string, organizationId = ORG_A): TenantContext => ({
  ...createServiceContext(organizationId),
  userId: randomUUID(),
  membershipId: MEMBERSHIP,
  role,
  actorType: 'user',
});
/** An agent carries its initiator's role, and an owner's agent still may not touch a switch. */
const agentOf = (role = 'owner'): TenantContext => ({
  ...person(role),
  actorType: 'agent',
  agentRunId: RUN,
});

const global_: LiveSwitch = { organizationId: null, scope: 'global', targetRef: null };
const ofOrganization = (organizationId = ORG_A): LiveSwitch => ({
  organizationId,
  scope: 'organization',
  targetRef: null,
});
const ofProvider = (providerKind = 'openai_hosted'): LiveSwitch => ({
  organizationId: null,
  scope: 'provider',
  targetRef: providerKind,
});
const ofVersion = (versionId = VERSION, organizationId = ORG_A): LiveSwitch => ({
  organizationId,
  scope: 'agent_version',
  targetRef: versionId,
});

type World = {
  /** What `app.current_organization_id()` answers. Undefined means this tenant. */
  bound?: string | null;
  /** The live rows the database would hand back, or the failure reading them. */
  switches?: readonly object[] | Error;
  /** The run row for an agent's context, or null if it cannot be found. */
  run?: { agentVersionId: string; providerKind: string | null } | null;
  versions?: readonly object[];
  inserted?: { table: unknown; values: Record<string, unknown> }[];
  updated?: { table: unknown; values: Record<string, unknown> }[];
};

/** A double for a transaction. It proves what the code does with rows, not the SQL that fetches them. */
function fakeTx(world: World): Tx {
  const rowsFor = (table: unknown) => {
    if (table === killSwitches) {
      if (world.switches instanceof Error) throw world.switches;
      return world.switches ?? [];
    }
    if (table === agentRuns) return world.run ? [world.run] : [];
    if (table === agentVersions) return world.versions ?? [];
    return [];
  };
  const query = (table: unknown) => {
    const rows = () => Promise.resolve().then(() => rowsFor(table));
    const q = {
      where: () => q,
      leftJoin: () => q,
      innerJoin: () => q,
      orderBy: () => q,
      then: (ok: (value: unknown) => unknown, no: (reason: unknown) => unknown) =>
        rows().then(ok, no),
    };
    return q;
  };
  return {
    execute: async () => ({
      rows: [{ organization_id: world.bound === undefined ? ORG_A : world.bound }],
    }),
    select: () => ({ from: query }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        (world.inserted ??= []).push({ table, values });
        return Object.assign(Promise.resolve(), {
          returning: async () => [{ id: SWITCH }],
        });
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        (world.updated ??= []).push({ table, values });
        return { where: () => ({ returning: async () => [{ id: SWITCH }] }) };
      },
    }),
  } as unknown as Tx;
}

const fakeDatabase = (world: World) =>
  ({
    transaction: (_bindings: unknown, fn: (tx: Tx) => Promise<unknown>) => fn(fakeTx(world)),
  }) as unknown as AppDatabase;

/** A database that fails the test if anything reaches it: a refusal has to come before any query. */
const untouchable = {
  transaction: () => {
    throw new Error('A refused request reached the database');
  },
} as unknown as AppDatabase;

const halted = expect.objectContaining({ name: 'AppError', code: 'AI_HALTED' });
const refusedWith = (code: string) => expect.objectContaining({ name: 'AppError', code });

describe('switchCovers', () => {
  const run = { agentVersionId: VERSION, providerKind: 'openai_hosted' };

  it('takes each scope to mean what it says', () => {
    expect(switchCovers(global_, ORG_A, run)).toBe(true);
    expect(switchCovers(global_, ORG_B, {})).toBe(true);
    expect(switchCovers(ofOrganization(), ORG_A, run)).toBe(true);
    expect(switchCovers(ofProvider(), ORG_A, run)).toBe(true);
    expect(switchCovers(ofVersion(), ORG_A, run)).toBe(true);
  });

  it('leaves another tenant alone, even if its row somehow reached this one', () => {
    expect(switchCovers(ofOrganization(ORG_B), ORG_A, run)).toBe(false);
    expect(switchCovers(ofVersion(VERSION, ORG_B), ORG_A, run)).toBe(false);
  });

  it('does not stop another version or provider', () => {
    expect(switchCovers(ofVersion(OTHER_VERSION), ORG_A, run)).toBe(false);
    expect(switchCovers(ofProvider('anthropic_hosted'), ORG_A, run)).toBe(false);
  });

  it('matches an ID however it was spelled, as a text column cannot', () => {
    const shouted = ofVersion(VERSION.toUpperCase());
    expect(switchCovers(shouted, ORG_A, run)).toBe(true);
    expect(switchCovers(ofOrganization(ORG_A.toUpperCase()), ORG_A, run)).toBe(true);
  });

  it('treats a scope it does not know as covering everything', () => {
    expect(switchCovers({ ...global_, scope: 'everything_else' }, ORG_A, {})).toBe(true);
  });

  it('treats a targeted switch with no target as covering what it can', () => {
    expect(switchCovers({ ...ofProvider(), targetRef: null }, ORG_A, run)).toBe(true);
    expect(switchCovers({ ...ofVersion(), targetRef: null }, ORG_A, run)).toBe(true);
  });
});

describe('createHaltCheck', () => {
  const check = createHaltCheck();
  const boundRun = { agentVersionId: VERSION, providerKind: 'openai_hosted' };
  const unboundRun = { agentVersionId: VERSION, providerKind: null };

  // Claiming a queued run happens under the initiator's context, before any provider is chosen.
  const stages = [
    {
      stage: 'a queued run',
      context: person('member'),
      target: { agentVersionId: VERSION },
      run: undefined,
    },
    {
      stage: 'the next model turn',
      context: agentOf('member'),
      target: { agentVersionId: VERSION, providerKind: 'openai_hosted' as const },
      run: unboundRun,
    },
    { stage: 'the next tool', context: agentOf('member'), target: {}, run: boundRun },
  ];

  describe.each(stages)('at $stage', ({ context, target, run }) => {
    const passes = (switches: readonly object[]) =>
      check.assertRunning(fakeTx({ switches, run: run ?? null }), context, target);

    it('runs with no switch engaged', async () => {
      await expect(passes([])).resolves.toBeUndefined();
    });

    it('stops under a global switch', async () => {
      await expect(passes([global_])).rejects.toEqual(halted);
    });

    it("stops under this tenant's switch", async () => {
      await expect(passes([ofOrganization()])).rejects.toEqual(halted);
    });

    it('stops under a switch for this agent version', async () => {
      await expect(passes([ofVersion()])).rejects.toEqual(halted);
    });

    it("runs on under another tenant's switch", async () => {
      await expect(passes([ofOrganization(ORG_B), ofVersion(VERSION, ORG_B)])).resolves.toBe(
        undefined,
      );
    });

    it('runs on under a switch for another version', async () => {
      await expect(passes([ofVersion(OTHER_VERSION)])).resolves.toBeUndefined();
    });
  });

  describe('a provider switch', () => {
    it('stops a queued run at its first turn, once the provider is known and before any key', async () => {
      const tx = fakeTx({ switches: [ofProvider()], run: unboundRun });
      await expect(
        check.assertRunning(tx, person('member'), { agentVersionId: VERSION }),
      ).resolves.toBeUndefined();
      await expect(
        check.assertRunning(tx, agentOf('member'), {
          agentVersionId: VERSION,
          providerKind: 'openai_hosted',
        }),
      ).rejects.toEqual(halted);
    });

    it('stops the next turn on that provider', async () => {
      const tx = fakeTx({ switches: [ofProvider()], run: unboundRun });
      await expect(
        check.assertRunning(tx, agentOf(), { providerKind: 'openai_hosted' }),
      ).rejects.toEqual(halted);
    });

    it('stops the next tool of a run pinned to that provider, though the tool never names it', async () => {
      const tx = fakeTx({ switches: [ofProvider()], run: boundRun });
      await expect(check.assertRunning(tx, agentOf(), {})).rejects.toEqual(halted);
    });

    it('leaves a run on another provider alone', async () => {
      const tx = fakeTx({ switches: [ofProvider('anthropic_hosted')], run: boundRun });
      await expect(
        check.assertRunning(tx, agentOf(), { providerKind: 'openai_hosted' }),
      ).resolves.toBeUndefined();
    });
  });

  it("finds an agent's version from its own run, so a caller who forgets it still stops", async () => {
    const tx = fakeTx({ switches: [ofVersion()], run: unboundRun });
    await expect(check.assertRunning(tx, agentOf(), {})).rejects.toEqual(halted);
  });

  describe('fails closed', () => {
    it('when the switches cannot be read', async () => {
      const tx = fakeTx({ switches: new Error('connection terminated'), run: boundRun });
      await expect(check.assertRunning(tx, agentOf(), {})).rejects.toEqual(halted);
    });

    it('with an error that says nothing of why', async () => {
      const reason = 'select from governance.kill_switches failed';
      const tx = fakeTx({ switches: new Error(reason), run: boundRun });
      const error = await check.assertRunning(tx, agentOf(), {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect((error as Error).message).not.toContain(reason);
      expect((error as Error).cause).toBeUndefined();
    });

    it("when an agent's own run cannot be found", async () => {
      const tx = fakeTx({ switches: [], run: null });
      await expect(check.assertRunning(tx, agentOf(), {})).rejects.toEqual(halted);
    });

    it('when no tenant is bound, since RLS would then hide this tenant from the read', async () => {
      const tx = fakeTx({ switches: [], run: boundRun, bound: null });
      await expect(check.assertRunning(tx, agentOf(), {})).rejects.toEqual(halted);
    });

    it('when another tenant is bound', async () => {
      const tx = fakeTx({ switches: [], run: boundRun, bound: ORG_B });
      await expect(check.assertRunning(tx, agentOf(), {})).rejects.toEqual(halted);
    });

    it('when a row holds a scope this code has never heard of', async () => {
      const tx = fakeTx({ switches: [{ ...global_, scope: 'tenant_group' }], run: boundRun });
      await expect(check.assertRunning(tx, agentOf(), {})).rejects.toEqual(halted);
    });
  });
});

describe('engageKillSwitch', () => {
  const stopAll = { scope: 'organization', target_ref: null, reason_code: 'INCIDENT' } as const;

  it.each(['member', 'service', 'viewer', ''])('refuses the role %j', async (role) => {
    await expect(engageKillSwitch(untouchable, person(role), stopAll)).rejects.toEqual(
      refusedWith('FORBIDDEN'),
    );
  });

  it('refuses an agent, even one its owner started', async () => {
    await expect(engageKillSwitch(untouchable, agentOf('owner'), stopAll)).rejects.toEqual(
      refusedWith('FORBIDDEN'),
    );
  });

  it.each(['global', 'provider'])(
    'refuses a tenant aiming at the operator scope %s, as a refusal to be audited',
    async (scope) => {
      const forged = { scope, target_ref: null, reason_code: 'INCIDENT' };
      await expect(engageKillSwitch(untouchable, person('owner'), forged as never)).rejects.toEqual(
        refusedWith('FORBIDDEN'),
      );
    },
  );

  it.each([
    ['a free-text reason', { ...stopAll, reason_code: 'they said so' }],
    ['a target on a tenant-wide stop', { ...stopAll, target_ref: VERSION }],
    ['no target on a version stop', { ...stopAll, scope: 'agent_version' }],
    ['an extra field', { ...stopAll, organization_id: ORG_B }],
    ['a target that is no ID', { scope: 'agent_version', target_ref: 'x', reason_code: 'OTHER' }],
  ])('refuses %s', async (_name, input) => {
    await expect(engageKillSwitch(untouchable, person('owner'), input as never)).rejects.toEqual(
      refusedWith('INVALID_INPUT'),
    );
  });

  it('refuses a version this tenant cannot see, and writes nothing', async () => {
    const world: World = { versions: [] };
    await expect(
      engageKillSwitch(fakeDatabase(world), person('owner'), {
        scope: 'agent_version',
        target_ref: VERSION,
        reason_code: 'INCIDENT',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(world.inserted).toBeUndefined();
  });

  it('stores the version in the spelling the trigger on attempts compares, not the one it was sent in', async () => {
    const world: World = { versions: [{ id: VERSION }] };
    await engageKillSwitch(fakeDatabase(world), person('admin'), {
      scope: 'agent_version',
      target_ref: VERSION.toUpperCase(),
      reason_code: 'INCIDENT',
    });
    const row = world.inserted?.find((entry) => entry.table === killSwitches);
    expect(row?.values).toMatchObject({ scope: 'agent_version', targetRef: VERSION });
  });

  it('records who did it, in one transaction with the audit row and the event, with codes only', async () => {
    const world: World = {};
    const { switchId } = await engageKillSwitch(fakeDatabase(world), person('owner'), stopAll);
    expect(switchId).toBe(SWITCH);
    const row = world.inserted?.find((entry) => entry.table === killSwitches);
    expect(row?.values).toEqual({
      organizationId: ORG_A,
      scope: 'organization',
      targetRef: null,
      reasonCode: 'INCIDENT',
      engagedByMembershipId: MEMBERSHIP,
    });
    const audit = world.inserted?.find((entry) => entry.table === auditEvents);
    expect(audit?.values).toEqual({
      organizationId: ORG_A,
      actorType: 'user',
      actorId: MEMBERSHIP,
      action: KILL_SWITCH_ENGAGED,
      targetRef: `kill_switch:${SWITCH}`,
      decision: 'allow',
      safeReason: 'INCIDENT',
    });
    const event = world.inserted?.find((entry) => entry.table === domainEvents);
    expect(event?.values).toMatchObject({
      eventType: KILL_SWITCH_ENGAGED,
      aggregateType: 'kill_switch',
      aggregateId: SWITCH,
      payload: { scope: 'organization', targetRef: null, reasonCode: 'INCIDENT' },
    });
  });
});

describe('releaseKillSwitch', () => {
  it.each(['member', 'service', ''])('refuses the role %j', async (role) => {
    await expect(
      releaseKillSwitch(untouchable, person(role), { switchId: SWITCH }),
    ).rejects.toEqual(refusedWith('FORBIDDEN'));
  });

  it('refuses an agent, so nothing a model does can lift a stop', async () => {
    await expect(
      releaseKillSwitch(untouchable, agentOf('owner'), { switchId: SWITCH }),
    ).rejects.toEqual(refusedWith('FORBIDDEN'));
  });

  it('refuses something that is no ID', async () => {
    await expect(
      releaseKillSwitch(untouchable, person('owner'), { switchId: 'not-an-id' }),
    ).rejects.toEqual(refusedWith('INVALID_INPUT'));
  });

  it('refuses a switch this tenant cannot see', async () => {
    await expect(
      releaseKillSwitch(fakeDatabase({ switches: [] }), person('owner'), { switchId: SWITCH }),
    ).rejects.toEqual(refusedWith('NOT_FOUND'));
  });

  it("refuses the operator's switch, changes nothing and leaves a record", async () => {
    const world: World = {
      switches: [{ id: SWITCH, organizationId: null, releasedAt: null }],
    };
    await expect(
      releaseKillSwitch(fakeDatabase(world), person('owner'), { switchId: SWITCH }),
    ).rejects.toEqual(refusedWith('KILL_SWITCH_NOT_YOURS'));
    expect(world.updated).toBeUndefined();
    expect(world.inserted).toEqual([
      {
        table: auditEvents,
        values: {
          organizationId: ORG_A,
          actorType: 'user',
          actorId: MEMBERSHIP,
          action: 'kill_switch.release',
          targetRef: `kill_switch:${SWITCH}`,
          decision: 'deny',
          safeReason: 'KILL_SWITCH_NOT_YOURS',
        },
      },
    ]);
  });

  it("lifts this tenant's switch, audited with codes only", async () => {
    const world: World = {
      switches: [
        {
          id: SWITCH,
          organizationId: ORG_A,
          scope: 'organization',
          reasonCode: 'INCIDENT',
          releasedAt: null,
        },
      ],
    };
    await releaseKillSwitch(fakeDatabase(world), person('admin'), { switchId: SWITCH });
    expect(world.updated?.[0]?.values).toMatchObject({ releasedByMembershipId: MEMBERSHIP });
    expect(world.updated?.[0]?.values['releasedAt']).toBeInstanceOf(Date);
    expect(world.inserted?.find((entry) => entry.table === auditEvents)?.values).toEqual({
      organizationId: ORG_A,
      actorType: 'user',
      actorId: MEMBERSHIP,
      action: KILL_SWITCH_RELEASED,
      targetRef: `kill_switch:${SWITCH}`,
      decision: 'allow',
    });
    expect(world.inserted?.find((entry) => entry.table === domainEvents)?.values).toMatchObject({
      eventType: KILL_SWITCH_RELEASED,
      aggregateId: SWITCH,
    });
  });
});

describe('listKillSwitches', () => {
  it('refuses a member and an agent', async () => {
    await expect(listKillSwitches(untouchable, person('member'))).rejects.toEqual(
      refusedWith('FORBIDDEN'),
    );
    await expect(listKillSwitches(untouchable, agentOf('owner'))).rejects.toEqual(
      refusedWith('FORBIDDEN'),
    );
    await expect(listHaltableAgentVersions(untouchable, person('member'))).rejects.toEqual(
      refusedWith('FORBIDDEN'),
    );
  });

  it("says which rows are the operator's, and holds no person's ID", async () => {
    const engagedAt = new Date();
    const world: World = {
      switches: [
        { id: SWITCH, organizationId: null, scope: 'global', reasonCode: 'INCIDENT', engagedAt },
        {
          id: VERSION,
          organizationId: ORG_A,
          scope: 'organization',
          targetRef: null,
          reasonCode: 'OTHER',
          engagedAt,
          engagedByMembershipId: MEMBERSHIP,
        },
      ],
    };
    const rows = await listKillSwitches(fakeDatabase(world), person('owner'));
    expect(rows.map((row) => row.operator)).toEqual([true, false]);
    expect(JSON.stringify(rows)).not.toContain(MEMBERSHIP);
  });
});

describe('the safety page', () => {
  it('offers only reasons the contract accepts', () => {
    for (const { code } of HALT_REASONS) {
      expect(
        engageKillSwitchSchema.safeParse({
          scope: 'organization',
          target_ref: null,
          reason_code: code,
        }).success,
      ).toBe(true);
    }
  });

  it('has words for its own reasons, and shows a code it does not know as it is', () => {
    expect(reasonLabel('SUSPECTED_INJECTION')).not.toContain('_');
    expect(reasonLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('has words for every scope and provider an operator can stop', () => {
    expect(scopeLabel({ scope: 'global', targetRef: null })).toMatch(/every organization/i);
    for (const kind of PROVIDER_KINDS) {
      expect(scopeLabel({ scope: 'provider', targetRef: kind })).not.toContain(kind);
    }
  });
});

describe('createHaltWatcher', () => {
  const POLL = 1_000;
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const call = {
    organizationId: ORG_A,
    agentVersionId: VERSION,
    providerKind: 'openai_hosted',
  };

  const watcherWith = (read: SwitchReader, readTimeoutMs?: number) => {
    const watcher = createHaltWatcher({
      pollMs: POLL,
      read,
      log: quiet,
      ...(readTimeoutMs === undefined ? {} : { readTimeoutMs }),
    });
    watcher.start();
    return watcher;
  };

  /** Moves the clock until the signal aborts, and says how long that took. */
  const timeToAbort = async (signal: AbortSignal, giveUpAfter = 60_000) => {
    const started = Date.now();
    while (!signal.aborted && Date.now() - started < giveUpAfter) {
      await vi.advanceTimersByTimeAsync(50);
    }
    return signal.aborted ? Date.now() - started : Number.POSITIVE_INFINITY;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['global', global_],
    ['organization', ofOrganization()],
    ['provider', ofProvider()],
    ['agent_version', ofVersion()],
  ])('aborts a call in flight when a %s switch engages, within its limit', async (_scope, row) => {
    let live: readonly LiveSwitch[] = [];
    const watcher = watcherWith(async () => live);
    const signal = watcher.signalFor(call);
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(signal.aborted).toBe(false);

    // Late in a poll's wait, then early in one: neither may take longer than the stated limit.
    for (const offset of [POLL - 50, 50]) {
      live = [];
      const another = watcher.signalFor(call);
      await vi.advanceTimersByTimeAsync(POLL);
      await vi.advanceTimersByTimeAsync(offset);
      live = [row];
      expect(await timeToAbort(another)).toBeLessThanOrEqual(watcher.abortLimitMs);
    }
    await watcher.stop();
  });

  it('aborts with the code the gateway stops on, and a signal the adapter can act on', async () => {
    const watcher = watcherWith(async () => [global_]);
    const signal = watcher.signalFor(call);
    const inFlight = new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason as Error));
    });
    const outcome = expect(inFlight).rejects.toEqual(halted);
    await vi.advanceTimersByTimeAsync(POLL);
    await outcome;
    await watcher.stop();
  });

  it("leaves another tenant's call, another version and another provider running", async () => {
    const watcher = watcherWith(async () => [
      ofOrganization(ORG_B),
      ofVersion(OTHER_VERSION),
      ofProvider('anthropic_hosted'),
    ]);
    const signal = watcher.signalFor(call);
    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(signal.aborted).toBe(false);
    await watcher.stop();
  });

  it('reads each tenant under its own binding, and only for tenants with a call in flight', async () => {
    const read = vi.fn<SwitchReader>(async () => []);
    const watcher = watcherWith(read);
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(read).not.toHaveBeenCalled();

    watcher.signalFor(call);
    watcher.signalFor(call);
    watcher.signalFor({ ...call, organizationId: ORG_B });
    await vi.advanceTimersByTimeAsync(POLL);
    expect(read.mock.calls.map(([organizationId]) => organizationId).sort()).toEqual(
      [ORG_A, ORG_B].sort(),
    );
    await watcher.stop();
  });

  it('aborts on one tenant going down without touching the other', async () => {
    const read: SwitchReader = async (organizationId) => {
      if (organizationId === ORG_A) throw new Error('down');
      return [];
    };
    const watcher = watcherWith(read);
    const mine = watcher.signalFor(call);
    const theirs = watcher.signalFor({ ...call, organizationId: ORG_B });
    await vi.advanceTimersByTimeAsync(POLL);
    expect(mine.aborted).toBe(true);
    expect(mine.reason).toEqual(halted);
    expect(theirs.aborted).toBe(false);
    await watcher.stop();
  });

  it('counts a read that throws at once as unreadable', async () => {
    const watcher = watcherWith(() => {
      throw new Error('no pool');
    });
    const signal = watcher.signalFor(call);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(signal.aborted).toBe(true);
    await watcher.stop();
  });

  it('counts a read that never answers as unreadable, within the stated limit', async () => {
    const watcher = watcherWith(() => new Promise(() => undefined), 500);
    const signal = watcher.signalFor(call);
    expect(await timeToAbort(signal)).toBeLessThanOrEqual(watcher.abortLimitMs);
    expect(signal.reason).toEqual(halted);
    await watcher.stop();
  });

  it('counts a row it cannot understand as a stop', async () => {
    const watcher = watcherWith(async () => [{ ...global_, scope: 'tenant_group' }]);
    const signal = watcher.signalFor(call);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(signal.aborted).toBe(true);
    await watcher.stop();
  });

  it('keeps polling after a failed read, so a recovered database ends the halt for new calls', async () => {
    let down = true;
    const watcher = watcherWith(async () => {
      if (down) throw new Error('down');
      return [];
    });
    const first = watcher.signalFor(call);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(first.aborted).toBe(true);

    down = false;
    const second = watcher.signalFor(call);
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(second.aborted).toBe(false);
    await watcher.stop();
  });

  it('assumes the worst of a call whose provider is not chosen yet', async () => {
    const watcher = watcherWith(async () => [ofProvider('anthropic_hosted')]);
    const signal = watcher.signalFor({ organizationId: ORG_A, agentVersionId: VERSION });
    await vi.advanceTimersByTimeAsync(POLL);
    expect(signal.aborted).toBe(true);
    await watcher.stop();
  });

  it('refuses to promise anything while it is not running', async () => {
    const watcher = createHaltWatcher({ pollMs: POLL, read: async () => [], log: quiet });
    expect(watcher.signalFor(call).aborted).toBe(true);
    watcher.start();
    expect(watcher.signalFor(call).aborted).toBe(false);
    await watcher.stop();
    expect(watcher.signalFor(call).aborted).toBe(true);
  });

  it('aborts what is left when it stops, since nothing is watching those any more', async () => {
    const watcher = watcherWith(async () => []);
    const signal = watcher.signalFor(call);
    await watcher.stop();
    expect(signal.aborted).toBe(true);
  });

  it('forgets a finished call, so it stops reading and a later switch aborts nothing', async () => {
    const read = vi.fn<SwitchReader>(async () => []);
    const watcher = watcherWith(read);
    const signal = watcher.signalFor(call);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(read).toHaveBeenCalledTimes(1);
    watcher.release(signal);
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(read).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await watcher.stop();
  });

  it('watch forgets the call however it ends', async () => {
    const read = vi.fn<SwitchReader>(async () => []);
    const watcher = watcherWith(read);
    await expect(watcher.watch(call, async () => 'answer')).resolves.toBe('answer');
    await expect(
      watcher.watch(call, async () => {
        throw new Error('adapter failed');
      }),
    ).rejects.toThrow('adapter failed');
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(read).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it('stops a whole model call through watch, in a measured time', async () => {
    let live: readonly LiveSwitch[] = [];
    const watcher = watcherWith(async () => live);
    let abortedAfter = Number.NaN;
    const started = Date.now();
    const adapter = (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          abortedAfter = Date.now() - started;
          reject(signal.reason as Error);
        });
      });
    const turn = watcher.watch(call, adapter);
    const outcome = expect(turn).rejects.toEqual(halted);
    live = [global_];
    await vi.advanceTimersByTimeAsync(watcher.abortLimitMs);
    await outcome;
    expect(abortedAfter).toBeLessThanOrEqual(watcher.abortLimitMs);
    await watcher.stop();
  });

  it('never starts two polls at once', async () => {
    let running = 0;
    let most = 0;
    const read: SwitchReader = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, POLL * 2));
      running -= 1;
      return [];
    };
    const watcher = watcherWith(read, POLL * 5);
    watcher.signalFor(call);
    await vi.advanceTimersByTimeAsync(POLL * 20);
    expect(most).toBe(1);
    // A read is under way on the fake clock, and stopping waits for it.
    const stopped = watcher.stop();
    await vi.advanceTimersByTimeAsync(POLL * 5);
    await stopped;
  });

  it('logs codes and counts, never what a read failed on', async () => {
    const secret = 'postgres://user:hunter2@db/ensemus';
    const watcher = watcherWith(async () => {
      throw Object.assign(new Error(secret), { code: 'ECONNREFUSED' });
    });
    watcher.signalFor(call);
    await vi.advanceTimersByTimeAsync(POLL);
    const logged = JSON.stringify([quiet.warn.mock.calls, quiet.error.mock.calls]);
    expect(logged).toContain('ECONNREFUSED');
    expect(logged).not.toContain(secret);
    await watcher.stop();
  });

  it('refuses a poll interval that would never poll', () => {
    expect(() => createHaltWatcher({ pollMs: 0, read: async () => [], log: quiet })).toThrow(
      RangeError,
    );
  });

  it('has a poll interval for the wiring to use', () => {
    expect(HALT_POLL_MS).toBeGreaterThan(0);
  });
});

describe('the operator command', () => {
  const parse = (...argv: string[]) => parseHaltCommand(argv, PROVIDER_KINDS);

  it('takes the commands it documents', () => {
    expect(parse('engage', 'global', 'INCIDENT')).toEqual({
      kind: 'engage',
      input: { scope: 'global', reasonCode: 'INCIDENT' },
    });
    expect(parse('engage', 'provider', 'openai_hosted', 'INCIDENT')).toEqual({
      kind: 'engage',
      input: { scope: 'provider', providerKind: 'openai_hosted', reasonCode: 'INCIDENT' },
    });
    expect(parse('release', SWITCH)).toEqual({ kind: 'release', switchId: SWITCH });
    expect(parse('list')).toEqual({ kind: 'list' });
  });

  it('puts an ID in the spelling the database uses', () => {
    expect(parse('release', SWITCH.toUpperCase())).toEqual({ kind: 'release', switchId: SWITCH });
  });

  it.each([
    ['nothing', []],
    ['an unknown verb', ['stop', 'global', 'INCIDENT']],
    ['no reason', ['engage', 'global']],
    ['free text as a reason', ['engage', 'global', 'they said so']],
    ['a lower-case reason', ['engage', 'global', 'incident']],
    ['a tenant scope', ['engage', 'organization', 'INCIDENT']],
    ['an agent-version scope', ['engage', 'agent_version', VERSION, 'INCIDENT']],
    // A typed name that matches nothing would look like a stop and stop nothing.
    ['a provider that does not exist', ['engage', 'provider', 'opnai_hosted', 'INCIDENT']],
    ['no provider', ['engage', 'provider', 'INCIDENT']],
    ['something extra', ['engage', 'global', 'INCIDENT', 'extra']],
    ['a release with no ID', ['release']],
    ['a release of something that is no ID', ['release', 'all']],
    ['a list with an argument', ['list', 'all']],
  ])('refuses %s', (_name, argv) => {
    expect(parse(...argv)).toBeNull();
  });

  const ops = () => ({
    engage: vi.fn(async () => SWITCH),
    release: vi.fn(async () => undefined),
    list: vi.fn(async () => [
      {
        id: SWITCH,
        scope: 'provider',
        targetRef: 'openai_hosted',
        engagedAt: new Date('2026-11-06T00:00:00.000Z'),
      },
      {
        id: VERSION,
        scope: 'global',
        targetRef: null,
        engagedAt: new Date('2026-11-06T00:00:01Z'),
      },
    ]),
  });

  const run = async (command: HaltCommand, operations = ops()) => {
    const written: string[] = [];
    await runHaltCommand(command, operations, (text) => written.push(text));
    return { output: written.join(''), operations };
  };

  it("prints the switch's ID and nothing else", async () => {
    const { output, operations } = await run({
      kind: 'engage',
      input: { scope: 'global', reasonCode: 'INCIDENT' },
    });
    expect(output).toBe(`${SWITCH}\n`);
    expect(operations.engage).toHaveBeenCalledWith({ scope: 'global', reasonCode: 'INCIDENT' });
  });

  it('prints the same on a release', async () => {
    const { output, operations } = await run({ kind: 'release', switchId: SWITCH });
    expect(output).toBe(`${SWITCH}\n`);
    expect(operations.release).toHaveBeenCalledWith(SWITCH);
  });

  it('lists one switch to a line, for a person to pick an ID from', async () => {
    const { output } = await run({ kind: 'list' });
    expect(output).toBe(
      `${SWITCH}\tprovider\topenai_hosted\t2026-11-06T00:00:00.000Z\n` +
        `${VERSION}\tglobal\t-\t2026-11-06T00:00:01.000Z\n`,
    );
  });

  it('prints no ID for a stop that failed, so a failure cannot look like a stop', async () => {
    const failing = { ...ops(), engage: vi.fn(() => Promise.reject(new Error('refused'))) };
    const written: string[] = [];
    await expect(
      runHaltCommand(
        { kind: 'engage', input: { scope: 'global', reasonCode: 'INCIDENT' } },
        failing,
        (text) => written.push(text),
      ),
    ).rejects.toThrow('refused');
    expect(written).toEqual([]);
  });

  it('reaches only the database: its entry point names nothing with a network of its own', () => {
    const source = readFileSync(new URL('./halt-global.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort();
    expect(imports).toEqual([
      './kill-switch',
      '@ensemus/config',
      '@ensemus/database/halt-operator',
      '@ensemus/domain/ai',
      '@ensemus/telemetry',
    ]);
    expect(source).not.toMatch(/\bfetch\(|TEMPORAL|createLogger\('halt-global'\)\s*;/);
  });

  it('keeps stdout to the ID: its log goes to stderr', () => {
    const source = readFileSync(new URL('./halt-global.ts', import.meta.url), 'utf8');
    expect(source).toContain('process.stderr.write');
    expect(source.match(/process\.stdout\.write/g)).toHaveLength(1);
  });

  it('asks for nothing but the migrator role, to run where only the database is up', () => {
    const source = readFileSync(new URL('./halt-global.ts', import.meta.url), 'utf8');
    expect([...source.matchAll(/readSecret\('([A-Z_]+)'\)/g)].map((match) => match[1])).toEqual([
      'DATABASE_URL_MIGRATOR',
    ]);
  });
});
