// The order oauthExchangeWorkflow takes its steps in (ADR-038 D1). Plain code with type imports only, so the
// workflow sandbox can load it and the unit tests can script it. Changing the order needs a patch: the
// replay corpus fails the build if that is forgotten.
import type { OAuthExchangeOutcome } from './schemas';

export type OAuthExchangePorts = {
  /** Tried once, ever. A code is single use, so a second try could only fail or look like a replay. */
  exchange(): Promise<OAuthExchangeOutcome>;
  /**
   * Ends the attempt `failed` and revokes its code and verifier. It touches only PostgreSQL and the
   * sealed values, never the provider, so it may retry until it lands.
   */
  abandon(): Promise<void>;
};

const FAILED: OAuthExchangeOutcome = { outcome: 'failed', connectionId: null };

/**
 * One exchange. The Activity settles the attempt itself whichever way it ends, and says so. If it never
 * answers, because its worker died, it timed out or it could not reach the database, nothing knows how
 * far it got, so the attempt is abandoned: a connection it did commit stays, and anything else ends
 * `failed`, so no attempt is left `exchanging` and the admin is told to start again.
 */
export async function runOAuthExchange(ports: OAuthExchangePorts): Promise<OAuthExchangeOutcome> {
  let outcome: OAuthExchangeOutcome;
  try {
    outcome = await ports.exchange();
  } catch {
    await ports.abandon();
    return FAILED;
  }
  return outcome;
}
