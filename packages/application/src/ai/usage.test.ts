// The ledger's rules, against an in-memory store that makes the same promises the SQL makes: a conditional
// update is atomic, a savepoint rolls back, and a unique key holds. The SQL itself is proved as the real
// roles in tests/integration/ai-usage.test.ts. People's side of budgets (budget.ts) is tested here too.
import { randomUUID } from 'node:crypto';
import type { SetBudget } from '@ensemus/contracts/ai';
import type { AgentContext, AppDatabase, TenantContext, Tx } from '@ensemus/database';
import { modelLedgerKey } from '@ensemus/domain/ai';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import {
  diagnoseStop,
  getStopDiagnostics,
  getUsageSummary,
  listBudgets,
  periodRange,
  setBudget,
  summarizeUsage,
} from './budget';
import type { LedgerEntry, UsageLedger } from './ports';
import {
  billingPeriodOf,
  closeRunReservationsOver,
  costMicros,
  isBillable,
  ledgerOver,
  lostAnswerEntry,
  recordLostAnswer,
  reservationFate,
  type BudgetRow,
  type HeldReservationRow,
  type LedgerFacts,
  type LedgerRow,
  type LedgerStore,
  type ReservationRow,
  type RunFacts,
} from './usage';

const ORG = randomUUID();
const RUN = randomUUID();
const VERSION = randomUUID();
const WORK = randomUUID();
const NOW = new Date('2026-11-06T12:00:00Z');
const PERIOD = '2026-11';
const tx = {} as Tx;

const context = {
  organizationId: ORG,
  userId: randomUUID(),
  membershipId: randomUUID(),
  role: 'owner',
  actorType: 'agent',
  agentRunId: RUN,
} as unknown as AgentContext;

type Step = { stepNumber: number; state: string; attempt: number; kind: string };

/** Holds to what the database holds to. Anything else here would prove a double, and not the rules. */
class MemoryStore implements LedgerStore {
  budgets: (BudgetRow & { period: string; agentVersionId: string | null })[] = [];
  reservations: ReservationRow[] = [];
  ledger: LedgerRow[] = [];
  steps = new Map<string, Step>();
  counterMicros = 0;
  facts: Partial<LedgerFacts> = {};
  run: Partial<RunFacts> | null = {};
  #turn: Promise<unknown> = Promise.resolve();

