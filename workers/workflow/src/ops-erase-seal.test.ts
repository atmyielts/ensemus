// Composition checks only. Native SQL/role/restore acceptance remains a separate database gate.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({
  seal: vi.fn(),
  close: vi.fn(),
  inspect: vi.fn(),
  erase: vi.fn(),
  finish: vi.fn(),
  physical: vi.fn(),
  begin: vi.fn(),
  appClose: vi.fn(),
  eraserClose: vi.fn(),
  order: [] as string[],
}));
vi.mock('@ensemus/config', () => ({ readSecret: () => 'test-only-unused-url' }));
vi.mock('@ensemus/database', async (original) => ({
  ...(await original<typeof import('@ensemus/database')>()),
  openAppDatabase: () => ({ db: {}, close: ports.appClose }),
  withTenantTx: async (_db: unknown, _context: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    ports.order.push('transaction-start');
    const result = await fn({});
    ports.order.push('transaction-committed');
    return result;
  },
}));
vi.mock('@ensemus/database/eraser', () => ({
  openEraserDatabase: () => ({ db: {}, close: ports.eraserClose }),
  listErasableTables: async () => [],
  eraseTenantRows: ports.erase,
}));
vi.mock('@ensemus/application/knowledge/delegated-erasure', () => ({
  sealDelegatedErasureInTx: ports.seal,
  closeDelegatedRecordInputsInTx: ports.close,
}));
vi.mock('@ensemus/application/saas/offboarding', async (original) => ({
  ...(await original<typeof import('@ensemus/application/saas/offboarding')>()),
  beginErasure: ports.begin,
  inspectErasure: ports.inspect,
  finishErasure: ports.finish,
}));
vi.mock('@ensemus/application/saas/tenant-object-erasure', () => ({
  createTenantObjectErasure: () => ({
    purge: async () => ({
      files: { purged: 0, failed: 0 },
      archives: { held: 0 },
      unconfirmedDeletes: 0,
    }),
    confirm: ports.physical,
  }),
}));
vi.mock('@ensemus/storage', () => ({
  S3ObjectStore: class {
    async *listPages() {
      yield* [];
    }
  },
}));
import { eraseCommand, type EraseCommandBindings } from './ops-erase';

