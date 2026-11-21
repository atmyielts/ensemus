// The words of every platform email, as plain text and as simple accessible HTML. Pure, so every message
// can be tested without a relay. No message carries an internal code, a tenant's content beyond the
// company's own name, or anything a notification points at: it says what happened and links to Ensemus,
// which checks access when the link is opened.
import type { AccountMailKind } from './mail';

export type RenderedMail = { subject: string; text: string; html: string };

type Common = {
  /** The person's name as they gave it. Empty is fine. */
  recipientName: string;
};

export type MailContent =
  | (Common & { kind: 'password_reset'; link: string; validMinutes: number })
  | (Common & { kind: 'email_verification'; link: string; validHours: number })
  | (Common & {
      kind: 'email_change_confirm';
      link: string;
      newAddress: string;
      validHours: number;
    })
  | (Common & { kind: 'email_change_verify'; link: string; validHours: number })
  | (Common & { kind: 'password_changed'; resetLink: string })
  | (Common & {
      kind: 'invitation';
      link: string;
      organizationName: string;
      inviterName: string;
      validDays: number;
    })
  | (Common & {
      kind: 'notification';
      organizationName: string;
      title: string;
      link: string;
      reminder: boolean;
      preferencesLink: string | null;
      unsubscribeLink: string | null;
    })
  | (Common & {
      kind: 'digest';
      organizationName: string;
      /** Plain words for the topic, such as "activity". */
      topicLabel: string;
      items: readonly { title: string; count: number }[];
      inboxLink: string;
      preferencesLink: string;
      unsubscribeLink: string | null;
    });

// Compile-time check that every account kind has a template above.
type _AccountKindsCovered = AccountMailKind extends MailContent['kind'] ? true : never;
const _covered: _AccountKindsCovered = true;
void _covered;

