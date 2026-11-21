// The process that starts jobs (ADR-034 D3). Its container sits on an internal network with only the sandbox
// worker, holds no database URL and no secret but its own request token, and has no route anywhere. It runs
// only under the `sandbox` profile. All it does itself is read settings: @ensemus/sandbox/runner is the server.
import { loadSandboxRunnerConfig, readSecret } from '@ensemus/config';
import { createOciCliRuntime, createSandboxRunnerServer } from '@ensemus/sandbox/runner';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('sandbox-runner');

try {
  const config = loadSandboxRunnerConfig();
  // No default runtime, on purpose. With none set, every job is refused, and nothing runs as a plain process.
  const server = createSandboxRunnerServer({
    runtime: config.runtimeBinary
      ? createOciCliRuntime({ binary: config.runtimeBinary, stateDir: config.stateDir })
      : null,
    rootfs: config.rootfs,
    workRoot: config.workRoot,
    token: readSecret('SANDBOX_RUNNER_TOKEN'),
    maxConcurrentJobs: config.maxConcurrentJobs,
    ceilings: config.ceilings,
  });
  server.listen(config.port, () => {
    log.info('sandbox_runner.started', { runtimeConfigured: config.runtimeBinary !== null });
  });
} catch (error) {
  log.error('sandbox_runner.crashed', { errorCode: errorCode(error) });
  process.exit(1);
}
