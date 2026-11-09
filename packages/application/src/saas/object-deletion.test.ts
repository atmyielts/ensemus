import { describe, expect, it, vi } from 'vitest';
import { createServiceContext } from '@ensemus/database/service';
import type { TenantContext } from '@ensemus/database';
import {
  createObjectDeletionExecutor,
  refuseUnadmittedDeletes,
  type DeletionTarget,
  type ObjectDeletionAuthority,
} from './object-deletion';

const context = createServiceContext('90000000-0000-4000-8000-000000000001');
const target = {
  kind: 'archive' as const,
  importId: '90000000-0000-4000-8000-000000000002',
  sourceArtifactId: '90000000-0000-4000-8000-000000000003',
  writeToken: '90000000-0000-4000-8000-000000000004',
};
const claimId = '90000000-0000-4000-8000-000000000005';
const key = `${context.organizationId}/archive-quarantine/${target.importId}/${target.sourceArtifactId}/${target.writeToken}`;
function fixture() {
  const authority: ObjectDeletionAuthority = {
    begin: vi.fn(async () => ({ state: 'admitted' as const, claimId, objectKey: key })),
    terminal: vi.fn(async () => undefined),
    proveAbsent: vi.fn(async () => true),
  };
  const store = {
    delete: vi.fn(async () => undefined),
    exists: vi.fn(async () => false),
    deleteForPurge: vi.fn(
      async (): Promise<{
        transport: 'not_attempted' | 'deleted' | 'unknown';
        capabilityVerified: boolean;
      }> => ({ transport: 'deleted', capabilityVerified: true }),
    ),
    isPhysicallyAbsent: vi.fn(async () => true),
  };
  return { authority, store, erase: createObjectDeletionExecutor({ authority, store }) };
}
describe('durable object deletion transport boundaries', () => {
  it('records known terminal transport before independent absence proof', async () => {
    const f = fixture(),
      order: string[] = [];
    vi.mocked(f.authority.begin).mockImplementation(async () => {
      order.push('admit');
      return { state: 'admitted', claimId, objectKey: key };
    });
    f.store.deleteForPurge.mockImplementation(async () => {
      order.push('delete');
      return { transport: 'deleted', capabilityVerified: true };
    });
    vi.mocked(f.authority.terminal).mockImplementation(async () => {
      order.push('terminal');
    });
    f.store.isPhysicallyAbsent.mockImplementation(async () => {
      order.push('physical-absence');
      return true;
    });
    vi.mocked(f.authority.proveAbsent).mockImplementation(async () => {
      order.push('receipt');
      return true;
    });
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'purged', quiescent: true });
    expect(order).toEqual(['admit', 'delete', 'terminal', 'physical-absence', 'receipt']);
    expect(f.store.delete).not.toHaveBeenCalled();
    expect(f.store.exists).not.toHaveBeenCalled();
  });
  it.each(['held', 'unconfirmed'] as const)(
    'does no storage work after %s admission',
    async (state) => {
      const f = fixture();
      vi.mocked(f.authority.begin).mockResolvedValue({ state });
      await expect(f.erase(context, target)).resolves.toEqual({ state });
      expect(f.store.delete).not.toHaveBeenCalled();
      expect(f.store.exists).not.toHaveBeenCalled();
      expect(f.store.deleteForPurge).not.toHaveBeenCalled();
      expect(f.store.isPhysicallyAbsent).not.toHaveBeenCalled();
      expect(f.authority.proveAbsent).not.toHaveBeenCalled();
    },
  );
  it('retains an unknown DELETE and never checks HEAD or fabricates a successful receipt', async () => {
    const f = fixture();
    f.store.deleteForPurge.mockResolvedValue({ transport: 'unknown', capabilityVerified: false });
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.authority.terminal).toHaveBeenCalledWith(context, claimId, 'unknown');
    expect(f.store.deleteForPurge).toHaveBeenCalledTimes(1);
    expect(f.store.isPhysicallyAbsent).not.toHaveBeenCalled();
    expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it('does not replay an unresolved operation even when a later HEAD would say absent', async () => {
    const f = fixture();
    f.store.deleteForPurge.mockResolvedValueOnce({
      transport: 'unknown',
      capabilityVerified: false,
    });
    await f.erase(context, target);
    vi.mocked(f.authority.begin).mockResolvedValue({ state: 'unconfirmed' });
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.store.deleteForPurge).toHaveBeenCalledTimes(1);
    expect(f.store.isPhysicallyAbsent).not.toHaveBeenCalled();
  });
  it('retries only absence checking for a durably known terminal DELETE', async () => {
    const f = fixture();
    vi.mocked(f.authority.begin).mockResolvedValue({ state: 'deleted', claimId, objectKey: key });
    f.store.isPhysicallyAbsent.mockRejectedValueOnce(new Error('TEST_READ_OUTAGE'));
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'purged', quiescent: true });
    expect(f.store.deleteForPurge).not.toHaveBeenCalled();
    expect(f.authority.terminal).not.toHaveBeenCalled();
    expect(f.authority.proveAbsent).toHaveBeenCalledTimes(1);
  });
  it('cannot bless still-present bytes', async () => {
    const f = fixture();
    f.store.isPhysicallyAbsent.mockResolvedValue(false);
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it('does not turn a failed terminal receipt into a HEAD-based recovery', async () => {
    const f = fixture();
    vi.mocked(f.authority.terminal).mockRejectedValue(new Error('TEST_LOST_COMMIT'));
    await expect(f.erase(context, target)).rejects.toThrow('TEST_LOST_COMMIT');
    expect(f.store.isPhysicallyAbsent).not.toHaveBeenCalled();
    expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it('requires the final SQL proof to accept actual identity and hold state', async () => {
    const f = fixture();
    vi.mocked(f.authority.proveAbsent).mockResolvedValue(false);
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
  });
  it('retains an admitted unconfirmed claim after a capability refusal without inventing UNKNOWN or resend', async () => {
    const f = fixture();
    f.store.deleteForPurge.mockResolvedValue({
      transport: 'not_attempted',
      capabilityVerified: false,
    });
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.authority.terminal).not.toHaveBeenCalled();
    expect(f.store.isPhysicallyAbsent).not.toHaveBeenCalled();
    vi.mocked(f.authority.begin).mockResolvedValue({ state: 'unconfirmed' });
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.store.deleteForPurge).toHaveBeenCalledTimes(1);
    expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it('admits nothing when the store refuses its capability preflight, so a later purge can retry (LIFE-01)', async () => {
    const f = fixture();
    const preflight = vi.fn(async (): Promise<void> => {
      throw new Error('TEST_STORE_UNREACHABLE');
    });
    const erase = createObjectDeletionExecutor({
      authority: f.authority,
      store: { ...f.store, assertPurgeCapability: preflight },
    });
    await expect(erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.authority.begin).not.toHaveBeenCalled();
    expect(f.store.deleteForPurge).not.toHaveBeenCalled();
    expect(f.store.isPhysicallyAbsent).not.toHaveBeenCalled();
    expect(f.authority.terminal).not.toHaveBeenCalled();
    // Back up: the same target is admitted once and deleted once.
    preflight.mockResolvedValue(undefined);
    await expect(erase(context, target)).resolves.toEqual({ state: 'purged', quiescent: true });
    expect(f.authority.begin).toHaveBeenCalledTimes(1);
    expect(f.store.deleteForPurge).toHaveBeenCalledTimes(1);
  });
  it('asks the capability preflight before admission, and still retains a claim refused after it', async () => {
    const f = fixture(),
      order: string[] = [];
    const erase = createObjectDeletionExecutor({
      authority: f.authority,
      store: {
        ...f.store,
        assertPurgeCapability: async () => {
          order.push('preflight');
        },
      },
    });
    vi.mocked(f.authority.begin).mockImplementation(async () => {
      order.push('admit');
      return { state: 'admitted', claimId, objectKey: key };
    });
    f.store.deleteForPurge.mockResolvedValue({
      transport: 'not_attempted',
      capabilityVerified: false,
    });
    await expect(erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
    expect(order).toEqual(['preflight', 'admit']);
    expect(f.authority.terminal).not.toHaveBeenCalled();
    expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it('records the actual completed DELETE even when its capability post-check refused qualification', async () => {
    const f = fixture();
    f.store.deleteForPurge.mockResolvedValue({ transport: 'deleted', capabilityVerified: false });
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.authority.terminal).toHaveBeenCalledWith(context, claimId, 'deleted');
    expect(f.store.isPhysicallyAbsent).not.toHaveBeenCalled();
    expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it('cannot bless a retained terminal DELETE after versioning becomes enabled', async () => {
    const f = fixture();
    vi.mocked(f.authority.begin).mockResolvedValue({ state: 'deleted', claimId, objectKey: key });
    f.store.isPhysicallyAbsent.mockRejectedValue(new Error('OBJECT_PHYSICAL_ABSENCE_UNPROVEN'));
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.store.deleteForPurge).not.toHaveBeenCalled();
    expect(f.authority.terminal).not.toHaveBeenCalled();
    expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it('treats an unexpected failure from the destructive adapter as unresolved transport', async () => {
    const f = fixture();
    f.store.deleteForPurge.mockRejectedValue(new Error('TEST_UNEXPECTED_ADAPTER_FAILURE'));
    await expect(f.erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.authority.terminal).toHaveBeenCalledWith(context, claimId, 'unknown');
    expect(f.store.isPhysicallyAbsent).not.toHaveBeenCalled();
    expect(f.authority.proveAbsent).not.toHaveBeenCalled();
  });
  it.each(['deleteForPurge', 'isPhysicallyAbsent'] as const)(
    'cannot certify through an adapter without %s',
    async (missing) => {
      const f = fixture(),
        store = { ...f.store, [missing]: undefined };
      const erase = createObjectDeletionExecutor({ authority: f.authority, store });
      await expect(erase(context, target)).resolves.toEqual({ state: 'unconfirmed' });
      expect(f.authority.begin).not.toHaveBeenCalled();
      expect(f.store.delete).not.toHaveBeenCalled();
      expect(f.store.exists).not.toHaveBeenCalled();
      expect(f.authority.proveAbsent).not.toHaveBeenCalled();
    },
  );
  it.each(['user', 'delegated', 'agent'] as const)(
    'refuses %s archive cleanup before authority or storage',
    async (actorType) => {
      const f = fixture(),
        caller = { ...context, actorType } as TenantContext;
      await expect(f.erase(caller, target)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.authority.begin).not.toHaveBeenCalled();
      expect(f.store.deleteForPurge).not.toHaveBeenCalled();
    },
  );
  // 0547's target, typed as DeletionTarget lists it: exactly the keys
  // lifecycle.raw_restore_survivor_delete_target returns, handed to admission key for key.
  const survivor: DeletionTarget = {
    kind: 'raw_restore_survivor',
    sourceId: '90000000-0000-4000-8000-000000000011',
    sourceVersion: '3',
    purgeJobId: '90000000-0000-4000-8000-000000000012',
    documentId: '90000000-0000-4000-8000-000000000013',
    writeId: '90000000-0000-4000-8000-000000000014',
    generation: 1,
    priorMaterialRestoreGeneration: '90000000-0000-4000-8000-000000000015',
    materialRestoreGeneration: '90000000-0000-4000-8000-000000000016',
    authRestoreGeneration: '90000000-0000-4000-8000-000000000017',
  };
  it('hands a restore survivor target to admission exactly as SQL named it', async () => {
    const f = fixture();
    await expect(f.erase(context, survivor)).resolves.toEqual({ state: 'purged', quiescent: true });
    expect(f.authority.begin).toHaveBeenCalledWith(context, survivor);
    expect(Object.keys(vi.mocked(f.authority.begin).mock.calls[0]![1]).sort()).toEqual([
      'authRestoreGeneration',
      'documentId',
      'generation',
      'kind',
      'materialRestoreGeneration',
      'priorMaterialRestoreGeneration',
      'purgeJobId',
      'sourceId',
      'sourceVersion',
      'writeId',
    ]);
  });
  it.each(['user', 'delegated', 'agent'] as const)(
    'refuses a %s restore survivor deletion before authority or storage',
    async (actorType) => {
      const f = fixture(),
        caller = { ...context, actorType } as TenantContext;
      await expect(f.erase(caller, survivor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.authority.begin).not.toHaveBeenCalled();
      expect(f.store.deleteForPurge).not.toHaveBeenCalled();
    },
  );
  it('ordinary Knowledge I/O cannot bypass durable delete admission', async () => {
    const base = {
      put: vi.fn(async (_key: string, _body: Buffer, _mime: string) => {}),
      get: vi.fn(async (_key: string) => Buffer.from('generated fixture')),
      exists: vi.fn(async (_key: string) => false),
      delete: vi.fn(async (_key: string) => {}),
      deleteForPurge: vi.fn(async (_key: string) => ({
        transport: 'deleted' as const,
        capabilityVerified: true,
      })),
      isPhysicallyAbsent: vi.fn(async (_key: string) => true),
    };
    const guarded = refuseUnadmittedDeletes(base);
    await expect(guarded.delete('generated-fixture-key')).rejects.toMatchObject({
      code: 'OBJECT_DELETE_UNCONFIRMED',
    });
    await expect(guarded.deleteForPurge('generated-fixture-key')).rejects.toMatchObject({
      code: 'OBJECT_DELETE_UNCONFIRMED',
    });
    expect(base.delete).not.toHaveBeenCalled();
    expect(base.deleteForPurge).not.toHaveBeenCalled();
    await guarded.put('generated-fixture-key', Buffer.from('x'), 'text/plain');
    await guarded.get('generated-fixture-key');
    await guarded.exists('generated-fixture-key');
    expect(base.put).toHaveBeenCalledTimes(1);
    expect(base.get).toHaveBeenCalledTimes(1);
    expect(base.exists).toHaveBeenCalledTimes(1);
  });
});
