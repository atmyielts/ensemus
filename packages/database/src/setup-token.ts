// For the operator's setup command only (lint blocks the web tier). It uses the migrator role.
import { createHash, randomBytes } from 'node:crypto';
import { openDatabase } from './connection';
import { setupTokens } from './schema';

const VALID_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * Makes a one-time code for one new account, for use where sign-up is off. Only its hash is stored, so
 * this return value is the only place the code ever exists.
 */
export async function issueSetupToken(migratorUrl: string, now = new Date()) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + VALID_FOR_MS);
  const { db, close } = openDatabase(migratorUrl, { max: 1 });
  try {
    await db.insert(setupTokens).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt,
    });
  } finally {
    await close();
  }
  return { token, expiresAt };
}
