// Platform email: the mail Ensemus itself sends to the people who use it (account recovery, verification,
// invitations and notifications). Not a tenant connector, and never an agent's tool: nobody in a tenant
// chooses what goes, or to whom. Pure rules only, so the web tier, the worker and the SQL can be held to the
// same lists. 0571's triggers repeat MAIL_TRANSITIONS, and a test holds the two together.

/** Mail about someone's own account. Never carries tenant content, and never has an organization. */
export const ACCOUNT_MAIL_KINDS = [
  'password_reset',
  'email_verification',
  /** Sent to the address being left, asking its owner to agree. */
  'email_change_confirm',
  /** Sent to the new address, proving it works. */
  'email_change_verify',
  'password_changed',
] as const;
export type AccountMailKind = (typeof ACCOUNT_MAIL_KINDS)[number];

export const TENANT_MAIL_KINDS = ['invitation', 'notification', 'digest'] as const;
export type TenantMailKind = (typeof TENANT_MAIL_KINDS)[number];

export const MAIL_KINDS = [...ACCOUNT_MAIL_KINDS, ...TENANT_MAIL_KINDS] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export const MAIL_STATUSES = [
  'queued',
  'sending',
  'held',
  'sent',
  'failed',
  'bounced',
  'unknown',
  'suppressed',
  'expired',
  'skipped',
  'digested',
] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];

/**
 * How a message may move. `sending` is a claim committed before the relay is contacted (ADR-027 D2):
 * only a refusal before the commit point puts it back in the queue, and silence after it, or a worker that
 * died holding it, is `unknown`, never a second send.
 */
export const MAIL_TRANSITIONS: Readonly<Record<MailStatus, readonly MailStatus[]>> = {
  queued: ['sending', 'held', 'suppressed', 'expired', 'skipped'],
  sending: ['sent', 'queued', 'failed', 'bounced', 'unknown'],
  held: ['digested', 'skipped'],
  sent: [],
  failed: [],
  bounced: [],
  /** A late answer is believed (ADR-027 D2): a claim given up on can still have been accepted. */
  unknown: ['sent'],
  suppressed: [],
  expired: [],
  skipped: [],
  digested: [],
};

/** Waiting for the worker. Anything else has settled, and the database has erased its link and address. */
export const PENDING_MAIL_STATUSES: readonly MailStatus[] = ['queued', 'sending', 'held'];

export function isSettledMail(status: MailStatus): boolean {
  return !PENDING_MAIL_STATUSES.includes(status);
}

export function canMoveMail(from: MailStatus, to: MailStatus): boolean {
  return MAIL_TRANSITIONS[from].includes(to);
}

/**
 * How a message's link is sealed (ADR-024 D5): to the worker's public key, bound to the message's own ID
 * and its tenant, or to this fixed scope for account mail, which has none. Moved to another row or another
 * tenant, it fails to open.
 */
export const MAIL_LINK_PURPOSE = 'mail.link';
export const ACCOUNT_MAIL_SCOPE = '00000000-0000-0000-0000-000000000000';

/** What is sealed: the link, and for an email change, the address being moved to. */
export type MailLinkPayload = { link: string; newAddress?: string };

/** Tries, counting the first. After this a message that never reached the relay has failed. */
export const MAX_MAIL_ATTEMPTS = 6;

/** The wait before try `attempt + 1`, doubling from 30 seconds to an hour, with up to a fifth of jitter. */
export function mailRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 60 * 60_000);
  return Math.round(base + base * 0.2 * random());
}

/** A worker holding a claim this long has died or hung. Its message is `unknown`, and is not sent again. */
export const MAIL_SEND_LEASE_MS = 5 * 60_000;

/**
 * Limits, per hour, enforced by 0571 when a message is queued. Over a limit the message is kept as
 * `suppressed`, so the person who asked still sees the same answer and nobody learns which addresses exist.
 */
export const MAIL_LIMITS = {
  /** Account mail to one address. Enough to ask for a reset and then ask again. */
  accountPerRecipientPerHour: 5,
  /** Notification and invitation mail to one address. Beyond this, the rest waits for the digest. */
  notificationsPerRecipientPerHour: 20,
  /** Everything one tenant sends. Past this, notification mail waits for the digest. */
  perOrganizationPerHour: 500,
  /** Invitations one tenant sends, and to one address. Enforced by 0571 when queued. */
  invitationsPerOrganizationPerHour: 50,
  invitationsPerAddressPerHour: 3,
} as const;

/** How long a link stays good, and so how long its message may wait to be sent. */
export const MAIL_VALIDITY_SECONDS: Readonly<Record<MailKind, number>> = {
  password_reset: 30 * 60,
  email_verification: 24 * 60 * 60,
  email_change_confirm: 24 * 60 * 60,
  email_change_verify: 24 * 60 * 60,
  password_changed: 24 * 60 * 60,
  invitation: 7 * 24 * 60 * 60,
  notification: 3 * 24 * 60 * 60,
  digest: 2 * 24 * 60 * 60,
};

// --- Notification preferences

/** What a person can choose about. Each notification kind belongs to exactly one. */
export const NOTIFICATION_TOPICS = [
  'approvals',
  'answers',
  'billing',
  'support',
  'activity',
] as const;
export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number];

export const NOTIFICATION_DELIVERIES = ['immediate', 'daily', 'off'] as const;
export type NotificationDelivery = (typeof NOTIFICATION_DELIVERIES)[number];

