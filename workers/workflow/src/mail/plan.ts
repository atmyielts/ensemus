// What to do with one message, and what it says, from what is true at the moment it is due. Pure: the
// database gathers the facts (`@ensemus/database/mailer`) and the loop does the sending.
import type { TenantMailFacts, TenantMailPlan } from '@ensemus/database/mailer';
import {
  decideNotificationMail,
  MAIL_LIMITS,
  MAIL_VALIDITY_SECONDS,
  NOTIFICATION_DELIVERIES,
  NOTIFICATION_TOPIC_LABELS,
  NOTIFICATION_TOPICS,
  nextDigestAt,
  notificationTopicOf,
  type NotificationDelivery,
  type NotificationTopic,
} from '@ensemus/domain/mail';
import type { MailContent } from '@ensemus/domain/mail-templates';
import { notificationPath, notificationTitle } from '@ensemus/domain/notification-copy';

const delivery = (value: string | null): NotificationDelivery | null =>
  (NOTIFICATION_DELIVERIES as readonly string[]).includes(value ?? '')
    ? (value as NotificationDelivery)
    : null;

const topic = (value: string): NotificationTopic | null =>
  (NOTIFICATION_TOPICS as readonly string[]).includes(value) ? (value as NotificationTopic) : null;

/** The topic a message's preference is read for, or null when none applies (an invitation). */
export function topicOfMail(row: {
  kind: string;
  notificationKind: string | null;
  targetRef: string | null;
}): NotificationTopic | null {
  if (row.kind === 'notification' && row.notificationKind)
    return notificationTopicOf(row.notificationKind);
  if (row.kind === 'digest') return topic((row.targetRef ?? '').replace(/^topic:/, ''));
  return null;
}

/** Whether a member's mail this hour, or the company's, is enough to start holding news for a digest. */
const throttled = (facts: TenantMailFacts) =>
  facts.recentToMember >= MAIL_LIMITS.notificationsPerRecipientPerHour ||
  facts.recentForOrganization >= MAIL_LIMITS.perOrganizationPerHour;

export function planTenantMail(
  facts: TenantMailFacts,
  options: { now: Date; unsubscribeTokenSha256: string },
): TenantMailPlan {
  const skip = (code: string): TenantMailPlan => ({ action: 'settle', status: 'skipped', code });
  if (!facts.organization || facts.organization.lifecycle === 'deleted')
    return skip('RECIPIENT_GONE');

  if (facts.kind === 'invitation') {
    if (!facts.invitation?.open) return skip('INVITATION_CLOSED');
    if (!facts.invitation.link) return skip('LINK_UNAVAILABLE');
    if (facts.bounced) return { action: 'settle', status: 'suppressed', code: 'ADDRESS_BOUNCED' };
    return { action: 'send', unsubscribe: null };
  }

  const member = facts.member;
  if (!member?.active) return skip('RECIPIENT_GONE');

  if (facts.kind === 'digest') {
    const digestTopic = topic(facts.digest?.topic ?? '');
    if (!digestTopic || !facts.digest?.items.length) return skip('ALREADY_READ');
    if (!member.addressVerified) return skip('ADDRESS_UNVERIFIED');
    if (delivery(facts.preference) === 'off') return skip('PREFERENCE_OFF');
    if (facts.bounced) return { action: 'settle', status: 'suppressed', code: 'ADDRESS_BOUNCED' };
    return {
      action: 'send',
      unsubscribe: { topic: digestTopic, tokenSha256: options.unsubscribeTokenSha256 },
    };
  }

  const notification = facts.notification;
  if (!notification) return skip('RECIPIENT_GONE');
  const decision = decideNotificationMail({
    kind: notification.kind,
    delivery: delivery(facts.preference),
    read: notification.read,
    recipientActive: member.active,
    addressVerified: member.addressVerified,
    isReminder: notification.reminderNumber !== null,
    throttled: throttled(facts),
  });
  if (decision.action === 'skip') return skip(decision.code);
  if (decision.action === 'hold') return { action: 'hold', digestDueAt: nextDigestAt(options.now) };
  if (facts.bounced && !decision.essential)
    return { action: 'settle', status: 'suppressed', code: 'ADDRESS_BOUNCED' };
  return {
    action: 'send',
    unsubscribe: decision.essential
      ? null
      : {
          topic: notificationTopicOf(notification.kind),
          tokenSha256: options.unsubscribeTokenSha256,
        },
  };
}

export type Links = {
  publicUrl: string;
  /** The raw unsubscribe token, when the message carries one. */
  unsubscribeToken: string | null;
};

