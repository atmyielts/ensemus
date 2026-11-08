import { randomUUID } from 'node:crypto';
import type { TenantContext, Tx } from '@ensemus/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, it, expect, vi } from 'vitest';
import { createUsageLedgerReader } from './usage-reader';
import { UsageUnavailable } from './ports';

const context = { organizationId: randomUUID() } as TenantContext;
const reader = createUsageLedgerReader();
const ledger = () => ({
  id: randomUUID(),
  meter: 'model_input_tokens',
  unit: 'token',
  quantity: '9007199254740993',
  cost_micros: '9007199254740995',
  status: 'estimated',
  billable: true,
  occurred_at: '2026-11-01T12:30:00.123456Z',
  corrects_id: null,
});
describe('M4 usage reader preserves exact ledger values and cursor position', () => {
  it('reconciles an unconsumed older row without moving the progress cursor backwards', async () => {
    const row = ledger();
    const laterId = randomUUID();
    const cursor = Buffer.from(JSON.stringify(['2026-11-02T12:30:00.123456Z', laterId])).toString(
      'base64url',
    );
    const execute = vi.fn().mockResolvedValue({ rows: [row] });
    const page = await reader.listSince({ execute } as unknown as Tx, context, {
      after: cursor,
      limit: 1,
    });
    expect(page.entries[0]!.id).toBe(row.id);
    expect(page.nextCursor).toBe(cursor);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toContain('not exists');
    expect(query.sql).toContain('c.organization_id=u.organization_id');
    expect(query.sql).toContain("c.idempotency_key='usage:' || u.id::text");
  });
  it('final pages retain a durable cursor with PostgreSQL microseconds', async () => {
    const row = ledger();
    const execute = vi.fn().mockResolvedValue({ rows: [row] });
    const tx = { execute } as unknown as Tx;
    const page = await reader.listSince(tx, context, { after: null, limit: 1 });
    expect(page).toMatchObject({
      more: false,
      entries: [{ id: row.id, quantity: 9007199254740993n, costMicros: 9007199254740995n }],
    });
    expect(JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString())).toEqual([
      row.occurred_at,
      row.id,
    ]);
    execute.mockResolvedValue({ rows: [] });
    await reader.listSince(tx, context, { after: page.nextCursor, limit: 1 });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[1]![0]);
    expect(query.params).toContain(row.occurred_at);
    expect(query.params).toContain(row.id);
    expect(query.params).toContain(context.organizationId);
  });
  it('a look-ahead row signals more without leaking it into the consumed page', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [ledger(), ledger()] });
    const result = await reader.listSince({ execute } as unknown as Tx, context, {
      after: null,
      limit: 1,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.more).toBe(true);
  });
  it('signed corrections retain their original ledger reference', async () => {
    const original = randomUUID();
    const row = {
      ...ledger(),
      quantity: '-11',
      cost_micros: null,
      status: 'correction',
      corrects_id: original,
    };
    const page = await reader.listSince(
      { execute: vi.fn().mockResolvedValue({ rows: [row] }) } as unknown as Tx,
      context,
      { after: null, limit: 1 },
    );
    expect(page.entries[0]).toMatchObject({
      quantity: -11n,
      status: 'correction',
      correctsUsageId: original,
      costMicros: null,
    });
  });
  it.each([0, -1, 1001, 1.5])('bad page limit %s touches no ledger', async (limit) => {
    const execute = vi.fn();
    await expect(
      reader.listSince({ execute } as unknown as Tx, context, { after: null, limit }),
    ).rejects.toBeInstanceOf(UsageUnavailable);
    expect(execute).not.toHaveBeenCalled();
  });
  it('bad cursors and missing ledger fail closed with a safe error', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('TEST_PRIVATE_DATABASE_TEXT'));
    await expect(
      reader.listSince({ execute } as unknown as Tx, context, { after: 'not-a-cursor', limit: 1 }),
    ).rejects.toThrow('USAGE_UNAVAILABLE');
    expect(execute).not.toHaveBeenCalled();
    await expect(
      reader.listSince({ execute } as unknown as Tx, context, { after: null, limit: 1 }),
    ).rejects.toThrow('USAGE_UNAVAILABLE');
  });
  it('period totals are exact billable signed sums and the end is excluded', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ meter: 'model_output_tokens', unit: 'token', quantity: '9007199254740993' }],
    });
    const from = new Date('2026-11-01T00:00:00Z');
    const to = new Date('2026-12-01T00:00:00Z');
    expect(await reader.sumForPeriod({ execute } as unknown as Tx, context, { from, to })).toEqual([
      { meter: 'model_output_tokens', unit: 'token', quantity: 9007199254740993n },
    ]);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toContain('billable=true');
    expect(query.params).toEqual([context.organizationId, from.toISOString(), to.toISOString()]);
    await expect(
      reader.sumForPeriod({ execute } as unknown as Tx, context, { from: to, to: from }),
    ).rejects.toBeInstanceOf(UsageUnavailable);
  });
});
