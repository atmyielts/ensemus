// Platform email, the application's side (0571): what a person chooses to get by email, an unsubscribe
// link, and an invitation's email. The web tier only queues. The mail worker sends, and reads each
// person's choice at the moment a message is due.
import { createHash, randomUUID } from 'node:crypto';
import {
  mailOutbox,
  mailUnsubscribeTokens,
  notificationPreferences,
  withMailUnsubscribeTx,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  DEFAULT_NOTIFICATION_DELIVERY,
  MAIL_LINK_PURPOSE,
  NOTIFICATION_DELIVERIES,
  NOTIFICATION_TOPICS,
  type NotificationDelivery,
  type NotificationTopic,
} from '@ensemus/domain/mail';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from './errors';

/** Seals a link to the mail worker's public key. The web tier cannot open what it seals. */
export type MailSealer = (input: {
  organizationId: string;
  secretId: string;
  purpose: string;
  plaintext: string;
}) => { keyId: string; wrappedKey: Buffer; iv: Buffer; ciphertext: Buffer; authTag: Buffer };

/** Present only where the mail worker runs. */
export type InvitationMail = { seal: MailSealer; publicUrl: string };

export const invitationPath = (token: string) => `/invite/${encodeURIComponent(token)}`;

/**
 * Queues an invitation's email in the transaction that made the invitation, which 0571 requires. Answers
 * whether it will go: over the company's or the address's hourly limit it is kept unsent, and the person
 * inviting copies the link instead.
 */
export async function queueInvitationMail(
  tx: Tx,
  context: TenantContext,
  input: { invitationId: string; email: string; token: string },
  mail: InvitationMail,
): Promise<boolean> {
  const id = randomUUID();
  const sealed = mail.seal({
    organizationId: context.organizationId,
    secretId: id,
    purpose: MAIL_LINK_PURPOSE,
    plaintext: JSON.stringify({ link: `${mail.publicUrl}${invitationPath(input.token)}` }),
  });
  const [row] = await tx
    .insert(mailOutbox)
    .values({
      id,
      organizationId: context.organizationId,
      kind: 'invitation',
      idempotencyKey: `invitation:${context.organizationId}:${input.invitationId}`,
      invitationId: input.invitationId,
      recipientAddress: input.email,
      linkKeyId: sealed.keyId,
      linkWrappedKey: sealed.wrappedKey,
      linkIv: sealed.iv,
      linkCiphertext: sealed.ciphertext,
      linkAuthTag: sealed.authTag,
      // Set by 0571 from the kind. Named because the column has no default.
      sendBefore: sql`now() + interval '7 days'`,
    })
    .returning({ status: mailOutbox.status });
  return row?.status === 'queued';
}

// --- Preferences

export type NotificationPreference = {
  topic: NotificationTopic;
  delivery: NotificationDelivery;
  /** No choice was made, so this is the default. */
  isDefault: boolean;
};

function requirePerson(context: TenantContext) {
  // Only a person chooses what they hear about. An agent or a service has no inbox of its own.
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
}

/** Every topic, with this person's choice or the default. */
export async function getMyNotificationPreferences(
  database: AppDatabase,
  context: TenantContext,
): Promise<NotificationPreference[]> {
  requirePerson(context);
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({ topic: notificationPreferences.topic, delivery: notificationPreferences.delivery })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.membershipId, context.membershipId)),
  );
  const chosen = new Map(rows.map((row) => [row.topic, row.delivery]));
  return NOTIFICATION_TOPICS.map((topic) => {
    const value = chosen.get(topic);
    const delivery = (NOTIFICATION_DELIVERIES as readonly string[]).includes(value ?? '')
      ? (value as NotificationDelivery)
      : DEFAULT_NOTIFICATION_DELIVERY[topic];
    return { topic, delivery, isDefault: value === undefined };
  });
}

export const notificationPreferencesSchema = z.strictObject(
  Object.fromEntries(
    NOTIFICATION_TOPICS.map((topic) => [topic, z.enum(NOTIFICATION_DELIVERIES).optional()]),
  ) as Record<NotificationTopic, z.ZodOptional<z.ZodEnum<{ [K in NotificationDelivery]: K }>>>,
);

