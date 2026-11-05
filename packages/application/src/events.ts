import { randomUUID } from 'node:crypto';
import { domainEvents, outboxEvents, type TenantContext, type Tx } from '@ensemus/database';

export type EmittedEvent = {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  classification: string;
  /** Identifiers and enums only. Events travel to places documents may not. */
  payload: Record<string, string | number | boolean | null>;
  correlationId?: string;
  causationId?: string;
};

const EVENT_TYPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** Writes the fact and its outbox row in the caller's transaction, so neither exists alone. */
export async function emit(tx: Tx, context: TenantContext, event: EmittedEvent): Promise<string> {
  if (!EVENT_TYPE.test(event.eventType)) throw new Error('Invalid event type format');
  const id = randomUUID();
  await tx.insert(domainEvents).values({
    organizationId: context.organizationId,
    id,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    actorType: context.actorType === 'service' ? 'system' : 'membership',
    actorId: context.actorType === 'service' ? null : context.membershipId,
    classification: event.classification,
    payload: event.payload,
    correlationId: event.correlationId ?? id,
    causationId: event.causationId ?? null,
  });
  await tx.insert(outboxEvents).values({ organizationId: context.organizationId, eventId: id });
  return id;
}
