// For @ensemus/auth only (enforced by lint). This role can read password hashes and sessions, and
// nothing tenant-related, so a bug in application queries cannot reach them.
import { createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { accounts, rateLimits, sessions, setupTokens, users, verifications } from './schema';

export const authSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  rateLimit: rateLimits,
};

export function openAuthDatabase(url: string) {
  return openDatabase(url, { max: 5 });
}

export const hashSetupToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Takes a setup code, if it is one that still works. Taking it and checking it are one statement, so
 * two people sending the same code cannot both get through. Returns its ID, or nothing.
 */
export async function claimSetupToken(
  db: EnsemusDrizzle,
  token: string,
  now = new Date(),
): Promise<string | null> {
  const [claimed] = await db
    .update(setupTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(setupTokens.tokenHash, hashSetupToken(token)),
        isNull(setupTokens.usedAt),
        gt(setupTokens.expiresAt, now),
      ),
    )
    .returning({ id: setupTokens.id });
  return claimed?.id ?? null;
}

/** Gives a code back when the account it was for could not be made. Nothing has used it. */
export async function releaseSetupToken(db: EnsemusDrizzle, id: string) {
  await db.update(setupTokens).set({ usedAt: null }).where(eq(setupTokens.id, id));
}
