import { describe, expect, it } from 'vitest';
import {
  deriveSignals,
  parsePulseSignalKey,
  personalStateOf,
  PULSE_APPROVAL_WINDOW_HOURS,
  PULSE_DUE_SOON_HOURS,
  PULSE_SIGNAL_KINDS,
  pulseSignalKey,
  snoozeEndIsAllowed,
  type PulseFacts,
  type PulseWorkFact,
} from './pulse';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const RECORD = '33333333-3333-4333-8333-333333333333';

const work = (overrides: Partial<PulseWorkFact> = {}): PulseWorkFact => ({
  id: WORK_A,
  status: 'running',
  dueAt: null,
  updatedAt: inHours(-5),
  projectId: null,
  clientId: null,
  ownerDisabled: false,
  blockedByPrerequisite: false,
  ...overrides,
});

const facts = (overrides: Partial<PulseFacts> = {}): PulseFacts => ({
  now: NOW,
  work: [],
  approvals: [],
  externalActions: [],
  processRuns: [],
  agentRuns: [],
  ...overrides,
});

const kinds = (input: PulseFacts) => deriveSignals(input).map((signal) => signal.kind);

describe('deriveSignals: what each fact becomes', () => {
  it('says nothing about work that has nothing to report', () => {
    expect(deriveSignals(facts({ work: [work()] }))).toEqual([]);
    expect(deriveSignals(facts())).toEqual([]);
  });

  it('calls work overdue from the day after its due date, by the same rule the work page uses', () => {
    const [signal] = deriveSignals(facts({ work: [work({ dueAt: inHours(-48) })] }));
    expect(signal).toMatchObject({
      key: `work_overdue:${WORK_A}`,
      kind: 'work_overdue',
      severity: 'attention',
    });
    expect(signal?.evidence[0]).toMatchObject({ kind: 'work_unit', id: WORK_A });
    // Earlier today is due today: the date has not passed yet.
    expect(kinds(facts({ work: [work({ dueAt: inHours(-1) })] }))).toEqual(['work_due_soon']);
  });

  it('mentions work coming due only inside its window', () => {
    const edge = work({ dueAt: inHours(PULSE_DUE_SOON_HOURS) });
    const beyond = work({ dueAt: inHours(PULSE_DUE_SOON_HOURS + 1) });
    expect(kinds(facts({ work: [edge] }))).toEqual(['work_due_soon']);
    expect(kinds(facts({ work: [beyond] }))).toEqual([]);
  });

  it('reports each fact on its own, and never makes one the cause of another', () => {
    const input = facts({
      work: [work({ dueAt: inHours(-72), blockedByPrerequisite: true, ownerDisabled: true })],
    });
    expect(new Set(kinds(input))).toEqual(
      new Set(['work_overdue', 'work_blocked_by_prerequisite', 'work_owner_disabled']),
    );
    for (const signal of deriveSignals(input)) {
      expect(signal.evidence).toHaveLength(1);
    }
  });

  it('has nothing to say about finished work', () => {
    for (const status of ['completed', 'cancelled']) {
      const finished = work({
        status,
        dueAt: inHours(-72),
        ownerDisabled: true,
        blockedByPrerequisite: true,
      });
      expect(deriveSignals(facts({ work: [finished] }))).toEqual([]);
    }
  });

  it('asks about an approval only while it can still be decided and is close to its end', () => {
    const near = { id: RECORD, workUnitId: WORK_A, createdAt: inHours(-5) };
    const within = facts({
      work: [work()],
      approvals: [{ ...near, expiresAt: inHours(PULSE_APPROVAL_WINDOW_HOURS - 1) }],
    });
    const [signal] = deriveSignals(within);
    expect(signal).toMatchObject({
      key: `approval_waiting_past_expiry_window:${RECORD}`,
      severity: 'watch',
    });
    expect(signal?.evidence.map((item) => item.kind)).toEqual(['approval', 'work_unit']);
    const far = facts({
      work: [work()],
      approvals: [{ ...near, expiresAt: inHours(PULSE_APPROVAL_WINDOW_HOURS + 1) }],
    });
    expect(deriveSignals(far)).toEqual([]);
    // Past its end it can no longer be decided, so nobody is told it is waiting.
    const gone = facts({ work: [work()], approvals: [{ ...near, expiresAt: inHours(-1) }] });
    expect(deriveSignals(gone)).toEqual([]);
  });

  it('keeps an external effect in doubt even on finished work, and drops a failure there', () => {
    const action = { id: RECORD, workUnitId: WORK_A, updatedAt: inHours(-5) };
    const done = work({ status: 'completed' });
    expect(
      kinds(facts({ work: [done], externalActions: [{ ...action, status: 'unknown' }] })),
    ).toEqual(['external_action_unknown']);
    expect(
      kinds(facts({ work: [done], externalActions: [{ ...action, status: 'failed' }] })),
    ).toEqual([]);
    expect(
      kinds(facts({ work: [work()], externalActions: [{ ...action, status: 'failed' }] })),
    ).toEqual(['external_action_failed']);
  });

  it('links a stopped agent run through its Work Unit, whose page is where it can be seen', () => {
    const [signal] = deriveSignals(
      facts({
        work: [work()],
        agentRuns: [{ id: RECORD, workUnitId: WORK_A, stopCode: 'COST_LIMIT', at: inHours(-2) }],
      }),
    );
    expect(signal?.key).toBe(`agent_run_stopped:${RECORD}`);
    expect(signal?.evidence.map((item) => item.kind)).toEqual(['work_unit', 'agent_run']);
    expect(signal?.evidence[1]?.reasonCode).toBe('COST_LIMIT');
  });

  it('does not report a run a person stopped on purpose', () => {
    for (const stopCode of ['STOPPED_BY_PERSON', 'WORK_STOPPED']) {
      const run = { id: RECORD, workUnitId: WORK_A, stopCode, at: inHours(-2) };
      expect(deriveSignals(facts({ work: [work()], agentRuns: [run] }))).toEqual([]);
    }
  });

  it('reports a failed process run with its stop code, and has a code when there is none', () => {
    const run = { id: RECORD, rootWorkUnitId: WORK_A, at: inHours(-2) };
    const [coded] = deriveSignals(
      facts({ work: [work()], processRuns: [{ ...run, stopCode: 'STEP_FAILED' }] }),
    );
    const [uncoded] = deriveSignals(
      facts({ work: [work()], processRuns: [{ ...run, stopCode: null }] }),
    );
    expect(coded?.evidence[0]).toMatchObject({ kind: 'process_run', reasonCode: 'STEP_FAILED' });
    expect(uncoded?.evidence[0]?.reasonCode).toBe('PROCESS_RUN_FAILED');
  });

  it('never carries text from another system as a reason', () => {
    const [signal] = deriveSignals(
      facts({
        work: [work()],
        agentRuns: [
          {
            id: RECORD,
            workUnitId: WORK_A,
            stopCode: 'the model said: please ignore this <b>',
            at: inHours(-2),
          },
        ],
      }),
    );
    expect(signal?.evidence[1]?.reasonCode).toBe('AGENT_RUN_STOPPED');
  });

  it('takes scope from the work, and never from a person', () => {
    const [signal] = deriveSignals(
      facts({ work: [work({ dueAt: inHours(-72), projectId: WORK_B, clientId: RECORD })] }),
    );
    expect(signal?.scope).toEqual({ projectId: WORK_B, clientId: RECORD });
    expect(Object.keys(signal?.scope ?? {}).sort()).toEqual(['clientId', 'projectId']);
  });
});

