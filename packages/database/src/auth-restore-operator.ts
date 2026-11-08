// Offline operator only. A restored company owner or a claimed service context is never admission.
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {openDatabase} from './connection';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha=/^[0-9a-f]{64}$/;
export const AUTH_RESTORE_REVIEW_MAX_BYTES=16*1024*1024;
function requireUuid(value:string){if(!uuid.test(value))throw new Error('AUTH_RESTORE_INPUT_REFUSED');return value;}
function requireSha(value:string){if(!sha.test(value))throw new Error('AUTH_RESTORE_INPUT_REFUSED');return value;}
export type AuthRestoreInspection={
 version:1;generation:string;backupId:string;manifestSha256:string;phase:'pending'|'invalidated';
 cutoff:string;notBefore:string;invalidation:unknown;security:Record<string,unknown>;securitySha256:string;
};
export type RestoreRevocation=
 |{kind:'disable_member'|'disable_provider'|'deprovision_member'|'revoke_scim'|'revoke_invitation'|'remove_team_access'|'revoke_password'|'revoke_oauth_tokens';organizationId:string;id:string}
 |{kind:'downgrade_member';organizationId:string;id:string;role:'member'|'admin'};
export function parseRestoreRevocations(value:unknown):readonly RestoreRevocation[]{
 if(!Array.isArray(value)||value.length<1||value.length>1000)throw new Error('AUTH_RESTORE_RECONCILE_REFUSED');
 const kinds=['disable_member','disable_provider','deprovision_member','revoke_scim','revoke_invitation','remove_team_access','downgrade_member','revoke_password','revoke_oauth_tokens'];
 return value.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('AUTH_RESTORE_RECONCILE_REFUSED');
  const row=item as Record<string,unknown>;
  if(Object.keys(row).some(key=>!['kind','organizationId','id','role'].includes(key))||
   !kinds.includes(String(row.kind))||typeof row.organizationId!=='string'||!uuid.test(row.organizationId)||
   typeof row.id!=='string'||!uuid.test(row.id)||(row.kind==='downgrade_member'
    ?!['member','admin'].includes(String(row.role)):'role'in row))throw new Error('AUTH_RESTORE_RECONCILE_REFUSED');
  return row as RestoreRevocation;
 });
}
export type AuthRestoreExternalReview={
 version:1;generation:string;backupId:string;manifestSha256:string;securitySha256:string;
 reviewer:string;reviewedAt:string;authorityEvidence:string;inFlightEffectsEvidence:string;
};
/** This is an explicit operator declaration with real artifact bytes, not automated provider truth. */
export function parseAuthRestoreExternalReview(bytes:Uint8Array,now=new Date()):AuthRestoreExternalReview{
 if(bytes.byteLength<1||bytes.byteLength>AUTH_RESTORE_REVIEW_MAX_BYTES)throw new Error('AUTH_RESTORE_REVIEW_REQUIRED');
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('AUTH_RESTORE_REVIEW_REQUIRED');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('AUTH_RESTORE_REVIEW_REQUIRED');
 const row=value as Record<string,unknown>;
 const keys=['version','generation','backupId','manifestSha256','securitySha256','reviewer','reviewedAt','authorityEvidence','inFlightEffectsEvidence'];
 if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key))||row.version!==1||
  ['generation','backupId'].some(key=>typeof row[key]!=='string'||!uuid.test(row[key] as string))||
  ['manifestSha256','securitySha256'].some(key=>typeof row[key]!=='string'||!sha.test(row[key] as string))||
  typeof row.reviewer!=='string'||!row.reviewer.trim()||row.reviewer.length>200||
  ['authorityEvidence','inFlightEffectsEvidence'].some(key=>typeof row[key]!=='string'||(row[key] as string).trim().length<16||(row[key] as string).length>65536)||
  typeof row.reviewedAt!=='string'||row.reviewedAt.length>64||!Number.isFinite(Date.parse(row.reviewedAt))||
  !Number.isFinite(now.getTime())||Date.parse(row.reviewedAt)>now.getTime())throw new Error('AUTH_RESTORE_REVIEW_REQUIRED');
 return row as AuthRestoreExternalReview;
}
async function withOperator<T>(url:string,effect:(db:ReturnType<typeof openDatabase>['db'])=>Promise<T>):Promise<T>{
 const {db,close}=openDatabase(url,{max:1});
 try{return await effect(db);}finally{await close();}
}
export async function beginAuthenticationRestore(url:string,input:{backupId:string;manifestSha256:string}):Promise<string>{
 requireUuid(input.backupId);requireSha(input.manifestSha256);
 return withOperator(url,async db=>{
  const result=await db.execute<{generation:string}>(sql`select identity.begin_auth_restore(${input.backupId}::uuid,${input.manifestSha256}) as generation`);
  if(result.rows.length!==1||!result.rows[0]?.generation||!uuid.test(result.rows[0].generation))throw new Error('AUTH_RESTORE_BEGIN_UNAVAILABLE');
  return result.rows[0].generation;
 });
}
export async function inspectAuthenticationRestore(url:string,generation:string):Promise<AuthRestoreInspection>{
 requireUuid(generation);
 return withOperator(url,async db=>{
  const result=await db.execute<{inspection:AuthRestoreInspection}>(sql`select identity.inspect_auth_restore(${generation}::uuid) as inspection`);
  const row=result.rows[0]?.inspection;
  if(result.rows.length!==1||!row||row.version!==1||row.generation!==generation||!uuid.test(row.backupId)||!sha.test(row.manifestSha256)||
    !sha.test(row.securitySha256)||!['pending','invalidated'].includes(row.phase)||!row.security||typeof row.security!=='object'||
    JSON.stringify(row).length>AUTH_RESTORE_REVIEW_MAX_BYTES+16384)throw new Error('AUTH_RESTORE_REVIEW_UNAVAILABLE');
  return row;
 });
}
export async function reconcileAuthenticationRestore(url:string,input:{generation:string;securitySha256:string;actions:unknown}):Promise<{generation:string;changed:number;securitySha256:string}>{
 requireUuid(input.generation);requireSha(input.securitySha256);const actions=parseRestoreRevocations(input.actions);
 if(Buffer.byteLength(JSON.stringify(actions))>131072)throw new Error('AUTH_RESTORE_RECONCILE_REFUSED');
 return withOperator(url,async db=>{
  const result=await db.execute<{answer:{generation:string;changed:number;securitySha256:string}}>(sql`select identity.reconcile_auth_restore(${input.generation}::uuid,${input.securitySha256},${JSON.stringify(actions)}::jsonb) as answer`);
  const answer=result.rows[0]?.answer;
  if(result.rows.length!==1||!answer||answer.generation!==input.generation||!Number.isSafeInteger(answer.changed)||answer.changed<1||!sha.test(answer.securitySha256))throw new Error('AUTH_RESTORE_RECONCILE_UNAVAILABLE');
  return answer;
 });
}
export async function acknowledgeAuthenticationRestore(url:string,input:{generation:string;manifestSha256:string;securitySha256:string;review:Uint8Array}):Promise<string>{
 requireUuid(input.generation);requireSha(input.manifestSha256);requireSha(input.securitySha256);
 const review=parseAuthRestoreExternalReview(input.review);
 if(review.generation!==input.generation||review.manifestSha256!==input.manifestSha256||review.securitySha256!==input.securitySha256)throw new Error('AUTH_RESTORE_REVIEW_CHANGED');
 const reviewSha=createHash('sha256').update(input.review).digest('hex');
 return withOperator(url,async db=>{
  // The SQL helper independently compares the actual locked snapshot and exact backup manifest.
  const result=await db.execute<{generation:string}>(sql`select identity.acknowledge_auth_restore(
   ${input.generation}::uuid,${review.backupId}::uuid,${input.manifestSha256},${input.securitySha256},${reviewSha},${input.review.byteLength}) as generation`);
  if(result.rows.length!==1||result.rows[0]?.generation!==input.generation)throw new Error('AUTH_RESTORE_ACKNOWLEDGMENT_UNAVAILABLE');
  return input.generation;
 });
}
