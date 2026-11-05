// For @ensemus/auth only (enforced by lint). This role can read password hashes and sessions, and
// nothing tenant-related, so a bug in application queries cannot reach them.
import { openDatabase } from './connection';
import { accounts, rateLimits, sessions, users, verifications } from './schema';

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
