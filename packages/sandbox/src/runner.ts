import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute, parse, resolve } from 'node:path';
import {
  compileSandboxPolicy,
  probePassed,
  SANDBOX_INPUT_MAX_BYTES,
  type IsolationProbeReport,
  type SandboxJobEnding,
  type SandboxLimits,
} from '@ensemus/domain/sandbox';
import { clearStaleJobBundles, prepareWorkRoot, runWithBundle, validJobFiles } from './job-bundle';
import type { OciSpec } from './oci';
import { createOciCliRuntime } from './oci-runtime';
import { runIsolationProbe } from './probe';
import {
  RUNNER_HEALTH_PATH,
  RUNNER_JOBS_PATH,
  RUNNER_MAX_REQUEST_BYTES,
  RUNNER_PROBE_PATH,
  runnerJobRequestSchema,
  runnerJobResponseSchema,
  runnerProbeResponseSchema,
  type RunnerJobRequest,
} from './protocol';

export { createOciCliRuntime };
export type { IsolationProbeReport };

export type RawJobResult = {
  ending: SandboxJobEnding;
  exitCode: number | null;
  wallMs: number;
  cpuMs: number;
  peakMemoryKb: number;
  stdout: Buffer;
  stdoutBytes: number;
  stderrBytes: number;
};

/** This port is implemented by an OCI runtime and by isolated fixtures in unit tests. */
export interface ContainerRuntime {
  readonly name: string;
  version(): Promise<string>;
  run(input: {
    jobId: string;
    bundleDir: string;
    spec: OciSpec;
    stdin: Buffer;
    limits: SandboxLimits;
    signal: AbortSignal;
  }): Promise<RawJobResult>;
}

export type SandboxRunnerConfig = {
  runtime: ContainerRuntime | null;
  rootfs: string;
  workRoot: string;
  token: string;
  maxConcurrentJobs: number;
  ceilings: SandboxLimits;
};

const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const PROBE_MAX_AGE_MS = 60_000;
const PROBE_RETRY_AFTER_MS = 5000;

class RequestTooLarge extends Error {}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

function write(response: ServerResponse, status: number, body?: object, close = false): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('cache-control', 'no-store');
  if (close) response.setHeader('connection', 'close');
  if (!body) {
    response.end();
    return;
  }
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

async function readJob(request: IncomingMessage): Promise<RunnerJobRequest | null> {
  const buffers: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > RUNNER_MAX_REQUEST_BYTES) throw new RequestTooLarge();
    buffers.push(buffer);
  }
  try {
    const input = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers)),
    );
    const parsed = runnerJobRequestSchema.safeParse(input);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function decodeJob(job: RunnerJobRequest) {
  const stdin = Buffer.from(job.stdinBase64, 'base64');
  if (stdin.length > SANDBOX_INPUT_MAX_BYTES || stdin.toString('base64') !== job.stdinBase64) {
    return null;
  }
  let bytes = 0;
  const files = [];
  for (const file of job.files) {
    const decoded = Buffer.from(file.contentBase64, 'base64');
    bytes += decoded.length;
    if (bytes > MAX_BUNDLE_BYTES || decoded.toString('base64') !== file.contentBase64) return null;
    files.push({ path: file.path, bytes: decoded });
  }
  return validJobFiles(files, job.policy.entry) ? { stdin, files } : null;
}

