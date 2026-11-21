import { describe, expect, it } from 'vitest';
import { renderMail, type MailContent } from './mail-templates';

const LINK = 'https://ensemus.example/reset-password/abc';

const ALL: MailContent[] = [
  { kind: 'password_reset', recipientName: 'Ada', link: LINK, validMinutes: 30 },
  { kind: 'email_verification', recipientName: 'Ada', link: LINK, validHours: 24 },
  {
    kind: 'email_change_confirm',
    recipientName: 'Ada',
    link: LINK,
    newAddress: 'new@example.com',
    validHours: 24,
  },
  { kind: 'email_change_verify', recipientName: 'Ada', link: LINK, validHours: 24 },
  { kind: 'password_changed', recipientName: 'Ada', resetLink: 'https://ensemus.example/forgot' },
  {
    kind: 'invitation',
    recipientName: '',
    link: LINK,
    organizationName: 'Northwind',
    inviterName: 'Grace',
    validDays: 7,
  },
  {
    kind: 'notification',
    recipientName: 'Ada',
    organizationName: 'Northwind',
    title: 'An approval needs your decision',
    link: 'https://ensemus.example/o/x/approvals/y',
    reminder: false,
    preferencesLink: 'https://ensemus.example/o/x/notifications',
    unsubscribeLink: 'https://ensemus.example/unsubscribe/t',
  },
  {
    kind: 'digest',
    recipientName: 'Ada',
    organizationName: 'Northwind',
    topicLabel: 'activity',
    items: [
      { title: 'You were put on some work', count: 3 },
      { title: 'Your import has finished', count: 1 },
    ],
    inboxLink: 'https://ensemus.example/o/x/inbox',
    preferencesLink: 'https://ensemus.example/o/x/notifications',
    unsubscribeLink: null,
  },
];

describe('platform email words', () => {
  it('renders every kind as plain text and as HTML, with its link in both', () => {
    for (const content of ALL) {
      const mail = renderMail(content);
      expect(mail.subject.length).toBeGreaterThan(5);
      expect(mail.html).toContain('<html lang="en">');
      expect(mail.html).toContain(`<title>${mail.subject.replace(/'/g, '&#39;')}</title>`);
      const link =
        'link' in content
          ? content.link
          : 'resetLink' in content
            ? content.resetLink
            : content.inboxLink;
      expect(mail.text).toContain(link);
      expect(mail.html).toContain(link);
    }
  });

  it('carries no internal code and no line break in a subject', () => {
    for (const content of ALL) {
      const mail = renderMail(content);
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(`${mail.subject}\n${mail.text}`).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
      expect(mail.text).not.toMatch(/deployment|operator|UTC/i);
    }
  });

  it('escapes whatever a person typed, in the HTML', () => {
    const mail = renderMail({
      kind: 'invitation',
      recipientName: '',
      link: LINK,
      organizationName: '<script>alert(1)</script>',
      inviterName: 'Eve "the" <b>',
      validDays: 7,
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('<b>');
  });

  it('folds a name that tries to start a new line, in the subject too', () => {
    const mail = renderMail({
      kind: 'invitation',
      recipientName: '',
      link: LINK,
      organizationName: 'Acme\r\nBcc: victim@example.com',
      inviterName: 'Grace' + String.fromCharCode(0x2028) + 'Hopper',
      validDays: 7,
    });
    expect(mail.subject).not.toContain('\n');
    expect(mail.subject).not.toContain('\r');
    expect(mail.subject).not.toContain(String.fromCharCode(0x2028));
    expect(mail.subject).toContain('Acme Bcc: victim@example.com');
  });

  it('offers unsubscribing only where someone chose the mail', () => {
    const chosen = renderMail(ALL[6]!);
    expect(chosen.text).toContain('Stop these emails');
    const essential = renderMail({
      ...(ALL[6] as Extract<MailContent, { kind: 'notification' }>),
      preferencesLink: null,
      unsubscribeLink: null,
    });
    expect(essential.text).not.toContain('Stop these emails');
    expect(essential.text).toContain("can't be turned off");
  });

  it('marks a reminder as one', () => {
    const mail = renderMail({
      ...(ALL[6] as Extract<MailContent, { kind: 'notification' }>),
      reminder: true,
    });
    expect(mail.subject).toBe('Reminder: An approval needs your decision');
  });

  it('counts a digest, and names the new address in an email change', () => {
    expect(renderMail(ALL[7]!).text).toContain('4 updates');
    expect(renderMail(ALL[7]!).text).toContain('You were put on some work (3)');
    expect(renderMail(ALL[2]!).text).toContain('new@example.com');
  });
});
