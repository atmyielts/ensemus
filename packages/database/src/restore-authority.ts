import {sql} from 'drizzle-orm';
import type {EnsemusDrizzle} from './connection';

export class RestoreAdmissionDenied extends Error {
  readonly code='RESTORE_PENDING';
  constructor(){super('This installation is waiting for restore review.');this.name='RestoreAdmissionDenied';}
}
type Executor=Pick<EnsemusDrizzle,'execute'>;
export function isRestoreAdmissionDenied(error:unknown):boolean{
  let current=error;
  for(let depth=0;depth<5&&current&&typeof current==='object';depth++){
    if(current instanceof RestoreAdmissionDenied||('code'in current&&['EN422','RESTORE_PENDING'].includes(String(current.code))))return true;
    if('body'in current&&current.body&&typeof current.body==='object'&&'code'in current.body&&current.body.code==='RESTORE_PENDING')return true;
    current='cause'in current?current.cause:undefined;
  }
  return false;
}
/** Fixed SQL metadata check; neither a context role nor an application GUC can admit a restore. */
export async function assertRestoreAdmission(database:Executor):Promise<void>{
  try{await database.execute(sql`select app.assert_restore_admitted()`);}
  catch(error){if(isRestoreAdmissionDenied(error))throw new RestoreAdmissionDenied();throw error;}
}
export type AuthRestoreAdmission={
  version:1;phase:'pending'|'invalidated'|'admitted';generation:string;
  cutoff:string|null;notBefore:string|null;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function timestamp(value:unknown):value is string{
  return typeof value==='string'&&value.length<=64&&Number.isFinite(Date.parse(value));
}
/** Selects no expiry, token, verification value, factor or private review body. */
export function parseAuthRestoreAdmission(value:unknown):AuthRestoreAdmission|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const row=value as Record<string,unknown>;
  if(Object.keys(row).some(key=>!['version','phase','generation','cutoff','notBefore'].includes(key))||
    row.version!==1||!['pending','invalidated','admitted'].includes(String(row.phase))||
    typeof row.generation!=='string'||!uuid.test(row.generation)||
    !(row.cutoff===null||timestamp(row.cutoff))||!(row.notBefore===null||timestamp(row.notBefore)))return null;
  if((row.cutoff===null)!==(row.notBefore===null)||(row.phase!=='admitted'&&row.cutoff===null))return null;
  return row as AuthRestoreAdmission;
}
export async function readAuthRestoreAdmission(database:Executor):Promise<AuthRestoreAdmission>{
  const result=await database.execute<{admission:unknown}>(sql`select identity.auth_restore_admission() as admission`);
  const value=parseAuthRestoreAdmission(result.rows[0]?.admission);
  if(result.rows.length!==1||!value)throw new RestoreAdmissionDenied();
  return value;
}
