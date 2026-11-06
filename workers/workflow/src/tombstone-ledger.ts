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
/**
 * How long one batch may spend writing entries before the rest of it waits for their retry. A store
 * that answers slowly never fails, so nothing else stops it holding up the Temporal signals behind it,
 * one event at a time. This is about as long as one Temporal call may take.
 */
const BATCH_BUDGET_MS = 10_000;

export function createLedgerWriter(
  store: {
    exists(key: string): Promise<boolean>;
    put(key: string, body: Buffer, mimeType: string): Promise<void>;
  },
  now: () => number = Date.now,
) {
  let downUntil = 0;
  let spent = 0;
  const write = async (event: DispatchableEvent) => {
    const entry = {
      organizationId: event.organizationId,
      targetType: event.aggregateType,
      targetId: event.aggregateId,
      deletedAt: event.occurredAt,
    };
    // Outside the try: an event that cannot become an entry is at fault itself, and goes dead visibly.
    const key = ledgerKeyFor(entry);
    const body = serializeLedgerEntry(entry);
    if (now() < downUntil || spent >= BATCH_BUDGET_MS) throw new LedgerUnavailable();
    const started = now();
    try {
      // Delivery is at least once. The first write stands, so an entry is never changed.
      if (!(await store.exists(key))) await store.put(key, body, 'application/json');
    } catch (error) {
      downUntil = now() + STORE_DOWN_MS;
      throw new LedgerUnavailable(undefined, { cause: error });
    } finally {
      spent += now() - started;
    }
  };
  return Object.assign(write, {
    /** A new batch has a new budget. */
    startBatch: () => {
      spent = 0;
    },
  });
}