  async budgetsThatApply(
    _tx: Tx,
    query: { organizationId: string; agentVersionId: string; period: string },
  ) {
    return this.budgets
      .filter(
        (row) =>
          row.period === query.period &&
          (row.agentVersionId === null || row.agentVersionId === query.agentVersionId),
      )
      .map((row) => ({ ...row }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async runFacts(_tx: Tx, query: { runId: string }): Promise<RunFacts | null> {
    if (query.runId !== RUN || this.run === null) return null;
    return {
      agentVersionId: VERSION,
      workUnitId: WORK,
      costMicros: this.counterMicros,
      boundProfileId: null,
      boundProfileVersion: null,
      providerKind: null,
      ...this.run,
    };
  }

  async reservationsOfAttempt(_tx: Tx, query: { stepId: string; attempt: number }) {
    return this.reservations
      .filter((row) => row.stepId === query.stepId && row.attempt === query.attempt)
      .map((row) => ({ ...row }))
      .sort((a, b) => a.budgetId.localeCompare(b.budgetId));
  }

  /** One at a time, as two writers on one budget row wait for each other's lock. */
  async allOrNothing<T>(inner: Tx, fn: (savepoint: Tx) => Promise<T>): Promise<T> {
    const attempt = async () => {
      const saved = {
        budgets: this.budgets.map((row) => ({ ...row })),
        reservations: this.reservations.map((row) => ({ ...row })),
      };
      try {
        return await fn(inner);
      } catch (error) {
        Object.assign(this, saved);
        throw error;
      }
    };
    const result = this.#turn.then(attempt, attempt);
    this.#turn = result.catch(() => undefined);
    return result;
  }

  async insertReservation(_tx: Tx, row: Omit<ReservationRow, 'id' | 'status'>) {
    const taken = this.reservations.some(
      (held) =>
        held.budgetId === row.budgetId &&
        held.stepId === row.stepId &&
        held.attempt === row.attempt,
    );
    if (taken) return null;
    const id = randomUUID();
    this.reservations.push({ ...row, id, status: 'held' });
    return id;
  }

  async takeHeadroom(_tx: Tx, query: { budgetId: string; amountMicros: number }) {
    const row = this.budgets.find((budget) => budget.id === query.budgetId);
    if (!row) return false;
    if (row.reservedMicros + row.spentMicros + query.amountMicros > row.limitMicros) return false;
    row.reservedMicros += query.amountMicros;
    return true;
  }

  async lockReservationGroup(_tx: Tx, query: { reservationId: string; runId: string }) {
    const head = this.reservations.find(
      (row) => row.id === query.reservationId && row.runId === query.runId,
    );
    if (!head) return [];
    return this.reservationsOfAttempt(tx, { stepId: head.stepId, attempt: head.attempt });
  }

  async closeReservation(_tx: Tx, query: { id: string; status: 'settled' | 'released' }) {
    const row = this.reservations.find((held) => held.id === query.id);
    if (row) row.status = query.status;
  }

  async moveMoney(
    _tx: Tx,
    query: { budgetId: string; releaseMicros: number; spendMicros: number },
  ) {
    const row = this.budgets.find((budget) => budget.id === query.budgetId);
    if (!row) throw new Error('no such budget');
    row.reservedMicros -= query.releaseMicros;
    row.spentMicros += query.spendMicros;
  }

  async ledgerFacts(
    _tx: Tx,
    query: { reservationId: string | null; rateCardId: string | null; profileId: string | null },
  ): Promise<LedgerFacts> {
    let reservationPeriod: string | null = null;
    if (query.reservationId) {
      const held = this.reservations.find((row) => row.id === query.reservationId);
      const budget = this.budgets.find((row) => row.id === held?.budgetId);
      reservationPeriod = budget?.period ?? null;
    }
    return {
      commercialMode: 'byom',
      billingOwner: query.profileId ? 'customer' : null,
      reservationPeriod,
      rateCardVersion: query.rateCardId ? 3 : null,
      ...this.facts,
    };
  }

  async insertLedger(_tx: Tx, row: LedgerRow) {
    if (this.ledger.some((held) => held.idempotencyKey === row.idempotencyKey)) return false;
    this.ledger.push(row);
    return true;
  }

  async ledgerTotal() {
    return this.ledger.reduce((sum, row) => sum + row.costMicros, 0);
  }

  async heldOfRun(_tx: Tx, query: { runId: string }): Promise<HeldReservationRow[]> {
    return this.reservations
      .filter((row) => row.runId === query.runId && row.status === 'held')
      .map((row) => {
        const step = this.steps.get(row.stepId) ?? {
          stepNumber: 0,
          state: 'in_flight',
          attempt: row.attempt,
          kind: 'model_turn',
        };
        return {
          ...row,
          stepNumber: step.stepNumber,
          stepState: step.state,
          stepAttempt: step.attempt,
          stepKind: step.kind,
        };
      });
  }
}

const inMemory = (store: MemoryStore): UsageLedger =>
  ledgerOver(store, { inTenant: (_context, fn) => fn(tx), now: () => NOW });

const orgBudget = (limitMicros: number, over: Partial<BudgetRow> = {}) => ({
  id: randomUUID(),
  period: PERIOD,
  agentVersionId: null,
  limitMicros,
  reservedMicros: 0,
  spentMicros: 0,
  ...over,
});

const reservation = (over: Record<string, unknown> = {}) => ({
  runId: RUN,
  stepId: randomUUID(),
  attempt: 1,
  agentVersionId: VERSION,
  amountMicros: 100,
  ...over,
});

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  idempotencyKey: modelLedgerKey(RUN, 1, 1),
  meter: 'model_input_tokens',
  quantity: 10,
  unit: 'token',
  costMicros: 20,
  rateCardId: randomUUID(),
  rateCardVersion: 3,
  reservationId: null,
  workUnitId: WORK,
  runId: RUN,
  stepId: null,
  profileId: null,
  profileVersion: null,
  providerKind: null,
  requestHash: null,
  status: 'final',
  ...over,
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'no error',
    (error: unknown) => (error instanceof AppError ? error.code : String(error)),
  );

describe('costMicros', () => {
  const rate = { inputMicrosPerMtok: 1_000_000, outputMicrosPerMtok: 3_000_000 };

  it('charges each meter from its own rate', () => {
    expect(costMicros({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, rate)).toBe(4_000_000);
    expect(costMicros({ inputTokens: 1000, outputTokens: 0 }, rate)).toBe(1000);
    expect(costMicros({ inputTokens: 0, outputTokens: 0 }, rate)).toBe(0);
  });

  it('rounds up, so one token at a tiny rate still costs something', () => {
    expect(
      costMicros(
        { inputTokens: 1, outputTokens: 0 },
        { inputMicrosPerMtok: 1, outputMicrosPerMtok: 1 },
      ),
    ).toBe(1);
    // 1.5 and 1.5 round up on each meter, which is what lets one meter's row be checked alone.
    expect(
      costMicros(
        { inputTokens: 3, outputTokens: 3 },
        { inputMicrosPerMtok: 500_000, outputMicrosPerMtok: 500_000 },
      ),
    ).toBe(4);
  });

  it('stays exact where a float would not', () => {
    // 2^53 + 1 is not a float, so this product only comes out right in whole numbers.
    expect(
      costMicros(
        { inputTokens: 9_007_199_254, outputTokens: 0 },
        { inputMicrosPerMtok: 1_000_001, outputMicrosPerMtok: 0 },
      ),
    ).toBe(9_007_208_262);
  });

  it('refuses anything that is not a whole, non-negative amount', () => {
    for (const usage of [
      { inputTokens: -1, outputTokens: 0 },
      { inputTokens: 0.5, outputTokens: 0 },
      { inputTokens: Number.NaN, outputTokens: 0 },
      { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
    ]) {
      expect(() => costMicros(usage, rate)).toThrow(RangeError);
    }
    expect(() =>
      costMicros(
        { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
        { inputMicrosPerMtok: Number.MAX_SAFE_INTEGER, outputMicrosPerMtok: 0 },
      ),
    ).toThrow(RangeError);
  });
});

describe('billing period and who pays', () => {
  it('is the UTC month', () => {
    expect(billingPeriodOf(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
    expect(billingPeriodOf(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01');
  });

  it('bills only an Ensemus-owned profile in Cloud, so a customer is never charged twice (QA-027)', () => {
    expect(isBillable('cloud', 'ensemus')).toBe(true);
    expect(isBillable('cloud', 'customer')).toBe(false);
    expect(isBillable('byom', 'customer')).toBe(false);
    expect(isBillable('byom', 'ensemus')).toBe(false);
    expect(isBillable('sovereign', 'customer')).toBe(false);
    expect(isBillable('cloud', null)).toBe(false);
  });
});

describe('reserve', () => {
  it('denies with no budget at all, and has no default to fall back on', async () => {
    const store = new MemoryStore();
    await expect(inMemory(store).reserve(tx, context, reservation())).resolves.toEqual({
      ok: false,
      code: 'BUDGET_NOT_CONFIGURED',
    });
    expect(store.reservations).toEqual([]);
  });

  it('denies when the only budget is for another month', async () => {
    const store = new MemoryStore();
    store.budgets.push({ ...orgBudget(1000), period: '2026-10' });
    await expect(inMemory(store).reserve(tx, context, reservation())).resolves.toEqual({
      ok: false,
      code: 'BUDGET_NOT_CONFIGURED',
    });
  });

  it('holds the amount on every budget that applies', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000), { ...orgBudget(500), agentVersionId: VERSION });
    const held = await inMemory(store).reserve(tx, context, reservation());
    expect(held).toMatchObject({ ok: true, amountMicros: 100 });
    expect(store.budgets.map((row) => row.reservedMicros)).toEqual([100, 100]);
    expect(store.reservations).toHaveLength(2);
  });

  it('takes nothing from any budget when one of them is exhausted', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000, { id: '00000000-0000-4000-8000-000000000001' }), {
      ...orgBudget(50, { id: '00000000-0000-4000-8000-000000000002' }),
      agentVersionId: VERSION,
    });
    await expect(inMemory(store).reserve(tx, context, reservation())).resolves.toEqual({
      ok: false,
      code: 'BUDGET_EXHAUSTED',
    });
    // The caller commits this transaction, so the first budget's hold must not survive.
    expect(store.budgets.map((row) => row.reservedMicros)).toEqual([0, 0]);
    expect(store.reservations).toEqual([]);
  });

  it('lets one of two reservations have the last of the headroom', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(100));
    const ledger = inMemory(store);
    const answers = await Promise.all([
      ledger.reserve(tx, context, reservation()),
      ledger.reserve(tx, context, reservation()),
    ]);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.filter((answer) => !answer.ok)).toEqual([
      { ok: false, code: 'BUDGET_EXHAUSTED' },
    ]);
    expect(store.budgets[0]?.reservedMicros).toBe(100);
  });

  it('counts what is already spent and reserved against the limit', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(100, { spentMicros: 60, reservedMicros: 30 }));
    const ledger = inMemory(store);
    await expect(ledger.reserve(tx, context, reservation())).resolves.toMatchObject({ ok: false });
    await expect(
      ledger.reserve(tx, context, reservation({ amountMicros: 10 })),
    ).resolves.toMatchObject({ ok: true });
  });

  it('holds once for one step and attempt, however many times it is asked', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const request = reservation();
    const first = await ledger.reserve(tx, context, request);
    const second = await ledger.reserve(tx, context, request);
    expect(second).toEqual(first);
    expect(store.budgets[0]?.reservedMicros).toBe(100);
  });

  it('refuses a reservation for a closed attempt, rather than let a call run with no hold', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const request = reservation();
    const held = await ledger.reserve(tx, context, request);
    if (!held.ok) throw new Error('expected a hold');
    await ledger.release(tx, context, held.reservationId);
    expect(await code(ledger.reserve(tx, context, request))).toBe('INVALID_STATE');
  });

  it('refuses amounts that are not whole micros', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    for (const amountMicros of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await code(ledger.reserve(tx, context, reservation({ amountMicros })))).toBe(
        'INVALID_INPUT',
      );
    }
  });

  it('refuses another run, another version, and a person', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    expect(await code(ledger.reserve(tx, context, reservation({ runId: randomUUID() })))).toBe(
      'FORBIDDEN',
    );
    // Naming a different version is how a run would slip past that version's own budget.
    expect(
      await code(ledger.reserve(tx, context, reservation({ agentVersionId: randomUUID() }))),
    ).toBe('INVALID_INPUT');
    const person = { ...context, actorType: 'user' } as unknown as AgentContext;
    expect(await code(ledger.reserve(tx, person, reservation()))).toBe('FORBIDDEN');
    store.run = null;
    expect(await code(ledger.reserve(tx, context, reservation()))).toBe('NOT_FOUND');
  });

  it('allows a zero hold on a budget with room, and refuses it on one already overspent', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(10, { spentMicros: 11 }));
    await expect(
      inMemory(store).reserve(tx, context, reservation({ amountMicros: 0 })),
    ).resolves.toEqual({ ok: false, code: 'BUDGET_EXHAUSTED' });
  });
});

