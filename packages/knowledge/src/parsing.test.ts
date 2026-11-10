import { describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_BYTES } from '@ensemus/domain/knowledge';
import { parseDocument } from './parsing';

describe('document parsing', () => {
  it('refuses formats, encoding, NUL and empty input before any text can be stored', () => {
    expect(parseDocument(Buffer.from('pdf'), 'application/pdf')).toEqual({
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
    });
    expect(parseDocument(new Uint8Array([0xc3, 0x28]), 'text/plain')).toEqual({
      ok: false,
      code: 'UNREADABLE_ENCODING',
    });
    expect(parseDocument(Buffer.from('a\0b'), 'text/plain')).toEqual({
      ok: false,
      code: 'UNREADABLE_ENCODING',
    });
    expect(parseDocument(Buffer.from(' \n '), 'text/plain')).toEqual({
      ok: false,
      code: 'EMPTY_DOCUMENT',
    });
    expect(parseDocument(Buffer.alloc(MAX_DOCUMENT_BYTES + 1), 'text/plain')).toEqual({
      ok: false,
      code: 'TOO_LARGE',
    });
  });
  it('keeps text, markdown and CSV as text with normalized line endings', () => {
    for (const type of ['text/plain', 'text/markdown', 'text/csv']) {
      expect(parseDocument(Buffer.from('First\r\nSecond\rLast'), type)).toEqual({
        ok: true,
        text: 'First\nSecond\nLast',
        parserVersion: 'v1',
      });
    }
  });
  it('extracts visible HTML without script, style, comments, tags or executable output', () => {
    const parsed = parseDocument(
      Buffer.from(
        '<p>One &amp; two</p><!--hidden--><script>private()</script><style>.private{}</style><p title=">">Three &#128512;</p>',
      ),
      'text/html',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.text).toContain('One & two');
      expect(parsed.text).toContain('Three 😀');
      expect(parsed.text).not.toMatch(/private|hidden|<p|title=/);
    }
  });
  it('refuses invalid JSON and emits only its parsed textual form for valid JSON', () => {
    expect(parseDocument(Buffer.from('{'), 'application/json')).toEqual({
      ok: false,
      code: 'UNREADABLE_ENCODING',
    });
    const parsed = parseDocument(Buffer.from('{"a": "hello"}'), 'application/json');
    expect(parsed.ok && parsed.text).toContain('hello');
  });
});
