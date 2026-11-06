// Runs once when the server starts. Next.js reports uncaught errors from pages and actions through
// console.error, whole, and an ORM error's message is its SQL and its parameters. This keeps those
// out of the logs (ADR-013): what remains is an error code, and the digest a person can quote.
//
// It also starts tracing, if an operator named a collector (ADR-037 D3). The guard goes first, because
// a failure here is reported through console.error too. A ConfigError is left to propagate: Next.js
// then stops the process, and a setting that looks on and is not would be a false reading. There is no
// signal handler, because one could change how the server stops. The last batch of spans may be lost
// when it does, which is acceptable for tracing.
//
// NEXT_OTEL_FETCH_DISABLED is not set, because redactSpan in the SDK module already removes what a fetch
// span carries, on the only path out.
export async function register() {
  // A branch rather than an early return, as the Next.js docs show it. The bundler can drop a branch
  // for another runtime, along with what it imports, and the SDK module only works on Node.js.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [{ loadTracingConfig }, { createLogger }, { installConsoleGuard }] = await Promise.all([
      import('@ensemus/config'),
      import('@ensemus/telemetry'),
      import('@ensemus/telemetry/console-guard'),
    ]);
    installConsoleGuard(createLogger('web'));

    const tracing = loadTracingConfig();
    if (tracing.enabled) {
      // Imported only here, so a default install never loads the SDK, and it cannot try to send.
      const { startTracing } = await import('@ensemus/telemetry/tracing-sdk');
      const release = process.env.ENSEMUS_RELEASE;
      await startTracing('web', tracing, release ? { release } : {});
    }
  }
}
