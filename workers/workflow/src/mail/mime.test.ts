import { describe, expect, it } from 'vitest';
import { buildPlatformMessage, UnsafeMessage, type PlatformMessageInput } from './mime';

const input: PlatformMessageInput = {
  fromAddress: 'ensemus@example.com',
  fromName: 'Ensemus',
  to: 'ada@example.com',
  subject: 'Reset your Ensemus password',
  text: 'Hi Ada,\n\n.a line that starts with a dot\n',
  html: '<!doctype html><p>Hi Ada</p>',
  messageId: '<0b6f1d1e-2c3a-4b5c-8d9e-0f1a2b3c4d5e@ensemus.example.com>',
  date: new Date('2026-11-12T08:00:00Z'),
  unsubscribeUrl: null,
  boundary: 'ensemus-test-boundary',
};

const headersOf = (data: string) => data.split('\r\n\r\n')[0]!;

describe('a platform email', () => {
  it('has both parts, one recipient and no Bcc', () => {
    const message = buildPlatformMessage(input);
    expect(message.recipients).toEqual(['ada@example.com']);
    expect(message.envelopeFrom).toBe('ensemus@example.com');
    const headers = headersOf(message.data);
    expect(headers).toContain('From: "Ensemus" <ensemus@example.com>');
    expect(headers).toContain('To: ada@example.com');
    expect(headers).toContain(
      'Message-ID: <0b6f1d1e-2c3a-4b5c-8d9e-0f1a2b3c4d5e@ensemus.example.com>',
    );
    expect(headers).toContain('Auto-Submitted: auto-generated');
    expect(headers).toContain('multipart/alternative; boundary="ensemus-test-boundary"');
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(message.data).toContain('Content-Type: text/plain; charset=utf-8');
    expect(message.data).toContain('Content-Type: text/html; charset=utf-8');
    expect(message.data.endsWith('--ensemus-test-boundary--')).toBe(true);
  });

  it('dot-stuffs the body, so it cannot end the message early', () => {
    const message = buildPlatformMessage(input);
    expect(message.data).toContain('\r\n..a line that starts with a dot');
    expect(message.data).not.toMatch(/\r\n\.\r\n/);
  });

  it('offers one-click unsubscribe only when asked to', () => {
    expect(headersOf(buildPlatformMessage(input).data)).not.toContain('List-Unsubscribe');
    const headers = headersOf(
      buildPlatformMessage({
        ...input,
        unsubscribeUrl: 'https://ensemus.example.com/api/mail/unsubscribe/abc',
      }).data,
    );
    expect(headers).toContain(
      'List-Unsubscribe: <https://ensemus.example.com/api/mail/unsubscribe/abc>',
    );
    expect(headers).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('encodes a subject that is not plain ASCII', () => {
    const headers = headersOf(buildPlatformMessage({ ...input, subject: 'Grüße from Zoë' }).data);
    expect(headers).toMatch(/Subject: =\?utf-8\?B\?/);
  });

  it('refuses anything that could add a header or a recipient', () => {
    for (const bad of [
      { subject: 'Hi\r\nBcc: eve@example.com' },
      { to: 'ada@example.com, eve@example.com' },
      { to: 'ada@example.com\r\nBcc: eve@example.com' },
      { fromName: 'Ensemus\nBcc: eve@example.com' },
      { messageId: '<not a message id>' },
      { unsubscribeUrl: 'https://example.com/a>\r\nBcc: eve@example.com' },
      { unsubscribeUrl: 'javascript:alert(1)' },
      { boundary: 'short' },
    ] as Partial<PlatformMessageInput>[]) {
      expect(() => buildPlatformMessage({ ...input, ...bad })).toThrow(UnsafeMessage);
    }
  });

  it('refuses a body that holds its own boundary', () => {
    expect(() =>
      buildPlatformMessage({ ...input, text: 'see --ensemus-test-boundary here' }),
    ).toThrow(UnsafeMessage);
  });
});
