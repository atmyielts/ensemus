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
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;

/** Exponential backoff with jitter, capped. Exported for testing. */
export function nextAttemptDelayMs(attempts: number, random = Math.random()): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
  return Math.round(ceiling / 2 + (random * ceiling) / 2);
}

export type ClaimResult = { handled: number; failed: number; dead: number };

/**
 * Delivers due events at least once. Rows stay locked for the handler's duration, so several
 * dispatchers can run together, and a crash before commit simply leaves the row due. Handlers must
 * therefore be idempotent. An event that keeps failing goes dead, visibly, and stops retrying.
 */
export async function dispatchDueEvents(
  db: EnsemusDrizzle,
  handler: (event: DispatchableEvent) => Promise<void>,
  options: { limit?: number } = {},
): Promise<ClaimResult> {
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
      .limit(options.limit ?? 50)
      .for('update', { skipLocked: true });
    if (due.length === 0) return { handled: 0, failed: 0, dead: 0 };

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

    const result: ClaimResult = { handled: 0, failed: 0, dead: 0 };
    const key = (organizationId: string, id: string) => `${organizationId}/${id}`;
    const attemptsById = new Map(due.map((d) => [key(d.organizationId, d.eventId), d.attempts]));

    for (const event of metadata) {
      const eventKey = key(event.organizationId, event.id);
      const attempts = attemptsById.get(eventKey);
      if (attempts === undefined) continue;
      const where = and(
        eq(outboxEvents.organizationId, event.organizationId),
        eq(outboxEvents.eventId, event.id),
      );
      try {
        await handler({
          organizationId: event.organizationId,
          eventId: event.id,
          eventType: event.eventType,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          attempts,
        });
        await tx
          .update(outboxEvents)
          .set({ state: 'published', attempts: attempts + 1 })
          .where(where);
        result.handled += 1;
      } catch {
        const next = attempts + 1;
        if (next >= MAX_ATTEMPTS) {
          await tx.update(outboxEvents).set({ state: 'dead', attempts: next }).where(where);
          result.dead += 1;
        } else {
          await tx
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
  });
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