describe('headroom', () => {
  it('is null with no budget, and the smallest of those that apply otherwise', async () => {
    const store = new MemoryStore();
    const ledger = inMemory(store);
    const query = { runId: RUN, agentVersionId: VERSION };
    await expect(ledger.headroom(context, query)).resolves.toEqual({ availableMicros: null });
    store.budgets.push(orgBudget(1000, { spentMicros: 100 }), {
      ...orgBudget(500, { reservedMicros: 50 }),
      agentVersionId: VERSION,
    });
    await expect(ledger.headroom(context, query)).resolves.toEqual({ availableMicros: 450 });
  });

  it('reads as nothing left, and not as a negative, after an overspend', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(10, { spentMicros: 15 }));
    await expect(
      inMemory(store).headroom(context, { runId: RUN, agentVersionId: VERSION }),
    ).resolves.toEqual({ availableMicros: 0 });
  });
});

describe('settle and release', () => {
  const held = async (store: MemoryStore, ledger: UsageLedger, amountMicros = 100) => {
    const answer = await ledger.reserve(tx, context, reservation({ amountMicros }));
    if (!answer.ok) throw new Error('expected a hold');
    return answer.reservationId;
  };

  it('moves what was held to what was spent, and frees what was not used', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const reservationId = await held(store, ledger);
    await ledger.settle(tx, context, { reservationId, actualMicros: 30 });
    expect(store.budgets[0]).toMatchObject({ reservedMicros: 0, spentMicros: 30 });
    expect(store.reservations[0]?.status).toBe('settled');
  });

  it('may overspend, because it records what happened', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(100));
    const ledger = inMemory(store);
    const reservationId = await held(store, ledger);
    await ledger.settle(tx, context, { reservationId, actualMicros: 900 });
    expect(store.budgets[0]).toMatchObject({ reservedMicros: 0, spentMicros: 900 });
  });

  it('settles every budget the reservation held', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000), { ...orgBudget(500), agentVersionId: VERSION });
    const ledger = inMemory(store);
    const reservationId = await held(store, ledger);
    await ledger.settle(tx, context, { reservationId, actualMicros: 70 });
    expect(store.budgets.map((row) => [row.reservedMicros, row.spentMicros])).toEqual([
      [0, 70],
      [0, 70],
    ]);
  });

  it('counts a retried settlement once', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const reservationId = await held(store, ledger);
    await ledger.settle(tx, context, { reservationId, actualMicros: 30 });
    await ledger.settle(tx, context, { reservationId, actualMicros: 30 });
    expect(store.budgets[0]).toMatchObject({ reservedMicros: 0, spentMicros: 30 });
  });

  it('frees the whole hold on cancel, and only once', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const reservationId = await held(store, ledger);
    await ledger.release(tx, context, reservationId);
    await ledger.release(tx, context, reservationId);
    expect(store.budgets[0]).toMatchObject({ reservedMicros: 0, spentMicros: 0 });
    expect(store.reservations[0]?.status).toBe('released');
  });

  it('does not take back what a settlement already spent', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const reservationId = await held(store, ledger);
    await ledger.settle(tx, context, { reservationId, actualMicros: 30 });
    await ledger.release(tx, context, reservationId);
    expect(store.budgets[0]).toMatchObject({ reservedMicros: 0, spentMicros: 30 });
    expect(store.reservations[0]?.status).toBe('settled');
  });

  it('still counts a call whose answer arrives after its hold was released', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const reservationId = await held(store, ledger);
    await ledger.release(tx, context, reservationId);
    await ledger.settle(tx, context, { reservationId, actualMicros: 30 });
    // The provider billed it whatever we did with the hold, so forgetting it would under-count.
    expect(store.budgets[0]).toMatchObject({ reservedMicros: 0, spentMicros: 30 });
  });

  it('does not find a reservation from another run or tenant', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    expect(
      await code(ledger.settle(tx, context, { reservationId: randomUUID(), actualMicros: 1 })),
    ).toBe('NOT_FOUND');
    expect(await code(ledger.release(tx, context, randomUUID()))).toBe('NOT_FOUND');
  });

  it('refuses a settlement that is not whole micros', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const reservationId = await held(store, ledger);
    expect(await code(ledger.settle(tx, context, { reservationId, actualMicros: -1 }))).toBe(
      'INVALID_INPUT',
    );
    expect(await code(ledger.settle(tx, context, { reservationId, actualMicros: 0.5 }))).toBe(
      'INVALID_INPUT',
    );
  });
});

