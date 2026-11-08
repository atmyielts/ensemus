// Pure/native-library source checks. Database rows, role guards and actual restore are separate gates.
import {createHmac,randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {signJWT} from 'better-auth/crypto';
import {betterAuth} from 'better-auth';
import {memoryAdapter} from 'better-auth/adapters/memory';
import {createAuthRestoreAdmission,restoreVerificationTokenIsCurrent} from '../../packages/auth/src/restore-admission';
import {parseAuthRestoreAdmission,isRestoreAdmissionDenied,RestoreAdmissionDenied} from '../../packages/database/src/restore-authority';
const secret='generated-restore-native-key-never-real-credentials';
const admitted={version:1 as const,phase:'admitted' as const,generation:randomUUID(),cutoff:null,notBefore:null};
afterEach(()=>vi.useRealTimers());
describe('protected restore metadata and native admission',()=>{
  it.each([null,{}, {...admitted,generation:'unknown'},{...admitted,phase:'pending'},{...admitted,cutoff:'Infinity',notBefore:'Infinity'},{...admitted,token:'must-never-be-returned'},{...admitted,phase:'pending',cutoff:'2026-11-08T00:00:00Z',notBefore:'2026-11-08T00:01:00Z'}])('closes missing or malformed metadata %#',value=>expect(parseAuthRestoreAdmission(value)).toBeNull());
  it('parses explicit admitted seed and pending state without deciding elapsed time is admission',()=>{
    expect(parseAuthRestoreAdmission(admitted)).toEqual(admitted);
    const pending={...admitted,phase:'pending',cutoff:'2026-11-08T00:00:00Z',notBefore:'2026-11-08T00:15:00Z'};
    expect(parseAuthRestoreAdmission(pending)?.phase).toBe('pending');
  });
  it('normalizes only bounded restore error causes, including native API refusal',()=>{
    expect(isRestoreAdmissionDenied(new RestoreAdmissionDenied())).toBe(true);
    expect(isRestoreAdmissionDenied({cause:{code:'EN422'}})).toBe(true);
    expect(isRestoreAdmissionDenied({body:{code:'RESTORE_PENDING'}})).toBe(true);
    expect(isRestoreAdmissionDenied({code:'OTHER',message:'RESTORE_PENDING'})).toBe(false);
  });
  it.each(['pending','invalidated','missing'] as const)('native get-session refuses %s before accepting a session',async phase=>{
    const meta=phase==='missing'?null:{...admitted,phase,cutoff:'2026-11-08T00:00:00Z',notBefore:'2026-11-08T00:15:00Z'};
    const database={execute:vi.fn(async()=>({rows:[{admission:meta}]}))} as unknown as Parameters<typeof createAuthRestoreAdmission>[0];
    const native=betterAuth({baseURL:'https://generated-restore.example.invalid',secret,database:memoryAdapter({}),plugins:[createAuthRestoreAdmission(database,secret)],telemetry:{enabled:false}});
    const response=await native.handler(new Request('https://generated-restore.example.invalid/api/auth/get-session'));
    expect(response.status).toBe(503);expect((await response.json()).code).toBe('RESTORE_PENDING');
    await expect(native.api.getSession({headers:new Headers()})).rejects.toMatchObject({body:{code:'RESTORE_PENDING'}});
  });
});
describe('actual native signed email verification cutoff',()=>{
  const base=Date.parse('2026-11-08T00:00:00Z'),cutoff=new Date(base+5500).toISOString();
  const signed=(claims:Record<string,unknown>,algorithm:'HS256'|'HS384'='HS256')=>{
    const header=Buffer.from(JSON.stringify({alg:algorithm})).toString('base64url'),body=Buffer.from(JSON.stringify(claims)).toString('base64url'),data=`${header}.${body}`;
    return `${data}.${createHmac(algorithm==='HS256'?'sha256':'sha384',secret).update(data).digest('base64url')}`;
  };
  it('refuses a real native pre-restore token and accepts a real native newly issued token',async()=>{
    vi.useFakeTimers();vi.setSystemTime(base);
    const old=await signJWT({email:'generated@example.invalid'},secret);
    vi.setSystemTime(base+10000);
    expect(await restoreVerificationTokenIsCurrent(old,secret,cutoff)).toBe(false);
    expect(await restoreVerificationTokenIsCurrent(await signJWT({email:'generated@example.invalid'},secret),secret,cutoff)).toBe(true);
  });
  it.each(['missing-iat','same-second','future-iat','missing-exp','foreign-issuer','wrong-key','wrong-algorithm'] as const)('refuses %s without bypassing the pinned verifier',async kind=>{
    vi.useFakeTimers();vi.setSystemTime(base+10000);
    const now=Math.floor(Date.now()/1000),claims:Record<string,unknown>={email:'generated@example.invalid',iat:now,exp:now+3600};
    if(kind==='missing-iat')delete claims.iat;
    if(kind==='same-second')claims.iat=Math.floor(Date.parse(cutoff)/1000);
    if(kind==='future-iat')claims.iat=now+300;
    if(kind==='missing-exp')delete claims.exp;
    if(kind==='foreign-issuer')claims.iss='unrecognized-issuer';
    const token=signed(claims,kind==='wrong-algorithm'?'HS384':'HS256');
    expect(await restoreVerificationTokenIsCurrent(token,kind==='wrong-key'?'different-generated-native-key':secret,cutoff)).toBe(false);
  });
});
