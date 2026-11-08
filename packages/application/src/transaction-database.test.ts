// This checks savepoint binding bookkeeping only, not PostgreSQL role/security acceptance.
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Tx } from '@ensemus/database';
import { describe, expect, it } from 'vitest';
import { databaseInTransaction } from './transaction-database';

const paymentKeys = [
  'billing.payment_org',
  'billing.payment_control_org',
  'billing.payment_route_processor',
  'billing.payment_route_identity',
  'billing.payment_route_customer',
  'billing.payment_target_org',
  'billing.payment_target_account',
  'billing.payment_webhook_token',
] as const;

function savepoints() {
  const state = new Map<string, string>(paymentKeys.map((key, index) => [key, `outer-${index}`]));
  const dialect = new PgDialect();
  const tx = {
    async execute(query: SQL) {
      const parsed = dialect.sqlToQuery(query);
      const key = parsed.params[0];
      if (typeof key !== 'string') throw new Error('TEST_EXPECTED_FIXED_SETTING_KEY');
      if (parsed.sql.includes('current_setting'))
        return { rows: [{ value: state.get(key) ?? '' }] };
      if (parsed.sql.includes('set_config') && typeof parsed.params[1] === 'string') {
        state.set(key, parsed.params[1]);
        return { rows: [] };
      }
      throw new Error('TEST_UNEXPECTED_SQL');
    },
    async transaction<T>(fn: (nested: Tx) => Promise<T>): Promise<T> {
      const previous = new Map(state);
      try {
        return await fn(tx as unknown as Tx);
      } catch (error) {
        state.clear();
        for (const [key, value] of previous) state.set(key, value);
        throw error;
      }
    },
  };
  return { state, tx: tx as unknown as Tx };
}

describe('payment selector savepoint composition', () => {
  it('clears all private payment selectors for the nested actor and restores them after success', async () => {
    const { state, tx } = savepoints(),
      initial = new Map(state);
    expect(
      await databaseInTransaction(tx).transaction(
        { 'app.actor_type': 'service' },
        async (nested) => {
          for (const key of paymentKeys) expect(state.get(key)).toBe('');
          await nested.execute(
            sql`select set_config(${'billing.payment_webhook_token'},${'nested-token'},true)`,
          );
          return 'saved';
        },
      ),
    ).toBe('saved');
    for (const key of paymentKeys) expect(state.get(key)).toBe(initial.get(key));
  });
  it('restores the outer selectors through savepoint rollback after a nested failure', async () => {
    const { state, tx } = savepoints(),
      initial = new Map(state);
    await expect(
      databaseInTransaction(tx).run(async (nested) => {
        for (const key of paymentKeys) expect(state.get(key)).toBe('');
        await nested.execute(sql`select set_config(${'billing.payment_org'},${'nested-org'},true)`);
        throw new Error('TEST_NESTED_PAYMENT_FAILURE');
      }),
    ).rejects.toThrow('TEST_NESTED_PAYMENT_FAILURE');
    for (const key of paymentKeys) expect(state.get(key)).toBe(initial.get(key));
  });
});
