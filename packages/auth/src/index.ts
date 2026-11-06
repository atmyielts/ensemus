// Embedded authentication (ADR-024 D5, ID-03): local accounts and optional OIDC, with no hosted
// identity service, so it works unchanged in an air-gapped install.
import {
  authSchema,
  claimSetupToken,
  openAuthDatabase,
  releaseSetupToken,
} from '@ensemus/database/auth';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins';

export type OidcProvider = {
  providerId: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
};

export type AuthOptions = {
  databaseUrl: string;
  secret: string;
  baseURL: string;
  allowSignup: boolean;
  oidc?: OidcProvider;
  /** Framework plugins, such as Next.js cookies. They run last. */
  plugins?: BetterAuthPlugin[];
};

const log = createLogger('auth');

/**
 * Better Auth logs whole error objects, and an ORM error quotes its SQL and its parameters, which
 * here means email addresses. Only a fixed event and an error code ever leave this function.
 */
export function logSafely(level: string, _message: string, ...args: unknown[]) {
  const error = args.find((arg) => arg instanceof Error);
  const fields = error ? { errorCode: errorCode(error) } : {};
  if (level === 'error') log.error('auth.error', fields);
  else if (level === 'warn') log.warn('auth.warning', fields);
}

export type SetupAccount = { token: string; name: string; email: string; password: string };
export type SetupOutcome = 'created' | 'invalid_token' | 'invalid_details';

export type CredentialForm =
  | { path: '/sign-in/email'; body: { email: string; password: string } }
  | { path: '/sign-up/email'; body: { name: string; email: string; password: string } };

export type CredentialOutcome = {
  outcome: 'accepted' | 'refused' | 'rate_limited';
  /** The HTTP status behind the outcome, for the log. */
  status: number;
  /** The cookies to set, which the caller's framework has to pass on to the browser. */
  setCookie: string | null;
};

/** What the limits and the session record read. Nothing else from the form's request is passed on. */
const FORWARDED_HEADERS = ['x-forwarded-for', 'user-agent'];
const TOO_MANY_REQUESTS = 429;

export function createAuth(options: AuthOptions) {
  const { db, close } = openAuthDatabase(options.databaseUrl);
  const build = (allowSignup: boolean) =>
    betterAuth({
      appName: 'Ensemus',
      baseURL: options.baseURL,
      secret: options.secret,
      trustedOrigins: [options.baseURL],
      telemetry: { enabled: false },
      logger: { log: logSafely },
      database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 12,
        maxPasswordLength: 128,
        disableSignUp: !allowSignup,
      },
      session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
      // Provider tokens are not kept readable in the identity tables.
      account: { encryptOAuthTokens: true },
      rateLimit: {
        enabled: true,
        storage: 'database',
        window: 60,
        max: 100,
        customRules: {
          '/sign-in/email': { window: 60, max: 10 },
          '/sign-up/email': { window: 60, max: 5 },
        },
      },
      advanced: {
        database: { generateId: 'uuid' },
        useSecureCookies: options.baseURL.startsWith('https://'),
        defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      },
      plugins: [
        ...(options.oidc
          ? [
              genericOAuth({
                config: [
                  {
                    providerId: options.oidc.providerId,
                    clientId: options.oidc.clientId,
                    clientSecret: options.oidc.clientSecret,
                    discoveryUrl: options.oidc.discoveryUrl,
                    scopes: ['openid', 'email', 'profile'],
                    pkce: true,
                  },
                ],
              }),
            ]
          : []),
        ...(options.plugins ?? []),
      ],
    });
  const auth = build(options.allowSignup);

  /**
   * Submits a sign-in or sign-up form the way /api/auth receives it. Better Auth applies its rate limit
   * in its router, and `auth.api` goes straight to the endpoint past that, so a form calling `auth.api`
   * could be tried without limit. Going through the router means one limit and one count, whichever way
   * someone arrives. The Server Action has already had its origin checked by Next.js.
   */
  async function submitCredentials(
    form: CredentialForm,
    incoming: Headers,
  ): Promise<CredentialOutcome> {
    const headers = new Headers({
      'content-type': 'application/json',
      origin: new URL(options.baseURL).origin,
    });
    for (const name of FORWARDED_HEADERS) {
      const value = incoming.get(name);
      if (value) headers.set(name, value);
    }
    const response = await auth.handler(
      new Request(new URL(`/api/auth${form.path}`, options.baseURL), {
        method: 'POST',
        headers,
        body: JSON.stringify(form.body),
      }),
    );
    return {
      outcome: response.ok
        ? 'accepted'
        : response.status === TOO_MANY_REQUESTS
          ? 'rate_limited'
          : 'refused',
      status: response.status,
      setCookie: response.ok ? response.headers.get('set-cookie') : null,
    };
  }

  // Never mounted on any route, so sign-up stays exactly as closed as it was. The only way in here is
  // through redeemSetupToken, past a code only the operator's command can make.
  let forSetupCodes: typeof auth | undefined;

  /**
   * Makes the one account a setup code is for, and signs that person in (ID-01). The code is taken
   * first, so it cannot be used twice at once, and given back if the account could not be made.
   */
  async function redeemSetupToken(account: SetupAccount, headers: Headers): Promise<SetupOutcome> {
    const claimed = await claimSetupToken(db, account.token);
    if (!claimed) return 'invalid_token';
    try {
      forSetupCodes ??= build(true);
      await forSetupCodes.api.signUpEmail({
        body: { name: account.name, email: account.email, password: account.password },
        headers,
      });
      log.info('auth.setup_code_used');
      return 'created';
    } catch (error) {
      await releaseSetupToken(db, claimed);
      log.info('auth.setup_code_refused', { errorCode: errorCode(error) });
      return 'invalid_details';
    }
  }

  return { auth, close, redeemSetupToken, submitCredentials };
}

export type EnsemusAuth = ReturnType<typeof createAuth>['auth'];
