// For the outbox dispatcher only (lint blocks this elsewhere). Its role crosses tenants, and sees
// event metadata and outbox state, never payloads or actors (ADR-024 D4).
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { domainEvents, outboxEvents } from './schema';

export type DispatchableEvent = {
  organizationId: string;
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  attempts: number;
};

export function openDispatcherDatabase(url: string) {
  return openDatabase(url, { max: 2 });
}

const MAX_ATTEMPTS = 12;
/** At the backoff's 5-minute cap, about a day before an event that keeps failing this way goes dead. */
const AMBIGUOUS_MAX_ATTEMPTS = 288;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;
/** How long a claim lasts. A crash leaves the event due again after this, with nothing to clean up. */
const CLAIM_LEASE_MS = 2 * 60 * 1_000;
/** How soon to try again during an outage. It costs no attempt, so a long outage loses no events. */
const TRANSIENT_RETRY_MS = 30 * 1_000;

/** Exponential backoff with jitter, capped. Exported for testing. */
export function nextAttemptDelayMs(attempts: number, random = Math.random()): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
  return Math.round(ceiling / 2 + (random * ceiling) / 2);
}

/**
 * - `outage`: something this depends on is down, which says nothing about the event.
 * - `ambiguous`: it could be either, so it counts, but is given far longer before going dead.
 * - `fault`: the event itself is at fault.
 */
export type DeliveryFailure = 'outage' | 'ambiguous' | 'fault';

export type ClaimResult = {
  handled: number;
  /** Failed for a reason that may be specific to the event. These count towards going dead. */
  failed: number;
  /** Failed because something this depends on is down. These never count, and never go dead. */
  deferred: number;
  dead: number;
};

export type DispatchOptions = {
  limit?: number;
  /** Whether a failure says something is down, or that this event is at fault. */
  classify?: (error: unknown) => DeliveryFailure;
  /** How long a claim lasts. Only tests have a reason to shorten it. */
  leaseMs?: number;
  /** Called after each event, with what went wrong if anything did. */
  onEvent?: (error?: unknown) => void;
  /** Checked between events, so stopping does not have to wait for the batch. */
  shouldStop?: () => boolean;
};

/**
 * Takes up to a batch of due events in one short transaction, by pushing their next attempt out. No
 * transaction stays open while Temporal is called, so a slow or absent server holds no locks.
 */
async function claimDueEvents(db: EnsemusDrizzle, limit: number, leaseUntil: Date) {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({
        organizationId: outboxEvents.organizationId,
        eventId: outboxEvents.eventId,
        attempts: outboxEvents.attempts,
      })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.state, 'queued'), lte(outboxEvents.nextAttemptAt, sql`now()`)))
      .orderBy(asc(outboxEvents.nextAttemptAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (due.length === 0) return { due, metadata: [] };
    for (const { organizationId, eventId } of due) {
      await tx
        .update(outboxEvents)
        .set({ nextAttemptAt: leaseUntil })
        .where(
          and(eq(outboxEvents.organizationId, organizationId), eq(outboxEvents.eventId, eventId)),
        );
    }
    const metadata = await tx
      .select({
        organizationId: domainEvents.organizationId,
        id: domainEvents.id,
        eventType: domainEvents.eventType,
        aggregateType: domainEvents.aggregateType,
        aggregateId: domainEvents.aggregateId,
        occurredAt: domainEvents.occurredAt,
      })
      .from(domainEvents)
      .where(
        inArray(
          domainEvents.id,
          due.map((d) => d.eventId),
        ),
      )
      .orderBy(asc(domainEvents.occurredAt));
    return { due, metadata };
  });
}

/**
 * Delivers due events at least once, and records each outcome in its own statement. A crash after
 * delivery delivers it again when the claim runs out, so handlers must be idempotent. An event that
 * keeps failing goes dead, visibly, and stops retrying. An outage is not the event's fault: it costs
 * no attempts, and the rest of the batch waits rather than taking a timeout each. An ambiguous failure
 * could be either, so it holds nothing else up and is given about a day, which is longer than an
 * outage is likely to last and still ends visibly if the event is what is wrong.
 */
