// Gmail's half of mail (ADR-038 D6): the RFC 5322 message a send or a draft carries, and the text a read
// takes out of a message Gmail returns. Pure, so the rules are tested with no request. Building refuses a
// line break in any header value rather than repairing it, because an injected header is mail to someone
// nobody approved. Reading never follows a link and never fetches an attachment: it keeps text only.

/** Carries no text from what it refused. */
export class UnsafeGmailMessage extends Error {
  override name = 'UnsafeGmailMessage';
  constructor() {
    super('UNSAFE_MESSAGE');
  }
}

/** The approved message, as the tool's schema shapes it. */
export type GmailMessagePayload = {
  to: readonly string[];
  cc?: readonly string[] | undefined;
  bcc?: readonly string[] | undefined;
  subject: string;
  text_body: string;
};

/** Plain atoms, ASCII only: nothing a header parser could take for the end of an address. */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/;
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})>$/;
/** Every character some software treats as ending a line, and NUL. */
const LINE_BREAKING = /[\r\n\0\v\f\u0085\u2028\u2029]/;
const MAX_HEADER_WIDTH = 78;
const MAX_ENCODED_WORD_BYTES = 42;

/**
 * `<intent@domain>`: the same for every attempt at one intent and in every reconcile, as the SMTP
 * connector's is. The domain is the deployment's own (`ENSEMUS_MAIL_ID_DOMAIN`, checked as a host name
 * where the worker reads it), and names no customer.
 */
export const gmailMessageId = (externalActionId: string, domain: string) =>
  `<${externalActionId}@${domain}>`;

function checkAddress(address: string): string {
  if (typeof address !== 'string' || !ADDRESS.test(address)) throw new UnsafeGmailMessage();
  return address;
}

function checkText(text: string): string {
  if (typeof text !== 'string' || LINE_BREAKING.test(text)) throw new UnsafeGmailMessage();
  return text;
}

export function checkMessageId(value: string): string {
  if (typeof value !== 'string' || value.length > 998 || !MESSAGE_ID.test(value))
    throw new UnsafeGmailMessage();
  return value;
}

const isPlainHeaderText = (text: string) => /^[\x20-\x7e]*$/.test(text) && !text.includes('=?');

/** RFC 2047, splitting on whole characters so each word decodes on its own. */
function encodedWords(text: string): string[] {
  const words: string[] = [];
  let current: Buffer[] = [];
  let size = 0;
  const flush = () => {
    if (size === 0) return;
    words.push(`=?utf-8?B?${Buffer.concat(current).toString('base64')}?=`);
    current = [];
    size = 0;
  };
  for (const character of text) {
    const bytes = Buffer.from(character, 'utf8');
    if (size + bytes.length > MAX_ENCODED_WORD_BYTES) flush();
    current.push(bytes);
    size += bytes.length;
  }
  flush();
  return words;
}