/**
 * Saves this person's choices. A topic set back to its default keeps no row, so a better default later
 * reaches everyone who never chose. Topics not named are left as they are.
 */
export async function setMyNotificationPreferences(
  database: AppDatabase,
  context: TenantContext,
  raw: unknown,
): Promise<NotificationPreference[]> {
  requirePerson(context);
  const parsed = notificationPreferencesSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  await withTenantTx(database, context, async (tx) => {
    for (const topic of NOTIFICATION_TOPICS) {
      const delivery = parsed.data[topic];
      if (!delivery) continue;
      if (delivery === DEFAULT_NOTIFICATION_DELIVERY[topic]) {
        await tx
          .delete(notificationPreferences)
          .where(
            and(
              eq(notificationPreferences.membershipId, context.membershipId),
              eq(notificationPreferences.topic, topic),
            ),
          );
        continue;
      }
      await tx
        .insert(notificationPreferences)
        .values({
          organizationId: context.organizationId,
          membershipId: context.membershipId,
          topic,
          delivery,
        })
        .onConflictDoUpdate({
          target: [
            notificationPreferences.organizationId,
            notificationPreferences.membershipId,
            notificationPreferences.topic,
          ],
          set: { delivery, updatedAt: new Date() },
        });
    }
  });
  return getMyNotificationPreferences(database, context);
}

// --- Unsubscribe links

const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export type UnsubscribeOutcome =
  { status: 'done'; topic: NotificationTopic; organizationId: string } | { status: 'invalid' };

/** What a link would turn off, without changing anything, so a page can ask first. */
export async function describeUnsubscribe(
  database: AppDatabase,
  token: string,
): Promise<{ topic: NotificationTopic } | null> {
  if (!TOKEN.test(token)) return null;
  const [row] = await withMailUnsubscribeTx(database, hashToken(token), (tx) =>
    tx
      .select({ topic: mailUnsubscribeTokens.topic })
      .from(mailUnsubscribeTokens)
      .where(eq(mailUnsubscribeTokens.tokenSha256, hashToken(token))),
  );
  return row ? { topic: row.topic as NotificationTopic } : null;
}

/**
 * Turns off the one topic one email's link names, for the person it was sent to. Needs no sign-in, so a
 * mail program's one-click unsubscribe works (RFC 8058), and it can do nothing else: 0571 lets the link
 * write only `off`, only for that person and topic. Following it again changes nothing.
 */
export async function unsubscribeByToken(
  database: AppDatabase,
  token: string,
): Promise<UnsubscribeOutcome> {
  if (!TOKEN.test(token)) return { status: 'invalid' };
  const hash = hashToken(token);
  return withMailUnsubscribeTx(database, hash, async (tx): Promise<UnsubscribeOutcome> => {
    const [row] = await tx
      .select({
        organizationId: mailUnsubscribeTokens.organizationId,
        membershipId: mailUnsubscribeTokens.membershipId,
        topic: mailUnsubscribeTokens.topic,
      })
      .from(mailUnsubscribeTokens)
      .where(eq(mailUnsubscribeTokens.tokenSha256, hash));
    if (!row) return { status: 'invalid' };
    // The preference is the tenant's row, born only with its tenant bound (0533).
    await tx.execute(sql`select set_config('app.organization_id', ${row.organizationId}, true)`);
    await tx
      .insert(notificationPreferences)
      .values({
        organizationId: row.organizationId,
        membershipId: row.membershipId,
        topic: row.topic,
        delivery: 'off',
      })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.organizationId,
          notificationPreferences.membershipId,
          notificationPreferences.topic,
        ],
        set: { delivery: 'off', updatedAt: new Date() },
      });
    await tx
      .update(mailUnsubscribeTokens)
      .set({ usedAt: sql`coalesce(${mailUnsubscribeTokens.usedAt}, now())` })
      .where(eq(mailUnsubscribeTokens.tokenSha256, hash));
    return {
      status: 'done',
      topic: row.topic as NotificationTopic,
      organizationId: row.organizationId,
    };
  });
}
