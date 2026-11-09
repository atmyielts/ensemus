import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { replyAsDesk, requestBreakGlass, SupportContentBusy, type DeskDb } from './support-desk';
const input = {
  organizationId: randomUUID(),
  ticketId: randomUUID(),
  agentRef: 'test-desk@example.invalid',
  body: 'Test reply',
};

/** A desk transaction that records, in order, every statement the desk command sends. */
function recordingDesk(organizationId: string, ticketId: string) {
  const dialect = new PgDialect(),
    steps: string[] = [],
    row = { id: ticketId, organizationId, status: 'open', firstResponseAt: null, version: 1 },
    written = () =>
      Object.assign(Promise.resolve(undefined), {
        returning: async () => [{ id: randomUUID() }],
      });
  const tx = {
    execute: async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      if (sql.includes('current_user')) {
        steps.push('role');
        return { rows: [{ role: 'ensemus_support' }] };
      }
      // Placeholders are spelled :pN here, so this file names no currency-like token.
      const text = sql.replace(/\$(\d+)/g, (_, position: string) => `:p${position}`);
      steps.push(`execute ${text} ${JSON.stringify(params)}`);
      return { rows: [] };
    },
    select: () => ({
      from: () => ({
        where: () => ({
          for: async (strength: string) => {
            steps.push(`lock ticket ${strength}`);
            return [row];
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => {
        steps.push('insert');
        return written();
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          steps.push('update');
        },
      }),
    }),
  };
  const db = { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  return { db: db as unknown as DeskDb, steps };
}
const binding = (organizationId: string) =>
  `execute select set_config('app.organization_id', :p1, true) ${JSON.stringify([organizationId])}`;

describe('desk writes bind the tenant of the ticket they locked (0533)', () => {
  it('binds the reply transaction before the message is born', async () => {
    const desk = recordingDesk(input.organizationId, input.ticketId);
    await replyAsDesk(desk.db, input);
    expect(desk.steps).toEqual([
      'role',
      'lock ticket update',
      binding(input.organizationId),
      'insert',
      'update',
    ]);
  });
  it('binds the break-glass transaction before the request and its log are born', async () => {
    const desk = recordingDesk(input.organizationId, input.ticketId);
    await requestBreakGlass(
      desk.db,
      {
        organizationId: input.organizationId,
        ticketId: input.ticketId,
        requestedBy: input.agentRef,
        reasonCode: 'TEST_REASON',
        scopeType: 'artifact',
        scopeId: randomUUID(),
        requestedMinutes: 5,
      },
      { enabled: true, maxMinutes: 10 },
    );
    expect(desk.steps).toEqual([
      'role',
      'lock ticket update',
      binding(input.organizationId),
      'insert',
      'insert',
    ]);
  });
});
describe('desk fence contention does not cause automatic replay', () => {
  it('maps only the explicit fixed fence code to a plain retryable busy result', async () => {
    const transaction = vi.fn().mockRejectedValue({ cause: { code: 'EN807' } });
    const failure = await replyAsDesk({ transaction } as unknown as DeskDb, input).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SupportContentBusy);
    expect(failure).toMatchObject({
      code: 'SUPPORT_CONTENT_BUSY',
      retryable: true,
      message: 'This organization is being updated. Try again.',
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it.each(['55P03', '25006', '42501'])('preserves unrelated database refusal %s', async (code) => {
    const original = { cause: { code } },
      transaction = vi.fn().mockRejectedValue(original);
    await expect(replyAsDesk({ transaction } as unknown as DeskDb, input)).rejects.toBe(original);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
