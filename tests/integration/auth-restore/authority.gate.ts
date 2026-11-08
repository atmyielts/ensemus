// Dedicated disposable-DB profile ONLY: pending admission is deliberately never cleared by a
// shortcut/test clock. The operator supplies a separately migrated owned DB, then discards it.
// No password/account/session/assurance/factor authority is seeded: native HTTP enrolls the person.
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {parseSetCookieHeader} from 'better-auth/cookies';
import {createAuth} from '@ensemus/auth';
import {invalidateAuthenticationAfterRestore} from '@ensemus/auth/restore';
import {createOrganization,openAppDatabase} from '@ensemus/database';
import {beginAuthenticationRestore,inspectAuthenticationRestore,reconcileAuthenticationRestore,acknowledgeAuthenticationRestore} from '@ensemus/database/auth-restore-operator';
import {totpFromUri} from '../../helpers/totp';
const roles=['MIGRATOR','AUTH','APP','AGENT','DISPATCHER','SECRETS'] as const;
type Role=typeof roles[number];
const url=(role:Role)=>{
 const text=process.env['ENSEMUS_AUTH_RESTORE_'+role+'_URL'];
 if(!text)throw new Error('ISOLATED_AUTH_RESTORE_URL_REQUIRED');
 const value=new URL(text),owned=process.env.ENSEMUS_AUTH_RESTORE_OWNED_TEST_DATABASE;
 if(!owned||!/^ensemus_auth_restore_[a-z0-9_]{8,80}$/.test(owned)||value.pathname!=='/'+owned||
  !['postgres:','postgresql:'].includes(value.protocol)||decodeURIComponent(value.username)!=='ensemus_'+role.toLowerCase())throw new Error('ISOLATED_AUTH_RESTORE_DATABASE_REQUIRED');
 return text;
};
const cookieJar=(original:string,setCookie:string|null)=>{
 const jar=new Map(original.split(';').filter(Boolean).map(part=>{const split=part.indexOf('=');return[part.slice(0,split).trim(),part.slice(split+1)] as const;}));
 for(const[name,value]of parseSetCookieHeader(setCookie??'')){if(value.maxAge===0)jar.delete(name);else jar.set(name,value.value);}
 return [...jar].map(([name,value])=>name+'='+value).join('; ');
};
describe.sequential('0422 actual-role isolated restore barrier (unrun source)',()=>{
 const secret=randomBytes(48).toString('base64url'),base='https://generated-restore.example.invalid',password='generated restore owner password long enough';
 const manifestSha256='a'.repeat(64),backupId=randomUUID();
 let generation:string,organizationId:string,membershipId:string,userId:string,cookie:string;
 let beforeFactor:{secret:string;verified:boolean;enabled:boolean;failed:number},beforeRates:string;
 let runtime:ReturnType<typeof createAuth>|undefined;
 const client=async(role:Role)=>{const connection=new pg.Client({connectionString:url(role)});await connection.connect();return connection;};
 async function asRole<T>(role:Role,effect:(connection:pg.Client)=>Promise<T>):Promise<T>{const connection=await client(role);try{return await effect(connection);}finally{await connection.end();}}
 const counts=()=>asRole('MIGRATOR',async connection=>(await connection.query('select identity.auth_restore_transient_counts() as counts')).rows[0].counts as {sessions:number;assurances:number;verifications:number;setupTokens:number;backupSets:number});
 beforeAll(async()=>{
  // Require every role URL to name this same explicitly disposable database/endpoint.
  const target=new URL(url('MIGRATOR'));
  for(const role of roles){const value=new URL(url(role));if(value.host!==target.host||value.pathname!==target.pathname)throw new Error('ISOLATED_AUTH_RESTORE_DATABASE_REQUIRED');}
  runtime=createAuth({databaseUrl:url('AUTH'),secret,baseURL:base,allowSignup:true});
  const response=await runtime.auth.handler(new Request(base+'/api/auth/sign-up/email',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({email:'generated-'+randomUUID()+'@example.invalid',name:'Generated restore owner',password})}));
  expect(response.status).toBe(200);cookie=cookieJar('',response.headers.get('set-cookie'));
  let native=await runtime.readInteractiveSession(new Headers({cookie}));if(!native)throw new Error('NATIVE_RESTORE_FIXTURE_REQUIRED');
  userId=native.user.id;
  const enrollment=await runtime.mfa.enable({password},{userId,sessionId:native.session.id},new Headers({cookie}));
  if(enrollment.outcome!=='verified'||!enrollment.totpURI)throw new Error('NATIVE_ENROLLMENT_REQUIRED');
  cookie=cookieJar(cookie,enrollment.setCookie);
  const confirmation=await runtime.mfa.confirmEnrollment({code:totpFromUri(enrollment.totpURI)},{userId,sessionId:native.session.id},new Headers({cookie}));
  expect(confirmation.outcome).toBe('verified');cookie=cookieJar(cookie,confirmation.setCookie);
  native=await runtime.readInteractiveSession(new Headers({cookie}));if(!native)throw new Error('NATIVE_FACTOR_SESSION_REQUIRED');
  const app=openAppDatabase(url('APP'));
  try{const org=await createOrganization(app.db,{userId,name:'Generated restore company',commercialMode:'sovereign'});organizationId=org.organizationId;membershipId=org.membershipId;}finally{await app.close();}
  beforeFactor=await asRole('AUTH',async connection=>{
   // A restored failure-counter example is not an assurance or password/factor bypass.
   await connection.query('update identity.two_factors set failed_verification_count=7 where user_id=$1',[userId]);
   return(await connection.query("select encode(sha256(convert_to(f.secret,'UTF8')),'hex') as secret,f.verified,u.two_factor_enabled as enabled,f.failed_verification_count as failed from identity.two_factors f join identity.users u on u.id=f.user_id where f.user_id=$1",[userId])).rows[0];
  });
  beforeRates=await asRole('AUTH',async connection=>JSON.stringify((await connection.query('select key,count,last_request from identity.rate_limits order by key')).rows));
  // No live native/application pool is permitted at begin. The real helper checks actual logins.
  await runtime.close();runtime=undefined;
 },120000);
 afterAll(async()=>{await runtime?.close();});
 it('refuses begin while an actual application reader remains connected',async()=>{
  await asRole('APP',async()=>{await expect(beginAuthenticationRestore(url('MIGRATOR'),{backupId,manifestSha256})).rejects.toBeDefined();});
 });
 it('does not grant begin/inspect/ack to auth, app, agent, dispatcher or secrets logins',async()=>{
  for(const role of roles.filter(role=>role!=='MIGRATOR'))await asRole(role,async connection=>{
   await expect(connection.query('select identity.begin_auth_restore($1,$2)',[backupId,manifestSha256])).rejects.toMatchObject({code:'42501'});
   await expect(connection.query('select identity.inspect_auth_restore($1)',[randomUUID()])).rejects.toMatchObject({code:'42501'});
  });
 });
 it('commits a fresh pending auth generation with material rotation before any cleanup',async()=>{
  generation=await beginAuthenticationRestore(url('MIGRATOR'),{backupId,manifestSha256});
  const inspection=await inspectAuthenticationRestore(url('MIGRATOR'),generation);
  expect(inspection).toMatchObject({generation,backupId,manifestSha256,phase:'pending',invalidation:null});
  expect(Date.parse(inspection.notBefore)-Date.parse(inspection.cutoff)).toBeGreaterThanOrEqual(900000);
  expect((await counts()).sessions).toBeGreaterThan(0);
 });
 it('blocks tenant, unbound dispatcher, native identity and generation admission while pending',async()=>{
  for(const role of ['APP','AGENT','DISPATCHER','SECRETS'] as const)await asRole(role,async connection=>{
   await connection.query("select set_config('app.organization_id',$1,false),set_config('app.actor_type','service',false)",[organizationId]);
   await expect(connection.query('select app.current_organization_id()')).rejects.toMatchObject({code:'EN422'});
   await expect(connection.query('select app.current_auth_restore_generation()')).rejects.toMatchObject({code:'EN422'});
  });
  await asRole('AUTH',async connection=>{
   await expect(connection.query('select id from identity.users')).rejects.toMatchObject({code:'EN422'});
   await expect(connection.query("delete from identity.verifications where identifier='ensemus-auth-restore:v1'")).rejects.toBeDefined();
   await connection.query("select set_config('identity.auth_restore_operation','acknowledge',false)");
   await expect(connection.query("update identity.verifications set value=jsonb_set(value::jsonb,'{phase}','\"admitted\"')::text where identifier='ensemus-auth-restore:v1'")).rejects.toMatchObject({code:'EN422'});
  });
 });
 it('does not let a wrong native key partially delete sessions or invalidate a generation',async()=>{
  const before=await counts();
  await expect(invalidateAuthenticationAfterRestore({databaseUrl:url('AUTH'),secret:randomBytes(48).toString('base64url'),generation})).rejects.toBeDefined();
  expect(await counts()).toEqual(before);expect((await inspectAuthenticationRestore(url('MIGRATOR'),generation)).phase).toBe('pending');
 });
 it('uses real native crypto to clear transients/backups while preserving the factor, flag and counters',async()=>{
  const result=await invalidateAuthenticationAfterRestore({databaseUrl:url('AUTH'),secret,generation});
  expect(result.alreadyInvalidated).toBe(false);expect(result.proof.backupCodeSetsRevoked).toBe(1);
  expect(await counts()).toEqual({sessions:0,assurances:0,verifications:0,setupTokens:0,backupSets:1});
  await asRole('MIGRATOR',async connection=>{
   await connection.query('begin');
   try{await connection.query("select set_config('identity.auth_restore_count_scope','v1',true),set_config('identity.auth_restore_review_scope','v1',true)");
    const row=(await connection.query("select encode(sha256(convert_to(f.secret,'UTF8')),'hex') as secret,f.verified,u.two_factor_enabled as enabled,f.failed_verification_count as failed from identity.two_factors f join identity.users u on u.id=f.user_id where f.user_id=$1",[userId])).rows[0];expect(row).toEqual(beforeFactor);
   }finally{await connection.query('rollback');}
  });
  expect(await asRole('AUTH',async connection=>JSON.stringify((await connection.query('select key,count,last_request from identity.rate_limits order by key')).rows))).toBe(beforeRates);
  const retry=await invalidateAuthenticationAfterRestore({databaseUrl:url('AUTH'),secret,generation});expect(retry.alreadyInvalidated).toBe(true);expect(retry.proof).toEqual(result.proof);
 });
 it('keeps the old native cookie and newly restarted native handler refused after successful cleanup',async()=>{
  runtime=createAuth({databaseUrl:url('AUTH'),secret,baseURL:base,allowSignup:true});
  const response=await runtime.auth.handler(new Request(base+'/api/auth/get-session',{headers:{cookie}}));expect(response.status).toBe(503);expect(await response.json()).toMatchObject({code:'RESTORE_PENDING'});
  await runtime.close();runtime=undefined;
 });
 it('refuses stale review and direct authority elevation, and permits exact owner revocation without inventing a replacement',async()=>{
  const snapshot=await inspectAuthenticationRestore(url('MIGRATOR'),generation);
  await expect(reconcileAuthenticationRestore(url('MIGRATOR'),{generation,securitySha256:'0'.repeat(64),actions:[{kind:'disable_member',organizationId,id:membershipId}]})).rejects.toBeDefined();
  await asRole('MIGRATOR',async connection=>{
   await connection.query("select set_config('identity.auth_restore_operation','reconcile',false),set_config('identity.auth_restore_generation',$1,false)",[generation]);
   await expect(connection.query("update org.memberships set status='active' where organization_id=$1 and id=$2",[organizationId,membershipId])).resolves.toBeDefined();
   await expect(connection.query("insert into org.memberships(organization_id,id,user_id,role,status) values($1,$2,$3,'owner','active')",[organizationId,randomUUID(),randomUUID()])).rejects.toBeDefined();
  });
  const result=await reconcileAuthenticationRestore(url('MIGRATOR'),{generation,securitySha256:snapshot.securitySha256,actions:[{kind:'disable_member',organizationId,id:membershipId}]});expect(result.changed).toBe(1);expect(result.securitySha256).not.toBe(snapshot.securitySha256);
  await asRole('MIGRATOR',async connection=>{
   await connection.query("select set_config('identity.auth_restore_operation','reconcile',false),set_config('identity.auth_restore_generation',$1,false)",[generation]);
   await expect(connection.query("update org.memberships set status='active' where organization_id=$1 and id=$2",[organizationId,membershipId])).rejects.toMatchObject({code:'EN422'});
  });
  const review=Buffer.from(JSON.stringify({version:1,generation,backupId,manifestSha256,securitySha256:result.securitySha256,reviewer:'Generated independent operator',reviewedAt:new Date().toISOString(),authorityEvidence:'Generated current authority report.',inFlightEffectsEvidence:'Generated external transport reconciliation.'}));
  await expect(acknowledgeAuthenticationRestore(url('MIGRATOR'),{generation,manifestSha256,securitySha256:result.securitySha256,review})).rejects.toBeDefined();
  expect((await inspectAuthenticationRestore(url('MIGRATOR'),generation)).phase).toBe('invalidated');
  await expect(reconcileAuthenticationRestore(url('MIGRATOR'),{generation,securitySha256:result.securitySha256,actions:[{kind:'downgrade_member',organizationId,id:membershipId,role:'owner'}]})).rejects.toBeDefined();
 });
 it('rotates actual generations on a partial retry and never accepts an old cleanup proof',async()=>{
  const next=await beginAuthenticationRestore(url('MIGRATOR'),{backupId,manifestSha256});expect(next).not.toBe(generation);
  await expect(invalidateAuthenticationAfterRestore({databaseUrl:url('AUTH'),secret,generation})).rejects.toBeDefined();
  expect((await inspectAuthenticationRestore(url('MIGRATOR'),next)).phase).toBe('pending');
 });
});
