import type { TenantContext, Tx } from '@ensemus/database';
import { KILL_SWITCH_ENGAGED, KILL_SWITCH_RELEASED } from '@ensemus/domain/ai-events';
import { sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { emit } from '../events';
import type { OffboardingAgentHaltPort,TenantExportPort } from './ports';

/** One actual native-admitted offboarding owns one durable M4 organization stop. */
export function createOffboardingAgentHaltPort(): OffboardingAgentHaltPort {
  const change = async (tx:Tx,context:TenantContext,offboardingId:string,release:boolean) => {
    if(context.actorType!=='service' && context.actorType!=='user') throw new AppError('FORBIDDEN');
    const result=await tx.execute<{switch_id:string|null;changed:boolean}>(
      sql`select * from lifecycle.offboarding_agent_stop(${offboardingId}::uuid,${release})`,
    );
    const row=result.rows[0];
    if(!row) throw new AppError('PREREQUISITES_INCOMPLETE');
    if(row.changed && row.switch_id) await emit(tx,context,{
      eventType:release?KILL_SWITCH_RELEASED:KILL_SWITCH_ENGAGED,aggregateType:'kill_switch',
      aggregateId:row.switch_id,aggregateVersion:release?2:1,classification:'internal',
      payload:{scope:'organization',targetRef:null,reasonCode:'TENANT_OFFBOARDING'},
    });
  };
  return {
    haltOffboardingAgents:(tx,context,id)=>change(tx,context,id,false),
    releaseOffboardingAgents:(tx,context,id)=>change(tx,context,id,true),
  };
}

/** A pointer to an actual completed archive, never a download or imported authority. */
export function createOffboardingExportPort():TenantExportPort {
 return {async latestExport(tx) {
  const result=await tx.execute<{id:string|null}>(sql`select lifecycle.offboarding_latest_export() as id`);
  const row=result.rows[0];if(!row)throw new AppError('PREREQUISITES_INCOMPLETE');
  return row.id?{exportRef:`organization_export:${row.id}`}:null;
 }};
}
