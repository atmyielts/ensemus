import { createServer } from 'node:net';
import { loadIsolationConfig } from '@ensemus/config';
import { describe, expect, it, vi } from 'vitest';
import { collectIsolationEvidence, connectForIsolation } from './isolation-probes';

const pin = '87da694a-7328-4f75-8b08-15cac3459c4c';
const endpoint = (port: number) => ({ host: '127.0.0.1', port });

function config(env: NodeJS.ProcessEnv = {}) {
  return loadIsolationConfig({
    ENSEMUS_RELEASE: 'fixture-release',
    TEMPORAL_NAMESPACE: 'workspace-a',
    OBJECT_STORAGE_BUCKET: 'workspace-a',
    ENSEMUS_ISOLATION_FOREIGN_ENDPOINTS: JSON.stringify({
      database: [endpoint(15432)],
      temporal: [endpoint(17233)],
      objects: [endpoint(18333)],
    }),
    ENSEMUS_ISOLATION_FOREIGN_NAMESPACES: '["workspace-b"]',
    ENSEMUS_ISOLATION_FOREIGN_BUCKETS: '["workspace-b"]',
    ENSEMUS_ISOLATION_DECLARATIONS: JSON.stringify({
      backups: 'generated backup reference',
      embeddings: 'generated embedding reference',
      telemetry: 'generated telemetry reference',
      key_encryption_key: 'generated key reference',
    }),
    ...env,
  });
}

const absent = async () => 'unreachable' as const;
const local = () => ({
  listOrganizationIds: async () => [pin],
  localNamespace: async () => true,
  localWorkerPool: async () => true,
  localBucket: async () => true,
  connect: vi.fn(absent),
});

describe('dedicated deployment isolation evidence', () => {
  it('checks all the pinned peers and records operator references only as digests', async () => {
    const deps = local();
    const rows = await collectIsolationEvidence(config(), pin, deps);
    expect(rows.map(({ result }) => result)).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
      'passed',
      'declared',
      'declared',
      'declared',
      'declared',
    ]);
    expect(deps.connect.mock.calls).toEqual([15432, 17233, 18333].map((port) => [endpoint(port)]));
    expect(rows.find((row) => row.aspect === 'backups')?.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toMatch(/127\.0\.0\.1|workspace-a|generated backup reference/);
  });

  it('refuses a reachable peer even when everything local is healthy', async () => {
    const rows = await collectIsolationEvidence(config(), pin, {
      ...local(),
      connect: async ({ port }) => (port === 17233 ? 'reachable' : 'unreachable'),
    });
    for (const aspect of ['network', 'worker_pool', 'temporal_namespace']) {
      expect(rows).toContainEqual({ aspect, result: 'failed', code: 'FOREIGN_ENDPOINT_REACHABLE' });
    }
  });

  it('withholds evidence when the peer inventory or declarations are missing', async () => {
    const deps = local();
    const rows = await collectIsolationEvidence(
      loadIsolationConfig({ ENSEMUS_RELEASE: 'fixture-release' }),
      pin,
      deps,
    );
    expect(deps.connect).not.toHaveBeenCalled();
    expect(rows).toContainEqual({
      aspect: 'network',
      result: 'failed',
      code: 'NO_FOREIGN_ENDPOINTS_GIVEN',
    });
    expect(rows).toContainEqual({ aspect: 'backups', result: 'failed', code: 'NOT_DECLARED' });
  });

  it('refuses shared names, foreign organizations and unexpected connection errors', async () => {
    const rows = await collectIsolationEvidence(
      config({
        ENSEMUS_ISOLATION_FOREIGN_NAMESPACES: '["workspace-a"]',
        ENSEMUS_ISOLATION_FOREIGN_BUCKETS: '["workspace-a"]',
      }),
      pin,
      {
        ...local(),
        listOrganizationIds: async () => [pin, 'different'],
        connect: async ({ port }) => {
          if (port === 15432) throw new Error('private endpoint metadata');
          return 'unreachable';
        },
      },
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { aspect: 'database', result: 'failed', code: 'FOREIGN_ORGANIZATION_PRESENT' },
        { aspect: 'network', result: 'failed', code: 'PROBE_FAILED' },
        { aspect: 'worker_pool', result: 'failed', code: 'NAMESPACE_SHARED' },
        { aspect: 'object_store', result: 'failed', code: 'BUCKET_SHARED' },
      ]),
    );
  });

  it('requires the pinned row and positive local namespace, worker and storage checks', async () => {
    const rows = await collectIsolationEvidence(config(), pin, {
      ...local(),
      listOrganizationIds: async () => [],
      localNamespace: async () => false,
      localWorkerPool: async () => false,
      localBucket: async () => {
        throw new Error('local store unavailable');
      },
    });
    for (const aspect of ['database', 'worker_pool', 'temporal_namespace', 'object_store']) {
      expect(rows).toContainEqual({ aspect, result: 'failed', code: 'PROBE_FAILED' });
    }
  });

  it('rejects malformed peer addresses without leaking the supplied value', () => {
    const input = {
      ENSEMUS_ISOLATION_FOREIGN_ENDPOINTS: '{"database":[{"host":"not-a-literal","port":8}]}',
    };
    expect(() => config(input)).toThrow(/ENSEMUS_ISOLATION_FOREIGN_ENDPOINTS/);
    expect(() => config(input)).not.toThrow(/not-a-literal/);
  });

  it('can tell an active TCP listener from a closed one using real sockets', async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) =>
      server.once('error', reject).listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP listener');
    try {
      await expect(connectForIsolation(endpoint(address.port))).resolves.toBe('reachable');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await expect(connectForIsolation(endpoint(address.port))).resolves.toBe('unreachable');
  });
});
