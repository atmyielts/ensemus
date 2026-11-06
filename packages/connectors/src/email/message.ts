// Turns an approved payload into the exact bytes that go out. Pure, so the rules can be tested with no
// socket. The contract schema already refuses a line break in any field, and this refuses it again on its
// own, because an injected header is an email to someone nobody approved (ADR-027 D1).
import type { EmailSendPayload } from '@ensemus/contracts/external-actions';

/** Carries no text from what it refused, since that could be anything in the payload. */
export class UnsafeMessage extends Error {
  override name = 'UnsafeMessage';
  constructor() {
    super('UNSAFE_MESSAGE');
  }
}

export type OutgoingMessage = {
  envelopeFrom: string;
  /** Everyone from the payload, once each. This is the only place a Bcc appears. */
  recipients: string[];
  /** Headers and body in 7-bit ASCII with CRLF line ends, before dot-stuffing and with no final CRLF. */
  data: string;
};

/** Plain atoms only. No quoted local parts or comments, and so nothing an SMTP command could trip on. */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/;
const MESSAGE_ID = /^<[A-Za-z0-9-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})>$/;
/** Every character some software treats as ending a line, and NUL. */
const LINE_BREAKING = /[\r\n\0\v\f]/;
const MAX_HEADER_WIDTH = 78;
/** Bytes of UTF-8 in one encoded word, so that with its wrapper it fits a header line. */
const MAX_ENCODED_WORD_BYTES = 42;
/** RFC 5321's limit on a text line, leaving room for the line end. */
const MAX_BODY_LINE = 998;
const MAX_QP_LINE = 76;

function checkAddress(address: string): string {
  if (typeof address !== 'string' || !ADDRESS.test(address)) throw new UnsafeMessage();
  return address;
}

function checkText(text: string): string {
  if (typeof text !== 'string' || LINE_BREAKING.test(text)) throw new UnsafeMessage();
  return text;
}

/** A printable ASCII string that a mail reader cannot take for an encoded word. */
const isPlainHeaderText = (text: string) => /^[\x20-\x7e]*$/.test(text) && !text.includes('=?');

/** RFC 2047, splitting on whole characters so that each word decodes on its own. */
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

/** Folds on spaces. An encoded word or an address is never split, because neither holds a space. */
function header(name: string, value: string): string {
  const lines: string[] = [];
  let line = `${name}:`;
  for (const token of value.split(' ')) {
    if (line.length + 1 + token.length > MAX_HEADER_WIDTH && line.trim().length > name.length + 1) {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line += ` ${token}`;
    }
  }
  lines.push(line);
  return lines.join('\r\n');
}

function phrase(name: string): string {
  if (isPlainHeaderText(name)) return `"${name.replace(/(["\\])/g, '\\$1')}"`;
  return encodedWords(name).join(' ');
}

const unstructured = (text: string) =>
  isPlainHeaderText(text) ? text : encodedWords(text).join(' ');

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

/** Keeps a character's escape together, and marks a soft break with `=`. */
function quotedPrintableLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  const out: string[] = [];
  let width = 0;
  bytes.forEach((byte, index) => {
    const last = index === bytes.length - 1;
    const literal =
      (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last);
    const token = literal
      ? String.fromCharCode(byte)
      : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    if (width + token.length > MAX_QP_LINE - 1) {
      out.push('=\r\n');
      width = 0;
    }
    out.push(token);
    width += token.length;
  });
  return out.join('');
}

function encodeBody(text: string): { encoding: '7bit' | 'quoted-printable'; body: string } {
  const lines = text.split(/\r\n|\r|\n/);
  const plain = lines.every(
    (line) => line.length <= MAX_BODY_LINE && /^[\t\x20-\x7e]*$/.test(line),
  );
  if (plain) return { encoding: '7bit', body: lines.join('\r\n') };
  return { encoding: 'quoted-printable', body: lines.map(quotedPrintableLine).join('\r\n') };
}

/** Builds exactly the approved message. Throws UnsafeMessage rather than repairing anything. */
export function buildMessage(input: {
  payload: EmailSendPayload;
  messageId: string;
  date: Date;
}): OutgoingMessage {
  const { payload, messageId, date } = input;
  if (!MESSAGE_ID.test(messageId)) throw new UnsafeMessage();
  const sender = checkAddress(payload.from.address);
  const to = payload.to.map(checkAddress);
  const cc = (payload.cc ?? []).map(checkAddress);
  const bcc = (payload.bcc ?? []).map(checkAddress);
  const subject = checkText(payload.subject);
  const senderName = payload.from.name === undefined ? undefined : checkText(payload.from.name);
  const replyTo = payload.reply_to === undefined ? undefined : checkAddress(payload.reply_to);
  if (to.length === 0) throw new UnsafeMessage();

  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const address of [...to, ...cc, ...bcc]) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(address);
  }

  const { encoding, body } = encodeBody(payload.text_body);
  const headers = [
    header('From', senderName === undefined ? sender : `${phrase(senderName)} <${sender}>`),
    header('To', to.join(', ')),
    ...(cc.length ? [header('Cc', cc.join(', '))] : []),
    ...(replyTo === undefined ? [] : [header('Reply-To', replyTo)]),
    header('Subject', unstructured(subject)),
    header('Date', rfc5322Date(date)),
    header('Message-ID', messageId),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${encoding}`,
  ];
  return { envelopeFrom: sender, recipients, data: `${headers.join('\r\n')}\r\n\r\n${body}` };
}

/** RFC 5321 4.5.2: a line starting with a dot gets another, so no body can end the message early. */
export function dotStuff(data: string): string {
  return data.replace(/(^|\r\n)\./g, '$1..');
}
