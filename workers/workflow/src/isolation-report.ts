// Owned by the isolation slice (EXP-08). See docs/06-delivery/m11c-slices.md and ADR-035 D5. A one-shot job that
// runs real probes from inside a deployment and records what it found, so nobody writes "isolated" by hand.
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('isolation-report');

async function main() {
  throw new Error('NOT_IMPLEMENTED');
}

main().catch((error: unknown) => {
  log.error('isolation_report.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