describe('record', () => {
  it('writes one row for one key, and answers false the second time', async () => {
    const store = new MemoryStore();
    const ledger = inMemory(store);
    await expect(ledger.record(tx, context, entry())).resolves.toBe(true);
    await expect(ledger.record(tx, context, entry())).resolves.toBe(false);
    expect(store.ledger).toHaveLength(1);
  });

  it('keeps the rate card version the cost was worked out from', async () => {
    const store = new MemoryStore();
    await inMemory(store).record(tx, context, entry());
    expect(store.ledger[0]).toMatchObject({ rateCardVersion: 3 });
  });

  it('refuses a version the rate card does not have', async () => {
    const store = new MemoryStore();
    expect(await code(inMemory(store).record(tx, context, entry({ rateCardVersion: 4 })))).toBe(
      'INVALID_INPUT',
    );
    expect(store.ledger).toEqual([]);
  });

  it('refuses a measured model cost with no rate card to show for it', async () => {
    const store = new MemoryStore();
    const ledger = inMemory(store);
    expect(await code(ledger.record(tx, context, entry({ rateCardId: null })))).toBe(
      'INVALID_INPUT',
    );
    expect(
      await code(ledger.record(tx, context, entry({ rateCardId: null, rateCardVersion: null }))),
    ).toBe('INVALID_INPUT');
  });

  it('takes BYOM as not billable and Cloud on its own profile as billable', async () => {
    const byom = new MemoryStore();
    await inMemory(byom).record(tx, context, entry({ profileId: randomUUID() }));
    expect(byom.ledger[0]).toMatchObject({ billable: false, commercialMode: 'byom' });

    const cloud = new MemoryStore();
    cloud.facts = { commercialMode: 'cloud', billingOwner: 'ensemus' };
    await inMemory(cloud).record(tx, context, entry({ profileId: randomUUID() }));
    expect(cloud.ledger[0]).toMatchObject({ billable: true, commercialMode: 'cloud' });

    const ownKey = new MemoryStore();
    ownKey.facts = { commercialMode: 'cloud', billingOwner: 'customer' };
    await inMemory(ownKey).record(tx, context, entry({ profileId: randomUUID() }));
    expect(ownKey.ledger[0]).toMatchObject({ billable: false, commercialMode: 'cloud' });
  });

  it('puts a row in its reservation month, so a call over midnight on the last day stays with its budget', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const answer = await ledgerOver(store, {
      inTenant: (_context, fn) => fn(tx),
      now: () => NOW,
    }).reserve(tx, context, reservation());
    if (!answer.ok) throw new Error('expected a hold');
    const nextMonth = ledgerOver(store, {
      inTenant: (_context, fn) => fn(tx),
      now: () => new Date('2026-12-01T00:00:01Z'),
    });
    await nextMonth.record(tx, context, entry({ reservationId: answer.reservationId }));
    expect(store.ledger[0]).toMatchObject({ billingPeriod: PERIOD });
    await nextMonth.record(tx, context, entry({ idempotencyKey: 'tool:a:1' }));
    expect(store.ledger[1]).toMatchObject({ billingPeriod: '2026-12' });
  });

  it('refuses a malformed row, and a person writing one', async () => {
    const store = new MemoryStore();
    const ledger = inMemory(store);
    for (const bad of [
      { quantity: -1 },
      { quantity: 0.5 },
      { costMicros: -1 },
      { costMicros: 0.5 },
      { unit: 'call' as const },
      { meter: 'tool_call' as const },
      { status: 'correction' as const },
      { correctsId: randomUUID() },
      { runId: randomUUID() },
    ]) {
      expect(await code(ledger.record(tx, context, entry(bad))), JSON.stringify(bad)).not.toBe(
        'no error',
      );
    }
    const person = { ...context, actorType: 'user' } as unknown as AgentContext;
    expect(await code(ledger.record(tx, person, entry()))).toBe('FORBIDDEN');
    expect(store.ledger).toEqual([]);
  });

  it('lets a correction take money back, with a pointer to what it corrects', async () => {
    const store = new MemoryStore();
    const ledger = inMemory(store);
    await expect(
      ledger.record(
        tx,
        context,
        entry({
          idempotencyKey: 'correction:1',
          status: 'correction',
          correctsId: randomUUID(),
          costMicros: -5,
          rateCardId: null,
          rateCardVersion: null,
        }),
      ),
    ).resolves.toBe(true);
  });

  it('allows a tool call with no cost and no rate card', async () => {
    const store = new MemoryStore();
    await expect(
      inMemory(store).record(
        tx,
        context,
        entry({
          idempotencyKey: 'tool:a:1',
          meter: 'tool_call',
          unit: 'call',
          quantity: 1,
          costMicros: 0,
          rateCardId: null,
          rateCardVersion: null,
        }),
      ),
    ).resolves.toBe(true);
    expect(store.ledger[0]).toMatchObject({ billable: false });
  });
});

