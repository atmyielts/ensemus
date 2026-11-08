// Generated fixtures only. Real app-role SQL proves admission/tenant/hold authority; the explicit
// private memory transport proves orchestration, not an external provider's physical deletion.
import { randomUUID } from 'node:crypto';
import { deleteArtifactInTx,pgCode } from '@ensemus/application';
import { createObjectDeletionExecutor,createSqlObjectDeletionAuthority } from '@ensemus/application/saas/object-deletion';
import { placeLegalHold } from '@ensemus/application/saas/legal-holds';
import { blobLifecycle,openAppDatabase,withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { lifecycleArtifact,lifecycleTenant,LifecycleMemoryStore } from './saas-lifecycle-fixture';
import { urls } from '../helpers/stack';

describe('actual tenant deletion and hold admission',()=>{
 const app=openAppDatabase(urls.app()),auth=new pg.Client({connectionString:urls.auth()});
 beforeAll(async()=>{await auth.connect();});
 afterAll(async()=>{await auth.end();await app.close();});
 const prepared=async()=>{
  const owner=await lifecycleTenant(app.db,auth),store=new LifecycleMemoryStore();
  const file=await lifecycleArtifact(app.db,owner,store);
  await withTenantTx(app.db,owner,tx=>deleteArtifactInTx(tx,owner,file));
  return {owner,store,file,service:createServiceContext(owner.organizationId)};
 };
 const execute=(store:LifecycleMemoryStore)=>createObjectDeletionExecutor({authority:createSqlObjectDeletionAuthority(app.db),store});
 it('honors any active hold before physical DELETE even when logical deletion predates it',async()=>{
  const f=await prepared(),remove=vi.spyOn(f.store,'deleteForPurge');
  await placeLegalHold(app.db,f.owner,{matterRef:randomUUID(),scopes:[{type:'organization',id:null}]});
  await expect(execute(f.store)(f.service,{kind:'ordinary',artifactId:f.file.artifactId})).resolves.toEqual({state:'held'});
  expect(remove).not.toHaveBeenCalled();
 });
 it('retains ambiguous DELETE debt, refuses a new hold, and never promotes by HEAD/retry',async()=>{
  const f=await prepared(),remove=vi.spyOn(f.store,'deleteForPurge').mockResolvedValue({transport:'unknown',capabilityVerified:false}),
   head=vi.spyOn(f.store,'isPhysicallyAbsent').mockResolvedValue(true),erase=execute(f.store);
  await expect(erase(f.service,{kind:'ordinary',artifactId:f.file.artifactId})).resolves.toEqual({state:'unconfirmed'});
  await expect(erase(f.service,{kind:'ordinary',artifactId:f.file.artifactId})).resolves.toEqual({state:'unconfirmed'});
  expect(remove).toHaveBeenCalledTimes(1);expect(head).not.toHaveBeenCalled();
  const refusal=await placeLegalHold(app.db,f.owner,{matterRef:randomUUID(),scopes:[{type:'organization',id:null}]}).catch((error:unknown)=>error);
  expect(pgCode(refusal)).toBe('EN851');
  const counts=await withTenantTx(app.db,f.service,tx=>tx.execute<{unconfirmed:number}>(sql`select unconfirmed from lifecycle.object_delete_counts()`));
  expect(counts.rows[0]?.unconfirmed).toBe(1);
 });
 it('retries only capability-backed absence after known terminal DELETE and records exact positive receipt',async()=>{
  const f=await prepared(),remove=vi.spyOn(f.store,'deleteForPurge'),head=vi.spyOn(f.store,'isPhysicallyAbsent');
  head.mockRejectedValueOnce(new Error('TEST_HEAD_OUTAGE'));
  const erase=execute(f.store),target={kind:'ordinary' as const,artifactId:f.file.artifactId};
  await expect(erase(f.service,target)).resolves.toEqual({state:'unconfirmed'});
  await expect(erase(f.service,target)).resolves.toEqual({state:'purged',quiescent:true});
  expect(remove).toHaveBeenCalledTimes(1);expect(head).toHaveBeenCalledTimes(2);
  const counts=await withTenantTx(app.db,f.service,tx=>tx.execute<{unconfirmed:number;proven:number}>(sql`select unconfirmed,proven from lifecycle.object_delete_counts()`));
  expect(counts.rows[0]).toEqual({unconfirmed:0,proven:1});
 });
 it('refuses another tenant and an orphan upload whose writer has no completion receipt',async()=>{
  const f=await prepared(),other=await lifecycleTenant(app.db,auth),remove=vi.spyOn(f.store,'deleteForPurge');
  await expect(execute(f.store)(createServiceContext(other.organizationId),{kind:'ordinary',artifactId:f.file.artifactId})).resolves.toEqual({state:'unconfirmed'});
  const id=randomUUID();
  await withTenantTx(app.db,other,tx=>tx.insert(blobLifecycle).values({organizationId:other.organizationId,
   artifactId:id,objectKey:`${other.organizationId}/artifacts/${id}`,state:'uploading',purgeAfter:new Date(0)}));
  await expect(execute(f.store)(createServiceContext(other.organizationId),{kind:'ordinary',artifactId:id})).resolves.toEqual({state:'unconfirmed'});
  expect(remove).not.toHaveBeenCalled();
 });
 it('grants no application SELECT over private claim/restore/native-admission tables',async()=>{
  const owner=await lifecycleTenant(app.db,auth),service=createServiceContext(owner.organizationId);
  for(const table of ['object_deletion_claims','object_restore_debts','offboarding_admissions','offboarding_agent_stops']) {
   const error=await withTenantTx(app.db,service,tx=>tx.execute(sql`select * from lifecycle.${sql.identifier(table)}`)).catch((cause:unknown)=>cause);
   expect(pgCode(error)).toBe('42501');
  }
 });
 it('observes the actual hold waiter before committing an admitted deletion',async()=>{
  const f=await prepared(),claim=new pg.Client({connectionString:urls.app()}),observer=new pg.Client({connectionString:urls.superuser()});
  await claim.connect();await observer.connect();let waiting:Promise<unknown>|undefined;
  try {
   await claim.query('begin');
   await claim.query("select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true),set_config('app.membership_id','',true)",[f.owner.organizationId]);
   const pid=(await claim.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid;
   await claim.query('select * from lifecycle.begin_object_deletion($1::jsonb)',[JSON.stringify({kind:'ordinary',artifactId:f.file.artifactId})]);
   waiting=placeLegalHold(app.db,f.owner,{matterRef:randomUUID(),scopes:[{type:'organization',id:null}]}).catch((error:unknown)=>error);
   const deadline=Date.now()+5000;let observed=false;
   while(Date.now()<deadline) {
    const rows=await observer.query<{blocked:boolean}>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',[pid]);
    if(rows.rows[0]?.blocked){observed=true;break;}
    await new Promise((resolve)=>setTimeout(resolve,10));
   }
   expect(observed,'driver barrier must observe a real PostgreSQL lock waiter').toBe(true);
   await claim.query('commit');
   expect(pgCode(await waiting)).toBe('EN851');
  } finally {
   await claim.query('rollback').catch(()=>undefined);if(waiting)await waiting;
   await claim.end();await observer.end();
  }
 });
});
