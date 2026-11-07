import type { AppDatabase, Tx } from '@ensemus/database';
import { sql } from 'drizzle-orm';

const EMPTY_BINDINGS = {
  'app.organization_id': '',
  'app.user_id': '',
  'app.membership_id': '',
  'app.actor_type': '',
  'app.agent_run_id': '',
  'app.agent_input_protocol': '',
  'app.knowledge_model_protocol': '',
  'app.interactive_session_id': '',
  'app.invitation_token_hash': '',
  'app.webhook_token_hash': '',
  'app.scim_token_hash': '',
  'app.sso_provider_id': '',
  'app.studio_simulation_id': '',
  'app.portability_export_id': '',
  'app.portability_import_id': '',
  'app.portability_part_path': '',
  'app.portability_part_sha256': '',
};

/** Join an existing transaction through real savepoints. Successful SET LOCAL statements survive
 * RELEASE SAVEPOINT, so explicitly restore every binding before returning to the outer actor. Errors
 * roll back the savepoint, including its bindings. No context or authority is constructed here. */
export function databaseInTransaction(tx: Tx): AppDatabase {
  const transaction = <T>(
    bindings: Record<string, string>,
    fn: (nested: Tx) => Promise<T>,
  ): Promise<T> =>
    tx.transaction(async (nested) => {
      const applied = { ...EMPTY_BINDINGS, ...bindings },
        previous = new Map<string, string>();
      for (const [name, value] of Object.entries(applied)) {
        const result = await nested.execute<{ value: string | null }>(
          sql`select current_setting(${name},true) as value`,
        );
        previous.set(name, result.rows[0]?.value ?? '');
        await nested.execute(sql`select set_config(${name},${value},true)`);
      }
      const result = await fn(nested);
      for (const [name, value] of previous)
        await nested.execute(sql`select set_config(${name},${value},true)`);
      return result;
    });
  // The facade supplies AppDatabase's two public methods; it never exposes a raw Drizzle handle.
  return {
    transaction,
    run: <T>(fn: (nested: Tx) => Promise<T>) => transaction({}, fn),
  } as AppDatabase;
}
