import 'server-only';
import { createLogger } from '@ensemus/telemetry';
import {
  createClientAddressWatch,
  type ClientAddressWatch,
} from '@ensemus/telemetry/client-address-watch';

const log = createLogger('web');

// Next.js can load a server module once for pages and again for route handlers. They are one process and
// see one population of people, so they must share one watch (ADR-037 D9).
const WATCH = Symbol.for('ensemus.clientAddressWatch');
const processWide = globalThis as unknown as Record<symbol, ClientAddressWatch | undefined>;

function theWatch(): ClientAddressWatch {
  return (processWide[WATCH] ??= createClientAddressWatch({
    onSuspected: ({ identities }) =>
      log.warn('proxy.client_addresses_look_shared', { count: identities }),
  }));
}

/**
 * Tells the watch about one person who has a session, so nobody without one can raise the warning. The
 * address is the first value the proxy gave.
 */
export function noteClientAddress(forwardedFor: string | null, userId: string): void {
  try {
    const address = forwardedFor?.split(',', 1)[0]?.trim();
    theWatch().observe(address || null, userId);
  } catch {
    // Only writing the warning can fail, which leaves nowhere to report it, and a warning about a guess
    // is never worth a person's request.
  }
}
