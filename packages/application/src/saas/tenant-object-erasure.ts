import { withTenantTx, type AppDatabase, type TenantContext } from '@ensemus/database';
import { sql } from 'drizzle-orm';
import { purgeDueBlobs, type ObjectStore } from '../artifacts';
import { createImportedArchivePurge } from '../portability-archive-files';
import { AppError } from '../errors';
import { createObjectDeletionLifecycle } from './object-deletion';

export type ErasureObjectStore = ObjectStore & {listPages(prefix:string):AsyncIterable<readonly string[]>};
const count=(value:unknown)=>{
  const n=typeof value==='string' && /^\d+$/.test(value)?Number(value):value;
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0) throw new AppError('PREREQUISITES_INCOMPLETE');
  return n;
};
/** Physical cleanup has independent positive writer/delete/hold proofs. A count is never a provider proof. */
export function createTenantObjectErasure(deps:{database:AppDatabase;store:ErasureObjectStore}) {
  const lifecycle=createObjectDeletionLifecycle(deps);
  const archive=createImportedArchivePurge({...deps,lifecycle:lifecycle.archive});
  const assertIntent=async(context:TenantContext,offboardingId:string)=>{
    if(context.actorType!=='service') throw new AppError('FORBIDDEN');
    await withTenantTx(deps.database,context,async(tx)=>{
      const result=await tx.execute<{allowed:boolean}>(sql`select lifecycle.erasure_object_intent(${offboardingId}::uuid) as allowed`);
      if(result.rows[0]?.allowed!==true) throw new AppError('PREREQUISITES_INCOMPLETE');
    });
  };
  return {
    async purge(context:TenantContext,input:{offboardingId:string;limit?:number}) {
      await assertIntent(context,input.offboardingId);
      const limit=input.limit??25;
      if(!Number.isSafeInteger(limit)||limit<1||limit>25) throw new AppError('INVALID_INPUT');
      // Fair bounded allocation: at most25 ordinary/generated +25 inert archive files per call.
      const files=await purgeDueBlobs(deps.database,deps.store,context,new Date(),limit);
      const archives=await archive.purgeTenant(context,{limit});
      const counters=await withTenantTx(deps.database,context,async(tx)=>{
        const result=await tx.execute<{unconfirmed:number}>(sql`select unconfirmed from lifecycle.object_delete_counts()`);
        return count(result.rows[0]?.unconfirmed);
      });
      return {files,archives,unconfirmedDeletes:counters};
    },
    async confirm(context:TenantContext,input:{offboardingId:string}) {
      await assertIntent(context,input.offboardingId);
      const result=await withTenantTx(deps.database,context,async(tx)=>{
        const proof=await tx.execute<{ready:boolean}>(sql`select lifecycle.erasure_object_proofs(${input.offboardingId}::uuid) as ready`);
        return proof.rows[0]?.ready===true;
      });
      // Includes unregistered objects and export/other namespaces whose real cleanup is still owed.
      // They remain explicit attention, never silently deleted or qualified by an empty SQL inventory.
      let objectsRemaining=0;
      for await(const page of deps.store.listPages(`${context.organizationId}/`)) {
        for(const key of page) {
          if(!key.startsWith(`${context.organizationId}/`)) throw new AppError('PREREQUISITES_INCOMPLETE');
          objectsRemaining+=1;
          if(!Number.isSafeInteger(objectsRemaining)) throw new AppError('PREREQUISITES_INCOMPLETE');
        }
      }
      return {confirmed:result&&objectsRemaining===0,objectsRemaining};
    },
  };
}
