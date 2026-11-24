// Account recovery and verification by email (0571). Better Auth makes and checks the tokens: a reset
// token is single use, lives thirty minutes and is stored only as its SHA-256; a verification token is a
// signed, expiring JWT that is stored nowhere. This file only turns Better Auth's "send this" into a row
// in the account mail queue, with the link sealed to the mail worker's key, because the web tier never
// sends mail and never holds a key that could read the link back (ADR-024 D5). Every form goes through
// Better Auth's router, so its limits apply, as `submitCredentials` does for passwords.
import { createHash, randomUUID } from 'node:crypto';
import {
  clearMailSuppression,
  type openAuthDatabase,
  queueAccountMail,
  reserveReauthentication,
  revokeSessionAssurances,
  type AccountMailKind,
  type SealedLink,
} from '@ensemus/database/auth';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('auth');

type EnsemusDrizzle = ReturnType<typeof openAuthDatabase>['db'];

/** The same as @ensemus/domain/mail's, which this package does not depend on. A test holds them equal. */
export const ACCOUNT_MAIL_LINK_PURPOSE = 'mail.link';
export const ACCOUNT_MAIL_LINK_SCOPE = '00000000-0000-0000-0000-000000000000';

export const RESET_TOKEN_SECONDS = 30 * 60;
export const VERIFICATION_TOKEN_SECONDS = 24 * 60 * 60;

/** Present only where the mail worker runs. Without it, nothing promises anyone an email. */
export type AccountMailOptions = {
  /** Seals a link to the mail worker's public key. The web tier cannot open what it seals. */
  seal(input: {
    organizationId: string;
    secretId: string;
    purpose: string;
    plaintext: string;
  }): SealedLink;
};

export const resetPasswordPath = (token: string) => `/reset-password/${encodeURIComponent(token)}`;
export const verifyEmailPath = (token: string) => `/verify-email/${encodeURIComponent(token)}`;

/**
 * What a verification link is for, read from its JWT without checking it, only to choose words: Better
 * Auth checks the token itself when it is used.
 */
export function verificationPurposeOf(
  token: string,
): 'verify' | 'approve_change' | 'finish_change' {
  const type = requestTypeOf(token);
  return type === 'change-email-confirmation'
    ? 'approve_change'
    : type === 'change-email-verification'
      ? 'finish_change'
      : 'verify';
}

function requestTypeOf(token: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    return typeof payload?.requestType === 'string' ? payload.requestType : null;
  } catch {
    return null;
  }
}

type User = { id: string; email: string; name?: string | null };

/**
 * Better Auth's mail settings, wired to the queue. A failure is logged as a code and swallowed: a person
 * asking for a reset gets the same answer whether or not an account exists or the queue worked, and a
 * sign-up is not undone because its welcome mail could not be queued.
 */
export function accountMailSettings(
  db: EnsemusDrizzle,
  baseURL: string,
  options: AccountMailOptions,
) {
  async function queue(
    kind: AccountMailKind,
    user: User,
    address: string,
    payload: { link: string; newAddress?: string } | null,
    key: string,
  ) {
    const id = randomUUID();
    try {
      await queueAccountMail(db, {
        id,
        kind,
        idempotencyKey: `${kind}:${createHash('sha256').update(key).digest('hex')}`,
        userId: user.id,
        address,
        link: payload
          ? options.seal({
              organizationId: ACCOUNT_MAIL_LINK_SCOPE,
              secretId: id,
              purpose: ACCOUNT_MAIL_LINK_PURPOSE,
              plaintext: JSON.stringify(payload),
            })
          : null,
      });
    } catch (error) {
      log.error('auth.mail_queue_failed', { kind, errorCode: errorCode(error) });
    }
  }

  return {
    queuePasswordChanged: (user: User) =>
      queue('password_changed', user, user.email, null, `${user.id}:${randomUUID()}`),
    emailAndPassword: {
      resetPasswordTokenExpiresIn: RESET_TOKEN_SECONDS,
      // Every session ends, on every device, and the person signs in again with the new password.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }: { user: User; token: string }) => {
        // Not awaited: an address with an account answers in the same time as one without.
        void queue(
          'password_reset',
          user,
          user.email,
          { link: `${baseURL}${resetPasswordPath(token)}` },
          token,
        );
      },
      onPasswordReset: async ({ user }: { user: User }) => {
        await revokeSessionAssurances(db, user.id).catch((error: unknown) =>
          log.error('auth.reset_assurance_revoke_failed', { errorCode: errorCode(error) }),
        );
        await queue('password_changed', user, user.email, null, `${user.id}:${randomUUID()}`);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: VERIFICATION_TOKEN_SECONDS,
      sendVerificationEmail: async ({ user, token }: { user: User; token: string }) => {
        // Proving a new address while moving to it, or proving the address someone signed up with.
        const moving = requestTypeOf(token) === 'change-email-verification';
        await queue(
          moving ? 'email_change_verify' : 'email_verification',
          user,
          user.email,
          { link: `${baseURL}${verifyEmailPath(token)}` },
          token,
        );
      },
      afterEmailVerification: async (user: User) => {
        await clearMailSuppression(db, user.email).catch((error: unknown) =>
          log.error('auth.mail_suppression_clear_failed', { errorCode: errorCode(error) }),
        );
      },
    },
    changeEmail: {
      enabled: true,
      // A verified address has to agree first, then the new one proves itself.
      sendChangeEmailConfirmation: async ({
        user,
        newEmail,
        token,
      }: {
        user: User;
        newEmail: string;
        token: string;
      }) => {
        await queue(
          'email_change_confirm',
          user,
          user.email,
          { link: `${baseURL}${verifyEmailPath(token)}`, newAddress: newEmail },
          token,
        );
      },
    },
  };
}

