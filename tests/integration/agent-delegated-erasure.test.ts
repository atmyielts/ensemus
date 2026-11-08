// Negative native-role gates only. Positive seal/restore/crash-resume requires the composed actual
// SaaS fixture and 0422/0516; no fabricated offboarding, child, input or physical receipt is used.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createWorkUnit } from '@ensemus/application';
import { openAppDatabase, runAuthorityCheckpoints, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { sealDelegatedErasureInTx } from '../../packages/application/src/knowledge/delegated-erasure';
import { pgCode } from '../../packages/application/src/errors';
import { openAgentTestDatabase, seedAgentVersion, seedAiTenant, seedQueuedRun, testAgentSpec } from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

describe('delegated erasure witness native authority (0515)',()=>{
  const app=openAppDatabase(urls.app()),agent=openAgentTestDatabase();
  afterAll(async()=>{await agent.close();await app.close();});
  it('refuses an unadmitted intent, human caller and actual agent login without writing evidence',async()=>{
    const tenant=await seedAiTenant(app.db,{commercialMode:'sovereign'}),service=createServiceContext(tenant.organizationId);
    await expect(withTenantTx(app.db,tenant.owner,tx=>sealDelegatedErasureInTx(tx,tenant.owner,{offboardingId:randomUUID()})))
      .rejects.toMatchObject({code:'FORBIDDEN'});
    expect(await withTenantTx(app.db,service,tx=>sealDelegatedErasureInTx(tx,service,{offboardingId:randomUUID()}))).toBe(false);
    expect(await withTenantTx(agent.db,service,tx=>sealDelegatedErasureInTx(tx,service,{offboardingId:randomUUID()}))).toBe(false);
    for(const database of [app.db,agent.db]) {
      await expect(withTenantTx(database,service,tx=>tx.execute(sql`select proof_sha256 from lifecycle.delegated_erasure_receipts
        where organization_id=${tenant.organizationId}::uuid`))).rejects.toSatisfy((error:unknown)=>pgCode(error)==='42501');
      await expect(withTenantTx(database,service,tx=>tx.execute(sql`insert into lifecycle.delegated_erasure_receipts(organization_id,offboarding_id,
        material_restore_generation,auth_restore_generation,admitted_at,erasure_started_at,proof_sha256,run_count,child_count,source_count)
        values(${tenant.organizationId}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,now(),now(),${'0'.repeat(64)},0,0,0)`)))
        .rejects.toSatisfy((error:unknown)=>pgCode(error)==='42501');
    }
  });
  it('keeps the material getter and scope internals private despite forged selector strings',async()=>{
    const tenant=await seedAiTenant(app.db,{commercialMode:'sovereign'}),service=createServiceContext(tenant.organizationId);
    for(const database of [app.db,agent.db]) {
      await expect(withTenantTx(database,service,async tx=>{
        await tx.execute(sql`select set_config('lifecycle.delegated_erase_org',${tenant.organizationId},true)`);
        return tx.execute(sql`select lifecycle.current_delegated_material_proof()`);
      })).rejects.toSatisfy((error:unknown)=>pgCode(error)==='42501');
    }
  });
  it('does not grant a real restricted eraser early removal of genuine actual-run birth evidence or body reads',async()=>{
    const tenant=await seedAiTenant(app.db,{commercialMode:'sovereign'});
    const work=await createWorkUnit(app.db,tenant.owner,{title:'Actual retained Work control'});
    const version=await seedAgentVersion(app.db,tenant.owner,testAgentSpec());
    const runId=await seedQueuedRun(app.db,tenant.owner,{workUnitId:work.id,version});
    const original=()=>withTenantTx(app.db,tenant.owner,tx=>tx.select().from(runAuthorityCheckpoints).where(eq(runAuthorityCheckpoints.runId,runId)));
    expect(await original()).toHaveLength(1);
    const eraser=new pg.Client({connectionString:urls.superuser()});await eraser.connect();
    try {
      await eraser.query('set session authorization ensemus_eraser');
      await eraser.query('begin');
      await eraser.query("select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true),set_config('lifecycle.delegated_erase_org',$1,true)",[tenant.organizationId]);
      // RLS may filter the target before the proof trigger runs; neither outcome removes evidence.
      try {expect((await eraser.query('delete from ai.run_authority_checkpoints where organization_id=$1',[tenant.organizationId])).rowCount).toBe(0);}
      catch(error) {expect(['42501','EN850']).toContain(pgCode(error));}
      await eraser.query('rollback');
      await expect(eraser.query('select title from work.work_units')).rejects.toMatchObject({code:'42501'});
      await expect(eraser.query('delete from lifecycle.delegated_erasure_receipts')).rejects.toMatchObject({code:'42501'});
    } finally {await eraser.query('reset session authorization');await eraser.end();}
    expect(await original()).toHaveLength(1);
  });
});
