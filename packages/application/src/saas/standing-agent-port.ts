import type { TenantContext, Tx } from '@ensemus/database';
import { KILL_SWITCH_ENGAGED, KILL_SWITCH_RELEASED } from '@ensemus/domain/ai-events';
import { sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import type { AgentHaltPort } from './ports';

/** Only the exact standing transition's retained SQL receipt may create or release these stops. */
export function createStandingAgentHaltPort(): AgentHaltPort {
  const change = async (tx: Tx, context: TenantContext, reasonCode: string, release: boolean) => {
    if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode)) throw new AppError('INVALID_INPUT');
    const result = await tx.execute<{ switch_id: string | null; changed: boolean }>(
      sql`select * from lifecycle.standing_agent_stop(${reasonCode},${release})`,
    );
    if (
      !result.rows.length ||
      result.rows.some(
        (row) =>
          typeof row.changed !== 'boolean' ||
          (row.switch_id !== null && !idSchema.safeParse(row.switch_id).success) ||
          (row.changed && row.switch_id === null),
      )
    )
      throw new AppError('PREREQUISITES_INCOMPLETE');
    for (const row of result.rows) {
      if (!row.changed || !row.switch_id) continue;
      await emit(tx, context, {
        eventType: release ? KILL_SWITCH_RELEASED : KILL_SWITCH_ENGAGED,
        aggregateType: 'kill_switch',
        aggregateId: row.switch_id,
        aggregateVersion: release ? 2 : 1,
        classification: 'internal',
        payload: { scope: 'organization', targetRef: null, reasonCode: 'TENANT_STANDING' },
      });
    }
  };
  return {
    haltTenantAgents: (tx, context, reason) => change(tx, context, reason, false),
    releaseTenantAgents: (tx, context, reason) => change(tx, context, reason, true),
  };
}