describe('a lost answer (FD-12)', () => {
  const input = (reservationId: string, amountMicros: number) => ({
    lost: { attempt: 1, reservationId, amountMicros },
    runId: RUN,
    stepId: randomUUID(),
    stepNumber: 4,
    workUnitId: WORK,
    profile: null,
    rateCard: null,
  });

  it('is an estimate at the reserved amount, under the key of the attempt that was lost', () => {
    expect(lostAnswerEntry(input('r', 500))).toMatchObject({
      idempotencyKey: modelLedgerKey(RUN, 4, 1),
      status: 'estimated',
      costMicros: 500,
      quantity: 0,
      reservationId: 'r',
    });
  });

  it('over-counts rather than under: the budget is charged what was held, not what was billed', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const answer = await ledger.reserve(tx, context, reservation({ amountMicros: 500 }));
    if (!answer.ok) throw new Error('expected a hold');

    await expect(
      recordLostAnswer(ledger, tx, context, input(answer.reservationId, 500)),
    ).resolves.toBe(true);

    expect(store.budgets[0]).toMatchObject({ reservedMicros: 0, spentMicros: 500 });
    expect(store.ledger[0]).toMatchObject({ status: 'estimated', costMicros: 500 });
  });

  it('counts once when the retry itself is retried', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const answer = await ledger.reserve(tx, context, reservation({ amountMicros: 500 }));
    if (!answer.ok) throw new Error('expected a hold');
    const lost = input(answer.reservationId, 500);
    await recordLostAnswer(ledger, tx, context, lost);
    await expect(recordLostAnswer(ledger, tx, context, lost)).resolves.toBe(false);
    expect(store.ledger).toHaveLength(1);
    expect(store.budgets[0]).toMatchObject({ spentMicros: 500 });
  });

  it('keeps the estimate when a worker thought dead reports its real answer late', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const answer = await ledger.reserve(tx, context, reservation({ amountMicros: 500 }));
    if (!answer.ok) throw new Error('expected a hold');
    const lost = input(answer.reservationId, 500);
    await recordLostAnswer(ledger, tx, context, lost);
    await ledger.settle(tx, context, { reservationId: answer.reservationId, actualMicros: 10 });
    await expect(
      ledger.record(tx, context, entry({ idempotencyKey: modelLedgerKey(RUN, 4, 1) })),
    ).resolves.toBe(false);
    expect(store.budgets[0]).toMatchObject({ spentMicros: 500 });
  });
});

