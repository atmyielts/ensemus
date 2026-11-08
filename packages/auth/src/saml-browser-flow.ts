import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes,randomUUID} from 'node:crypto';
import {authSchema,prepareNativeSamlLinkSource,readSsoProvider,storeNativeSamlBrowserIntent,type openAuthDatabase,type SamlLinkPrimaryProof,type SamlLinkSource} from '@ensemus/database/auth';
import type {SSOSAMLUserResolutionInput,SSOUserResolution,SSOUserResolutionContext} from '@better-auth/sso';
import type {BetterAuthPlugin} from 'better-auth';
import {APIError,createAuthEndpoint,sensitiveSessionMiddleware} from 'better-auth/api';
import {parseCookies} from 'better-auth/cookies';
import type {SamlEnvelope} from './sso-request';
import {ssoBoundary,ssoIdpIssuer,trustedSamlProvider} from './sso-flow';
import type {SsoProviderState} from './sso';
import {matchesSamlBrowserProof,nativeSamlRedirect,parseSamlIntent,issueSamlBrowserProof,readSamlBrowserProof,samlBrowserCookie,samlHash,SAML_BROWSER_COOKIE,SAML_BROWSER_PREFIX,SAML_BROWSER_TTL_SECONDS,SAML_SELF_LINK_PREFIX,type SamlBrowserIntent} from './saml-browser-binding';

