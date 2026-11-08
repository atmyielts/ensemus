import {
  readAuthRestoreAdmission,
  type openAuthDatabase,
  isRestoreAdmissionDenied,
} from '@ensemus/database/auth';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { verifyJWT } from 'better-auth/crypto';

/** The native verifier checks the signature too; no unverified JWT field can relax its cutoff. */
export async function restoreVerificationTokenIsCurrent(
  token: unknown,
  secret: string,
  cutoff: string | null,
): Promise<boolean> {
  if (cutoff === null) return true;
  if (typeof token !== 'string' || token.length > 16384 || !Number.isFinite(Date.parse(cutoff)))
    return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[0] || parts[0].length > 2048) return false;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as {
      alg?: unknown;
    };
    if (header.alg !== 'HS256') return false;
  } catch {
    return false;
  }
  const claims = await verifyJWT(token, secret);
  // Strictly later avoids accepting a pre-restore token from the same coarse iat second.
  // The installed native email issuer emits HS256/email/iat/exp and no iss claim.
  return Boolean(
    claims &&
    claims.iss === undefined &&
    typeof claims.email === 'string' &&
    claims.email.length <= 320 &&
    typeof claims.iat === 'number' &&
    Number.isSafeInteger(claims.iat) &&
    claims.iat >= 0 &&
    claims.iat * 1000 > Date.parse(cutoff) &&
    claims.iat * 1000 <= Date.now() + 1000 &&
    typeof claims.exp === 'number' &&
    Number.isSafeInteger(claims.exp) &&
    claims.exp > claims.iat,
  );
}
export function createAuthRestoreAdmission(
  database: ReturnType<typeof openAuthDatabase>['db'],
  secret: string,
): BetterAuthPlugin {
  const admitted = async () => {
    let state;
    try {
      state = await readAuthRestoreAdmission(database);
    } catch (error) {
      throw new APIError('SERVICE_UNAVAILABLE', {
        code: isRestoreAdmissionDenied(error) ? 'RESTORE_PENDING' : 'SIGN_IN_UNAVAILABLE',
      });
    }
    if (state.phase !== 'admitted')
      throw new APIError('SERVICE_UNAVAILABLE', { code: 'RESTORE_PENDING' });
    return state;
  };
  return {
    id: 'ensemus-auth-restore-admission',
    // Native initializes plugins sequentially. This FIRST plugin refuses before any later provider
    // initialization; request hooks alone would run after provider discovery had already started.
    init: async () => {
      await admitted();
    },
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (context) => {
            const state = await admitted();
            if (
              context.path === '/verify-email' &&
              !(await restoreVerificationTokenIsCurrent(context.query?.token, secret, state.cutoff))
            )
              throw new APIError('BAD_REQUEST', { code: 'INVALID_TOKEN' });
          }),
        },
      ],
    },
  };
}