describe('closing a run', () => {
  it('estimates a call that may have been sent, and frees a hold nothing used', () => {
    const row = {
      stepKind: 'model_turn',
      stepState: 'completed',
      stepAttempt: 2,
      attempt: 2,
    };
    expect(reservationFate({ ...row, stepState: 'in_flight' })).toBe('lost');
    expect(reservationFate({ ...row, attempt: 1 })).toBe('lost');
    expect(reservationFate(row)).toBe('unused');
    expect(reservationFate({ ...row, stepState: 'cancelled' })).toBe('unused');
    expect(reservationFate({ ...row, stepKind: 'delegation', stepState: 'in_flight' })).toBe(
      'unused',
    );
  });

  it('never forgets an interrupted call when a stopped run gives its holds back', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000));
    const ledger = inMemory(store);
    const interrupted = randomUUID();
    const finished = randomUUID();
    store.steps.set(interrupted, {
      stepNumber: 3,
      state: 'in_flight',
      attempt: 1,
      kind: 'model_turn',
    });
    store.steps.set(finished, { stepNumber: 2, state: 'failed', attempt: 1, kind: 'model_turn' });
    await ledger.reserve(tx, context, reservation({ stepId: interrupted, amountMicros: 200 }));
    await ledger.reserve(tx, context, reservation({ stepId: finished, amountMicros: 300 }));

    await expect(
      closeRunReservationsOver(store, ledger, tx, context, { runId: RUN }),
    ).resolves.toEqual({ estimatedMicros: 200, estimated: 1, released: 1 });

    expect(store.budgets[0]).toMatchObject({ reservedMicros: 0, spentMicros: 200 });
    expect(store.ledger).toHaveLength(1);
    expect(store.ledger[0]).toMatchObject({
      idempotencyKey: modelLedgerKey(RUN, 3, 1),
      status: 'estimated',
      costMicros: 200,
    });
  });

  it('closes a reservation that spans two budgets once, and is safe to repeat', async () => {
    const store = new MemoryStore();
    store.budgets.push(orgBudget(1000), { ...orgBudget(500), agentVersionId: VERSION });
    const ledger = inMemory(store);
    const stepId = randomUUID();
    store.steps.set(stepId, { stepNumber: 1, state: 'in_flight', attempt: 1, kind: 'model_turn' });
    await ledger.reserve(tx, context, reservation({ stepId, amountMicros: 100 }));

    const first = await closeRunReservationsOver(store, ledger, tx, context, { runId: RUN });
    const second = await closeRunReservationsOver(store, ledger, tx, context, { runId: RUN });

    expect(first).toEqual({ estimatedMicros: 100, estimated: 1, released: 0 });
    expect(second).toEqual({ estimatedMicros: 0, estimated: 0, released: 0 });
    expect(store.ledger).toHaveLength(1);
    expect(store.budgets.map((row) => [row.reservedMicros, row.spentMicros])).toEqual([
      [0, 100],
      [0, 100],
    ]);
  });
});

