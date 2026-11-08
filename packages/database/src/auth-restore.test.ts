// Orchestration-only boundary doubles. Actual role/crypto/SQL proof belongs to the isolated gate.
import {randomUUID} from 'node:crypto';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SQL} from 'drizzle-orm';
import {describe,expect,it,vi} from 'vitest';
import {invalidateRestoredAuthentication} from './auth-restore';
function fixture(options:{role?:string;recordedGeneration?:string;lockError?:Error}={}){
 const generation=randomUUID(),commands:{sql:string;params:unknown[]}[]=[],dialect=new PgDialect();
 const select=vi.fn(()=>({from:()=>({where:()=>({for:async()=>[{value:JSON.stringify({
  version:1,generation:options.recordedGeneration??generation,phase:'pending',notBefore:'2026-11-08T00:15:00Z',
 })}]})})}));
 const execute=vi.fn(async(query:SQL)=>{
  const command=dialect.sqlToQuery(query);commands.push({sql:command.sql,params:command.params});
  if(command.sql.includes('current_user'))return{rows:[{currentUser:options.role??'ensemus_auth',sessionUser:options.role??'ensemus_auth'}]};
  if(command.sql.includes('identity.lock_auth_restore_native_inventory')){
   throw options.lockError??new Error('TEST_STOP_AFTER_LOCK_ADMISSION');
  }
  return{rows:[]};
 });
 const tx={execute,select};
 const database={transaction:async(effect:(value:typeof tx)=>Promise<unknown>)=>effect(tx)} as unknown as Parameters<typeof invalidateRestoredAuthentication>[0];
 const verifyFactorCiphertext=vi.fn(async()=>undefined),verifyEmptyBackupCiphertext=vi.fn(async()=>undefined);
 return{generation,commands,select,execute,verifyFactorCiphertext,verifyEmptyBackupCiphertext,
  run:()=>invalidateRestoredAuthentication(database,{generation,emptyBackupCiphertext:'generated-test-ciphertext',
   verifyFactorCiphertext,verifyEmptyBackupCiphertext})};
}
describe('native restore lock-only helper protocol',()=>{
 it.each(['55P03','42883','EN422'])('refuses lock admission %s before factor reads, cleanup or crypto',async code=>{
  const failure=Object.assign(new Error('TEST_LOCK_REFUSED'),{code}),f=fixture({lockError:failure});
  await expect(f.run()).rejects.toBe(failure);
  expect(f.commands).toHaveLength(3);expect(f.select).toHaveBeenCalledTimes(1);
  expect(f.commands[2]?.sql).toContain('identity.lock_auth_restore_native_inventory(');
  expect(f.commands[2]?.params).toEqual([f.generation]);
  expect(f.commands.some(command=>/\block table\b|\bdelete from\b|\bupdate identity\b/i.test(command.sql))).toBe(false);
  expect(f.verifyFactorCiphertext).not.toHaveBeenCalled();expect(f.verifyEmptyBackupCiphertext).not.toHaveBeenCalled();
 });
 it('never asks the owner helper to lock a stale locally observed generation',async()=>{
  const f=fixture({recordedGeneration:randomUUID()});await expect(f.run()).rejects.toMatchObject({code:'RESTORE_PENDING'});
  expect(f.commands).toHaveLength(1);expect(f.commands.some(command=>command.sql.includes('lock_auth_restore_native_inventory'))).toBe(false);
 });
 it('requires the actual native auth login before reading control or using the helper',async()=>{
  const f=fixture({role:'ensemus_app'});await expect(f.run()).rejects.toThrow('AUTH_RESTORE_NATIVE_ROLE_REQUIRED');
  expect(f.select).not.toHaveBeenCalled();expect(f.commands).toHaveLength(1);
 });
});
