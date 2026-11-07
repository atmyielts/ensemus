import { sql } from 'drizzle-orm';
import type { Tx } from '@ensemus/database';
import { queryRows } from './portability-sql';

const keys = [
  'app.portability_export_id',
  'app.portability_import_id',
  'app.portability_part_path',
  'app.portability_part_sha256',
] as const;
type ScopeKey = (typeof keys)[number];

/** UUIDs identify intents, not credentials: SQL verifies the actual actor, owner and immutable pins.
 * A real savepoint restores scope on rollback without querying an aborted transaction. */
export async function withPortabilityScope<T>(
  tx: Tx,
  bindings: Partial<Record<ScopeKey, string>>,
  run: (scoped: Tx) => Promise<T>,
): Promise<T> {
  const previous = await queryRows<{ name: string; value: string | null }>(
    tx,
    sql`select name,current_setting(name,true) as value from unnest(${sql.param([...keys])}::text[]) name`,
  );
  return tx.transaction(async (scoped) => {
    for (const key of keys)
      await scoped.execute(sql`select set_config(${key},${bindings[key] ?? ''},true)`);
    const result = await run(scoped);
    for (const old of previous)
      await scoped.execute(sql`select set_config(${old.name},${old.value ?? ''},true)`);
    return result;
  });
}