type Database=ReturnType<typeof openAuthDatabase>['db'];
const refuse=()=>new APIError('FORBIDDEN',{code:'SSO_REFUSED'});
type LinkInput={password:string;callbackURL:string;consent:'connect'};
// Better Call's native endpoint accepts Standard Schema. Strict bounded fields require no new package.
const linkBody={'~standard':{version:1 as const,vendor:'ensemus',validate(value:unknown){
  if(!value||typeof value!=='object'||Array.isArray(value))return{issues:[{message:'Invalid company account connection request'}]};
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!['password','callbackURL','consent'].includes(key))||typeof input.password!=='string'||input.password.length>128||typeof input.callbackURL!=='string'||input.callbackURL.length>2048||input.consent!=='connect')return{issues:[{message:'Invalid company account connection request'}]};
  return{value:input as LinkInput};
}}};
function responseHeaders(response:Response,clear=false,cookie?:string):Response {
  const headers=new Headers(Array.from(response.headers.entries()));
  if(clear)headers.append('set-cookie',samlBrowserCookie('',0));
  if(cookie)headers.append('set-cookie',cookie);
  headers.set('cache-control','no-store');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
export function createSamlBrowserFlow(options:{database:Database;secret:string;baseURL:string;providerPrimary:(identity:{userId:string;sessionId:string})=>Promise<SamlLinkPrimaryProof|null>;providerPrimaryCurrent:(value:string)=>Promise<boolean>}) {
  const db=options.database,storage=new AsyncLocalStorage<{headers:Headers;envelope?:SamlEnvelope;matched?:boolean}>();
  async function bindStart(request:Request,response:Response,source?:SamlLinkSource):Promise<Response> {
    if(request.method!=='POST'||new URL(request.url).pathname!=='/api/auth/sign-in/sso'||!response.ok)return response;
    let payload:{url?:unknown};
    try{payload=await response.clone().json() as {url?:unknown};}catch{return response;}
    const redirect=nativeSamlRedirect(payload.url);
    // Tenant OIDC remains prohibited; a native SAML start without exact correlation never continues.
    if(!redirect)return Response.json({code:'SSO_REFUSED'},{status:400,headers:{'cache-control':'no-store'}});
    const nativeRequests=await db.query.verifications.findMany({where:(row,{eq})=>eq(row.identifier,`saml-authn-request:${redirect.requestId}`),limit:2});
    const nativeRequest=nativeRequests[0];
    if(nativeRequests.length!==1||!nativeRequest||nativeRequest.expiresAt.getTime()<=Date.now())throw refuse();
    let recorded:{id?:unknown;providerId?:unknown};
    try{recorded=JSON.parse(nativeRequest.value) as typeof recorded;}catch{throw refuse();}
    if(recorded.id!==redirect.requestId||typeof recorded.providerId!=='string')throw refuse();
    const provider=await readSsoProvider(db,recorded.providerId),issuer=provider?ssoIdpIssuer(provider):null;
    if(!provider?.domainVerified||!trustedSamlProvider(provider)||!provider.samlConfig||!issuer)throw refuse();
    if(source&&source.email.slice(source.email.lastIndexOf('@')+1).toLowerCase()!==provider.domain)throw refuse();
    const proof=randomBytes(32).toString('base64url'),id=randomUUID(),now=new Date();
    const intent:SamlBrowserIntent={version:1,mode:source?'self_link':'signin',phase:'prepared',requestId:redirect.requestId,relaySha256:redirect.relaySha256,providerId:provider.providerId,issuer,domain:provider.domain,boundary:ssoBoundary(provider),rawConfigSha256:samlHash(provider.samlConfig),browserProofSha256:samlHash(proof),...(source?{source}:{})};
    const expiresAt=new Date(Math.min(nativeRequest.expiresAt.getTime(),now.getTime()+SAML_BROWSER_TTL_SECONDS*1000));
    const row=await storeNativeSamlBrowserIntent(db,{id,identifier:`${source?SAML_SELF_LINK_PREFIX:SAML_BROWSER_PREFIX}${intent.relaySha256}`,value:JSON.stringify(intent),expiresAt,createdAt:now},source),stored=row?parseSamlIntent(row.value):null;
    if(!stored||stored.phase!=='prepared'||(source&&(!stored.organizationId||!stored.membershipId||stored.scopeAdmission!=='v1')))throw refuse();
    const cookie=issueSamlBrowserProof(options.secret,id,stored,proof);
    return responseHeaders(response,false,samlBrowserCookie(cookie.value));
  }
  return {
    bindStart,
    run(request:Request,envelope:SamlEnvelope|undefined,operation:()=>Promise<Response>):Promise<Response> {
      const scope={headers:new Headers(Array.from(request.headers.entries())),...(envelope?{envelope}:{}),matched:false};
      return storage.run(scope,async()=>{
        const response=await operation();
        return scope.matched?responseHeaders(response,true):response;
      });
    },
    async resolve(input:SSOSAMLUserResolutionInput,context:SSOUserResolutionContext,provider:SsoProviderState):Promise<SSOUserResolution> {
      const scope=storage.getStore(),envelope=scope?.envelope;
      if(!scope||!envelope?.requestId||!envelope.relaySha256)return{action:'reject',code:'SSO_REFUSED'};
      const proof=readSamlBrowserProof(options.secret,parseCookies(scope.headers.get('cookie')??'').get(SAML_BROWSER_COOKIE));
      if(!proof)return{action:'reject',code:'SSO_REFUSED'};
      const prefix=proof.mode==='self_link'?SAML_SELF_LINK_PREFIX:SAML_BROWSER_PREFIX;
      const row=await context.database.findOne<{id:string;value:string;identifier:string;expiresAt:Date}>({model:'verification',where:[{field:'id',value:proof.id},{field:'identifier',value:`${prefix}${envelope.relaySha256}`}]});
      const intent=row?parseSamlIntent(row.value):null;
      if(!row||!intent||intent.phase!=='prepared'||new Date(row.expiresAt).getTime()<=Date.now()||!matchesSamlBrowserProof(proof,intent,row.id)
        ||intent.requestId!==envelope.requestId||intent.relaySha256!==envelope.relaySha256||intent.providerId!==input.providerId||intent.issuer!==input.accountKey.issuer
        ||envelope.issuer!==input.accountKey.issuer||envelope.subject!==input.accountKey.accountId||intent.boundary!==ssoBoundary(provider)||!provider.samlConfig||intent.rawConfigSha256!==samlHash(provider.samlConfig))return{action:'reject',code:'SSO_REFUSED'};
      scope.matched=true;
      if(intent.mode==='self_link'){
        if(!intent.source||intent.scopeAdmission!=='v1'||!intent.organizationId||!intent.membershipId||intent.source.email.toLowerCase()!==input.providerUser.email.toLowerCase())return{action:'reject',code:'SSO_REFUSED'};
        if(intent.source.primary.kind==='provider'){
          const receipt=await context.database.findOne<{value:string}>({model:'verification',where:[{field:'id',value:intent.source.primary.proofId}]});
          if(!receipt||samlHash(receipt.value)!==intent.source.primary.fingerprint||!(await options.providerPrimaryCurrent(receipt.value)))return{action:'reject',code:'SSO_REFUSED'};
        }
      }
      const next={...intent,phase:'consumed' as const,subject:input.accountKey.accountId,signedEmail:input.providerUser.email};
      const changed=await context.database.update<{value:string}>({model:'verification',where:[{field:'id',value:row.id},{field:'value',value:row.value}],update:{value:JSON.stringify(next)}});
      const consumed=changed?parseSamlIntent(changed.value):null;
      if(!consumed||consumed.phase!=='consumed')throw refuse();
      if(intent.mode==='self_link'){
        // Only0421 writes this stamp in the SAME native transaction. Missing SQL never grants a link.
        if(consumed.finalizationAdmission!=='v1'||!consumed.finalizationTransaction||!intent.source)throw refuse();
        return{action:'link',userId:intent.source.userId,profile:'preserve'};
      }
      return{action:'continue'};
    },
    plugin(startNative:(request:Request)=>Promise<Response>):BetterAuthPlugin {
      return{id:'ensemus-explicit-saml-self-link',endpoints:{connectCompanyAccount:createAuthEndpoint('/sso/link-self',{method:'POST',requireHeaders:true,body:linkBody,use:[sensitiveSessionMiddleware]},async context=>{
        const session=context.context.session,input=context.body;
        if(!session?.session||!session.user||input.consent!=='connect')throw refuse();
        const callback=new URL(input.callbackURL),base=new URL(options.baseURL);
        if(base.protocol!=='https:'||callback.origin!==base.origin||callback.pathname!=='/sso/complete'||callback.hash||callback.username||callback.password)throw refuse();
        if(Array.from(callback.searchParams.keys()).some(key=>key!=='next')||callback.searchParams.getAll('next').length>1)throw refuse();
        const source=await prepareNativeSamlLinkSource(db,{userId:session.user.id,sessionId:session.session.id,sessionTokenSha256:samlHash(session.session.token)},hash=>context.context.password.verify({hash,password:input.password}),()=>options.providerPrimary({userId:session.user.id,sessionId:session.session.id}));
        if(!source)throw refuse();
        const headers=new Headers({'content-type':'application/json',origin:base.origin});
        for(const name of ['cookie','user-agent','x-forwarded-for']){const value=context.headers?.get(name);if(value)headers.set(name,value);}
        const request=new Request(new URL('/api/auth/sign-in/sso',options.baseURL),{method:'POST',headers,body:JSON.stringify({email:source.email,providerType:'saml',callbackURL:callback.href,errorCallbackURL:new URL('/sign-in/sso?error=refused',base).href})});
        return bindStart(request,await startNative(request),source);
      })}};
    },
  };
}
