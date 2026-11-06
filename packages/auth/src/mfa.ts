// Owned by the mfa slice (ID-05). See docs/06-delivery/m7-slices.md and ADR-031 D8. Better Auth's `twoFactor`
// plugin does the TOTP. What it does not do is remember that a session proved one recently, which is what
// "recent MFA" needs, so that is ours, written with the auth role after Better Auth said yes.
import type { BetterAuthPlugin } from 'better-auth';

/** Empty until the slice lands, so sign-in is unchanged until then. */
export function mfaPlugins(): BetterAuthPlugin[] {
  return [];
}

export type MfaOutcome = 'verified' | 'refused' | 'rate_limited' | 'not_enrolled';

export type MfaDependencies = {
  /** Better Auth's router, so its rate limits and lockout apply: `auth.api` goes round them. */
  handler: (request: Request) => Promise<Response>;
  baseURL: string;
  record: (input: {
    sessionId: string;
    userId: string;
    kind: 'mfa_totp' | 'mfa_backup_code';
  }) => Promise<void>;
};

export type MfaOperations = {
  /**
   * Checks a code against this session's person, through the router, and records the proof for this session
   * only if Better Auth accepted it. The session comes from the verified cookie, which the caller's headers
   * carry, and never from a form.
   */
  verifyStepUp(
    input: { code: string; kind: 'totp' | 'backup_code' },
    session: { sessionId: string; userId: string },
    headers: Headers,
  ): Promise<MfaOutcome>;
};

export function createMfaOperations(_deps: MfaDependencies): MfaOperations {
  return {
    async verifyStepUp() {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