export async function dispatchDueEvents(
  db: EnsemusDrizzle,
  handler: (event: DispatchableEvent) => Promise<void>,
  options: DispatchOptions = {},
): Promise<ClaimResult> {
  const result: ClaimResult = { handled: 0, failed: 0, deferred: 0, dead: 0 };
  const { due, metadata } = await claimDueEvents(
    db,
    options.limit ?? 50,
    new Date(Date.now() + (options.leaseMs ?? CLAIM_LEASE_MS)),
  );
  const key = (organizationId: string, id: string) => `${organizationId}/${id}`;
  const attemptsById = new Map(due.map((d) => [key(d.organizationId, d.eventId), d.attempts]));
  const classify = options.classify ?? ((): DeliveryFailure => 'fault');
  let holding = false;

  for (const event of metadata) {
    const attempts = attemptsById.get(key(event.organizationId, event.id));
    if (attempts === undefined) continue;
    const where = and(
      eq(outboxEvents.organizationId, event.organizationId),
      eq(outboxEvents.eventId, event.id),
    );
    // Stopping or an outage hands the rest back right away, instead of leaving them leased. Due means
    // due by the database's clock, so "now" is its clock too: this one can run a little ahead.
    if (holding || options.shouldStop?.()) {
      await db
        .update(outboxEvents)
        .set({ nextAttemptAt: holding ? new Date(Date.now() + TRANSIENT_RETRY_MS) : sql`now()` })
        .where(where);
      if (holding) result.deferred += 1;
      continue;
    }
    try {
      await handler({
        organizationId: event.organizationId,
        eventId: event.id,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        attempts,
      });
      await db
        .update(outboxEvents)
        .set({ state: 'published', attempts: attempts + 1 })
        .where(where);
      result.handled += 1;
      options.onEvent?.();
    } catch (error) {
      options.onEvent?.(error);
      const failure = classify(error);
      if (failure === 'outage') {
        holding = true;
        await db
          .update(outboxEvents)
          .set({ nextAttemptAt: new Date(Date.now() + TRANSIENT_RETRY_MS) })
          .where(where);
        result.deferred += 1;
        continue;
      }
      const next = attempts + 1;
      if (next >= (failure === 'ambiguous' ? AMBIGUOUS_MAX_ATTEMPTS : MAX_ATTEMPTS)) {
        await db.update(outboxEvents).set({ state: 'dead', attempts: next }).where(where);
        result.dead += 1;
      } else {
        await db
          .update(outboxEvents)
          .set({
            attempts: next,
            nextAttemptAt: new Date(Date.now() + nextAttemptDelayMs(next)),
          })
          .where(where);
        result.failed += 1;
      }
    }
  }
  return result;
}

/**
 * Puts dead events back in the queue with a clean count, for an operator who has fixed the cause.
 * Handlers are idempotent, so redelivering something that half worked is safe.
 */
export async function redriveDeadEvents(
  db: EnsemusDrizzle,
  options: { organizationId?: string } = {},
): Promise<number> {
  const redriven = await db
    .update(outboxEvents)
    .set({ state: 'queued', attempts: 0, nextAttemptAt: sql`now()` })
    .where(
      and(
        eq(outboxEvents.state, 'dead'),
        options.organizationId
          ? eq(outboxEvents.organizationId, options.organizationId)
          : undefined,
      ),
    )
    .returning({ eventId: outboxEvents.eventId });
  return redriven.length;
}

/** Every organization ever created, from event metadata alone, so its schedule can be checked. */
export async function listOrganizationIds(db: EnsemusDrizzle): Promise<string[]> {
  const rows = await db
    .selectDistinct({ organizationId: domainEvents.organizationId })
    .from(domainEvents)
    .where(eq(domainEvents.eventType, 'organization.created'));
  return rows.map((row) => row.organizationId);
}

/** Operators' view of the backlog: a number and an age, with no tenant content. */
export async function outboxBacklog(db: EnsemusDrizzle) {
  const [row] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${outboxEvents.state} = 'queued')::int`,
      dead: sql<number>`count(*) filter (where ${outboxEvents.state} = 'dead')::int`,
    })
    .from(outboxEvents);
  return row ?? { queued: 0, dead: 0 };
}
