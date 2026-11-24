// Platform email (0570, 0571). Who may write these, and how a message may move, are in 0571, which is
// flagged for human security review. The tables carry no message text: the mail worker renders each
// message when it sends it, from what is true then. A link with a live token in it is sealed to the
// worker's key and erased by the database the moment its message settles.
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgSchema, organizations, platformSchema } from './schema';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const when = () => timestamp({ withTimezone: true });

/** What both queues share: the sealed link and a message's progress. */
const delivery = () => ({
  recipientAddress: text(),
  /** SHA-256 of the lower-cased address, kept after the address itself is erased. */
  recipientSha256: text(),
  linkKeyId: text(),
  linkWrappedKey: bytea(),
  linkIv: bytea(),
  linkCiphertext: bytea(),
  linkAuthTag: bytea(),
  status: text().notNull().default('queued'),
  attempts: integer().notNull().default(0),
  nextAttemptAt: when().notNull().defaultNow(),
  sendBefore: when().notNull(),
  claimedAt: when(),
  lastCode: text(),
  providerStatus: integer(),
  messageId: text(),
  createdAt: when().notNull().defaultNow(),
  updatedAt: when().notNull().defaultNow(),
  sentAt: when(),
});

/** Mail about someone's own account. It has no tenant, and only the auth role can queue it. */
export const accountMailOutbox = platformSchema.table(
  'account_mail_outbox',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text().notNull(),
    idempotencyKey: text().notNull().unique(),
    recipientUserId: uuid().notNull(),
    ...delivery(),
  },
  (t) => [
    index('account_mail_outbox_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'queued'`),
    index('account_mail_outbox_recipient_idx').on(t.recipientSha256, t.createdAt),
  ],
);

/**
 * Mail for one tenant: an invitation to an address, or a notification or digest for a member, whose
 * address is looked up when it is sent, so a changed address or a person who left is honoured.
 */
export const mailOutbox = platformSchema.table(
  'mail_outbox',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    kind: text().notNull(),
    idempotencyKey: text().notNull().unique(),
    recipientMembershipId: uuid(),
    notificationId: uuid(),
    notificationKind: text(),
    targetRef: text(),
    reminderNumber: integer(),
    invitationId: uuid(),
    digestId: uuid(),
    digestDueAt: when(),
    ...delivery(),
  },
  (t) => [
    index('mail_outbox_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'queued'`),
    index('mail_outbox_held_idx')
      .on(t.digestDueAt)
      .where(sql`${t.status} = 'held'`),
    index('mail_outbox_membership_idx').on(t.organizationId, t.recipientMembershipId, t.createdAt),
  ],
);

/** Addresses that refused a message outright. Notification mail is not sent to them again. */
export const mailSuppressions = platformSchema.table('mail_suppressions', {
  addressSha256: text().primaryKey(),
  reason: text().notNull(),
  createdAt: when().notNull().defaultNow(),
});

/**
 * The token behind one email's unsubscribe link, as a hash. It can turn off one topic for one person and
 * do nothing else, which is why a link can carry it with no sign-in.
 */
export const mailUnsubscribeTokens = platformSchema.table('mail_unsubscribe_tokens', {
  tokenSha256: text().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.id),
  membershipId: uuid().notNull(),
  topic: text().notNull(),
  expiresAt: when().notNull(),
  usedAt: when(),
  createdAt: when().notNull().defaultNow(),
});

/** One person's choice for one topic. No row means the default for that topic. */
export const notificationPreferences = orgSchema.table(
  'notification_preferences',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    membershipId: uuid().notNull(),
    topic: text().notNull(),
    delivery: text().notNull(),
    updatedAt: when().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.membershipId, t.topic] }),
    check(
      'notification_preferences_topic',
      sql`${t.topic} in ('approvals','answers','billing','support','activity')`,
    ),
    check('notification_preferences_delivery', sql`${t.delivery} in ('immediate','daily','off')`),
  ],
);
