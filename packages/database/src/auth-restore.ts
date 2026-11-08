// Auth-only recovery transaction. No application/context/GUC substitutes for the actual auth login.
import {createHash} from 'node:crypto';
import {asc,eq,gt,sql} from 'drizzle-orm';
import type {EnsemusDrizzle} from './connection';
import {twoFactors} from './schema-product';
import {verifications} from './schema';
import {RestoreAdmissionDenied} from './restore-authority';
const CONTROL_ID='68766d8e-9f7d-4b87-b881-bb4c3ff1654b';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export type AuthRestoreInvalidation={
  version:1;completedAt:string;emptyBackupCipherSha256:string;sessionsRemoved:number;
  assurancesRemoved:number;verificationsRemoved:number;setupTokensRevoked:number;backupCodeSetsRevoked:number;
};
function rowCount(result:{rowCount:number|null}):number{
  if(result.rowCount===null||!Number.isSafeInteger(result.rowCount)||result.rowCount<0)throw new Error('AUTH_RESTORE_COUNT_UNAVAILABLE');
  return result.rowCount;
}
function parseProof(value:unknown):AuthRestoreInvalidation{
  if(!value||typeof value!=='object')throw new Error('AUTH_RESTORE_PROOF_UNAVAILABLE');
  const row=value as Record<string,unknown>,counts=['sessionsRemoved','assurancesRemoved','verificationsRemoved','setupTokensRevoked','backupCodeSetsRevoked'];
  if(row.version!==1||typeof row.completedAt!=='string'||!Number.isFinite(Date.parse(row.completedAt))||
    typeof row.emptyBackupCipherSha256!=='string'||!/^[0-9a-f]{64}$/.test(row.emptyBackupCipherSha256)||
    Object.keys(row).some(key=>!['version','completedAt','emptyBackupCipherSha256',...counts].includes(key))||
    counts.some(key=>typeof row[key]!=='number'||!Number.isSafeInteger(row[key])||(row[key] as number)<0))throw new Error('AUTH_RESTORE_PROOF_UNAVAILABLE');
  return row as AuthRestoreInvalidation;
}
export async function invalidateRestoredAuthentication(database:EnsemusDrizzle,input:{
  generation:string;emptyBackupCiphertext:string;
  /** Actual native crypto supplied by @ensemus/auth; never provider/browser content. */
  verifyFactorCiphertext:(ciphertext:string)=>Promise<void>;
  verifyEmptyBackupCiphertext:(ciphertext:string)=>Promise<void>;
}):Promise<{generation:string;proof:AuthRestoreInvalidation;alreadyInvalidated:boolean}>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.generation)||
    !input.emptyBackupCiphertext||input.emptyBackupCiphertext.length>16384)throw new Error('AUTH_RESTORE_INPUT_REFUSED');
  return database.transaction(async tx=>{
    const role=await tx.execute<{currentUser:string;sessionUser:string}>(sql`select current_user as "currentUser",session_user as "sessionUser"`);
    if(role.rows.length!==1||role.rows[0]?.currentUser!=='ensemus_auth'||role.rows[0]?.sessionUser!=='ensemus_auth')throw new Error('AUTH_RESTORE_NATIVE_ROLE_REQUIRED');
    const[control]=await tx.select({value:verifications.value}).from(verifications).where(eq(verifications.id,CONTROL_ID)).for('update',{noWait:true});
    if(!control)throw new RestoreAdmissionDenied();
    const body=JSON.parse(control.value) as Record<string,unknown>;
    if(body.version!==1||body.generation!==input.generation||!['pending','invalidated'].includes(String(body.phase))||
      typeof body.notBefore!=='string'||!Number.isFinite(Date.parse(body.notBefore)))throw new RestoreAdmissionDenied();
    await tx.execute(sql`select set_config('identity.auth_restore_operation','invalidate',true),
      set_config('identity.auth_restore_generation',${input.generation},true),
      set_config('identity.auth_restore_empty_cipher_sha256',${hash(input.emptyBackupCiphertext)},true)`);
    // The owned transaction has no provider/storage I/O. A concurrent writer makes NOWAIT fail,
    // rather than letting a changing or RLS-filtered inventory become a zero-state certificate.
    await tx.execute(sql`lock table identity.accounts,identity.session_assurances,identity.sessions,
      identity.setup_tokens,identity.two_factors,identity.users,identity.verifications in share row exclusive mode nowait`);
    const existing=body.phase==='invalidated'?parseProof(body.invalidation):null;
    let cursor:string|undefined,sets=0;
    for(;;){
      const page=await tx.select({id:twoFactors.id,secret:twoFactors.secret,backupCodes:twoFactors.backupCodes,lockedUntil:twoFactors.lockedUntil})
        .from(twoFactors).where(cursor?gt(twoFactors.id,cursor):undefined).orderBy(asc(twoFactors.id)).limit(200).for('update');
      for(const factor of page){
        if(!factor.secret||factor.secret.length>16384)throw new Error('AUTH_RESTORE_FACTOR_REFUSED');
        await input.verifyFactorCiphertext(factor.secret);
        if(existing){
          if(hash(factor.backupCodes)!==existing.emptyBackupCipherSha256||!factor.lockedUntil||factor.lockedUntil.getTime()<Date.parse(body.notBefore as string))throw new Error('AUTH_RESTORE_PROOF_NOT_CURRENT');
          await input.verifyEmptyBackupCiphertext(factor.backupCodes);
        }
        sets++;
      }
      if(page.length<200)break;cursor=page[page.length-1]!.id;
    }
    if(existing){
      const result=await tx.execute<{counts:{sessions:number;assurances:number;verifications:number;setupTokens:number;backupSets:number}}>(sql`select identity.auth_restore_transient_counts() as counts`);
      const counts=result.rows[0]?.counts;
      if(!counts||counts.sessions!==0||counts.assurances!==0||counts.verifications!==0||counts.setupTokens!==0||counts.backupSets!==sets||existing.backupCodeSetsRevoked!==sets)throw new Error('AUTH_RESTORE_PROOF_NOT_CURRENT');
      return{generation:input.generation,proof:existing,alreadyInvalidated:true};
    }
    // Correct-key checks above finish before any content/session mutation. The empty value is a
    // valid native encrypted [], not malformed ciphertext or a replacement factor.
    const assurancesRemoved=rowCount(await tx.execute(sql`delete from identity.session_assurances`));
    const sessionsRemoved=rowCount(await tx.execute(sql`delete from identity.sessions`));
    const verificationsRemoved=rowCount(await tx.execute(sql`delete from identity.verifications where id<>${CONTROL_ID}::uuid`));
    const setupTokensRevoked=rowCount(await tx.execute(sql`update identity.setup_tokens set used_at=clock_timestamp() where used_at is null`));
    const backupCodeSetsRevoked=rowCount(await tx.execute(sql`update identity.two_factors set backup_codes=${input.emptyBackupCiphertext},
      locked_until=greatest(locked_until,${body.notBefore as string}::timestamptz)`));
    if(backupCodeSetsRevoked!==sets)throw new Error('AUTH_RESTORE_FACTOR_INVENTORY_CHANGED');
    const clock=await tx.execute<{now:string}>(sql`select clock_timestamp()::text as now`);
    if(!clock.rows[0]?.now||!Number.isFinite(Date.parse(clock.rows[0].now)))throw new Error('AUTH_RESTORE_CLOCK_UNAVAILABLE');
    const proof:AuthRestoreInvalidation={version:1,completedAt:clock.rows[0].now,emptyBackupCipherSha256:hash(input.emptyBackupCiphertext),
      sessionsRemoved,assurancesRemoved,verificationsRemoved,setupTokensRevoked,backupCodeSetsRevoked};
    const result=await tx.update(verifications).set({value:JSON.stringify({...body,phase:'invalidated',invalidation:proof})}).where(eq(verifications.id,CONTROL_ID)).returning({value:verifications.value});
    if(result.length!==1)throw new Error('AUTH_RESTORE_PROOF_NOT_COMMITTED');
    // The SQL control guard independently rechecks this generation and actual zero transient state.
    const stored=JSON.parse(result[0]!.value) as {generation?:unknown;phase?:unknown;invalidation?:unknown};
    if(stored.generation!==input.generation||stored.phase!=='invalidated')throw new Error('AUTH_RESTORE_PROOF_NOT_COMMITTED');
    return{generation:input.generation,proof:parseProof(stored.invalidation),alreadyInvalidated:false};
  });
}