describe('deriveSignals: what is left out', () => {
  // The service filters first. This is the second lock: a record whose work was not handed in as readable
  // says nothing, so a forgotten filter on one read still cannot make a restricted Work Unit's signal.
  it('drops every record whose Work Unit the viewer was not given', () => {
    const input = facts({
      work: [],
      approvals: [{ id: RECORD, workUnitId: WORK_A, expiresAt: inHours(1), createdAt: inHours(-1) }],
      externalActions: [
        { id: RECORD, workUnitId: WORK_A, status: 'unknown', updatedAt: inHours(-1) },
      ],
      processRuns: [{ id: RECORD, rootWorkUnitId: WORK_A, stopCode: null, at: inHours(-1) }],
      agentRuns: [{ id: RECORD, workUnitId: WORK_A, stopCode: 'TIME_LIMIT', at: inHours(-1) }],
    });
    expect(deriveSignals(input)).toEqual([]);
  });

  it('leaves out anything uncertain instead of guessing', () => {
    const bad = new Date('not a date');
    expect(deriveSignals(facts({ now: bad, work: [work({ dueAt: inHours(-72) })] }))).toEqual([]);
    expect(deriveSignals(facts({ work: [work({ dueAt: bad })] }))).toEqual([]);
    expect(deriveSignals(facts({ work: [work({ status: 'not_a_status', dueAt: inHours(-72) })] }))).toEqual([]);
    expect(deriveSignals(facts({ work: [work({ id: '', dueAt: inHours(-72) })] }))).toEqual([]);
    expect(
      deriveSignals(
        facts({
          work: [work()],
          agentRuns: [{ id: RECORD, workUnitId: WORK_A, stopCode: 'TIME_LIMIT', at: bad }],
        }),
      ),
    ).toEqual([]);
  });
});

