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
}));
vi.mock('@ensemus/application/saas/offboarding', async (original) => ({
  ...(await original<typeof import('@ensemus/application/saas/offboarding')>()),
  beginErasure: ports.begin,
  inspectErasure: async () => ({
    state: 'erasing',
    activeHolds: 0,
    ledgerPending: 0,
    unsettledActions: 0,
    blobsPending: 0,
  }),
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
import { eraseCommand } from './ops-erase';

let directory: string;
beforeEach(() => {
  vi.resetAllMocks();
  ports.order.length = 0;
  directory = mkdtempSync(join(tmpdir(), 'ensemus-erase-seal-'));
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
async function run() {
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
});
