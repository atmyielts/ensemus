import { describe, expect, it, vi } from 'vitest';
import { createServiceContext } from '@ensemus/database/service';
import type { TenantContext } from '@ensemus/database';
import { createObjectDeletionExecutor,refuseUnadmittedDeletes, type ObjectDeletionAuthority } from './object-deletion';

const context = createServiceContext('90000000-0000-4000-8000-000000000001');
const target = { kind: 'archive' as const, importId: '90000000-0000-4000-8000-000000000002',
  sourceArtifactId: '90000000-0000-4000-8000-000000000003', writeToken: '90000000-0000-4000-8000-000000000004' };
const claimId = '90000000-0000-4000-8000-000000000005';
const key = `${context.organizationId}/archive-quarantine/${target.importId}/${target.sourceArtifactId}/${target.writeToken}`;
function fixture() {
  const authority: ObjectDeletionAuthority = {
    begin: vi.fn(async () => ({ state: 'admitted' as const, claimId, objectKey: key })),
    terminal: vi.fn(async () => undefined), proveAbsent: vi.fn(async () => true),
  };
  const store = { delete: vi.fn(async () => undefined), exists: vi.fn(async () => false) };
  return { authority, store, erase: createObjectDeletionExecutor({ authority, store }) };
}
describe('durable object deletion transport boundaries', () => {
  it('records known terminal transport before independent absence proof', async () => {
    const f = fixture(), order: string[] = [];
    vi.mocked(f.authority.begin).mockImplementation(async () => { order.push('admit');return { state: 'admitted',claimId,objectKey:key }; });
    f.store.delete.mockImplementation(async () => { order.push('delete'); });
    vi.mocked(f.authority.terminal).mockImplementation(async () => { order.push('terminal'); });
    f.store.exists.mockImplementation(async () => { order.push('head');return false; });
    vi.mocked(f.authority.proveAbsent).mockImplementation(async () => { order.push('receipt');return true; });
    await expect(f.erase(context,target)).resolves.toEqual({ state: 'purged',quiescent:true });
    expect(order).toEqual(['admit','delete','terminal','head','receipt']);
  });
  it.each(['held','unconfirmed'] as const)('does no storage work after %s admission', async (state) => {
    const f=fixture();vi.mocked(f.authority.begin).mockResolvedValue({state});
    await expect(f.erase(context,target)).resolves.toEqual({state});
    expect(f.store.delete).not.toHaveBeenCalled();expect(f.store.exists).not.toHaveBeenCalled();
    expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it('retains an unknown DELETE and never checks HEAD or fabricates a successful receipt', async () => {
    const f=fixture();f.store.delete.mockRejectedValue(new Error('TEST_AMBIGUOUS_TRANSPORT'));
    await expect(f.erase(context,target)).resolves.toEqual({state:'unconfirmed'});
    expect(f.authority.terminal).toHaveBeenCalledWith(context,claimId,'unknown');
    expect(f.store.delete).toHaveBeenCalledTimes(1);expect(f.store.exists).not.toHaveBeenCalled();
    expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it('does not replay an unresolved operation even when a later HEAD would say absent', async () => {
    const f=fixture();f.store.delete.mockRejectedValueOnce(new Error('TEST_TIMEOUT'));
    await f.erase(context,target);vi.mocked(f.authority.begin).mockResolvedValue({state:'unconfirmed'});
    await expect(f.erase(context,target)).resolves.toEqual({state:'unconfirmed'});
    expect(f.store.delete).toHaveBeenCalledTimes(1);expect(f.store.exists).not.toHaveBeenCalled();
  });
  it('retries only absence checking for a durably known terminal DELETE', async () => {
    const f=fixture();vi.mocked(f.authority.begin).mockResolvedValue({state:'deleted',claimId,objectKey:key});
    f.store.exists.mockRejectedValueOnce(new Error('TEST_READ_OUTAGE'));
    await expect(f.erase(context,target)).rejects.toThrow('TEST_READ_OUTAGE');
    await expect(f.erase(context,target)).resolves.toEqual({state:'purged',quiescent:true});
    expect(f.store.delete).not.toHaveBeenCalled();expect(f.authority.terminal).not.toHaveBeenCalled();
    expect(f.authority.proveAbsent).toHaveBeenCalledTimes(1);
  });
  it('cannot bless still-present bytes', async () => {
    const f=fixture();f.store.exists.mockResolvedValue(true);
    await expect(f.erase(context,target)).resolves.toEqual({state:'unconfirmed'});
    expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it('does not turn a failed terminal receipt into a HEAD-based recovery', async () => {
    const f=fixture();vi.mocked(f.authority.terminal).mockRejectedValue(new Error('TEST_LOST_COMMIT'));
    await expect(f.erase(context,target)).rejects.toThrow('TEST_LOST_COMMIT');
    expect(f.store.exists).not.toHaveBeenCalled();expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it('requires the final SQL proof to accept actual identity and hold state', async () => {
    const f=fixture();vi.mocked(f.authority.proveAbsent).mockResolvedValue(false);
    await expect(f.erase(context,target)).resolves.toEqual({state:'unconfirmed'});
  });
  it.each(['user','delegated','agent'] as const)('refuses %s archive cleanup before authority or storage', async (actorType) => {
    const f=fixture(), caller={...context,actorType} as TenantContext;
    await expect(f.erase(caller,target)).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(f.authority.begin).not.toHaveBeenCalled();expect(f.store.delete).not.toHaveBeenCalled();
  });
  it('ordinary Knowledge I/O cannot bypass durable delete admission',async()=>{
    const base={put:vi.fn(async(_key:string,_body:Buffer,_mime:string)=>{}),get:vi.fn(async(_key:string)=>Buffer.from('generated fixture')),
      exists:vi.fn(async(_key:string)=>false),delete:vi.fn(async(_key:string)=>{})};
    const guarded=refuseUnadmittedDeletes(base);
    await expect(guarded.delete('generated-fixture-key')).rejects.toMatchObject({code:'OBJECT_DELETE_UNCONFIRMED'});
    expect(base.delete).not.toHaveBeenCalled();
    await guarded.put('generated-fixture-key',Buffer.from('x'),'text/plain');
    await guarded.get('generated-fixture-key');await guarded.exists('generated-fixture-key');
    expect(base.put).toHaveBeenCalledTimes(1);expect(base.get).toHaveBeenCalledTimes(1);expect(base.exists).toHaveBeenCalledTimes(1);
  });
});
