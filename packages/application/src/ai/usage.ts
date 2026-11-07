// The usage ledger and budget reservations (MODEL-04, ADR-028 FD-6, FD-12). Only agent-worker uses this:
// its role alone can write these tables, and lint keeps web away. Billing in M8 reads this history and
// cannot rebuild it, so every choice below leans the same way: a budget may over-count a call and must
// never forget one. The rules are in `ledgerOver`, and the SQL they rest on is in `sqlStore`, so a test can
// hold the rules to a store that keeps the same promises.
import {
  agentRuns,
  budgetReservations,
  budgets,
  executionSteps,
  modelProfiles,
  organizations,
  rateCards,
  usageLedger,
  withTenantTx,
  type AgentContext,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import {
  modelLedgerKey,
  type BillingOwner,
  type ProviderKind,
  type ReservationStatus,
} from '@ensemus/domain/ai';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import type { LedgerEntry, Reservation, UsageLedger } from './ports';

type CommercialMode = 'cloud' | 'byom' | 'sovereign';

const MICROS_PER_MTOK_DIVISOR = 1_000_000n;

function wholeAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Cost of a call from its usage and rate card, rounded up on each meter, so a budget over-counts and
 * never under. In whole numbers throughout: a token count times a rate can pass what a float holds
 * exactly, and FD-6 keeps floats away from money. Too large to stay exact is an error, not a guess.
 */
export function costMicros(
  usage: { inputTokens: number; outputTokens: number },
  rate: { inputMicrosPerMtok: number; outputMicrosPerMtok: number },
): number {
  for (const value of [
    usage.inputTokens,
    usage.outputTokens,
    rate.inputMicrosPerMtok,
    rate.outputMicrosPerMtok,
  ]) {
    if (!wholeAmount(value)) throw new RangeError('Not a whole, non-negative amount');
  }
  const meter = (tokens: number, microsPerMtok: number) => {
    const product = BigInt(tokens) * BigInt(microsPerMtok);
    return (product + MICROS_PER_MTOK_DIVISOR - 1n) / MICROS_PER_MTOK_DIVISOR;
  };
  const total =
    meter(usage.inputTokens, rate.inputMicrosPerMtok) +
    meter(usage.outputTokens, rate.outputMicrosPerMtok);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Too large to stay exact');
  return Number(total);
}

/** The `YYYY-MM` a moment falls in, in UTC, so every replica agrees on when a month turns over. */
export const billingPeriodOf = (now: Date) => now.toISOString().slice(0, 7);

/**
 * Whether Ensemus bills this. Only a Cloud tenant on a profile Ensemus pays for: a customer's own
 * provider bills them directly, and charging for it as well would be charging twice (QA-027). A row
 * with no profile has no provider cost, and M8 decides from its meter what it does with those.
 */
export const isBillable = (mode: CommercialMode, billingOwner: BillingOwner | null) =>
  mode === 'cloud' && billingOwner === 'ensemus';

// --- The storage the rules need. Each method is one statement, and none opens a transaction of its own.

export type BudgetRow = {
  id: string;
  limitMicros: number;
  reservedMicros: number;
  spentMicros: number;
};

export type ReservationRow = {
  id: string;
  budgetId: string;
  runId: string;
  stepId: string;
  attempt: number;
  amountMicros: number;
  status: ReservationStatus;
};

export type HeldReservationRow = ReservationRow & {
  stepNumber: number;
  stepState: string;
  stepAttempt: number;
  stepKind: string;
};

export type RunFacts = {
  agentVersionId: string;
  workUnitId: string;
  costMicros: number;
  boundProfileId: string | null;
  boundProfileVersion: number | null;
  providerKind: ProviderKind | null;
};

export type LedgerFacts = {
  commercialMode: CommercialMode;
  billingOwner: BillingOwner | null;
  /** The month of the budget this reservation held, or null with no reservation or none found. */
  reservationPeriod: string | null;
  rateCardVersion: number | null;
};

export type LedgerRow = Omit<LedgerEntry, 'correctsId'> & {
  organizationId: string;
  billingPeriod: string;
  commercialMode: CommercialMode;
  billable: boolean;
  correctsId: string | null;
};

export interface LedgerStore {
  /** The organization's budget and this version's for the month, in ID order, so locks never cross. */
  budgetsThatApply(
    tx: Tx,
    query: { organizationId: string; agentVersionId: string; period: string },
  ): Promise<BudgetRow[]>;
  runFacts(tx: Tx, query: { runId: string }): Promise<RunFacts | null>;
  reservationsOfAttempt(
    tx: Tx,
    query: { stepId: string; attempt: number },
  ): Promise<ReservationRow[]>;
  /** A savepoint. A throw undoes everything `fn` did, and the caller's transaction carries on. */
  allOrNothing<T>(tx: Tx, fn: (savepoint: Tx) => Promise<T>): Promise<T>;
  /** Null when this budget, step and attempt already have a row. */
  insertReservation(
    tx: Tx,
    row: Omit<ReservationRow, 'id' | 'status'> & { organizationId: string },
  ): Promise<string | null>;
  /** The one atomic update: `reserved + spent + amount <= limit`. False when it did not fit. */
  takeHeadroom(tx: Tx, query: { budgetId: string; amountMicros: number }): Promise<boolean>;
  /** Every row of one reservation, locked and in budget order. Empty when this run has no such row. */
  lockReservationGroup(
    tx: Tx,
    query: { reservationId: string; runId: string },
  ): Promise<ReservationRow[]>;
  closeReservation(tx: Tx, query: { id: string; status: 'settled' | 'released' }): Promise<void>;
  moveMoney(
    tx: Tx,
    query: { budgetId: string; releaseMicros: number; spendMicros: number },
  ): Promise<void>;
  ledgerFacts(
    tx: Tx,
    query: { reservationId: string | null; rateCardId: string | null; profileId: string | null },
  ): Promise<LedgerFacts>;
  /** False when this key already has a row. */
  insertLedger(tx: Tx, row: LedgerRow): Promise<boolean>;
  ledgerTotal(tx: Tx, query: { runId: string }): Promise<number>;
  heldOfRun(tx: Tx, query: { runId: string }): Promise<HeldReservationRow[]>;
}

// --- The rules.

const TOKEN_METERS: ReadonlySet<LedgerEntry['meter']> = new Set([
  'model_input_tokens',
  'model_output_tokens',
]);

/**
 * A row billing can rely on. A refusal here is safe even after a real call: the transaction fails, the
 * Activity retries, and FD-12 finds the step in flight and writes the estimate, so nothing is forgotten.
 */
function assertWellFormed(entry: LedgerEntry) {
  const isCorrection = entry.status === 'correction';
  const hasCorrects = entry.correctsId !== undefined;
  const token = TOKEN_METERS.has(entry.meter);
  const hasRateId = entry.rateCardId !== null;
  const hasRateVersion = entry.rateCardVersion !== null;
  const measuredCost = entry.status === 'final' && (token || entry.costMicros > 0);
  const costAllowed = isCorrection
    ? Number.isSafeInteger(entry.costMicros)
    : wholeAmount(entry.costMicros);
  if (
    !wholeAmount(entry.quantity) ||
    !costAllowed ||
    isCorrection !== hasCorrects ||
    (token ? entry.unit !== 'token' : entry.unit !== 'call') ||
    hasRateId !== hasRateVersion ||
    (measuredCost && !hasRateId)
  ) {
    throw new AppError('INVALID_INPUT');
  }
}

/**
 * Only an agent writes this, and only for its own run. The grants say the first and this says both,
 * because a context for one run writing another's usage would pass every grant there is.
 */
function assertOwnRun(context: AgentContext, runId: string) {
  assertAgent(context);
  if (context.agentRunId !== runId.toLowerCase()) throw new AppError('FORBIDDEN');
}

function assertAgent(context: AgentContext) {
  if (context.actorType !== 'agent') throw new AppError('FORBIDDEN');
}

/** Unwinds a reservation's savepoint with what to tell the caller. */
class ReservationStop extends Error {
  constructor(readonly reason: 'exhausted' | 'raced') {
    super(reason);
  }
}

function heldAnswer(rows: readonly ReservationRow[]): Reservation {
  const [head] = rows;
  // A closed attempt with no fresh hold would let a model call run that nothing has room for.
  if (!head || rows.some((row) => row.status !== 'held')) throw new AppError('INVALID_STATE');
  return { ok: true, reservationId: head.id, amountMicros: head.amountMicros };
}

export type LedgerScope = {
  inTenant: <T>(context: AgentContext, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  now: () => Date;
};

/** The ledger over any store that keeps the promises in `LedgerStore`. Tests use this directly. */
export function ledgerOver(store: LedgerStore, scope: LedgerScope): UsageLedger {
  return {
    headroom(context, query) {
      return scope.inTenant(context, async (tx) => {
        const rows = await store.budgetsThatApply(tx, {
          organizationId: context.organizationId,
          agentVersionId: query.agentVersionId,
          period: billingPeriodOf(scope.now()),
        });
        if (rows.length === 0) return { availableMicros: null };
        const left = rows.map((row) => row.limitMicros - row.reservedMicros - row.spentMicros);
        // A settlement may overspend, and that means nothing left rather than less than nothing.
        return { availableMicros: Math.max(0, Math.min(...left)) };
      });
    },

    async reserve(tx, context, request) {
      assertOwnRun(context, request.runId);
      if (!wholeAmount(request.amountMicros)) throw new AppError('INVALID_INPUT');
      const run = await store.runFacts(tx, { runId: request.runId });
      if (!run) throw new AppError('NOT_FOUND');
      if (run.agentVersionId !== request.agentVersionId.toLowerCase()) {
        throw new AppError('INVALID_INPUT');
      }
      const attempt = { stepId: request.stepId, attempt: request.attempt };
      const existing = await store.reservationsOfAttempt(tx, attempt);
      if (existing.length > 0) {
        if (existing.some((row) => row.amountMicros !== request.amountMicros))
          throw new AppError('INVALID_STATE');
        return heldAnswer(existing);
      }

      const applicable = await store.budgetsThatApply(tx, {
        organizationId: context.organizationId,
        agentVersionId: run.agentVersionId,
        period: billingPeriodOf(scope.now()),
      });
      if (applicable.length === 0) return { ok: false, code: 'BUDGET_NOT_CONFIGURED' };

      try {
        // In a savepoint: the caller commits this transaction even when told no, and a hold on the
        // first budget must not outlive a refusal from the second.
        const reservationId = await store.allOrNothing(tx, async (savepoint) => {
          let head: string | null = null;
          for (const budget of applicable) {
            const id = await store.insertReservation(savepoint, {
              organizationId: context.organizationId,
              budgetId: budget.id,
              runId: request.runId,
              stepId: request.stepId,
              attempt: request.attempt,
              amountMicros: request.amountMicros,
            });
            if (!id) throw new ReservationStop('raced');
            const fitted = await store.takeHeadroom(savepoint, {
              budgetId: budget.id,
              amountMicros: request.amountMicros,
            });
            if (!fitted) throw new ReservationStop('exhausted');
            head ??= id;
          }
          return head;
        });
        if (!reservationId) throw new AppError('INVALID_STATE');
        return { ok: true, reservationId, amountMicros: request.amountMicros };
      } catch (error) {
        if (!(error instanceof ReservationStop)) throw error;
        if (error.reason === 'exhausted') return { ok: false, code: 'BUDGET_EXHAUSTED' };
        const raced = await store.reservationsOfAttempt(tx, attempt);
        if (raced.some((row) => row.amountMicros !== request.amountMicros))
          throw new AppError('INVALID_STATE');
        return heldAnswer(raced);
      }
    },

    async settle(tx, context, settlement) {
      assertAgent(context);
      if (!wholeAmount(settlement.actualMicros)) throw new AppError('INVALID_INPUT');
      const rows = await store.lockReservationGroup(tx, {
        reservationId: settlement.reservationId,
        runId: context.agentRunId,
      });
      if (rows.length === 0) throw new AppError('NOT_FOUND');
      for (const row of rows) {
        // Already settled means a retry, and this was counted. Released means the answer came after
        // a cancel gave the hold back: nothing is left to free, and the call still gets counted.
        if (row.status === 'settled') continue;
        await store.closeReservation(tx, { id: row.id, status: 'settled' });
        await store.moveMoney(tx, {
          budgetId: row.budgetId,
          releaseMicros: row.status === 'held' ? row.amountMicros : 0,
          spendMicros: settlement.actualMicros,
        });
      }
    },

    async release(tx, context, reservationId) {
      assertAgent(context);
      const rows = await store.lockReservationGroup(tx, {
        reservationId,
        runId: context.agentRunId,
      });
      if (rows.length === 0) throw new AppError('NOT_FOUND');
      for (const row of rows) {
        if (row.status !== 'held') continue;
        await store.closeReservation(tx, { id: row.id, status: 'released' });
        await store.moveMoney(tx, {
          budgetId: row.budgetId,
          releaseMicros: row.amountMicros,
          spendMicros: 0,
        });
      }
    },

    async record(tx, context, entry) {
      assertOwnRun(context, entry.runId);
      assertWellFormed(entry);
      const facts = await store.ledgerFacts(tx, {
        reservationId: entry.reservationId,
        rateCardId: entry.rateCardId,
        profileId: entry.profileId,
      });
      // What the row claims about its price has to be what that rate card says, or M8 cannot trust it.
      if (entry.rateCardId !== null && facts.rateCardVersion !== entry.rateCardVersion) {
        throw new AppError('INVALID_INPUT');
      }
      if (entry.reservationId !== null && facts.reservationPeriod === null) {
        throw new AppError('INVALID_INPUT');
      }
      const { correctsId, ...written } = entry;
      return store.insertLedger(tx, {
        ...written,
        organizationId: context.organizationId,
        // With its reservation's month, so one call stays with the budget that paid for it even if it
        // ends after midnight on the last day.
        billingPeriod: facts.reservationPeriod ?? billingPeriodOf(scope.now()),
        commercialMode: facts.commercialMode,
        billable: isBillable(facts.commercialMode, facts.billingOwner),
        correctsId: correctsId ?? null,
      });
    },

    reconcileRun(context, runId) {
      return scope.inTenant(context, async (tx) => {
        const run = await store.runFacts(tx, { runId });
        if (!run) throw new AppError('NOT_FOUND');
        const ledgerMicros = await store.ledgerTotal(tx, { runId });
        return {
          ledgerMicros,
          counterMicros: run.costMicros,
          matches: ledgerMicros === run.costMicros,
        };
      });
    },
  };
}

// --- A call whose answer was lost (FD-12).

export type LostAnswer = {
  /** From `TurnStart.lostAttempt`. */
  lost: { attempt: number; reservationId: string; amountMicros: number };
  runId: string;
  stepId: string;
  stepNumber: number;
  workUnitId: string;
  profile: { id: string; version: number; providerKind: ProviderKind | null } | null;
  rateCard: { id: string; version: number } | null;
};

/**
 * The provider may have billed this and nobody knows how much, so it is charged at what was reserved,
 * which is the most the call could have been allowed to cost. Quantity is zero because no token count
 * came back, and the status says this is an estimate.
 */
export function lostAnswerEntry(input: LostAnswer): LedgerEntry {
  return {
    idempotencyKey: modelLedgerKey(input.runId, input.stepNumber, input.lost.attempt),
    meter: 'model_input_tokens',
    quantity: 0,
    unit: 'token',
    costMicros: input.lost.amountMicros,
    rateCardId: input.rateCard?.id ?? null,
    rateCardVersion: input.rateCard?.version ?? null,
    reservationId: input.lost.reservationId,
    workUnitId: input.workUnitId,
    runId: input.runId,
    stepId: input.stepId,
    profileId: input.profile?.id ?? null,
    profileVersion: input.profile?.version ?? null,
    providerKind: input.profile?.providerKind ?? null,
    requestHash: null,
    status: 'estimated',
  };
}

/**
 * What a retry does first when it finds an earlier attempt still in flight. Safe to repeat. Answers
 * whether this is the first time, so the caller adds to the run's cost counter exactly once.
 */
export async function recordLostAnswer(
  ledger: UsageLedger,
  tx: Tx,
  context: AgentContext,
  input: LostAnswer,
): Promise<boolean> {
  await ledger.settle(tx, context, {
    reservationId: input.lost.reservationId,
    actualMicros: input.lost.amountMicros,
  });
  return ledger.record(tx, context, lostAnswerEntry(input));
}

// --- Closing a run.

/**
 * What a hold still open when a run ends means. A step in flight, or an attempt the step has moved past,
 * may have reached a provider. Anything else had its answer and was left over, so it is free to go.
 * Only model turns spend at a provider: a delegation's hold is a carve, and the child's own rows count it.
 */
export function reservationFate(row: {
  stepKind: string;
  stepState: string;
  stepAttempt: number;
  attempt: number;
}): 'lost' | 'unused' {
  if (row.stepKind !== 'model_turn') return 'unused';
  if (row.stepState === 'in_flight' || row.attempt < row.stepAttempt) return 'lost';
  return 'unused';
}

export type RunClose = { released: number; estimated: number; estimatedMicros: number };

export async function closeRunReservationsOver(
  store: LedgerStore,
  ledger: UsageLedger,
  tx: Tx,
  context: AgentContext,
  input: { runId: string },
): Promise<RunClose> {
  assertOwnRun(context, input.runId);
  const run = await store.runFacts(tx, { runId: input.runId });
  if (!run) throw new AppError('NOT_FOUND');
  const held = await store.heldOfRun(tx, { runId: input.runId });
  // One reservation is one row per budget, and closing any of them closes them all.
  const seen = new Set<string>();
  const close: RunClose = { released: 0, estimated: 0, estimatedMicros: 0 };
  for (const row of held) {
    const group = `${row.stepId}:${row.attempt}`;
    if (seen.has(group)) continue;
    seen.add(group);
    if (reservationFate(row) === 'unused') {
      await ledger.release(tx, context, row.id);
      close.released += 1;
      continue;
    }
    const written = await recordLostAnswer(ledger, tx, context, {
      lost: { attempt: row.attempt, reservationId: row.id, amountMicros: row.amountMicros },
      runId: input.runId,
      stepId: row.stepId,
      stepNumber: row.stepNumber,
      workUnitId: run.workUnitId,
      profile:
        run.boundProfileId !== null && run.boundProfileVersion !== null
          ? {
              id: run.boundProfileId,
              version: run.boundProfileVersion,
              providerKind: run.providerKind,
            }
          : null,
      rateCard: null,
    });
    if (written) {
      close.estimated += 1;
      close.estimatedMicros += row.amountMicros;
    }
  }
  return close;
}

/**
 * Gives back what a finished run still holds, and writes an estimate for any call it cannot prove was
 * not sent. `finishRun` calls this in its own transaction, so cancelling a run after a crash does not
 * quietly forget a call the provider billed. The answer says what to add to the run's cost counter.
 */
export function closeRunReservations(
  tx: Tx,
  context: AgentContext,
  input: { runId: string },
): Promise<RunClose> {
  return closeRunReservationsOver(
    sqlStore,
    ledgerOver(sqlStore, noOwnTransactions),
    tx,
    context,
    input,
  );
}

// --- The SQL. RLS is what confines each statement to the tenant bound on the transaction.

const sumOf = (column: unknown) => sql<string>`coalesce(sum(${column}), 0)::bigint`.mapWith(Number);

const reservationColumns = {
  id: budgetReservations.id,
  budgetId: budgetReservations.budgetId,
  runId: budgetReservations.runId,
  stepId: budgetReservations.stepId,
  attempt: budgetReservations.attempt,
  amountMicros: budgetReservations.amountMicros,
  status: budgetReservations.status,
};

const asReservation = (
  row: { status: string; runId: string | null; stepId: string | null } & Omit<
    ReservationRow,
    'status' | 'runId' | 'stepId'
  >,
): ReservationRow => {
  if (!row.runId || !row.stepId) throw new AppError('INVALID_STATE');
  return { ...row, runId: row.runId, stepId: row.stepId, status: row.status as ReservationStatus };
};

const sqlStore: LedgerStore = {
  budgetsThatApply(tx, query) {
    return tx
      .select({
        id: budgets.id,
        limitMicros: budgets.limitMicros,
        reservedMicros: budgets.reservedMicros,
        spentMicros: budgets.spentMicros,
      })
      .from(budgets)
      .where(
        and(
          eq(budgets.organizationId, query.organizationId),
          eq(budgets.period, query.period),
          or(
            and(eq(budgets.scope, 'organization'), isNull(budgets.agentVersionId)),
            and(
              eq(budgets.scope, 'agent_version'),
              eq(budgets.agentVersionId, query.agentVersionId),
            ),
          ),
        ),
      )
      .orderBy(asc(budgets.id));
  },

  async runFacts(tx, query) {
    const [row] = await tx
      .select({
        agentVersionId: agentRuns.agentVersionId,
        workUnitId: agentRuns.workUnitId,
        costMicros: agentRuns.costMicros,
        boundProfileId: agentRuns.boundProfileId,
        boundProfileVersion: agentRuns.boundProfileVersion,
        providerKind: modelProfiles.providerKind,
      })
      .from(agentRuns)
      .leftJoin(
        modelProfiles,
        and(
          eq(modelProfiles.organizationId, agentRuns.organizationId),
          eq(modelProfiles.id, agentRuns.boundProfileId),
        ),
      )
      .where(eq(agentRuns.id, query.runId));
    return row ? { ...row, providerKind: row.providerKind as ProviderKind | null } : null;
  },

  async reservationsOfAttempt(tx, query) {
    const rows = await tx
      .select(reservationColumns)
      .from(budgetReservations)
      .where(
        and(
          eq(budgetReservations.stepId, query.stepId),
          eq(budgetReservations.attempt, query.attempt),
          isNull(budgetReservations.modelCallId),
        ),
      )
      .orderBy(asc(budgetReservations.budgetId));
    return rows.map(asReservation);
  },

  allOrNothing(tx, fn) {
    // Inside a transaction, Drizzle makes this a savepoint.
    return tx.transaction(fn);
  },

  async insertReservation(tx, row) {
    const [inserted] = await tx
      .insert(budgetReservations)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: budgetReservations.id });
    return inserted?.id ?? null;
  },

  async takeHeadroom(tx, query) {
    // Postgres rereads the row after waiting on its lock, so this condition sees the other writer's
    // hold, and two of these cannot both take the last of the headroom.
    const amount = sql`${query.amountMicros}::bigint`;
    const moved = await tx
      .update(budgets)
      .set({ reservedMicros: sql`${budgets.reservedMicros} + ${amount}` })
      .where(
        and(
          eq(budgets.id, query.budgetId),
          sql`${budgets.reservedMicros} + ${budgets.spentMicros} + ${amount} <= ${budgets.limitMicros}`,
        ),
      )
      .returning({ id: budgets.id });
    return moved.length > 0;
  },

  async lockReservationGroup(tx, query) {
    const [head] = await tx
      .select({ stepId: budgetReservations.stepId, attempt: budgetReservations.attempt })
      .from(budgetReservations)
      .where(
        and(
          eq(budgetReservations.id, query.reservationId),
          eq(budgetReservations.runId, query.runId),
          isNull(budgetReservations.modelCallId),
        ),
      );
    if (!head?.stepId) return [];
    const rows = await tx
      .select(reservationColumns)
      .from(budgetReservations)
      .where(
        and(
          eq(budgetReservations.stepId, head.stepId),
          eq(budgetReservations.attempt, head.attempt),
          isNull(budgetReservations.modelCallId),
        ),
      )
      .orderBy(asc(budgetReservations.budgetId))
      .for('update');
    return rows.map(asReservation);
  },

  async closeReservation(tx, query) {
    await tx
      .update(budgetReservations)
      .set({ status: query.status, settledAt: new Date() })
      .where(eq(budgetReservations.id, query.id));
  },

  async moveMoney(tx, query) {
    await tx
      .update(budgets)
      .set({
        reservedMicros: sql`${budgets.reservedMicros} - ${query.releaseMicros}::bigint`,
        spentMicros: sql`${budgets.spentMicros} + ${query.spendMicros}::bigint`,
      })
      .where(eq(budgets.id, query.budgetId));
  },

  async ledgerFacts(tx, query) {
    const [organization] = await tx
      .select({ commercialMode: organizations.commercialMode })
      .from(organizations);
    if (!organization) throw new AppError('NOT_FOUND');
    let billingOwner: BillingOwner | null = null;
    if (query.profileId) {
      const [profile] = await tx
        .select({ billingOwner: modelProfiles.billingOwner })
        .from(modelProfiles)
        .where(eq(modelProfiles.id, query.profileId));
      billingOwner = (profile?.billingOwner as BillingOwner | undefined) ?? null;
    }
    let reservationPeriod: string | null = null;
    if (query.reservationId) {
      const [held] = await tx
        .select({ period: budgets.period })
        .from(budgetReservations)
        .innerJoin(
          budgets,
          and(
            eq(budgets.organizationId, budgetReservations.organizationId),
            eq(budgets.id, budgetReservations.budgetId),
          ),
        )
        .where(eq(budgetReservations.id, query.reservationId));
      reservationPeriod = held?.period ?? null;
    }
    let rateCardVersion: number | null = null;
    if (query.rateCardId) {
      const [card] = await tx
        .select({ version: rateCards.version })
        .from(rateCards)
        .where(eq(rateCards.id, query.rateCardId));
      rateCardVersion = card?.version ?? null;
    }
    return {
      commercialMode: organization.commercialMode as CommercialMode,
      billingOwner,
      reservationPeriod,
      rateCardVersion,
    };
  },

  async insertLedger(tx, row) {
    const inserted = await tx
      .insert(usageLedger)
      .values(row)
      .onConflictDoNothing({
        target: [usageLedger.organizationId, usageLedger.idempotencyKey],
      })
      .returning({ id: usageLedger.id });
    return inserted.length > 0;
  },

  async ledgerTotal(tx, query) {
    const [row] = await tx
      .select({ total: sumOf(usageLedger.costMicros) })
      .from(usageLedger)
      .where(eq(usageLedger.runId, query.runId));
    return row?.total ?? 0;
  },

  async heldOfRun(tx, query) {
    const rows = await tx
      .select({
        ...reservationColumns,
        stepNumber: executionSteps.stepNumber,
        stepState: executionSteps.state,
        stepAttempt: executionSteps.attempt,
        stepKind: executionSteps.kind,
      })
      .from(budgetReservations)
      .innerJoin(
        executionSteps,
        and(
          eq(executionSteps.organizationId, budgetReservations.organizationId),
          eq(executionSteps.id, budgetReservations.stepId),
        ),
      )
      .where(
        and(
          eq(budgetReservations.runId, query.runId),
          eq(budgetReservations.status, 'held'),
          isNull(budgetReservations.modelCallId),
        ),
      )
      .orderBy(asc(budgetReservations.stepId), asc(budgetReservations.budgetId));
    return rows.map((row) => ({ ...row, ...asReservation(row) }));
  },
};

/** For `closeRunReservations`, which works inside the caller's transaction and never opens its own. */
const noOwnTransactions: LedgerScope = {
  inTenant: () => {
    throw new Error('closing a run opens no transaction of its own');
  },
  now: () => new Date(),
};

export function createUsageLedger(database: AppDatabase): UsageLedger {
  const actual = ledgerOver(sqlStore, {
    inTenant: (context, fn) => withTenantTx(database, context, fn),
    now: () => new Date(),
  });
  return {
    ...actual,
    async reserve(tx, context, request) {
      assertOwnRun(context, request.runId);
      if (!wholeAmount(request.amountMicros)) throw new AppError('INVALID_INPUT');
      const proof = await tx.execute<{ allowed: boolean }>(
        sql`select ai.main_reservation_admitted(${request.runId}::uuid,${request.stepId}::uuid,${request.attempt},${request.amountMicros}::bigint) allowed`,
      );
      if (proof.rows[0]?.allowed !== true) throw new AppError('POLICY_DENIED');
      return actual.reserve(tx, context, request);
    },
  };
}
