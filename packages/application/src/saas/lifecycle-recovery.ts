import { artifactLineage,withTenantTx } from '@ensemus/database';
import { eq,sql,and,asc,gt } from 'drizzle-orm';
import { createArchiveQuarantineRecovery } from '../portability-archive-files';
import { purgeDueBlobs } from '../artifacts';
import type { RestoreRecoveryBindings } from '../restore-contributors';
import type { ErasureObjectStore } from './tenant-object-erasure';

/** Real metadata/storage recovery, with no agent-role payload access and no successful missing port.
 * External restore-writer uncertainty is retained as debt; this module never invents a fence. */
export function createLifecycleRecoveryBindings(store:ErasureObjectStore):RestoreRecoveryBindings {
  const archive=createArchiveQuarantineRecovery(store);
  return {
    'm6-archive-quarantine':{
      async reconcile(database,context) {
        const result=await archive.reconcile(database,context);
        const debt=await withTenantTx(database,context,tx=>tx.execute<{unconfirmed:number}>(
          sql`select unconfirmed from lifecycle.object_delete_counts()`,
        ));
        const n=debt.rows[0]?.unconfirmed;
        if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)throw new Error('RESTORE_METADATA_UNAVAILABLE');
        return {...result,needsAttention:result.needsAttention+n};
      },
    },
    'm5-derived-artifacts':{
      async reconcile(database,context) {
        let checked=0,needsAttention=0;
        let after:string|null=null;
        for(;;) {
        const rows=await withTenantTx(database,context,tx=>tx.select({id:artifactLineage.artifactId,
          objectKey:artifactLineage.objectKey,purgedAt:artifactLineage.physicalPurgedAt,
        }).from(artifactLineage).where(after?gt(artifactLineage.artifactId,after):undefined).orderBy(asc(artifactLineage.artifactId)).limit(100));
        for(const row of rows) {
          checked+=1;if(!row.purgedAt)continue;
          try {
            if(await store.exists(row.objectKey)) {
              needsAttention+=1;
              await withTenantTx(database,context,tx=>tx.update(artifactLineage).set({restoreReapplyPending:true})
                .where(and(eq(artifactLineage.organizationId,context.organizationId),eq(artifactLineage.artifactId,row.id))));
            }
          } catch {needsAttention+=1;}
        }
        const last=rows.at(-1);if(rows.length<100||!last)break;after=last.id;
        }
        // Exact settled writers may finish ordinary pending disposal. Unknown/restored writers refuse.
        const changed=await purgeDueBlobs(database,store,context,new Date(),25);
        needsAttention+=changed.failed;
        return {checked,changed:changed.purged,needsAttention};
      },
    },
  };
}
