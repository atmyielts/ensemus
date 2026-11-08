import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {parseAuthRestoreExternalReview,parseRestoreRevocations} from '../../packages/database/src/auth-restore-operator';
const generation=randomUUID(),organizationId=randomUUID(),id=randomUUID();
const review={version:1,generation,backupId:randomUUID(),manifestSha256:'a'.repeat(64),securitySha256:'b'.repeat(64),reviewer:'Independent test operator',reviewedAt:'2026-11-08T00:15:01Z',authorityEvidence:'Actual external identity review report reference.',inFlightEffectsEvidence:'Actual transport reconciliation report reference.'};
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value));
describe('restore operator review and denial-only inputs',()=>{
 it.each([
  [],[{kind:'activate_member',organizationId,id}],[{kind:'downgrade_member',organizationId,id,role:'owner'}],
  [{kind:'disable_member',organizationId,id,role:'member'}],[{kind:'disable_provider',organizationId,id,state:'active'}],
  [{kind:'disable_member',organizationId:'foreign-unbounded',id}],Array.from({length:1001},()=>({kind:'disable_member',organizationId,id})),
 ])('refuses mutation authority not present in the closed revocation contract %#',value=>expect(()=>parseRestoreRevocations(value)).toThrow());
 it('retains exact tenant/target identity for allowed revocations without accepting role promotion',()=>{
  const input=[{kind:'disable_member',organizationId,id},{kind:'downgrade_member',organizationId,id,role:'member'}];
  expect(parseRestoreRevocations(input)).toEqual(input);
 });
 it.each([
  {},{...review,generation:'unknown'},{...review,authorityEvidence:''},{...review,inFlightEffectsEvidence:''},
  {...review,reviewer:' '},{...review,secret:'must not be accepted'},{...review,reviewedAt:'Infinity'},
  {...review,reviewedAt:'2026-11-09T00:00:00Z'},{...review,securitySha256:'wrong'},
 ])('refuses incomplete/unbound authority review artifacts %#',value=>expect(()=>parseAuthRestoreExternalReview(bytes(value),new Date('2026-11-08T01:00:00Z'))).toThrow());
 it('retains independent authority and in-flight review declarations, without claiming provider validation',()=>expect(parseAuthRestoreExternalReview(bytes(review),new Date('2026-11-08T01:00:00Z'))).toEqual(review));
 it('refuses malformed UTF-8 instead of normalizing its signed review bytes',()=>expect(()=>parseAuthRestoreExternalReview(Buffer.from([0xc3,0x28]))).toThrow());
});