describe('reconcileRun', () => {
  it('equals the sum of the ledger, whatever the counters say', async () => {
    const store = new MemoryStore();
    const ledger = inMemory(store);
    await ledger.record(tx, context, entry({ idempotencyKey: 'a', costMicros: 20 }));
    await ledger.record(tx, context, entry({ idempotencyKey: 'b', costMicros: 30 }));
    store.counterMicros = 50;
    await expect(ledger.reconcileRun(context, RUN)).resolves.toEqual({
      ledgerMicros: 50,
      counterMicros: 50,
      matches: true,
    });
    store.counterMicros = 40;
    await expect(ledger.reconcileRun(context, RUN)).resolves.toEqual({
      ledgerMicros: 50,
      counterMicros: 40,
      matches: false,
    });
  });

  it('does not find a run it cannot see', async () => {
    const ledger = inMemory(new MemoryStore());
    expect(await code(ledger.reconcileRun(context, randomUUID()))).toBe('NOT_FOUND');
  });
});

// --- People's side (budget.ts). Every refusal here happens before any database is touched.

describe('budgets and usage for people', () => {
  const unreachable = new Proxy(
    {},
    {
      get() {
        throw new Error('a refusal must not reach the database');
      },
    },
  ) as AppDatabase;
  const person = (role: string, actorType = 'user') =>
    ({
      organizationId: ORG,
      userId: randomUUID(),
      membershipId: randomUUID(),
      role,
      actorType,
    }) as unknown as TenantContext;
  const budget: SetBudget = {
    scope: 'organization',
    agent_version_id: null,
    period: PERIOD,
    limit_micros: 1000,
  };

  it('refuses a member setting a budget or reading usage', async () => {
    expect(await code(setBudget(unreachable, person('member'), budget))).toBe('FORBIDDEN');
    expect(await code(getUsageSummary(unreachable, person('member'), { period: PERIOD }))).toBe(
      'FORBIDDEN',
    );
    expect(await code(listBudgets(unreachable, person('member'), { period: PERIOD }))).toBe(
      'FORBIDDEN',
    );
    expect(await code(getStopDiagnostics(unreachable, person('member'), { period: PERIOD }))).toBe(
      'FORBIDDEN',
    );
  });

  it('refuses an agent acting for an owner: its own budget is not its to raise', async () => {
    expect(await code(setBudget(unreachable, person('owner', 'agent'), budget))).toBe('FORBIDDEN');
    expect(await code(setBudget(unreachable, person('service', 'service'), budget))).toBe(
      'FORBIDDEN',
    );
  });

  it('refuses a budget whose scope and target disagree, or that is not whole micros', async () => {
    const owner = person('owner');
    for (const bad of [
      { ...budget, scope: 'agent_version' },
      { ...budget, agent_version_id: randomUUID() },
      { ...budget, limit_micros: -1 },
      { ...budget, limit_micros: 0.5 },
      { ...budget, limit_micros: Number.MAX_SAFE_INTEGER + 1 },
      { ...budget, period: '2026-13' },
      { ...budget, surprise: true },
    ]) {
      expect(await code(setBudget(unreachable, owner, bad as SetBudget))).toBe('INVALID_INPUT');
    }
    expect(await code(getUsageSummary(unreachable, owner, { period: 'soon' }))).toBe(
      'INVALID_INPUT',
    );
  });
});

