// Owned by the halt slice (SEC-06). The operator's command for a global or provider stop (ADR-028 FD-15),
// like setup-token. It reaches only the database, so it works with the network otherwise down. It prints
// the switch's ID and nothing else.
import { createLogger } from '@ensemus/telemetry';

const log = createLogger('halt-global');

log.error('halt_global.not_built', { errorCode: 'NOT_IMPLEMENTED' });
process.exit(1);
