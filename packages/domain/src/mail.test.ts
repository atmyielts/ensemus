import { describe, expect, it } from 'vitest';
import {
  canMoveMail,
  decideNotificationMail,
  DEFAULT_NOTIFICATION_DELIVERY,
  ESSENTIAL_NOTIFICATION_KINDS,
  isSettledMail,
  MAIL_STATUSES,
  MAIL_TRANSITIONS,
  mailRetryDelayMs,
  MAX_MAIL_ATTEMPTS,
  nextDigestAt,
  notificationTopicOf,
} from './mail';

const base = {
  kind: 'approval.requested',
  delivery: null,
  read: false,
  recipientActive: true,
  addressVerified: true,
  isReminder: false,
  throttled: false,
} as const;

describe('mail transitions', () => {
  it('only lets a claim be retried, settled, or found out late', () => {
    expect(canMoveMail('queued', 'sending')).toBe(true);
    expect(canMoveMail('sending', 'queued')).toBe(true);
    expect(canMoveMail('sending', 'unknown')).toBe(true);
    expect(canMoveMail('unknown', 'sent')).toBe(true);
    // Never sent twice: nothing settled goes back to the queue.
    for (const status of MAIL_STATUSES) {
      if (status === 'sending') continue;
      expect(canMoveMail(status, 'queued')).toBe(false);
    }
    expect(canMoveMail('unknown', 'queued')).toBe(false);
    expect(canMoveMail('sent', 'sending')).toBe(false);
  });

  it('names every status, and only pending ones still hold a link', () => {
    expect(Object.keys(MAIL_TRANSITIONS).sort()).toEqual([...MAIL_STATUSES].sort());
    expect(MAIL_STATUSES.filter((status) => !isSettledMail(status))).toEqual([
      'queued',
      'sending',
      'held',
    ]);
  });
});

describe('retry waits', () => {
  it('grow from 30 seconds and stop growing at an hour', () => {
    const none = () => 0;
    expect(mailRetryDelayMs(1, none)).toBe(30_000);
    expect(mailRetryDelayMs(2, none)).toBe(60_000);
    expect(mailRetryDelayMs(20, none)).toBe(60 * 60_000);
    expect(mailRetryDelayMs(1, () => 1)).toBe(36_000);
    expect(MAX_MAIL_ATTEMPTS).toBe(6);
  });
});

describe('what a notification mail does', () => {
  it('sends a decision at once by default', () => {
    expect(decideNotificationMail(base)).toEqual({ action: 'send', essential: false });
  });

  it('holds everyday activity for the daily summary by default', () => {
    expect(decideNotificationMail({ ...base, kind: 'work.assigned' })).toEqual({ action: 'hold' });
    expect(DEFAULT_NOTIFICATION_DELIVERY.activity).toBe('daily');
  });

  it('honours a choice, and never mails what was already read', () => {
    expect(decideNotificationMail({ ...base, delivery: 'off' })).toEqual({
      action: 'skip',
      code: 'PREFERENCE_OFF',
    });
    expect(decideNotificationMail({ ...base, read: true })).toEqual({
      action: 'skip',
      code: 'ALREADY_READ',
    });
  });

  it('sends a reminder even if read, and never holds one for a digest', () => {
    expect(decideNotificationMail({ ...base, read: true, isReminder: true })).toEqual({
      action: 'send',
      essential: false,
    });
    expect(decideNotificationMail({ ...base, delivery: 'daily', isReminder: true }).action).toBe(
      'send',
    );
  });

  it('holds the rest of a busy hour for one summary', () => {
    expect(decideNotificationMail({ ...base, throttled: true })).toEqual({ action: 'hold' });
  });

  it('never mails an unproven address, or someone who left', () => {
    expect(decideNotificationMail({ ...base, addressVerified: false })).toEqual({
      action: 'skip',
      code: 'ADDRESS_UNVERIFIED',
    });
    expect(decideNotificationMail({ ...base, recipientActive: false })).toEqual({
      action: 'skip',
      code: 'RECIPIENT_GONE',
    });
  });

  it('always sends essential mail, whatever was chosen', () => {
    for (const kind of ESSENTIAL_NOTIFICATION_KINDS) {
      expect(decideNotificationMail({ ...base, kind, delivery: 'off', read: true })).toEqual({
        action: 'send',
        essential: true,
      });
    }
  });
});

describe('topics', () => {
  it('puts each kind people asked about where they would look for it', () => {
    expect(notificationTopicOf('approval.requested')).toBe('approvals');
    expect(notificationTopicOf('knowledge.answer_ready')).toBe('answers');
    expect(notificationTopicOf('invoice.issued')).toBe('billing');
    expect(notificationTopicOf('payment.failed')).toBe('billing');
    expect(notificationTopicOf('ticket.replied')).toBe('support');
    expect(notificationTopicOf('something.new')).toBe('activity');
  });
});

describe('digest time', () => {
  it('is the next morning hour, strictly later', () => {
    expect(nextDigestAt(new Date('2026-11-12T07:59:00Z')).toISOString()).toBe(
      '2026-11-12T08:00:00.000Z',
    );
    expect(nextDigestAt(new Date('2026-11-12T08:00:00Z')).toISOString()).toBe(
      '2026-11-13T08:00:00.000Z',
    );
    expect(nextDigestAt(new Date('2026-12-31T23:00:00Z')).toISOString()).toBe(
      '2027-01-01T08:00:00.000Z',
    );
  });
});
