// An unsubscribe link, from a mail program with no session (RFC 8058). Binds only the hash of the token in
// the link, which reveals that one token's row, as withWebhookEndpointTx does for a webhook (0571). The
// caller binds the tenant from that row, and 0571's policies let this transaction write one thing: `off`,
// for that person and that topic.
import type { AppDatabase, Tx } from './tenant';

export function withMailUnsubscribeTx<T>(
  database: AppDatabase,
  tokenSha256: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(tokenSha256)) throw new Error('INVALID_UNSUBSCRIBE_TOKEN');
  return database.transaction({ 'app.mail_unsubscribe_token': tokenSha256 }, fn);
}