/** Folds on spaces. Neither an encoded word nor an address holds one, so neither is split. */
function header(name: string, value: string): string {
  checkText(value);
  const lines: string[] = [];
  let line = `${name}:`;
  for (const token of value.split(' ')) {
    if (line.length + 1 + token.length > MAX_HEADER_WIDTH && line.trim().length > name.length + 1) {
      lines.push(line);
      line = ` ${token}`;
    } else line += ` ${token}`;
  }
  lines.push(line);
  return lines.join('\r\n');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (value: number) => String(value).padStart(2, '0');

function rfc5322Date(date: Date): string {
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

/** Base64 in 76-character lines, so no body line is ever too long, whatever the text holds. */
function base64Body(text: string): string {
  const normalized = text.replace(/\r\n|\r|\n/g, '\r\n');
  return (
    Buffer.from(normalized, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? ''
  );
}

/**
 * Exactly the approved message, as RFC 5322 text. No From: Gmail sends as the account that granted the
 * token. Bcc is a header here because Gmail delivers to it and removes it before the mail leaves.
 * Threading headers come from the message being answered, and are checked as strictly as the rest.
 */
export function buildGmailMessage(input: {
  payload: GmailMessagePayload;
  messageId: string;
  date: Date;
  inReplyTo?: { messageId: string; references: readonly string[] } | undefined;
}): string {
  const { payload, date } = input;
  const messageId = checkMessageId(input.messageId);
  const to = payload.to.map(checkAddress);
  const cc = (payload.cc ?? []).map(checkAddress);
  const bcc = (payload.bcc ?? []).map(checkAddress);
  const subject = checkText(payload.subject);
  if (to.length === 0) throw new UnsafeGmailMessage();
  const reply = input.inReplyTo
    ? {
        messageId: checkMessageId(input.inReplyTo.messageId),
        references: input.inReplyTo.references.map(checkMessageId),
      }
    : undefined;

  const headers = [
    header('To', to.join(', ')),
    ...(cc.length ? [header('Cc', cc.join(', '))] : []),
    ...(bcc.length ? [header('Bcc', bcc.join(', '))] : []),
    header('Subject', isPlainHeaderText(subject) ? subject : encodedWords(subject).join(' ')),
    header('Date', rfc5322Date(date)),
    header('Message-ID', messageId),
    ...(reply
      ? [
          header('In-Reply-To', reply.messageId),
          header('References', [...reply.references, reply.messageId].slice(-20).join(' ')),
        ]
      : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${base64Body(payload.text_body)}`;
}

/** The message ID's own text, without its angle brackets, for Gmail's `rfc822msgid:` search. */
export const rfc822SearchTerm = (messageId: string) =>
  `rfc822msgid:${checkMessageId(messageId).slice(1, -1)}`;

/** The Message-IDs a References header lists, keeping only ones that pass the same check. */
export function messageIdsIn(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 16_384) return [];
  const found: string[] = [];
  for (const match of value.matchAll(/<[^<>\s]{1,1000}>/g)) {
    try {
      found.push(checkMessageId(match[0]));
    } catch {
      // One ID this would not send is left out of the thread, which costs threading and nothing else.
    }
  }
  return found;
}

// --- Reading.

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  bull: '•',
};

/** Named and numeric character references. One that names no valid character is dropped. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (
        !Number.isInteger(code) ||
        code < 1 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        return '';
      return String.fromCodePoint(code);
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * HTML to plain text. Scripts, styles and comments go with their content, block ends become line ends,
 * every tag goes, and so every link's target goes with it: only the words a person would see are kept.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article)\s*>/gi, '\n')
      .replace(/<(li)\b[^>]*>/gi, '- ')
      .replace(/<\/t[dh]\s*>/gi, '\t')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type Part = {
  mimeType?: unknown;
  filename?: unknown;
  headers?: unknown;
  body?: { data?: unknown; attachmentId?: unknown } | null;
  parts?: unknown;
};

function charsetOf(part: Part): string {
  const headers = Array.isArray(part.headers) ? (part.headers as unknown[]) : [];
  for (const raw of headers.slice(0, 100)) {
    const item = raw as { name?: unknown; value?: unknown } | null;
    if (typeof item?.name !== 'string' || item.name.toLowerCase() !== 'content-type') continue;
    const match =
      typeof item.value === 'string' ? /charset="?([\w.:-]{1,40})"?/i.exec(item.value) : null;
    if (match) return match[1]!.toLowerCase();
  }
  return 'utf-8';
}

function decodePart(part: Part): string | null {
  const data = part.body?.data;
  if (typeof data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, 'base64url');
  try {
    return new TextDecoder(charsetOf(part)).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * A message's text from Gmail's `format=full` payload: its plain-text part, or its HTML part as text when
 * it has no plain one. Any part with a file name or an attachment ID is an attachment and is skipped, and
 * nothing is fetched to fill in a part Gmail left out.
 */
export function messageText(payload: unknown): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (raw: unknown, depth: number) => {
    if (!raw || typeof raw !== 'object' || depth > 12) return;
    const part = raw as Part;
    const name = typeof part.filename === 'string' ? part.filename : '';
    if (name || part.body?.attachmentId !== undefined) return;
    const type = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    if (type === 'text/plain') {
      const text = decodePart(part);
      if (text !== null) plain.push(text);
    } else if (type === 'text/html') {
      const text = decodePart(part);
      if (text !== null) html.push(text);
    }
    if (Array.isArray(part.parts))
      for (const child of part.parts.slice(0, 100)) walk(child, depth + 1);
  };
  walk(payload, 0);
  if (plain.length) return plain.join('\n\n');
  return html.map(htmlToText).join('\n\n');
}

/** A header's value from Gmail's `headers` list, by name, or undefined. */
export function headerValue(headers: unknown, name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  const wanted = name.toLowerCase();
  for (const raw of headers.slice(0, 500)) {
    const item = raw as { name?: unknown; value?: unknown } | null;
    if (typeof item?.name === 'string' && item.name.toLowerCase() === wanted)
      return typeof item.value === 'string' ? item.value : undefined;
  }
  return undefined;
}
