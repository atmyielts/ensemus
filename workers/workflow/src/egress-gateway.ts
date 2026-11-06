// Owned by the email slice. See docs/06-delivery/m3-slices.md and ADR-027 D5. A byte-for-byte forwarder
// from one internal port to the one target the operator configured. It holds no secret and reaches no
// database, so taking it over gets an attacker nothing but that one target.
import { createLogger } from '@ensemus/telemetry';

const log = createLogger('egress-gateway');
log.error('egress_gateway.not_built');
process.exit(1);
