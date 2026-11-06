// Owned by the mfa slice (ID-05). See docs/06-delivery/m7-slices.md and ADR-031 D8. Better Auth's `twoFactor`
// plugin does the TOTP. What it does not do is remember that a session proved one recently, which is what
// "recent MFA" needs, so that is ours, written with the auth role after Better Auth said yes.
import type { BetterAuthPlugin } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { parseSetCookieHeader } from 'better-auth/cookies';
type AfterHook = NonNullable<NonNullable<BetterAuthPlugin['hooks']>['after']>[number];
export const MFA_ACCOUNT_LOCKOUT = {
  enabled: true,
  maxFailedAttempts: 10,
  durationSeconds: 900,
} as const;

export function mfaPlugins(idpHooks?: { before: AfterHook; after: AfterHook }): BetterAuthPlugin[] {
  const native = twoFactor({
    issuer: 'Ensemus',
    allowPasswordless: true,
    skipVerificationOnEnable: false,
    totpOptions: { digits: 6, period: 30 },
    backupCodeOptions: { storeBackupCodes: 'encrypted', amount: 10, length: 10 },
    accountLockout: MFA_ACCOUNT_LOCKOUT,
  });
  if (!idpHooks) return [native];
  return [
    {
      ...native,
      hooks: {
        ...native.hooks,
        after: [
          idpHooks.before,
          ...native.hooks.after.map((hook) => ({
            ...hook,
            matcher: (context: Parameters<AfterHook['matcher']>[0]) =>
              hook.matcher(context) || idpHooks.before.matcher(context),
          })),
          idpHooks.after,
        ],
      },
    },
  ];
}

/** Public factor mutation would allow password-only disable/regenerate to bypass step-up. These
 * paths are available only through our private router and its session/code checks. */
export const MFA_PRIVATE_PATHS = [
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/generate-backup-codes',
  '/two-factor/get-totp-uri',
  '/two-factor/view-backup-codes',
  '/two-factor/send-otp',
  '/two-factor/verify-otp',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
] as const;

export type MfaOutcome =
  | 'verified'
  | 'refused'
  | 'rate_limited'
  | 'not_enrolled'
  | 'primary_required'
  | 'setup_conflict'
  | 'already_enrolled';

export type MfaDependencies = {
  /** Better Auth's router, so its rate limits and lockout apply: `auth.api` goes round them. */
  handler: (request: Request) => Promise<Response>;
  managementHandler: (request: Request) => Promise<Response>;
  baseURL: string;
  enrollmentState: (userId: string) => Promise<'absent' | 'pending' | 'enrolled' | 'inconsistent'>;
  record: (input: {
    sessionId: string;
    userId: string;
    kind: 'mfa_totp' | 'mfa_backup_code';
    factorId?: string;
  }) => Promise<void>;
  reserveAttempt: (
    userId: string,
  ) => Promise<{ outcome: 'reserved'; factorId: string } | { outcome: 'locked' | 'not_enrolled' }>;
  /** Atomic auth-role admission across accounts' sessions and all web replicas. */
  admit: (input: {
    userId: string;
    kind: 'mfa_totp' | 'mfa_backup_code';
    code: string;
  }) => Promise<boolean>;
  revoke: (userId: string) => Promise<void>;
  prepareEnrollment: (input: {
    userId: string;
    sessionId: string;
    maxAgeSeconds: number;
  }) => Promise<string | null>;
  recordEnrollment: (
    input: { userId: string; sessionId: string; maxAgeSeconds: number },
    candidate: string,
  ) => Promise<boolean>;
  enrollmentCurrent: (input: {
    userId: string;
    sessionId: string;
    maxAgeSeconds: number;
  }) => Promise<boolean>;
  enrollmentCurrentAfterRotation: (input: {
    userId: string;
    sessionId: string;
    resultingSessionId: string;
    maxAgeSeconds: number;
  }) => Promise<boolean>;
  completePrimaryAfterFactor: (input: {
    userId: string;
    sessionId: string;
    headers: Headers;
  }) => Promise<boolean>;
};

type Code = { code: string; kind: 'totp' | 'backup_code' };
type Session = { sessionId: string; userId: string };
export type MfaResponse = {
  outcome: MfaOutcome;
  setCookie: string | null;
  totpURI?: string;
  backupCodes?: string[];
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
  completeSignIn(input: Code, headers: Headers): Promise<MfaResponse>;
  enable(
    input: { password: string; maxAgeSeconds?: number },
    session: Session,
    headers: Headers,
  ): Promise<MfaResponse>;
  confirmEnrollment(
    input: { code: string; maxAgeSeconds?: number },
    session: Session,
    headers: Headers,
  ): Promise<MfaResponse>;
  disable(
    input: Code & { password: string },
    session: Session,
    headers: Headers,
  ): Promise<MfaResponse>;
  regenerateBackupCodes(
    input: Code & { password: string },
    session: Session,
    headers: Headers,
  ): Promise<MfaResponse>;
  isEnrolled(session: Session, headers: Headers): Promise<boolean>;
};