/**
 * Sensible defaults: what needs a decision or answers a question someone asked comes at once, and the
 * steady trickle of everything else comes once a day.
 */
export const DEFAULT_NOTIFICATION_DELIVERY: Readonly<
  Record<NotificationTopic, NotificationDelivery>
> = {
  approvals: 'immediate',
  answers: 'immediate',
  billing: 'immediate',
  support: 'immediate',
  activity: 'daily',
};

/**
 * Kinds nobody can turn off: someone outside the company was let in, the company is leaving, or its
 * standing changed. They go at once, as essential mail, with no unsubscribe link.
 */
export const ESSENTIAL_NOTIFICATION_KINDS: ReadonlySet<string> = new Set([
  'break_glass.requested',
  'offboarding.progress',
  'tenant.standing_changed',
]);

const TOPIC_BY_KIND: Readonly<Record<string, NotificationTopic>> = {
  'approval.requested': 'approvals',
  'approval.decided': 'approvals',
  'approval.expired': 'approvals',
  'approval.closed': 'approvals',
  'approval.outdated': 'approvals',
  'approval.superseded': 'approvals',
  'approval.work_finished': 'approvals',
  'approval.work_reopened': 'approvals',
  'publish_review.requested': 'approvals',
  'publish_review.decided': 'approvals',
  'member.join_requested': 'approvals',
  'knowledge.answer_ready': 'answers',
  'knowledge.fact_disputed': 'answers',
  'invoice.issued': 'billing',
  'payment.failed': 'billing',
  'payment.unknown': 'billing',
  'credits.low': 'billing',
  'credits.exhausted': 'billing',
  'ticket.replied': 'support',
};

/** Anything not named above is ordinary activity, so a new kind is never mailed more eagerly by mistake. */
export function notificationTopicOf(kind: string): NotificationTopic {
  return TOPIC_BY_KIND[kind] ?? 'activity';
}

export type MailDecision =
  | { action: 'send'; essential: boolean }
  | { action: 'hold' }
  | {
      action: 'skip';
      code: 'PREFERENCE_OFF' | 'ALREADY_READ' | 'RECIPIENT_GONE' | 'ADDRESS_UNVERIFIED';
    };

/**
 * What to do with one notification's mail, at the moment it is due. Something the person has already
 * opened in Ensemus is not mailed, and a reminder is never held for a digest: it exists to reach them.
 */
export function decideNotificationMail(input: {
  kind: string;
  delivery: NotificationDelivery | null;
  read: boolean;
  recipientActive: boolean;
  /** An address nobody has proven may be someone else's, so nothing about a company goes to it. */
  addressVerified: boolean;
  isReminder: boolean;
  /** This person or this company has had a lot of mail in the last hour. */
  throttled: boolean;
}): MailDecision {
  if (!input.recipientActive) return { action: 'skip', code: 'RECIPIENT_GONE' };
  if (!input.addressVerified) return { action: 'skip', code: 'ADDRESS_UNVERIFIED' };
  if (ESSENTIAL_NOTIFICATION_KINDS.has(input.kind)) return { action: 'send', essential: true };
  if (input.read && !input.isReminder) return { action: 'skip', code: 'ALREADY_READ' };
  const delivery = input.delivery ?? DEFAULT_NOTIFICATION_DELIVERY[notificationTopicOf(input.kind)];
  if (delivery === 'off') return { action: 'skip', code: 'PREFERENCE_OFF' };
  if (delivery === 'daily' && !input.isReminder) return { action: 'hold' };
  // Noisy: the rest of the hour's news waits for one summary rather than a stream of emails.
  if (input.throttled) return { action: 'hold' };
  return { action: 'send', essential: false };
}

/** How a digest names its topic, in a subject line and an opening sentence. */
export const NOTIFICATION_TOPIC_LABELS: Readonly<Record<NotificationTopic, string>> = {
  approvals: 'approvals and reviews',
  answers: 'answers',
  billing: 'billing',
  support: 'support',
  activity: 'activity',
};

/** The hour of the day, in UTC, when held notifications go out as one digest per topic. */
export const DIGEST_HOUR_UTC = 8;

/** The next digest time strictly after `now`. */
export function nextDigestAt(now: Date): Date {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DIGEST_HOUR_UTC),
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Codes a mail row may carry. Never provider text. */
export const MAIL_CODES = [
  'ACCEPTED_BY_RELAY',
  'RATE_LIMITED',
  'NO_PASSWORD_ACCOUNT',
  'ADDRESS_BOUNCED',
  'PREFERENCE_OFF',
  'ALREADY_READ',
  'RECIPIENT_GONE',
  'ADDRESS_UNVERIFIED',
  'INVITATION_CLOSED',
  'LINK_UNAVAILABLE',
  'EXPIRED',
  'RELAY_BUSY',
  'CONNECT_FAILED',
  'TIMEOUT_BEFORE_COMMIT',
  'TLS_REQUIRED',
  'AUTH_FAILED',
  'CREDENTIAL_UNAVAILABLE',
  'REFUSED_BY_PROVIDER',
  'RECIPIENT_REFUSED',
  'UNSAFE_MESSAGE',
  'CONNECTION_LOST_AFTER_COMMIT',
  'TIMEOUT_AFTER_COMMIT',
  'LEASE_EXPIRED',
  'TOO_MANY_ATTEMPTS',
] as const;
export type MailCode = (typeof MAIL_CODES)[number];
