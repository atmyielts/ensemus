// Test-only pinned-library composition. No production export or runtime module imports test-support.
// The integration runner supplies the real auth-role connection; nothing here mints a fake proof.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { parseSetCookieHeader } from 'better-auth/cookies';
import { makeSignature } from 'better-auth/crypto';
export { hashPassword as fixturePasswordHash } from 'better-auth/crypto';
import { authSchema, type openAuthDatabase } from '@ensemus/database/auth';
import { mfaPlugins } from '../src/mfa';

export function privateFactorRouter(
  database: ReturnType<typeof openAuthDatabase>['db'],
  secret: string,
  baseURL: string,
): { handler: (request: Request) => Promise<Response> } {
  const auth = betterAuth({
    appName: 'Ensemus',
    database: drizzleAdapter(database, { provider: 'pg', schema: authSchema }),
    secret,
    baseURL,
    trustedOrigins: [baseURL],
    // Same cookie naming as createAuth for this baseURL, so a fixture's HTTPS runtime cookies are read.
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: baseURL.startsWith('https://'),
    },
    plugins: mfaPlugins(),
    rateLimit: { enabled: true, storage: 'database' },
    telemetry: { enabled: false },
    logger: { log: () => {} },
  });
  return { handler: (request) => auth.handler(request) };
}
export const fixtureCookies = (setCookie: string | null) =>
  [...parseSetCookieHeader(setCookie ?? '')]
    .map(([name, value]) => `${name}=${value.value}`)
    .join('; ');

/** Generated DB-session fixture only. Production still verifies this cookie through getSession. */
export async function fixtureSessionCookie(token: string, secret: string): Promise<string> {
  return `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, secret)}`)}`;
}