const validCode = (input: Code) =>
  typeof input.code === 'string' &&
  (input.kind === 'totp'
    ? input.code.length === 6 && !/[^0-9]/.test(input.code)
    : input.kind === 'backup_code' &&
      input.code.length >= 6 &&
      input.code.length <= 32 &&
      !/[^0-9A-Za-z-]/.test(input.code));
const factor = (input: Code) =>
  input.kind === 'totp' ? ('mfa_totp' as const) : ('mfa_backup_code' as const);
const refused = (outcome: MfaOutcome = 'refused'): MfaResponse => ({ outcome, setCookie: null });
function cookieHeaders(incoming: Headers, setCookie: string | null) {
  const headers = new Headers(incoming);
  if (setCookie) {
    const values = new Map(
      (headers.get('cookie') ?? '')
        .split(';')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
          const index = value.indexOf('=');
          return [value.slice(0, index), value.slice(index + 1)] as const;
        }),
    );
    for (const [name, value] of parseSetCookieHeader(setCookie)) {
      if (value.maxAge === 0) values.delete(name);
      else values.set(name, value.value);
    }
    headers.set('cookie', [...values].map(([name, value]) => `${name}=${value}`).join('; '));
  }
  return headers;
}
export function createMfaOperations(deps: MfaDependencies): MfaOperations {
  const call = async (path: string, body: unknown, headers: Headers, management = false) => {
    const forwarded = new Headers({
      'content-type': 'application/json',
      origin: new URL(deps.baseURL).origin,
    });
    for (const name of ['cookie', 'x-forwarded-for', 'user-agent']) {
      const value = headers.get(name);
      if (value) forwarded.set(name, value);
    }
    return (management ? deps.managementHandler : deps.handler)(
      new Request(new URL(`/api/auth${path}`, deps.baseURL), {
        method: 'POST',
        headers: forwarded,
        body: JSON.stringify(body),
      }),
    );
  };
  const session = async (headers: Headers): Promise<(Session & { enrolled: boolean }) | null> => {
    const forwarded = new Headers();
    for (const name of ['cookie', 'x-forwarded-for', 'user-agent']) {
      const value = headers.get(name);
      if (value) forwarded.set(name, value);
    }
    const response = await deps.handler(
      new Request(new URL('/api/auth/get-session?disableCookieCache=true', deps.baseURL), {
        headers: forwarded,
      }),
    );
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as {
      session?: { id?: unknown; userId?: unknown; expiresAt?: unknown };
      user?: { id?: unknown; twoFactorEnabled?: unknown };
    } | null;
    if (
      typeof data?.session?.id !== 'string' ||
      typeof data.user?.id !== 'string' ||
      data.session.userId !== data.user.id ||
      typeof data.session.expiresAt !== 'string' ||
      !(new Date(data.session.expiresAt).getTime() > Date.now())
    )
      return null;
    return {
      sessionId: data.session.id,
      userId: data.user.id,
      enrolled: data.user.twoFactorEnabled === true,
    };
  };
  const matches = (actual: Session | null, expected: Session) =>
    actual?.userId === expected.userId && actual?.sessionId === expected.sessionId;
  const verify = async (
    input: Code,
    headers: Headers,
    expected: Session | null,
    allowNewSession = false,
    enrollmentReturn?: (actual: Session) => Promise<boolean>,
  ): Promise<MfaResponse> => {
    if (!validCode(input)) return refused();
    const before = await session(headers);
    if (expected && !matches(before, expected)) return refused();
    if (expected && !allowNewSession && !before?.enrolled) return refused('not_enrolled');
    if (!expected && before) return refused();
    // The plugin meters account failures only for sign-in challenges. The short auth-role lock
    // reserving a signed-in attempt ends BEFORE the private router opens another connection.
    const attempt = before ? await deps.reserveAttempt(before.userId) : null;
    if (attempt && attempt.outcome !== 'reserved')
      return refused(attempt.outcome === 'locked' ? 'rate_limited' : 'not_enrolled');
    // A previous disable may have crashed after clearing the enabled flag but before revoke-all.
    // Remove those old proofs BEFORE enabling a replacement factor, so re-enrollment cannot revive
    // another session's assurance for the old secret. Wrong enrollment codes cannot use old proofs.
    if (allowNewSession && expected && before && !before.enrolled) await deps.revoke(before.userId);
    const response = await call(
      input.kind === 'totp' ? '/two-factor/verify-totp' : '/two-factor/verify-backup-code',
      { code: input.code, trustDevice: false },
      headers,
    );
    if (response.status !== 200)
      return refused(response.status === 429 ? 'rate_limited' : 'refused');
    const data = (await response.json().catch(() => null)) as {
      user?: { id?: unknown; twoFactorEnabled?: unknown };
    } | null;
    const setCookie = response.headers.get('set-cookie');
    const after = await session(cookieHeaders(headers, setCookie));
    if (
      !after?.enrolled ||
      data?.user?.id !== after.userId ||
      (expected && after.userId !== expected.userId) ||
      (!allowNewSession && expected && !matches(after, expected))
    )
      return refused();
    if (enrollmentReturn && !(await enrollmentReturn(after))) return refused('primary_required');
    if (!(await deps.admit({ userId: after.userId, kind: factor(input), code: input.code })))
      return refused();
    if (
      !expected &&
      !(await deps.completePrimaryAfterFactor({
        userId: after.userId,
        sessionId: after.sessionId,
        headers,
      }))
    )
      return refused('primary_required');
    await deps.record({
      sessionId: after.sessionId,
      userId: after.userId,
      kind: factor(input),
      ...(attempt?.outcome === 'reserved' ? { factorId: attempt.factorId } : {}),
    });
    return { outcome: 'verified', setCookie };
  };
  const management = async (
    path: string,
    password: string,
    expected: Session,
    headers: Headers,
  ): Promise<MfaResponse> => {
    if (
      typeof password !== 'string' ||
      password.length > 128 ||
      !matches(await session(headers), expected)
    )
      return refused();
    const response = await call(path, { password, method: 'totp' }, headers, true);
    if (response.status !== 200) {
      if (response.status === 429) return refused('rate_limited');
      if (path === '/two-factor/enable') {
        const problem = (await response
          .clone()
          .json()
          .catch(() => null)) as { code?: unknown } | null;
        if (problem?.code === 'TOTP_ALREADY_ENABLED') return refused('already_enrolled');
        if (response.status >= 500 || response.status === 409) {
          const state = await deps.enrollmentState(expected.userId);
          if (state === 'enrolled') return refused('already_enrolled');
          if (state === 'pending' || state === 'inconsistent') return refused('setup_conflict');
        }
      }
      return refused();
    }
    const data = (await response.json().catch(() => null)) as {
      totpURI?: unknown;
      backupCodes?: unknown;
      status?: unknown;
    } | null;
    const setCookie = response.headers.get('set-cookie');
    if (path === '/two-factor/disable') {
      if (data?.status !== true) return refused();
      // Plugin rotation invalidates only this session; all other sessions must lose their old MFA
      // assurances too. SSO assurance belongs to a separate proof and is preserved by the auth DAL.
      await deps.revoke(expected.userId);
      return { outcome: 'verified', setCookie };
    }
    if (
      !Array.isArray(data?.backupCodes) ||
      data.backupCodes.length !== 10 ||
      !data.backupCodes.every(
        (value) => typeof value === 'string' && /^[0-9A-Za-z-]{6,32}$/.test(value),
      )
    )
      return refused();
    if (
      path === '/two-factor/enable' &&
      (typeof data.totpURI !== 'string' || !data.totpURI.startsWith('otpauth://totp/'))
    )
      return refused();
    return {
      outcome: 'verified',
      setCookie,
      backupCodes: data.backupCodes as string[],
      ...(typeof data.totpURI === 'string' ? { totpURI: data.totpURI } : {}),
    };
  };
  return {
    verifyStepUp: async (input, expected, headers) =>
      (await verify(input, headers, expected)).outcome,
    completeSignIn: (input, headers) => verify(input, headers, null, true),
    async confirmEnrollment(input, expected, headers) {
      if (
        !(await deps.enrollmentCurrent({ ...expected, maxAgeSeconds: input.maxAgeSeconds ?? 900 }))
      )
        return refused('primary_required');
      return verify({ code: input.code, kind: 'totp' }, headers, expected, true, (actual) =>
        deps.enrollmentCurrentAfterRotation({
          ...expected,
          resultingSessionId: actual.sessionId,
          maxAgeSeconds: input.maxAgeSeconds ?? 900,
        }),
      );
    },
    async enable(input, expected, headers) {
      const identity = { ...expected, maxAgeSeconds: input.maxAgeSeconds ?? 900 };
      const candidate = await deps.prepareEnrollment(identity);
      if (!candidate) return refused('primary_required');
      const result = await management('/two-factor/enable', input.password, expected, headers);
      if (result.outcome === 'verified' && !(await deps.recordEnrollment(identity, candidate)))
        return refused('primary_required');
      return result;
    },
    async disable(input, expected, headers) {
      const proof = await verify(input, headers, expected);
      return proof.outcome === 'verified'
        ? management('/two-factor/disable', input.password, expected, headers)
        : proof;
    },
    async regenerateBackupCodes(input, expected, headers) {
      const proof = await verify(input, headers, expected);
      return proof.outcome === 'verified'
        ? management('/two-factor/generate-backup-codes', input.password, expected, headers)
        : proof;
    },
    isEnrolled: async (expected, headers) => {
      const current = await session(headers);
      return !!current?.enrolled && matches(current, expected);
    },
  };
}