describe('summarizeUsage', () => {
  const base = {
    period: PERIOD,
    limitMicros: 1000,
    reservedMicros: 10,
    costMicros: 20,
    inputTokens: 5,
    outputTokens: 6,
    estimatedRows: 0,
    billableRows: 0,
    tenantEstimateRows: 0,
  };

  it('labels BYOM and Sovereign as estimates that are never billable (QA-027)', () => {
    for (const mode of ['byom', 'sovereign'] as const) {
      expect(summarizeUsage({ ...base, mode })).toMatchObject({
        billable: false,
        is_estimate: true,
      });
    }
  });

  it('labels Cloud as billable only for what Ensemus pays for', () => {
    expect(summarizeUsage({ ...base, mode: 'cloud' })).toMatchObject({
      billable: false,
      is_estimate: false,
    });
    expect(summarizeUsage({ ...base, mode: 'cloud', billableRows: 1 })).toMatchObject({
      billable: true,
      is_estimate: false,
    });
  });

  it('calls Cloud an estimate if any part of it is', () => {
    expect(summarizeUsage({ ...base, mode: 'cloud', estimatedRows: 1 }).is_estimate).toBe(true);
    expect(summarizeUsage({ ...base, mode: 'cloud', tenantEstimateRows: 1 }).is_estimate).toBe(
      true,
    );
  });

  it('never shows a negative after a correction', () => {
    expect(summarizeUsage({ ...base, mode: 'cloud', costMicros: -5 }).spent_micros).toBe(0);
  });
});

describe('admin diagnostics', () => {
  it('tells "your plan does not include this" from "your policy does not allow this"', () => {
    expect(diagnoseStop('ENTITLEMENT_DENIED')).toBe('entitlement');
    expect(diagnoseStop('POLICY_DENIED')).toBe('policy');
    expect(diagnoseStop('PROFILE_CHANGED')).toBe('policy');
    expect(diagnoseStop('BUDGET_EXHAUSTED')).toBe('budget');
    expect(diagnoseStop('BUDGET_NOT_CONFIGURED')).toBe('budget');
    expect(diagnoseStop('RATE_CARD_MISSING')).toBe('budget');
    expect(diagnoseStop('COST_LIMIT')).toBe('budget');
    expect(diagnoseStop('MODEL_UNAVAILABLE')).toBeNull();
    expect(new AppError('ENTITLEMENT_DENIED').message).not.toBe(
      new AppError('POLICY_DENIED').message,
    );
  });

  it('reads one UTC month, across the turn of a year', () => {
    expect(periodRange('2026-12')).toEqual({
      from: new Date('2026-12-01T00:00:00Z'),
      to: new Date('2027-01-01T00:00:00Z'),
    });
  });
});