/** Authenticated request admission, bundle staging and fresh native probe evidence. */
export function createSandboxRunnerServer(config: SandboxRunnerConfig): Server {
  if (!config.token || /[\r\n]/.test(config.token)) throw new Error('INVALID_RUNNER_TOKEN');
  if (!Number.isSafeInteger(config.maxConcurrentJobs) || config.maxConcurrentJobs < 1) {
    throw new Error('INVALID_RUNNER_CONCURRENCY');
  }
  const tokenHash = sha256('Bearer ' + config.token);
  const runtime = config.runtime;
  const activeJobs = new Set<string>();
  let pendingRequests = 0;
  let preparedWorkRoot: Promise<string> | undefined;
  let probeInFlight: Promise<IsolationProbeReport> | undefined;
  let cachedProbe: { report: IsolationProbeReport; expiresAt: number } | undefined;

  async function prepare(): Promise<string> {
    if (!runtime) throw new Error('RUNNER_NOT_CONFIGURED');
    if (!isAbsolute(config.rootfs) || resolve(config.rootfs) === parse(config.rootfs).root) {
      throw new Error('INVALID_RUNTIME_ROOTFS');
    }
    return await (preparedWorkRoot ??= (async () => {
      await runtime.version();
      const workRoot = await prepareWorkRoot(config.workRoot);
      await clearStaleJobBundles(workRoot);
      return workRoot;
    })());
  }

  async function probe(): Promise<IsolationProbeReport> {
    if (!runtime) throw new Error('RUNNER_NOT_CONFIGURED');
    await runtime.version();
    if (cachedProbe && performance.now() < cachedProbe.expiresAt) return cachedProbe.report;
    return await (probeInFlight ??= (async () => {
      try {
        const report = runnerProbeResponseSchema.parse(
          await runIsolationProbe({
            runtime,
            workRoot: await prepare(),
            rootfs: config.rootfs,
            ceilings: config.ceilings,
          }),
        );
        cachedProbe = {
          report,
          expiresAt:
            performance.now() + (probePassed(report) ? PROBE_MAX_AGE_MS : PROBE_RETRY_AFTER_MS),
        };
        return report;
      } finally {
        probeInFlight = undefined;
      }
    })());
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === RUNNER_HEALTH_PATH && request.method === 'GET') {
      write(response, 200, { status: 'up' });
      return;
    }
    if (!timingSafeEqual(sha256(request.headers.authorization ?? ''), tokenHash)) {
      write(response, 401, undefined, true);
      return;
    }
    const isProbe = request.url === RUNNER_PROBE_PATH && request.method === 'GET';
    const isJob = request.url === RUNNER_JOBS_PATH && request.method === 'POST';
    if (!isProbe && !isJob) {
      write(response, 404, undefined, true);
      return;
    }
    if (!runtime) {
      write(response, 503, undefined, true);
      return;
    }
    if (isProbe) {
      write(response, 200, await probe());
      return;
    }
    const declared = request.headers['content-length'];
    if (declared !== undefined && Number(declared) > RUNNER_MAX_REQUEST_BYTES) {
      write(response, 413, undefined, true);
      return;
    }
    if (pendingRequests >= config.maxConcurrentJobs) {
      write(response, 503, undefined, true);
      return;
    }

    const cancellation = new AbortController();
    const disconnect = () => cancellation.abort();
    response.once('close', disconnect);
    pendingRequests++;
    try {
      const job = await readJob(request);
      if (!job) {
        write(response, 400);
        return;
      }
      const compiled = compileSandboxPolicy(job.policy, config.ceilings);
      const decoded = decodeJob(job);
      if (!compiled.ok || compiled.policyHash !== job.policyHash || !decoded) {
        write(response, 400);
        return;
      }
      if (activeJobs.has(job.jobId)) {
        write(response, 409);
        return;
      }
      activeJobs.add(job.jobId);
      try {
        const evidence = await probe();
        cancellation.signal.throwIfAborted();
        if (!probePassed(evidence)) {
          write(response, 503);
          return;
        }
        const { stdout, ...result } = await runWithBundle({
          runtime,
          jobId: job.jobId,
          workRoot: await prepare(),
          rootfs: config.rootfs,
          policy: compiled.policy,
          ...decoded,
          signal: cancellation.signal,
        });
        write(
          response,
          200,
          runnerJobResponseSchema.parse({
            ...result,
            stdoutBase64: stdout.toString('base64'),
            runtime: { name: evidence.runtime, version: evidence.runtimeVersion },
          }),
        );
      } finally {
        activeJobs.delete(job.jobId);
      }
    } finally {
      pendingRequests--;
      response.off('close', disconnect);
    }
  }

  return createServer({ requestTimeout: 30_000, headersTimeout: 5_000 }, (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      write(response, error instanceof RequestTooLarge ? 413 : 503, undefined, true);
    });
  });
}
