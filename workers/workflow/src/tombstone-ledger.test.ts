import type { DispatchableEvent } from '@ensemus/database/dispatcher';
import { parseLedgerEntry } from '@ensemus/domain/tombstone-ledger';
import { errorCode } from '@ensemus/telemetry';
import { describe, expect, it } from 'vitest';
import { classifyDeliveryError } from './dispatch-errors';
import { createLedgerWriter, LedgerUnavailable } from './tombstone-ledger';

const event: DispatchableEvent = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  eventId: '33333333-3333-4333-8333-333333333333',
  eventType: 'tombstone.recorded',
  aggregateType: 'artifact',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  occurredAt: new Date('2026-11-06T10:00:00.000Z'),
  attempts: 0,
};

function memory() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    puts: 0,
    asks: 0,
    failing: false,
    async exists(key: string) {
      this.asks += 1;
      if (this.failing) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
      return objects.has(key);
    },
    async put(key: string, body: Buffer) {
      this.puts += 1;
      objects.set(key, body);
    },
  };
}

describe('writing the tombstone ledger', () => {
  it('writes one valid entry from the event metadata', async () => {
    const store = memory();
    await createLedgerWriter(store)(event);
    const [[key, body]] = [...store.objects] as [[string, Buffer]];
    expect(parseLedgerEntry(key, body.toString())).toEqual({
      organizationId: event.organizationId,
      targetType: 'artifact',
      targetId: event.aggregateId,
      deletedAt: event.occurredAt,
    });
  });

  it('keeps the first write when the same event arrives again', async () => {
    const store = memory();
    const write = createLedgerWriter(store);
    await write(event);
    const first = [...store.objects.values()][0]?.toString();
    await write({ ...event, occurredAt: new Date('2030-01-01T00:00:00.000Z'), attempts: 1 });
    expect(store.puts).toBe(1);
    expect([...store.objects.values()][0]?.toString()).toBe(first);
  });

  it('reports a store failure as something other than the event being at fault', async () => {
    const store = memory();
    store.failing = true;
    const failure = await createLedgerWriter(store)(event).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LedgerUnavailable);
    // The cause says ECONNREFUSED, which alone would be read as an outage and hold up other events.
    expect(classifyDeliveryError(failure)).toBe('partial_outage');
    // And what the log says is the real reason, which tells a refused credential from an outage.
    expect(errorCode(failure)).toBe('ECONNREFUSED');
  });

  it('stops asking a store that just failed, and asks again after a while', async () => {
    const store = memory();
    store.failing = true;
    let clock = 1_000;
    const write = createLedgerWriter(store, () => clock);
    await expect(write(event)).rejects.toBeInstanceOf(LedgerUnavailable);
    expect(store.asks).toBe(1);

    await expect(write(event)).rejects.toBeInstanceOf(LedgerUnavailable);
    expect(store.asks).toBe(1);

    store.failing = false;
    clock += 30_000;
    await write(event);
    expect(store.asks).toBe(2);
    expect(store.objects.size).toBe(1);
  });

  it('blames the event when it cannot become an entry, whatever the store is doing', async () => {
    const store = memory();
    const failure = await createLedgerWriter(store)({
      ...event,
      aggregateType: 'client',
    }).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(LedgerUnavailable);
    expect(classifyDeliveryError(failure)).toBe('fault');
    expect(store.asks).toBe(0);
  });
});
