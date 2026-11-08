// Auth-only preparation. Browser IDs never enter this function: the native authoritative session
// supplies the source tuple and native token hash; account finalization uses the resolver adapter.
import {createHash} from 'node:crypto';
import {and,eq,gt,sql} from 'drizzle-orm';
import type {EnsemusDrizzle} from './connection';
import {accounts,sessions,users,verifications} from './schema';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export type SamlLinkPrimaryProof=
  | {kind:'credential';accountId:string;fingerprint:string}
  | {kind:'provider';accountId:string;proofId:string;fingerprint:string;authenticatedAt:number;providerId:string;rawConfigSha256:string|null};
export type SamlLinkSource={userId:string;sessionId:string;sessionTokenSha256:string;email:string;primary:SamlLinkPrimaryProof};
export async function prepareNativeSamlLinkSource(db:EnsemusDrizzle,input:{userId:string;sessionId:string;sessionTokenSha256:string},verifyCredential:(hash:string)=>Promise<boolean>,providerPrimary:()=>Promise<SamlLinkPrimaryProof|null>):Promise<SamlLinkSource|null> {
  return db.transaction(async tx=>{
    const[user]=await tx.select({id:users.id,email:users.email}).from(users).where(eq(users.id,input.userId)).for('share');
    const[session]=await tx.select({id:sessions.id,token:sessions.token}).from(sessions).where(and(eq(sessions.id,input.sessionId),eq(sessions.userId,input.userId),gt(sessions.expiresAt,new Date()))).for('share');
    if(!user||!session||hash(session.token)!==input.sessionTokenSha256)return null;
    const credentials=await tx.select({id:accounts.id,password:accounts.password}).from(accounts).where(and(eq(accounts.userId,input.userId),eq(accounts.providerId,'credential'))).limit(2).for('share');
    if(credentials.length>1)return null;
    let primary:SamlLinkPrimaryProof|null;
    const credential=credentials[0];
    if(credential?.password){
      if(!(await verifyCredential(credential.password)))return null;
      primary={kind:'credential',accountId:credential.id,fingerprint:hash(credential.password)};
    }else primary=await providerPrimary();
    if(!primary)return null;
    return{...input,email:user.email,primary};
  });
}
export async function storeNativeSamlBrowserIntent(db:EnsemusDrizzle,input:{id:string;identifier:string;value:string;expiresAt:Date;createdAt:Date},source?:SamlLinkSource) {
  // This helper owns the whole transaction. SET LOCAL is rolled back/cleared on every exit; no
  // preparation selector can escape into another request or the native callback transaction.
  return db.transaction(async tx=>{
    if(source)await tx.execute(sql`select set_config('identity.saml_link_preparation',${JSON.stringify(source)},true)`);
    const[row]=await tx.insert(verifications).values(input).returning();
    return row??null;
  });
}
