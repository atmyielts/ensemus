// Account-wide admission after plugin verification and before recent assurance. TOTP validity spans
// adjacent windows: claiming three overlapping IDs prevents a replay at the next clock boundary.
import { createHmac } from 'node:crypto';
import { authSchema, type openAuthDatabase } from '@ensemus/database/auth';

type AcceptedCode = { userId: string; kind: 'mfa_totp' | 'mfa_backup_code'; code: string };
const PERIOD_MS = 30_000;
const NAMESPACE = 'ensemus-mfa-admit:v1';
export function mfaReplayRows(key: string, input: AcceptedCode, now = new Date()) {
  const period = Math.floor(now.getTime() / PERIOD_MS);
  return [-1, 0, 1].map((offset) => {
    const digest = createHmac('sha256', key)
      .update(JSON.stringify([NAMESPACE, input.userId, input.kind, input.code, period + offset]))
      .digest();
    const identifier = `${NAMESPACE}:${digest.toString('hex')}`;
    const uuid = Buffer.from(digest.subarray(0, 16));
    uuid[6] = (uuid[6]! & 15) | 128;
    uuid[8] = (uuid[8]! & 63) | 128;
    const hex = uuid.toString('hex');
    return {
      id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
      identifier,
      value: 'consumed',
      expiresAt: new Date((period + 4) * PERIOD_MS),
    };
  });
}
class ReplayRefused extends Error {}
export function createMfaAdmission(db: ReturnType<typeof openAuthDatabase>['db'], key: string) {
  return async (input: AcceptedCode): Promise<boolean> => {
    const rows = mfaReplayRows(key, input);
    try {
      return await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(authSchema.verification)
          .values(rows)
          .onConflictDoNothing()
          .returning({ id: authSchema.verification.id });
        // Roll back partial inserts too: a losing replica cannot consume a future overlapping window.
        if (inserted.length !== rows.length) throw new ReplayRefused();
        return true;
      });
    } catch (error) {
      if (error instanceof ReplayRefused) return false;
      throw error;
    }
  };
}