const SIGN_OFF = 'The Ensemus team';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Control characters, and the two Unicode line and paragraph separators, built from code points so the
// source holds none of them.
const CONTROL_OR_LINE_BREAK = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]+`,
  'g',
);

/** Folds whitespace and strips anything that could start a new line in a header or a paragraph. */
function clean(value: string, max = 200): string {
  const folded = value.replace(CONTROL_OR_LINE_BREAK, ' ').trim();
  return folded.length > max ? `${folded.slice(0, max - 1)}…` : folded;
}

const greeting = (name: string) => (clean(name) ? `Hi ${clean(name, 80)},` : 'Hello,');

/** A line of the message: plain words, or a link with the words for it. */
type Block =
  | { type: 'p'; text: string }
  | { type: 'link'; label: string; href: string }
  | { type: 'list'; items: string[] }
  | { type: 'small'; text: string; links?: { label: string; href: string }[] };

function toText(blocks: Block[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === 'p') lines.push(block.text, '');
    else if (block.type === 'link') lines.push(`${block.label}:`, block.href, '');
    else if (block.type === 'list') lines.push(...block.items.map((item) => `- ${item}`), '');
    else {
      lines.push('--', block.text);
      for (const link of block.links ?? []) lines.push(`${link.label}: ${link.href}`);
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function toHtml(subject: string, blocks: Block[]): string {
  const body = blocks
    .map((block) => {
      if (block.type === 'p')
        return `<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(block.text)}</p>`;
      if (block.type === 'link')
        return (
          `<p style="margin:0 0 24px"><a href="${escapeHtml(block.href)}" ` +
          `style="display:inline-block;padding:12px 20px;border-radius:8px;background:#1f2a1c;` +
          `color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(block.label)}</a></p>` +
          `<p style="margin:0 0 16px;line-height:1.5;font-size:14px;color:#4a4a4a">` +
          `If the button does not work, copy this address into your browser:<br>` +
          `<span style="word-break:break-all">${escapeHtml(block.href)}</span></p>`
        );
      if (block.type === 'list')
        return `<ul style="margin:0 0 16px;padding-left:20px;line-height:1.5">${block.items
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join('')}</ul>`;
      const links = (block.links ?? [])
        .map(
          (link) =>
            `<a href="${escapeHtml(link.href)}" style="color:#4a4a4a">${escapeHtml(link.label)}</a>`,
        )
        .join(' · ');
      return (
        `<hr style="border:none;border-top:1px solid #e2e2e2;margin:24px 0">` +
        `<p style="margin:0;font-size:13px;line-height:1.5;color:#4a4a4a">${escapeHtml(block.text)}` +
        `${links ? `<br>${links}` : ''}</p>`
      );
    })
    .join('\n');
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(subject)}</title></head>\n` +
    `<body style="margin:0;padding:24px;background:#f6f6f4;color:#1a1a1a;${FONT}">\n` +
    `<main style="max-width:560px;margin:0 auto;padding:32px;background:#ffffff;border-radius:12px">\n` +
    `${body}\n</main>\n</body></html>\n`
  );
}

function render(subject: string, blocks: Block[]): RenderedMail {
  const safeSubject = clean(subject, 150);
  return { subject: safeSubject, text: toText(blocks), html: toHtml(safeSubject, blocks) };
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** Every platform email. Throws on nothing: unexpected values are cleaned, never trusted. */
export function renderMail(content: MailContent): RenderedMail {
  const hello: Block = { type: 'p', text: greeting(content.recipientName) };
  const signOff: Block = { type: 'p', text: SIGN_OFF };
  switch (content.kind) {
    case 'password_reset':
      return render('Reset your Ensemus password', [
        hello,
        {
          type: 'p',
          text: 'Someone asked to reset the password for your Ensemus account. If that was you, choose a new password here.',
        },
        { type: 'link', label: 'Choose a new password', href: content.link },
        {
          type: 'p',
          text: `The link works once, for the next ${content.validMinutes} minutes. If you didn't ask, you can ignore this email: your password stays as it is.`,
        },
        signOff,
      ]);
    case 'email_verification':
      return render('Confirm your email address for Ensemus', [
        hello,
        {
          type: 'p',
          text: 'Please confirm that this is your email address. It lets us tell you when something needs you, and helps you back in if you ever forget your password.',
        },
        { type: 'link', label: 'Confirm my email address', href: content.link },
        {
          type: 'p',
          text: `The link works for the next ${content.validHours} hours. If you didn't create an Ensemus account, you can ignore this email.`,
        },
        signOff,
      ]);
    case 'email_change_confirm':
      return render('Approve the change to your Ensemus email address', [
        hello,
        {
          type: 'p',
          text: `Someone asked to move your Ensemus account to ${clean(content.newAddress, 254)}. If that was you, approve it here, and we'll send one last link to the new address.`,
        },
        { type: 'link', label: 'Approve the change', href: content.link },
        {
          type: 'p',
          text: `The link works for the next ${content.validHours} hours. If you didn't ask for this, don't follow the link, and change your password to be safe.`,
        },
        signOff,
      ]);
    case 'email_change_verify':
      return render('Confirm your new email address for Ensemus', [
        hello,
        {
          type: 'p',
          text: 'Follow this link to finish moving your Ensemus account to this email address.',
        },
        { type: 'link', label: 'Use this email address', href: content.link },
        {
          type: 'p',
          text: `The link works for the next ${content.validHours} hours. If you didn't ask for this, you can ignore this email.`,
        },
        signOff,
      ]);
    case 'password_changed':
      return render('Your Ensemus password was changed', [
        hello,
        {
          type: 'p',
          text: 'The password for your Ensemus account was just changed, and you were signed out everywhere else. If that was you, there is nothing more to do.',
        },
        {
          type: 'p',
          text: "If it wasn't you, reset your password straight away, and tell whoever looks after Ensemus at your company.",
        },
        { type: 'link', label: 'Reset my password', href: content.resetLink },
        signOff,
      ]);
    case 'invitation': {
      const org = clean(content.organizationName, 120);
      const inviter = clean(content.inviterName, 80) || 'Someone';
      return render(`${inviter} invited you to ${org} on Ensemus`, [
        { type: 'p', text: 'Hello,' },
        {
          type: 'p',
          text: `${inviter} invited you to join ${org} on Ensemus, where the team keeps its work, approvals and knowledge.`,
        },
        { type: 'link', label: `Join ${org}`, href: content.link },
        {
          type: 'p',
          text: `The invitation works once, for this email address, and expires in ${content.validDays} days. If you weren't expecting it, you can ignore this email.`,
        },
        signOff,
      ]);
    }
    case 'notification': {
      const org = clean(content.organizationName, 120);
      const title = clean(content.title);
      const footerLinks = [
        ...(content.preferencesLink
          ? [{ label: 'Choose what we email you', href: content.preferencesLink }]
          : []),
        ...(content.unsubscribeLink
          ? [{ label: 'Stop these emails', href: content.unsubscribeLink }]
          : []),
      ];
      return render(content.reminder ? `Reminder: ${title}` : title, [
        hello,
        {
          type: 'p',
          text: content.reminder
            ? `A reminder from ${org}: ${lowerFirst(title)}. It's still waiting for you.`
            : `${title} in ${org}.`,
        },
        { type: 'link', label: 'Open it in Ensemus', href: content.link },
        {
          type: 'p',
          text: "To keep your company's work private, the details are only shown in Ensemus after you sign in.",
        },
        signOff,
        {
          type: 'small',
          text: footerLinks.length
            ? `You're getting this because of your email settings for ${org}.`
            : `You're getting this because it's about your company's access to Ensemus, and can't be turned off.`,
          links: footerLinks,
        },
      ]);
    }
    case 'digest': {
      const org = clean(content.organizationName, 120);
      const total = content.items.reduce((sum, item) => sum + item.count, 0);
      const topic = clean(content.topicLabel, 60);
      return render(`Your daily ${topic} summary for ${org}`, [
        hello,
        {
          type: 'p',
          text: `Here's your ${topic} in ${org} since your last summary: ${total} ${plural(total, 'update', 'updates')}.`,
        },
        {
          type: 'list',
          items: content.items.map((item) =>
            item.count > 1 ? `${clean(item.title)} (${item.count})` : clean(item.title),
          ),
        },
        { type: 'link', label: 'Open your inbox', href: content.inboxLink },
        signOff,
        {
          type: 'small',
          text: `You're getting this daily summary of ${topic} because of your email settings for ${org}.`,
          links: [
            { label: 'Choose what we email you', href: content.preferencesLink },
            ...(content.unsubscribeLink
              ? [{ label: 'Stop these emails', href: content.unsubscribeLink }]
              : []),
          ],
        },
      ]);
    }
  }
}

function lowerFirst(value: string): string {
  return value ? value[0]!.toLowerCase() + value.slice(1) : value;
}