export const unsubscribePageUrl = (publicUrl: string, token: string) =>
  `${publicUrl}/unsubscribe/${token}`;
export const unsubscribeOneClickUrl = (publicUrl: string, token: string) =>
  `${publicUrl}/api/mail/unsubscribe/${token}`;
export const preferencesUrl = (publicUrl: string, organizationId: string) =>
  `${publicUrl}/o/${organizationId}/notifications`;

/** The words of a tenant message. Only the company's name and fixed sentences: never its content. */
export function tenantMailContent(
  facts: TenantMailFacts,
  links: Links & { invitationLink: string | null },
): MailContent | null {
  const organizationName = facts.organization?.name ?? '';
  const base = `${links.publicUrl}/o/${facts.organizationId}`;
  const unsubscribeLink = links.unsubscribeToken
    ? unsubscribePageUrl(links.publicUrl, links.unsubscribeToken)
    : null;
  if (facts.kind === 'invitation') {
    if (!links.invitationLink) return null;
    return {
      kind: 'invitation',
      recipientName: '',
      link: links.invitationLink,
      organizationName,
      inviterName: facts.invitation?.inviterName ?? '',
      validDays: MAIL_VALIDITY_SECONDS.invitation / 86_400,
    };
  }
  if (!facts.member) return null;
  if (facts.kind === 'digest') {
    const digestTopic = topic(facts.digest?.topic ?? '') ?? 'activity';
    return {
      kind: 'digest',
      recipientName: facts.member.name,
      organizationName,
      topicLabel: NOTIFICATION_TOPIC_LABELS[digestTopic],
      items: (facts.digest?.items ?? []).map((item) => ({
        title: notificationTitle(item.kind),
        count: item.count,
      })),
      inboxLink: `${base}/inbox`,
      preferencesLink: preferencesUrl(links.publicUrl, facts.organizationId),
      unsubscribeLink,
    };
  }
  if (!facts.notification) return null;
  return {
    kind: 'notification',
    recipientName: facts.member.name,
    organizationName,
    title: notificationTitle(facts.notification.kind),
    link: notificationPath(base, facts.notification.targetRef),
    reminder: facts.notification.reminderNumber !== null,
    preferencesLink: unsubscribeLink ? preferencesUrl(links.publicUrl, facts.organizationId) : null,
    unsubscribeLink,
  };
}

/** The sealed part of an account or invitation message. */
export type SealedPayload = { link: string; newAddress?: string };

/** The words of an account message, or null when its link is missing and it cannot be sent. */
export function accountMailContent(
  kind: string,
  recipientName: string,
  payload: SealedPayload | null,
  publicUrl: string,
): MailContent | null {
  const hours = (seconds: number) => Math.round(seconds / 3600);
  switch (kind) {
    case 'password_reset':
      return payload
        ? {
            kind,
            recipientName,
            link: payload.link,
            validMinutes: MAIL_VALIDITY_SECONDS.password_reset / 60,
          }
        : null;
    case 'email_verification':
      return payload
        ? {
            kind,
            recipientName,
            link: payload.link,
            validHours: hours(MAIL_VALIDITY_SECONDS.email_verification),
          }
        : null;
    case 'email_change_confirm':
      return payload?.newAddress
        ? {
            kind,
            recipientName,
            link: payload.link,
            newAddress: payload.newAddress,
            validHours: hours(MAIL_VALIDITY_SECONDS.email_change_confirm),
          }
        : null;
    case 'email_change_verify':
      return payload
        ? {
            kind,
            recipientName,
            link: payload.link,
            validHours: hours(MAIL_VALIDITY_SECONDS.email_change_verify),
          }
        : null;
    case 'password_changed':
      return { kind, recipientName, resetLink: `${publicUrl}/forgot-password` };
    default:
      return null;
  }
}

/**
 * Reads what was sealed. A link that does not lead back to this Ensemus is refused, whatever sealed it,
 * so a message can never carry someone somewhere else.
 */
export function parseSealedPayload(plaintext: Buffer, publicUrl: string): SealedPayload | null {
  try {
    const value = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object') return null;
    const { link, newAddress } = value as Record<string, unknown>;
    if (typeof link !== 'string' || !link.startsWith(`${publicUrl}/`) || link.length > 2000)
      return null;
    if (newAddress !== undefined && (typeof newAddress !== 'string' || newAddress.length > 254))
      return null;
    return newAddress === undefined ? { link } : { link, newAddress };
  } catch {
    return null;
  }
}
