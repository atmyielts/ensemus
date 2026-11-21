// Account mail, queued by the auth role (0571). Only @ensemus/auth reaches this, through
// @ensemus/database/auth. The link is sealed before it gets here, so this role never holds a way to read it
// back, and the database decides the times, the limit and what a suppressed message keeps.
import { sql } from 'drizzle-orm';
import type { EnsemusDrizzle } from './connection';
import type { SealedLink } from './mailer';

export type AccountMailKind =
  | 'password_reset'
  | 'email_verification'
  | 'email_change_confirm'
  | 'email_change_verify'
  | 'password_changed';

/**
 * Queues one account message. Queuing the same key twice queues it once. Over the limit for an address,
 * 0571 keeps it as suppressed, and this still returns as if it were queued, so a caller cannot tell.
 */
export async function queueAccountMail(
  db: EnsemusDrizzle,
  input: {
    id: string;
    kind: AccountMailKind;
    idempotencyKey: string;
    userId: string;
    address: string;
    link: SealedLink | null;
  },
): Promise<void> {
  await db.execute(sql`
    insert into platform.account_mail_outbox
      (id, kind, idempotency_key, recipient_user_id, recipient_address, link_key_id, link_wrapped_key,
       link_iv, link_ciphertext, link_auth_tag)
    values (${input.id}::uuid, ${input.kind}, ${input.idempotencyKey}, ${input.userId}::uuid, ${input.address},
            ${input.link?.keyId ?? null}, ${input.link?.wrappedKey ?? null}, ${input.link?.iv ?? null},
            ${input.link?.ciphertext ?? null}, ${input.link?.authTag ?? null})
    on conflict (idempotency_key) do nothing`);
}

/** Someone has just proven this address works, so notification mail may go to it again. */
export async function clearMailSuppression(db: EnsemusDrizzle, address: string): Promise<void> {
  await db.execute(sql`
    delete from platform.mail_suppressions
     where address_sha256 = encode(sha256(convert_to(lower(btrim(${address})),'UTF8')),'hex')`);
}

/**
 * Counts one attempt at something that needs a password again, in a fixed window per person, across
 * every web replica. True while the person is within `limit`. Better Auth's own limit is per address and
 * path, and a signed-in person changing their email is the same person from anywhere.
 */
export async function reserveReauthentication(
  db: EnsemusDrizzle,
  userId: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  const key = `ensemus:reauth:${userId}`;
  const result = await db.execute<{ count: number }>(sql`
    insert into identity.rate_limits (key, count, last_request) values (${key}, 1, ${now})
    on conflict (key) do update set
      count = case when identity.rate_limits.last_request < ${now - windowMs} then 1
                   else identity.rate_limits.count + 1 end,
      last_request = case when identity.rate_limits.last_request < ${now - windowMs} then ${now}
                          else identity.rate_limits.last_request end
    returning count`);
  return Number(result.rows[0]?.count ?? limit + 1) <= limit;
}
