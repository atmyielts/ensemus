import type { AppDatabase, Tx } from '@ensemus/database';
import { sql } from 'drizzle-orm';

const EMPTY_BINDINGS = {
  'app.organization_id': '',
  'app.user_id': '',
  'app.membership_id': '',
  'app.actor_type': '',
  'app.agent_run_id': '',
  'app.agent_input_protocol': '',
  'app.agent_scope_protocol': '',
  'app.knowledge_model_protocol': '',
  'app.model_job_id': '',
  'objects.soft_delete_record_id': '',
  'app.process_start_run_id': '',
  'app.process_start_spec_id': '',
  'app.process_step_run_id': '',
  'app.process_step_key': '',
  'app.interactive_session_id': '',
  'app.invitation_token_hash': '',
  'app.webhook_token_hash': '',
  'app.scim_token_hash': '',
  'app.sso_provider_id': '',
  'app.studio_simulation_id': '',
  'app.outcome_draft_id': '',
  'app.portability_export_id': '',
  'app.portability_import_id': '',
  'app.portability_part_path': '',
  'app.portability_part_sha256': '',
  'app.payment_customer_hash': '',
  'lifecycle.erasure_count_org': '',
  'lifecycle.standing_org': '',
  'billing.entitlement_org': '',
  'billing.payment_org': '',
  'billing.payment_control_org': '',
  'billing.payment_route_processor': '',
  'billing.payment_route_identity': '',
  'billing.payment_route_customer': '',
  'billing.payment_target_org': '',
  'billing.payment_target_account': '',
  'billing.payment_webhook_token': '',
  'sovereign.archive_source_proof': '',
  'lifecycle.delegated_hold_org': '',
  'lifecycle.delegated_hold_run': '',
  'lifecycle.delegated_hold_source': '',
  'lifecycle.delegated_hold_job': '',
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
