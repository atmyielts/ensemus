// Embedded authentication (ADR-024 D5, ID-03): local accounts and optional OIDC, with no hosted
// identity service, so it works unchanged in an air-gapped install.
import { authSchema, openAuthDatabase } from '@ensemus/database/auth';
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

export function createAuth(options: AuthOptions) {
  const { db, close } = openAuthDatabase(options.databaseUrl);
  const auth = betterAuth({
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
      disableSignUp: !options.allowSignup,
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
  return { auth, close };
}

export type EnsemusAuth = ReturnType<typeof createAuth>['auth'];
