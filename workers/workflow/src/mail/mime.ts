// The exact bytes of one platform email: plain text and HTML as alternatives, with the same header and
// body rules as the email connector (packages/connectors/src/email/message.ts), so nothing a person typed
// can add a header or end the message early. Pure, so it can be tested with no relay.
import { randomBytes } from 'node:crypto';
import {
  checkAddress,
  checkText,
  dotStuff,
  encodeBody,
  header,
  phrase,
  rfc5322Date,
  UnsafeMessage,
  unstructured,
} from '@ensemus/connectors/email/message';

export { UnsafeMessage };

const MESSAGE_ID = /^<[A-Za-z0-9-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})>$/;
/** An https or http URL with nothing in it that could end a header or an angle bracket. */
const HEADER_URL = /^https?:\/\/[\x21-\x7e]{1,1900}$/;

export type PlatformMessageInput = {
  fromAddress: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  date: Date;
  /** RFC 8058 one-click unsubscribe, for mail someone chose to get. Never on essential mail. */
  unsubscribeUrl: string | null;
  /** Lets a test fix the boundary. */
  boundary?: string;
};

export type PlatformMessage = {
  envelopeFrom: string;
  recipients: [string];
  messageId: string;
  /** Dot-stuffed, with no final CRLF, ready for the SMTP client. */
  data: string;
};

/** Builds one message. Throws UnsafeMessage rather than repairing anything. */
export function buildPlatformMessage(input: PlatformMessageInput): PlatformMessage {
  if (!MESSAGE_ID.test(input.messageId)) throw new UnsafeMessage();
  const from = checkAddress(input.fromAddress);
  const to = checkAddress(input.to);
  const subject = checkText(input.subject);
  const fromName = checkText(input.fromName);
  if (input.unsubscribeUrl !== null && !HEADER_URL.test(input.unsubscribeUrl)) {
    throw new UnsafeMessage();
  }
  const boundary = input.boundary ?? `ensemus-${randomBytes(16).toString('hex')}`;
  if (!/^[A-Za-z0-9-]{8,70}$/.test(boundary)) throw new UnsafeMessage();

  const text = encodeBody(input.text);
  const html = encodeBody(input.html);
  // A part's body can only contain the boundary by accident, and then the message would be cut short.
  if (text.body.includes(`--${boundary}`) || html.body.includes(`--${boundary}`)) {
    throw new UnsafeMessage();
  }

  const headers = [
    header('From', `${phrase(fromName)} <${from}>`),
    header('To', to),
    header('Subject', unstructured(subject)),
    header('Date', rfc5322Date(input.date)),
    header('Message-ID', input.messageId),
    'MIME-Version: 1.0',
    // Says this came from a system, so out-of-office replies and forwarding rules leave it alone.
    'Auto-Submitted: auto-generated',
    ...(input.unsubscribeUrl
      ? [
          header('List-Unsubscribe', `<${input.unsubscribeUrl}>`),
          'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
        ]
      : []),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${text.encoding}`,
    '',
    text.body,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    `Content-Transfer-Encoding: ${html.encoding}`,
    '',
    html.body,
    `--${boundary}--`,
  ];
  return {
    envelopeFrom: from,
    recipients: [to],
    messageId: input.messageId,
    data: dotStuff(`${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`),
  };
}
