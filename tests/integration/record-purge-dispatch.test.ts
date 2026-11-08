// Authored actual-role0423 gate; unrun. Metadata events are not material/physical proof.
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient, createProject, createWorkUnit } from '@ensemus/application';
import { createObjectType, createObjectRecord, deleteObjectRecord } from '@ensemus/application/custom-objects';
import { clients, projects, domainEvents, openAppDatabase, tombstones, withTenantTx, type TenantContext } from '@ensemus/database';
import { closedRecordPurgeTargets, openDispatcherDatabase, recordPurgeTargetForEvent, type DispatchableEvent } from '@ensemus/database/dispatcher';
import { KNOWLEDGE_RECORD_PURGE_REQUESTED } from '@ensemus/domain/knowledge-events';
import { seedAiTenant } from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';
import { pgCode } from '../../packages/application/src/errors';

describe('typed-record closure outbox and least-privilege dispatcher (0423)',()=>{
  const app = openAppDatabase(urls.app()), dispatcher = openDispatcherDatabase(urls.dispatcher());
  afterAll(async()=>{await dispatcher.close();await app.close();});
  const eventFor = async (owner:TenantContext,kind:string,id:string):Promise<DispatchableEvent>=>{
    const rows = await withTenantTx(app.db,owner,(tx)=>tx.select().from(domainEvents).where(and(eq(domainEvents.eventType,KNOWLEDGE_RECORD_PURGE_REQUESTED),eq(domainEvents.aggregateType,kind),eq(domainEvents.aggregateId,id))));
    const header=rows[0];if(!header)throw new Error('TEST_RECORD_REQUEST_MISSING');
    expect(header.payload).toEqual({});expect(header.classification).toBe('restricted');
    return {organizationId:owner.organizationId,eventId:header.id,eventType:header.eventType,aggregateType:kind,aggregateId:id,occurredAt:header.occurredAt,attempts:0};
  };
  it.each(['client','project'] as const)('emits atomically from an actual %s DELETE even without a tombstone',async(kind)=>{
    const tenant=await seedAiTenant(app.db,{commercialMode:'sovereign'});
    const record=kind==='client'?await createClient(app.db,tenant.owner,{displayName:'Generated private client',classification:'restricted'}):await createProject(app.db,tenant.owner,{name:'Generated project'});
    if(!record)throw new Error('TEST_NATIVE_RECORD_MISSING');
    await withTenantTx(app.db,tenant.owner,async(tx)=>{
      if(kind==='client')await tx.delete(clients).where(eq(clients.id,record.id));
      else await tx.delete(projects).where(eq(projects.id,record.id));
    });
    const event=await eventFor(tenant.owner,kind,record.id);
    expect(await recordPurgeTargetForEvent(dispatcher.db,event)).toEqual({organizationId:tenant.organizationId,kind,id:record.id});
    const state=await withTenantTx(app.db,tenant.owner,(tx)=>tx.execute<{alive:boolean;tombstoned:boolean}>(sql`select actual.alive,exists(select 1 from platform.tombstones closed where closed.organization_id=actual.organization_id and closed.target_type=actual.record_kind and closed.target_id=actual.record_id) tombstoned from knowledge.structured_record_catalog actual where actual.organization_id=${tenant.organizationId}::uuid and actual.record_kind=${kind} and actual.record_id=${record.id}::uuid`));
    expect(state.rows).toEqual([{alive:false,tombstoned:false}]);
    // Recovery consults current catalog state, independently of the outbox delivery state.
    const page=await closedRecordPurgeTargets(dispatcher.db,{organizationId:tenant.organizationId,kind,id:'00000000-0000-0000-0000-000000000000'},25);
    expect(page.targets).toContainEqual({organizationId:tenant.organizationId,kind,id:record.id});
  });
  it('starts only a genuine native Work identity after its committed tombstone',async()=>{
    const tenant=await seedAiTenant(app.db,{commercialMode:'sovereign'}),work=await createWorkUnit(app.db,tenant.owner,{title:'Generated restricted Work',classification:'restricted'});
    await withTenantTx(app.db,tenant.owner,(tx)=>tx.insert(tombstones).values({organizationId:tenant.organizationId,targetType:'work_unit',targetId:work.id,reasonCode:'USER_DELETED'}));
    const event=await eventFor(tenant.owner,'work_unit',work.id);
    const target={organizationId:tenant.organizationId,kind:'work_unit',id:work.id};
    expect(await recordPurgeTargetForEvent(dispatcher.db,event)).toEqual(target);
    expect(await recordPurgeTargetForEvent(dispatcher.db,event)).toEqual(target);
    expect(await recordPurgeTargetForEvent(dispatcher.db,{...event,eventId:randomUUID()})).toBeNull();
    expect(await recordPurgeTargetForEvent(dispatcher.db,{...event,organizationId:randomUUID()})).toBeNull();
  });
  it('follows genuine object-record soft deletion without choosing human attachments or other record IDs',async()=>{
    const tenant=await seedAiTenant(app.db,{commercialMode:'sovereign'});
    const type=await createObjectType(app.db,tenant.owner,{slug:'purge_'+randomUUID().replaceAll('-',''),displayName:'Generated items',classification:'internal',fields:[{key:'name',label:'Name',kind:'text',required:true,indexed:false}],relations:[]});
    const record=await createObjectRecord(app.db,tenant.owner,{typeId:type.id,displayName:'Generated item',attributes:{name:'Generated'},classification:'restricted'});
    await deleteObjectRecord(app.db,tenant.owner,{recordId:record.id,expectedVersion:record.version});
    expect(await recordPurgeTargetForEvent(dispatcher.db,await eventFor(tenant.owner,'object_record',record.id))).toEqual({organizationId:tenant.organizationId,kind:'object_record',id:record.id});
  });
  it('does not use an arbitrary request header or a missing native identity as closure authority',async()=>{
    const tenant=await seedAiTenant(app.db,{commercialMode:'sovereign'}),work=await createWorkUnit(app.db,tenant.owner,{title:'Generated live Work'}),eventId=randomUUID();
    await withTenantTx(app.db,tenant.owner,async(tx)=>{
      await tx.execute(sql`insert into platform.domain_events(organization_id,id,event_type,aggregate_type,aggregate_id,aggregate_version,actor_type,classification,payload) values(${tenant.organizationId}::uuid,${eventId}::uuid,'knowledge.record_purge_requested','work_unit',${work.id}::uuid,1,'system','restricted','{}'::jsonb)`);
      await tx.execute(sql`insert into platform.outbox_events(organization_id,event_id) values(${tenant.organizationId}::uuid,${eventId}::uuid)`);
    });
    const event:DispatchableEvent={organizationId:tenant.organizationId,eventId,eventType:KNOWLEDGE_RECORD_PURGE_REQUESTED,aggregateType:'work_unit',aggregateId:work.id,occurredAt:new Date(),attempts:0};
    expect(await recordPurgeTargetForEvent(dispatcher.db,event)).toBeNull();
    const missing=randomUUID();
    await withTenantTx(app.db,tenant.owner,(tx)=>tx.insert(tombstones).values({organizationId:tenant.organizationId,targetType:'work_unit',targetId:missing,reasonCode:'USER_DELETED'}));
    const headers=await withTenantTx(app.db,tenant.owner,(tx)=>tx.select({id:domainEvents.id}).from(domainEvents).where(and(eq(domainEvents.eventType,KNOWLEDGE_RECORD_PURGE_REQUESTED),eq(domainEvents.aggregateId,missing))));
    expect(headers).toEqual([]);
  });
  it('rolls back closure and its outbox request together',async()=>{
    const tenant=await seedAiTenant(app.db,{commercialMode:'sovereign'}),record=await createClient(app.db,tenant.owner,{displayName:'Generated rollback client'});
    if(!record)throw new Error('TEST_NATIVE_RECORD_MISSING');
    await expect(withTenantTx(app.db,tenant.owner,async(tx)=>{await tx.delete(clients).where(eq(clients.id,record.id));throw new Error('TEST_ROLLBACK');})).rejects.toThrow('TEST_ROLLBACK');
    const headers=await withTenantTx(app.db,tenant.owner,(tx)=>tx.select({id:domainEvents.id}).from(domainEvents).where(and(eq(domainEvents.eventType,KNOWLEDGE_RECORD_PURGE_REQUESTED),eq(domainEvents.aggregateId,record.id))));
    expect(headers).toEqual([]);
    expect((await withTenantTx(app.db,tenant.owner,(tx)=>tx.select({id:clients.id}).from(clients).where(eq(clients.id,record.id))))).toHaveLength(1);
  });
  it('keeps caller roles and body privileges closed, preserves scopes and refuses partial cursors',async()=>{
    const tenant=await seedAiTenant(app.db,{commercialMode:'sovereign'});
    await expect(withTenantTx(app.db,tenant.owner,(tx)=>tx.execute(sql`select * from knowledge.closed_record_purge_targets(null,null,null,1)`))).rejects.toSatisfy((error:unknown)=>pgCode(error)==='42501');
    for(const query of [sql`select title from work.work_units`,sql`select attributes from objects.records`,sql`select payload from platform.domain_events`,sql`update knowledge.structured_record_catalog set alive=false`])await expect(dispatcher.db.execute(query)).rejects.toThrow();
    await expect(dispatcher.db.execute(sql`select * from knowledge.closed_record_purge_targets(${tenant.organizationId}::uuid,null,null,1)`)).rejects.toSatisfy((error:unknown)=>pgCode(error)==='22023');
    await dispatcher.db.transaction(async(tx)=>{
      await tx.execute(sql`select set_config('knowledge.record_purge_dispatch_scope','prior-scope',true),set_config('knowledge.record_purge_dispatch_org','prior-org',true),set_config('knowledge.record_purge_dispatch_event','prior-event',true)`);
      await tx.execute(sql`select * from knowledge.record_purge_event_target(${tenant.organizationId}::uuid,${randomUUID()}::uuid)`);
      await tx.execute(sql`select * from knowledge.closed_record_purge_targets(null,null,null,1)`);
      const state=await tx.execute<{scope:string;org:string;event:string}>(sql`select current_setting('knowledge.record_purge_dispatch_scope',true) scope,current_setting('knowledge.record_purge_dispatch_org',true) org,current_setting('knowledge.record_purge_dispatch_event',true) event`);
      expect(state.rows).toEqual([{scope:'prior-scope',org:'prior-org',event:'prior-event'}]);
    });
  });
});
