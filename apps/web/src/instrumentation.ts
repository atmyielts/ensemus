// Runs once when the server starts. Next.js reports uncaught errors from pages and actions through
// console.error, whole, and an ORM error's message is its SQL and its parameters. This keeps those
// out of the logs (ADR-013): what remains is an error code, and the digest a person can quote.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const [{ createLogger }, { installConsoleGuard }] = await Promise.all([
    import('@ensemus/telemetry'),
    import('@ensemus/telemetry/console-guard'),
  ]);
  installConsoleGuard(createLogger('web'));
}
