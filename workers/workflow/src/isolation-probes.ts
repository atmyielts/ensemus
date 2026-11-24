import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import type { IsolationConfig } from '@ensemus/config';
import type { IsolationAspect, IsolationCode, IsolationResult } from '@ensemus/domain/tenancy';

export type ProbeResult = {
  aspect: IsolationAspect;
  result: IsolationResult;
  code: IsolationCode | null;
  evidenceSha256?: string;
};
type Endpoint = { host: string; port: number };
type Connect = (endpoint: Endpoint) => Promise<'reachable' | 'unreachable'>;

const NETWORK_REFUSALS = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

export function connectForIsolation(endpoint: Endpoint, timeoutMs = 1_500): ReturnType<Connect> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('unreachable');
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('reachable');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (NETWORK_REFUSALS.has(error.code ?? '')) resolve('unreachable');
      else reject(error);
    });
  });
}

async function endpointRefusal(
  endpoints: readonly Endpoint[],
  connect: Connect,
): Promise<IsolationCode | null> {
  if (endpoints.length === 0) return 'NO_FOREIGN_ENDPOINTS_GIVEN';
  const answers = await Promise.allSettled(endpoints.map(async (endpoint) => connect(endpoint)));
  if (answers.some((answer) => answer.status === 'fulfilled' && answer.value === 'reachable'))
    return 'FOREIGN_ENDPOINT_REACHABLE';
  return answers.some((answer) => answer.status === 'rejected') ? 'PROBE_FAILED' : null;
}

async function checkLocal(prove: () => Promise<boolean>) {
  try {
    return await prove();
  } catch {
    return false;
  }
}

function comparedName(own: string, foreign: readonly string[], shared: IsolationCode) {
  if (!own || foreign.length === 0) return 'PROBE_FAILED';
  return foreign.includes(own) ? shared : null;
}

function probe(aspect: IsolationAspect, code: IsolationCode | null): ProbeResult {
  return { aspect, code, result: code === null ? 'passed' : 'failed' };
}

export async function collectIsolationEvidence(
  config: IsolationConfig,
  pinnedOrganizationId: string,
  deps: {
    listOrganizationIds: () => Promise<readonly string[]>;
    localNamespace: () => Promise<boolean>;
    localWorkerPool: () => Promise<boolean>;
    localBucket: () => Promise<boolean>;
    connect: Connect;
  },
): Promise<readonly ProbeResult[]> {
  const [database, dbPeer, temporalPeer, objectPeer, namespaceReady, workerReady, bucketReady] =
    await Promise.all([
      deps.listOrganizationIds().then(
        (ids): IsolationCode | null => {
          if (ids.some((id) => id !== pinnedOrganizationId)) return 'FOREIGN_ORGANIZATION_PRESENT';
          return ids.includes(pinnedOrganizationId) ? null : 'PROBE_FAILED';
        },
        (): IsolationCode => 'PROBE_FAILED',
      ),
      endpointRefusal(config.peers.database, deps.connect),
      endpointRefusal(config.peers.temporal, deps.connect),
      endpointRefusal(config.peers.objects, deps.connect),
      checkLocal(deps.localNamespace),
      checkLocal(deps.localWorkerPool),
      checkLocal(deps.localBucket),
    ]);
  const namespace =
    temporalPeer ??
    comparedName(config.namespace, config.namespaces, 'NAMESPACE_SHARED') ??
    (namespaceReady ? null : 'PROBE_FAILED');
  const bucket =
    objectPeer ??
    comparedName(config.bucket, config.buckets, 'BUCKET_SHARED') ??
    (bucketReady ? null : 'PROBE_FAILED');
  const declarations = (['backups', 'embeddings', 'telemetry', 'key_encryption_key'] as const).map(
    (aspect): ProbeResult => {
      const reference = config.declarations[aspect];
      return reference
        ? {
            aspect,
            result: 'declared',
            code: null,
            evidenceSha256: createHash('sha256').update(reference).digest('hex'),
          }
        : { aspect, result: 'failed', code: 'NOT_DECLARED' };
    },
  );
  return [
    probe('database', database),
    probe('network', dbPeer ?? temporalPeer ?? objectPeer),
    probe('worker_pool', namespace ?? (workerReady ? null : 'PROBE_FAILED')),
    probe('temporal_namespace', namespace),
    probe('object_store', bucket),
    ...declarations,
  ];
}