let directory: string;
beforeEach(() => {
  vi.resetAllMocks();
  ports.order.length = 0;
  directory = mkdtempSync(join(tmpdir(), 'ensemus-erase-seal-'));
  // A run resumed while already erasing, as before ADR-028 item 8b: the input closure is skipped.
  ports.inspect.mockResolvedValue({
    state: 'erasing',
    activeHolds: 0,
    ledgerPending: 0,
    unsettledActions: 0,
    blobsPending: 0,
  });
  ports.close.mockImplementation(async () => {
    ports.order.push('close-delegated-inputs');
    return { closed: 0, more: false };
  });
  ports.begin.mockResolvedValue({ more: false });
  ports.physical.mockResolvedValue({ confirmed: true, objectsRemaining: 0 });
  ports.seal.mockImplementation(async () => {
    ports.order.push('seal');
    return true;
  });
  ports.erase.mockImplementation(async () => {
    ports.order.push('erase');
    return [];
  });
  ports.finish.mockResolvedValue({ state: 'reported', report: { rowsRemoved: 0 } });
});
afterEach(() => {
  for (const name of ['input.json', 'report.json']) {
    const file = join(directory, name);
    if (existsSync(file)) unlinkSync(file);
  }
  rmdirSync(directory);
});
async function run(databases?: EraseCommandBindings['databases']) {
  const input = {
    organizationId: randomUUID(),
    offboardingId: randomUUID(),
    operatorRef: 'test-operator@example.invalid',
  };
  const file = join(directory, 'input.json'),
    report = join(directory, 'report.json');
  writeFileSync(file, JSON.stringify(input));
  const code = await eraseCommand(['run', '--file', file, '--report-file', report], {
    agents: {
      haltOffboardingAgents: async () => undefined,
      releaseOffboardingAgents: async () => undefined,
    },
    ...(databases ? { databases } : {}),
  });
  return {
    code,
    input,
    report: JSON.parse(readFileSync(report, 'utf8')) as { state: string; reasonCode?: string },
  };
}
describe('operator erasure material-witness composition', () => {
  it('commits the exact offboarding seal before row erasure', async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(ports.order).toEqual(['transaction-start', 'seal', 'transaction-committed', 'erase']);
    expect(ports.seal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: result.input.organizationId,
        actorType: 'service',
      }),
      result.input,
    );
    expect(ports.appClose).toHaveBeenCalledOnce();
    expect(ports.eraserClose).toHaveBeenCalledOnce();
  });
  it('retains pending work when native material proof refuses', async () => {
    ports.seal.mockResolvedValue(false);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.report).toEqual({ state: 'pending', reasonCode: 'MATERIAL_PURGE_PENDING' });
    expect(ports.erase).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
  });
  it('does not seal or erase while physical proof is missing', async () => {
    ports.physical.mockResolvedValue({ confirmed: false, objectsRemaining: 1 });
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.report.reasonCode).toBe('BLOB_PURGE_PENDING');
    expect(ports.seal).not.toHaveBeenCalled();
    expect(ports.erase).not.toHaveBeenCalled();
  });
  it('does not delete rows after a seal transaction fails', async () => {
    ports.seal.mockRejectedValue(new Error('TEST_SEAL_FAILURE'));
    const result = await run();
    expect(result.code).toBe(2);
    expect(result.report.state).toBe('failed');
    expect(ports.erase).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
  });

  // ADR-028 open question 12, lifecycle item 8b: the delegated input closure runs before erasing.
  describe('the delegated record input closure', () => {
    const ready = () =>
      ports.inspect.mockResolvedValue({
        state: 'ready_for_erasure',
        activeHolds: 0,
        ledgerPending: 0,
        unsettledActions: 0,
        blobsPending: 0,
      });
    beforeEach(() => {
      ready();
      ports.begin.mockImplementation(async () => {
        ports.order.push('begin');
        return { more: false };
      });
      ports.physical.mockImplementation(async () => {
        ports.order.push('physical-confirm');
        return { confirmed: true, objectsRemaining: 0 };
      });
      ports.finish.mockImplementation(async () => {
        ports.order.push('finish');
        return { state: 'reported', report: { rowsRemoved: 0 } };
      });
    });
    it('closes inputs, then begins, confirms objects, seals in its own transaction, erases, finishes', async () => {
      const result = await run();
      expect(result.code).toBe(0);
      expect(ports.order).toEqual([
        'transaction-start',
        'close-delegated-inputs',
        'transaction-committed',
        'begin',
        'physical-confirm',
        'transaction-start',
        'seal',
        'transaction-committed',
        'erase',
        'finish',
      ]);
      expect(ports.close).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          organizationId: result.input.organizationId,
          actorType: 'service',
        }),
        result.input,
      );
    });
    it('loops one transaction per page until no more remain', async () => {
      let pages = 0;
      ports.close.mockImplementation(async () => ({ closed: 100, more: ++pages < 3 }));
      expect((await run()).code).toBe(0);
      expect(ports.close).toHaveBeenCalledTimes(3);
    });
    it('reports DELEGATED_INPUTS_BUSY after twenty full pages and neither begins nor erases', async () => {
      ports.close.mockResolvedValue({ closed: 100, more: true });
      const result = await run();
      expect(result.code).toBe(1);
      expect(result.report).toEqual({ state: 'pending', reasonCode: 'DELEGATED_INPUTS_BUSY' });
      expect(ports.close).toHaveBeenCalledTimes(20);
      expect(ports.begin).not.toHaveBeenCalled();
      expect(ports.seal).not.toHaveBeenCalled();
      expect(ports.erase).not.toHaveBeenCalled();
    });
    it('skips the closure on a run resumed while erasing', async () => {
      ports.inspect.mockResolvedValue({
        state: 'erasing',
        activeHolds: 0,
        ledgerPending: 0,
        unsettledActions: 0,
        blobsPending: 0,
      });
      expect((await run()).code).toBe(0);
      expect(ports.close).not.toHaveBeenCalled();
      expect(ports.order).not.toContain('close-delegated-inputs');
    });
    it('a refused seal after the closure still exits 1 with MATERIAL_PURGE_PENDING and never erases', async () => {
      ports.seal.mockResolvedValue(false);
      const result = await run();
      expect(result.code).toBe(1);
      expect(result.report).toEqual({ state: 'pending', reasonCode: 'MATERIAL_PURGE_PENDING' });
      expect(ports.close).toHaveBeenCalledOnce();
      expect(ports.erase).not.toHaveBeenCalled();
    });
    it('a refused closure (a held tenant) stops before beginning', async () => {
      ports.close.mockRejectedValue(
        Object.assign(new Error('LEGAL_HOLD_ACTIVE'), { code: 'LEGAL_HOLD_ACTIVE' }),
      );
      const result = await run();
      expect(result.code).toBe(2);
      expect(result.report.state).toBe('failed');
      expect(ports.begin).not.toHaveBeenCalled();
      expect(ports.erase).not.toHaveBeenCalled();
    });
    it('uses injected database handles and leaves them open', async () => {
      const app = { db: {} as never, close: vi.fn() },
        eraser = { db: {} as never, close: vi.fn() };
      expect((await run({ app, eraser })).code).toBe(0);
      expect(app.close).not.toHaveBeenCalled();
      expect(eraser.close).not.toHaveBeenCalled();
      expect(ports.appClose).not.toHaveBeenCalled();
      expect(ports.eraserClose).not.toHaveBeenCalled();
    });
  });
});
