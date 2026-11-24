// Worker-to-runner transport for the operator-configured internal service; never follows redirects.
import {
  SANDBOX_INPUT_MAX_BYTES,
  SandboxRunnerUnavailable,
  type SandboxJob,
  type SandboxRunnerPort,
} from '@ensemus/domain/sandbox';
import {
  RUNNER_JOBS_PATH,
  RUNNER_MAX_REQUEST_BYTES,
  RUNNER_PROBE_PATH,
  runnerJobRequestSchema,
  runnerJobResponseSchema,
  runnerProbeResponseSchema,
} from './protocol';

const MAX_RESPONSE_BYTES = 2 * SANDBOX_INPUT_MAX_BYTES + 4096;
const decoder = new TextDecoder('utf-8', { fatal: true });

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > limit) throw unavailable();
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => undefined);
      throw unavailable();
    }
    chunks.push(result.value);
  }
  return JSON.parse(decoder.decode(Buffer.concat(chunks)));
}

function unavailable() {
  return new SandboxRunnerUnavailable('RUNNER_UNREACHABLE');
}

export function createRunnerClient(config: {
  url: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}): SandboxRunnerPort {
  const base = new URL(config.url);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    config.token.length === 0 ||
    /[\r\n]/.test(config.token)
  )
    throw new SandboxRunnerUnavailable('RUNNER_NOT_CONFIGURED');
  const send = config.fetch ?? globalThis.fetch;
  const headers = { authorization: `Bearer ${config.token}`, accept: 'application/json' };
  const request = async (path: string, options: RequestInit, limit: number) => {
    try {
      const response = await send(new URL(path, base), {
        ...options,
        headers: { ...headers, ...options.headers },
        redirect: 'error',
        cache: 'no-store',
      });
      if (!response.ok) throw unavailable();
      if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        throw unavailable();
      return await boundedJson(response, limit);
    } catch {
      // Protocol/decode failures reveal neither URL, token, body nor vendor error text.
      throw unavailable();
    }
  };
  function jobBody(job: SandboxJob) {
    const data = runnerJobRequestSchema.safeParse({
      jobId: job.jobId,
      policy: job.policy,
      policyHash: job.policyHash,
      files: job.files.map(({ path, content }) => ({
        path,
        contentBase64: content.toString('base64'),
      })),
      stdinBase64: job.stdin.toString('base64'),
    });
    if (!data.success) throw unavailable();
    const body = JSON.stringify(data.data);
    if (Buffer.byteLength(body, 'utf8') > RUNNER_MAX_REQUEST_BYTES) throw unavailable();
    return body;
  }
  return {
    async probe(signal) {
      const timeout = AbortSignal.timeout(10_000);
      const input = await request(
        RUNNER_PROBE_PATH,
        { method: 'GET', signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
        16_384,
      );
      const report = runnerProbeResponseSchema.safeParse(input);
      if (!report.success) throw unavailable();
      return report.data;
    },
    async execute(job, signal) {
      const input = await request(
        RUNNER_JOBS_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jobBody(job),
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(Math.min(job.policy.limits.wallMs + 5000, 300_000)),
          ]),
        },
        MAX_RESPONSE_BYTES,
      );
      const parsed = runnerJobResponseSchema.safeParse(input);
      if (!parsed.success) throw unavailable();
      const { stdoutBase64, ...rest } = parsed.data;
      const stdout = Buffer.from(stdoutBase64, 'base64');
      if (
        stdout.toString('base64') !== stdoutBase64 ||
        stdout.length > Math.min(job.policy.limits.outputKb * 1024, SANDBOX_INPUT_MAX_BYTES) ||
        rest.stdoutBytes < stdout.length
      )
        throw unavailable();
      return { ...rest, stdout };
    },
  };
}