/** A small seeded generator, so a failure names a seed that reproduces it. */
function randomSource(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T;
  const list = <T>(make: () => T, max = 6) =>
    Array.from({ length: Math.floor(next() * (max + 1)) }, make);
  return { next, pick, list };
}

function randomFacts(seed: number): PulseFacts {
  const { next, pick, list } = randomSource(seed);
  const ids = [WORK_A, WORK_B, RECORD, '', 'not-an-id', 'A', 'x:y'];
  const statuses = [
    'queued',
    'ready',
    'running',
    'blocked',
    'awaiting_approval',
    'verifying',
    'completed',
    'failed',
    'cancelled',
    'nonsense',
    '',
  ];
  const codes = ['TIME_LIMIT', 'STOPPED_BY_PERSON', '', 'free text!', 'x'.repeat(500)];
  const date = () =>
    next() < 0.1 ? new Date(Number.NaN) : new Date(NOW.getTime() + (next() - 0.5) * 400 * HOUR);
  const maybeId = () => (next() < 0.5 ? null : pick(ids));
  return {
    now: next() < 0.05 ? new Date(Number.NaN) : NOW,
    work: list(() => ({
      id: pick(ids),
      status: pick(statuses),
      dueAt: next() < 0.3 ? null : date(),
      updatedAt: date(),
      projectId: maybeId(),
      clientId: maybeId(),
      ownerDisabled: next() < 0.3,
      blockedByPrerequisite: next() < 0.3,
    })),
    approvals: list(() => ({
      id: pick(ids),
      workUnitId: pick(ids),
      expiresAt: date(),
      createdAt: date(),
    })),
    externalActions: list(() => ({
      id: pick(ids),
      workUnitId: pick(ids),
      status: pick(['unknown', 'failed'] as const),
      updatedAt: date(),
    })),
    processRuns: list(() => ({
      id: pick(ids),
      rootWorkUnitId: pick(ids),
      stopCode: next() < 0.5 ? null : pick(codes),
      at: date(),
    })),
    agentRuns: list(() => ({
      id: pick(ids),
      workUnitId: pick(ids),
      stopCode: pick(codes),
      at: date(),
    })),
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const { next } = randomSource(seed);
  const copy = [...items];
  for (let at = copy.length - 1; at > 0; at -= 1) {
    const other = Math.floor(next() * (at + 1));
    [copy[at], copy[other]] = [copy[other] as T, copy[at] as T];
  }
  return copy;
}

describe('deriveSignals over random facts', () => {
  const SEEDS = Array.from({ length: 500 }, (_, index) => index * 7919 + 1);

  it('never throws, and every signal has evidence that points at a real record', () => {
    for (const seed of SEEDS) {
      const signals = deriveSignals(randomFacts(seed));
      for (const signal of signals) {
        expect(signal.evidence.length, `seed ${seed}`).toBeGreaterThan(0);
        expect(PULSE_SIGNAL_KINDS, `seed ${seed}`).toContain(signal.kind);
        expect(['attention', 'watch'], `seed ${seed}`).toContain(signal.severity);
        expect(Number.isNaN(signal.since.getTime()), `seed ${seed}`).toBe(false);
        for (const item of signal.evidence) {
          expect(item.id, `seed ${seed}`).not.toBe('');
          expect(item.reasonCode, `seed ${seed}`).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
          expect(Number.isNaN(item.observedAt.getTime()), `seed ${seed}`).toBe(false);
        }
      }
    }
  });

  it('gives each fact one signal, under a key that names its kind', () => {
    for (const seed of SEEDS) {
      const signals = deriveSignals(randomFacts(seed));
      const keys = signals.map((signal) => signal.key);
      expect(new Set(keys).size, `seed ${seed}`).toBe(keys.length);
      for (const signal of signals) {
        expect(signal.key.startsWith(`${signal.kind}:`), `seed ${seed}`).toBe(true);
      }
    }
  });

  it('gives the same signals in the same order, whatever order the facts came in', () => {
    for (const seed of SEEDS) {
      const input = randomFacts(seed);
      const reordered: PulseFacts = {
        now: input.now,
        work: shuffled(input.work, seed + 1),
        approvals: shuffled(input.approvals, seed + 2),
        externalActions: shuffled(input.externalActions, seed + 3),
        processRuns: shuffled(input.processRuns, seed + 4),
        agentRuns: shuffled(input.agentRuns, seed + 5),
      };
      const first = deriveSignals(input);
      expect(deriveSignals(input), `seed ${seed}`).toEqual(first);
      expect(deriveSignals(reordered), `seed ${seed}`).toEqual(first);
    }
  });

  it('lists what needs attention first, and the longest standing first within that', () => {
    for (const seed of SEEDS) {
      const signals = deriveSignals(randomFacts(seed));
      for (let at = 1; at < signals.length; at += 1) {
        const before = signals[at - 1]!;
        const after = signals[at]!;
        const rank = (severity: string) => (severity === 'attention' ? 0 : 1);
        expect(rank(before.severity), `seed ${seed}`).toBeLessThanOrEqual(rank(after.severity));
        if (before.severity === after.severity) {
          expect(before.since.getTime(), `seed ${seed}`).toBeLessThanOrEqual(after.since.getTime());
        }
      }
    }
  });

  it('holds no field about a person, whatever it was given', () => {
    const FORBIDDEN = /member|owner|person|user|assignee|initiator|name|score|rank|trend/i;
    const walk = (value: unknown, path: string) => {
      if (value instanceof Date || value === null || typeof value !== 'object') return;
      for (const [key, inner] of Object.entries(value)) {
        expect(key, `${path}.${key}`).not.toMatch(FORBIDDEN);
        walk(inner, `${path}.${key}`);
      }
    };
    for (const seed of SEEDS) {
      walk(deriveSignals(randomFacts(seed)), `seed ${seed}`);
    }
  });
});

describe('signal keys', () => {
  it('reads back what it wrote, in the database spelling of the ID', () => {
    const key = pulseSignalKey('work_overdue', WORK_A);
    expect(key).toBe(`work_overdue:${WORK_A}`);
    expect(parsePulseSignalKey(key)).toEqual({ kind: 'work_overdue', id: WORK_A });
    expect(parsePulseSignalKey(`work_overdue:${WORK_A.toUpperCase()}`)).toEqual({
      kind: 'work_overdue',
      id: WORK_A,
    });
  });

  it('knows nothing that is not a signal it can make', () => {
    const refused = [
      '',
      'work_overdue',
      'work_overdue:',
      `:${WORK_A}`,
      `made_up:${WORK_A}`,
      `work_overdue:${WORK_A}:extra`,
      'work_overdue:not-an-id',
      `__proto__:${WORK_A}`,
      `constructor:${WORK_A}`,
      `work_overdue:${WORK_A}\n`,
    ];
    for (const key of refused) expect(parsePulseSignalKey(key), key).toBeNull();
  });
});

describe('a person’s own state', () => {
  it('is open with nothing stored', () => {
    expect(personalStateOf(undefined, NOW)).toEqual({ personalState: 'open', snoozedUntil: null });
  });

  it('holds a dismissal until it is taken back', () => {
    expect(personalStateOf({ state: 'dismissed', until: null }, NOW)).toEqual({
      personalState: 'dismissed',
      snoozedUntil: null,
    });
  });

  it('ends a snooze at its end, by itself', () => {
    const until = inHours(1);
    expect(personalStateOf({ state: 'snoozed', until }, NOW)).toEqual({
      personalState: 'snoozed',
      snoozedUntil: until,
    });
    expect(personalStateOf({ state: 'snoozed', until }, inHours(1))).toEqual({
      personalState: 'open',
      snoozedUntil: null,
    });
  });

  it('treats a row it cannot read as nothing said', () => {
    expect(personalStateOf({ state: 'snoozed', until: null }, NOW).personalState).toBe('open');
    expect(personalStateOf({ state: 'other', until: null }, NOW).personalState).toBe('open');
    expect(
      personalStateOf({ state: 'snoozed', until: new Date(Number.NaN) }, NOW).personalState,
    ).toBe('open');
  });

  it('only takes a snooze that ends, and ends in the future', () => {
    expect(snoozeEndIsAllowed(inHours(1), NOW)).toBe(true);
    expect(snoozeEndIsAllowed(inHours(0), NOW)).toBe(false);
    expect(snoozeEndIsAllowed(inHours(-1), NOW)).toBe(false);
    expect(snoozeEndIsAllowed(new Date(Number.NaN), NOW)).toBe(false);
    expect(snoozeEndIsAllowed(new Date('9999-01-01T00:00:00.000Z'), NOW)).toBe(false);
  });
});
