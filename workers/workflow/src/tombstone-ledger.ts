// Writes the tombstone ledger (ADR-026). An entry is built from outbox event metadata alone, because
// that is all the dispatcher's database role can see, and it is all an entry may hold.
import type { DispatchableEvent } from '@ensemus/database/dispatcher';
import { ledgerKeyFor, serializeLedgerEntry } from '@ensemus/domain/tombstone-ledger';

/** The store refused or did not answer. Nothing is wrong with the event, so it costs no attempt. */
export class LedgerUnavailable extends Error {
  override name = 'LedgerUnavailable';
}

/** After a failure, how long the rest are refused without asking, so a dead store costs one wait. */
const STORE_DOWN_MS = 30_000;

export function createLedgerWriter(
  store: {
    exists(key: string): Promise<boolean>;
    put(key: string, body: Buffer, mimeType: string): Promise<void>;
  },
  now: () => number = Date.now,
) {
  let downUntil = 0;
  return async (event: DispatchableEvent) => {
    const entry = {
      organizationId: event.organizationId,
      targetType: event.aggregateType,
      targetId: event.aggregateId,
      deletedAt: event.occurredAt,
    };
    // Outside the try: an event that cannot become an entry is at fault itself, and goes dead visibly.
    const key = ledgerKeyFor(entry);
    const body = serializeLedgerEntry(entry);
    if (now() < downUntil) throw new LedgerUnavailable();
    try {
      // Delivery is at least once. The first write stands, so an entry is never changed.
      if (!(await store.exists(key))) await store.put(key, body, 'application/json');
    } catch (error) {
      downUntil = now() + STORE_DOWN_MS;
      throw new LedgerUnavailable(undefined, { cause: error });
    }
  };
}
