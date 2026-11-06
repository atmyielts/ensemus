import { describe, expect, it } from 'vitest';
import { buildMessage, dotStuff, UnsafeMessage } from './message';

const FIXED = {
  messageId: '<11111111-1111-4111-8111-111111111111@mail.example.invalid>',
  date: new Date('2026-11-06T10:00:00.000Z'),
};
const payload = {
  from: { address: 'sender@example.invalid', name: 'Sender' },
  to: ['first@example.invalid'],
  subject: 'Hello',
  text_body: 'Plain text',
};
const build = (overrides: Record<string, unknown> = {}) =>
  buildMessage({ ...FIXED, payload: { ...payload, ...overrides } as typeof payload });
const headersOf = (data: string) => data.slice(0, data.indexOf('\r\n\r\n'));
const bodyOf = (data: string) => data.slice(data.indexOf('\r\n\r\n') + 4);
const unfold = (headers: string) => headers.replace(/\r\n[ \t]/g, ' ');

/** Decodes quoted-printable by hand, so the check does not share code with what it checks. */
function decodeQuotedPrintable(text: string): string {
  const bytes: number[] = [];
  const lines = text.split('\r\n');
  lines.forEach((line, index) => {
    const soft = line.endsWith('=');
    const content = soft ? line.slice(0, -1) : line;
    for (let i = 0; i < content.length; i += 1) {
      if (content[i] === '=') {
        bytes.push(Number.parseInt(content.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(content.charCodeAt(i));
      }
    }
    if (!soft && index < lines.length - 1) bytes.push(13, 10);
  });
  return Buffer.from(bytes).toString('utf8');
}

function decodeEncodedWords(value: string): string {
  const words = [...value.matchAll(/=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/g)];
  return Buffer.concat(words.map((word) => Buffer.from(word[1] ?? '', 'base64'))).toString('utf8');
}

describe('headers', () => {
  it('carries exactly what was approved, and the derived Message-ID', () => {
    const { data, envelopeFrom, recipients } = build({
      cc: ['second@example.invalid'],
      reply_to: 'reply@example.invalid',
    });
    const headers = unfold(headersOf(data));
    expect(headers).toContain('From: "Sender" <sender@example.invalid>');
    expect(headers).toContain('To: first@example.invalid');
    expect(headers).toContain('Cc: second@example.invalid');
    expect(headers).toContain('Reply-To: reply@example.invalid');
    expect(headers).toContain('Subject: Hello');
    expect(headers).toContain(`Message-ID: ${FIXED.messageId}`);
    expect(headers).toContain('Date: Fri, 06 Nov 2026 10:00:00 +0000');
    expect(headers).toContain('MIME-Version: 1.0');
    expect(envelopeFrom).toBe('sender@example.invalid');
    expect(recipients).toEqual(['first@example.invalid', 'second@example.invalid']);
  });

  it('puts a Bcc in the envelope and in no header', () => {
    const { data, recipients } = build({ bcc: ['hidden@example.invalid'] });
    expect(recipients).toContain('hidden@example.invalid');
    expect(data).not.toContain('hidden@example.invalid');
    expect(data.toLowerCase()).not.toContain('bcc');
  });

  it('lists a recipient named twice only once in the envelope', () => {
    const { recipients } = build({
      to: ['first@example.invalid'],
      cc: ['FIRST@example.invalid'],
      bcc: ['first@example.invalid'],
    });
    expect(recipients).toEqual(['first@example.invalid']);
  });

  it('encodes a non-ASCII subject and name as RFC 2047 words that decode exactly', () => {
    const subject = 'Déjà vu: Ñandú 日本語のメール '.repeat(4).trim();
    const { data } = build({
      subject,
      from: { address: 'sender@example.invalid', name: 'Zoë Müller' },
    });
    const headers = headersOf(data);
    expect(/^[\x20-\x7e\r\n]*$/.test(headers)).toBe(true);
    for (const line of headers.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    const subjectHeader = unfold(headers)
      .split('\r\n')
      .find((line) => line.startsWith('Subject:'));
    expect(decodeEncodedWords(subjectHeader ?? '')).toBe(subject);
    const fromHeader = unfold(headers)
      .split('\r\n')
      .find((line) => line.startsWith('From:'));
    expect(decodeEncodedWords(fromHeader ?? '')).toBe('Zoë Müller');
    expect(fromHeader).toContain('<sender@example.invalid>');
  });

  it('encodes a subject that only looks like an encoded word, so it cannot pose as one', () => {
    const subject = '=?utf-8?B?ZmFrZQ==?= real';
    const header = unfold(headersOf(build({ subject }).data))
      .split('\r\n')
      .find((line) => line.startsWith('Subject:'));
    expect(decodeEncodedWords(header ?? '')).toBe(subject);
  });

  it('quotes a name so that it cannot open another address', () => {
    const { data } = build({
      from: { address: 'sender@example.invalid', name: 'Eve "x" <evil@example.invalid>, \\' },
    });
    const from = unfold(headersOf(data))
      .split('\r\n')
      .find((line) => line.startsWith('From:'));
    expect(from).toBe('From: "Eve \\"x\\" <evil@example.invalid>, \\\\" <sender@example.invalid>');
  });

  it('folds a long recipient list on spaces, and keeps every address whole', () => {
    const to = Array.from({ length: 40 }, (_, i) => `recipient-${i}@example.invalid`);
    const headers = headersOf(build({ to }).data);
    for (const line of headers.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    for (const address of to) expect(unfold(headers)).toContain(address);
  });
});

describe('header injection, past the contract schema', () => {
  // The schema refuses these first. This proves the message builder holds on its own.
  const breaks = ['\r\n', '\n', '\r', '\0', '\v', '\f', '\r\nBcc: evil@example.invalid'];

  for (const breaker of breaks) {
    const shown = JSON.stringify(breaker);
    it(`refuses ${shown} in the subject`, () => {
      expect(() => build({ subject: `Hello${breaker}X` })).toThrow(UnsafeMessage);
    });
    it(`refuses ${shown} in the sender's name`, () => {
      expect(() =>
        build({ from: { address: 'sender@example.invalid', name: `N${breaker}X` } }),
      ).toThrow(UnsafeMessage);
    });
    it(`refuses ${shown} in the sender's address`, () => {
      expect(() => build({ from: { address: `sender${breaker}@example.invalid` } })).toThrow(
        UnsafeMessage,
      );
    });
    for (const field of ['to', 'cc', 'bcc']) {
      it(`refuses ${shown} in ${field}`, () => {
        expect(() =>
          build({
            to: ['first@example.invalid'],
            [field]: [`a${breaker}@example.invalid`],
          }),
        ).toThrow(UnsafeMessage);
      });
    }
    it(`refuses ${shown} in reply-to`, () => {
      expect(() => build({ reply_to: `a${breaker}@example.invalid` })).toThrow(UnsafeMessage);
    });
    it(`refuses ${shown} in the Message-ID`, () => {
      expect(() =>
        buildMessage({ ...FIXED, messageId: `<a${breaker}@x.invalid>`, payload }),
      ).toThrow(UnsafeMessage);
    });
  }

  it('refuses SMTP syntax hidden in an address', () => {
    for (const address of [
      'a@example.invalid> NOTIFY=NEVER',
      'a@example.invalid>',
      '<a@example.invalid',
      'a b@example.invalid',
      'a,b@example.invalid',
      'á@example.invalid',
      'no-at-sign',
    ]) {
      expect(() => build({ to: [address] }), address).toThrow(UnsafeMessage);
    }
  });

  it('refuses a message with nobody to send it to', () => {
    expect(() => build({ to: [] })).toThrow(UnsafeMessage);
  });

  it('keeps a body line that looks like a header in the body', () => {
    const { data } = build({ text_body: 'Line one\r\nBcc: evil@example.invalid\r\n\r\nLast' });
    expect(headersOf(data)).not.toContain('evil@example.invalid');
    expect(bodyOf(data)).toBe('Line one\r\nBcc: evil@example.invalid\r\n\r\nLast');
  });

  it('carries no error text from what it refused', () => {
    try {
      build({ subject: 'canary-subject\r\nX' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('canary');
    }
  });
});

describe('bodies', () => {
  it('sends a plain ASCII body as it is, and marks it 7bit', () => {
    const { data } = build({ text_body: 'Hello there' });
    expect(headersOf(data)).toContain('Content-Transfer-Encoding: 7bit');
    expect(headersOf(data)).toContain('Content-Type: text/plain; charset=utf-8');
    expect(bodyOf(data)).toBe('Hello there');
  });

  it('turns every kind of line ending into CRLF', () => {
    expect(bodyOf(build({ text_body: 'a\nb\rc\r\nd' }).data)).toBe('a\r\nb\r\nc\r\nd');
  });

  it('keeps a final line break', () => {
    expect(bodyOf(build({ text_body: 'a\n' }).data)).toBe('a\r\n');
  });

  it('encodes an 8-bit body so only 7-bit bytes go out, and it decodes exactly', () => {
    const text = 'Déjà vu = 日本語\r\nSecond línea  \r\n\ttab';
    const { data } = build({ text_body: text });
    expect(headersOf(data)).toContain('Content-Transfer-Encoding: quoted-printable');
    expect(/^[\t\r\n\x20-\x7e]*$/.test(data)).toBe(true);
    expect(decodeQuotedPrintable(bodyOf(data))).toBe(text);
  });

  it('breaks a line over the limit, and it still decodes exactly', () => {
    const text = 'x'.repeat(5000);
    const { data } = build({ text_body: text });
    expect(headersOf(data)).toContain('Content-Transfer-Encoding: quoted-printable');
    for (const line of bodyOf(data).split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(decodeQuotedPrintable(bodyOf(data))).toBe(text);
  });

  it('leaves a line of exactly 998 as it is, and encodes one of 999', () => {
    expect(headersOf(build({ text_body: 'y'.repeat(998) }).data)).toContain('7bit');
    expect(headersOf(build({ text_body: 'y'.repeat(999) }).data)).toContain('quoted-printable');
  });

  it('encodes control characters in a body, and they decode exactly', () => {
    const text = 'bell\x07 and nul\0 end';
    const { data } = build({ text_body: text });
    expect(/^[\t\r\n\x20-\x7e]*$/.test(data)).toBe(true);
    expect(decodeQuotedPrintable(bodyOf(data))).toBe(text);
  });

  it('keeps a multi-byte character whole across a soft break', () => {
    const text = '日本語'.repeat(200);
    expect(decodeQuotedPrintable(bodyOf(build({ text_body: text }).data))).toBe(text);
  });
});

describe('dotStuff', () => {
  it('doubles a dot only at the start of a line', () => {
    expect(dotStuff('.a\r\nb.c\r\n.\r\n..d')).toBe('..a\r\nb.c\r\n..\r\n...d');
  });

  it('stops a body from ending the message early', () => {
    const stuffed = dotStuff(build({ text_body: 'before\n.\nafter' }).data);
    expect(stuffed).not.toContain('\r\n.\r\n');
    expect(stuffed).toContain('\r\n..\r\n');
  });

  it('leaves a body with no leading dots alone', () => {
    expect(dotStuff('a.b\r\nc')).toBe('a.b\r\nc');
  });
});