export type RecoveryOutcome = 'done' | 'invalid' | 'expired' | 'weak' | 'rate_limited' | 'refused';

const TOO_MANY_REQUESTS = 429;
/** Changing an email address asks for the password again, this many times in this window per person. */
const REAUTH_LIMIT = 5;
const REAUTH_WINDOW_MS = 15 * 60_000;

/**
 * The forms, through Better Auth's router. Each forwards only the headers its limit and its session
 * read, and passes back the cookies a session change made.
 */
export function createAccountRecovery(deps: {
  db: EnsemusDrizzle;
  baseURL: string;
  handler: (request: Request) => Promise<Response>;
  verifyPassword: (password: string, headers: Headers) => Promise<boolean>;
  queuePasswordChanged: ((user: User) => Promise<void>) | null;
}) {
  const origin = new URL(deps.baseURL).origin;
  const call = async (
    path: string,
    incoming: Headers,
    init: { method: 'GET' | 'POST'; body?: unknown; withSession?: boolean },
  ) => {
    const headers = new Headers({ origin });
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    for (const name of ['x-forwarded-for', 'user-agent']) {
      const value = incoming.get(name);
      if (value) headers.set(name, value);
    }
    if (init.withSession) {
      const cookie = incoming.get('cookie');
      if (cookie) headers.set('cookie', cookie);
    }
    return deps.handler(
      new Request(new URL(`/api/auth${path}`, deps.baseURL), {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
    );
  };
  const codeOf = async (response: Response) =>
    (
      (await response
        .clone()
        .json()
        .catch(() => null)) as { code?: unknown } | null
    )?.code;
  const refusal = async (response: Response): Promise<RecoveryOutcome> => {
    if (response.status === TOO_MANY_REQUESTS) return 'rate_limited';
    const code = await codeOf(response);
    if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') return 'weak';
    if (code === 'TOKEN_EXPIRED') return 'expired';
    if (code === 'INVALID_TOKEN' || code === 'USER_NOT_FOUND') return 'invalid';
    return 'refused';
  };

  return {
    /** Always answers `done` unless limited, whether or not anyone has that address. */
    async requestPasswordReset(email: string, incoming: Headers): Promise<RecoveryOutcome> {
      const response = await call('/request-password-reset', incoming, {
        method: 'POST',
        body: { email },
      });
      return response.status === TOO_MANY_REQUESTS ? 'rate_limited' : 'done';
    },

    async resetPassword(token: string, newPassword: string, incoming: Headers) {
      const response = await call('/reset-password', incoming, {
        method: 'POST',
        body: { token, newPassword },
      });
      return response.ok ? ('done' as const) : refusal(response);
    },

    /**
     * Needs the current password, ends every other session and makes a new one for this browser, and
     * tells the person by email that it happened.
     */
    async changePassword(
      input: { userId: string; email: string; name: string; current: string; next: string },
      incoming: Headers,
    ): Promise<{ outcome: RecoveryOutcome; setCookie: string | null }> {
      const response = await call('/change-password', incoming, {
        method: 'POST',
        body: {
          currentPassword: input.current,
          newPassword: input.next,
          revokeOtherSessions: true,
        },
        withSession: true,
      });
      if (!response.ok) {
        const code = await codeOf(response);
        return {
          outcome: code === 'INVALID_PASSWORD' ? 'invalid' : await refusal(response),
          setCookie: null,
        };
      }
      await revokeSessionAssurances(deps.db, input.userId).catch((error: unknown) =>
        log.error('auth.change_assurance_revoke_failed', { errorCode: errorCode(error) }),
      );
      await deps.queuePasswordChanged?.({ id: input.userId, email: input.email, name: input.name });
      return { outcome: 'done', setCookie: response.headers.get('set-cookie') };
    },

    /**
     * Needs the current password again. Answers `done` whether or not the new address already has an
     * account, so this cannot be used to find out. Nothing changes until the links are followed.
     */
    async changeEmail(
      input: { userId: string; newEmail: string; password: string },
      incoming: Headers,
    ): Promise<RecoveryOutcome> {
      if (!(await reserveReauthentication(deps.db, input.userId, REAUTH_LIMIT, REAUTH_WINDOW_MS)))
        return 'rate_limited';
      if (!(await deps.verifyPassword(input.password, incoming).catch(() => false)))
        return 'invalid';
      const response = await call('/change-email', incoming, {
        method: 'POST',
        body: { newEmail: input.newEmail, callbackURL: '/' },
        withSession: true,
      });
      return response.ok ? 'done' : refusal(response);
    },

    /** Follows a verification link's token, and passes back the cookie an address change updates. */
    async verifyEmail(
      token: string,
      incoming: Headers,
    ): Promise<{ outcome: RecoveryOutcome; setCookie: string | null }> {
      const response = await call(`/verify-email?token=${encodeURIComponent(token)}`, incoming, {
        method: 'GET',
        withSession: true,
      });
      if (response.ok) return { outcome: 'done', setCookie: response.headers.get('set-cookie') };
      return { outcome: await refusal(response), setCookie: null };
    },

    /** Sends the signed-in person a fresh verification link. */
    async resendVerification(email: string, incoming: Headers): Promise<RecoveryOutcome> {
      const response = await call('/send-verification-email', incoming, {
        method: 'POST',
        body: { email },
        withSession: true,
      });
      return response.ok ? 'done' : refusal(response);
    },
  };
}

export type AccountRecovery = ReturnType<typeof createAccountRecovery>;
