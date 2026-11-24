// The real parse thread, as the knowledge worker runs it, on generated PDF and Office files (ADR-029 D4
// addendum). Each file gets its own thread, heap and deadline, and the thread's ways out are closed.
import { describe, expect, it } from 'vitest';
import {
  DOCX_MEDIA_TYPE,
  PDF_MEDIA_TYPE,
  PPTX_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
} from '@ensemus/domain/knowledge';
import {
  docxFixture,
  pdfFixture,
  pptxFixture,
  xlsxFixture,
  zipFixture,
} from '../../packages/knowledge/src/testing/document-fixtures';
import { closeThreadExits, createParseRunner } from '../../workers/workflow/src/parse-thread';

describe('the isolated parse thread with PDF and Office files', () => {
  const parse = createParseRunner();
  it('reads each format in its own thread and leaves the caller buffer intact', async () => {
    const pdf = pdfFixture(['Generated quarterly words']);
    const before = Buffer.from(pdf);
    expect(await parse(pdf, PDF_MEDIA_TYPE)).toEqual({
      ok: true,
      text: 'Generated quarterly words',
      parserVersion: 'v2',
    });
    expect(pdf.equals(before)).toBe(true);
    expect(await parse(docxFixture(['Generated memo']), DOCX_MEDIA_TYPE)).toMatchObject({
      ok: true,
      text: 'Generated memo',
    });
    expect(await parse(pptxFixture([['Generated slide']]), PPTX_MEDIA_TYPE)).toMatchObject({
      ok: true,
      text: 'Generated slide',
    });
    expect(
      await parse(xlsxFixture([{ name: 'S', rows: [['Generated cell']] }]), XLSX_MEDIA_TYPE),
    ).toMatchObject({ ok: true, text: 'S\nGenerated cell' });
  });
  it('returns codes, not crashes, for scans, passwords and bombs', async () => {
    expect(await parse(pdfFixture([null]), PDF_MEDIA_TYPE)).toEqual({
      ok: false,
      code: 'NEEDS_OCR',
    });
    const bomb = zipFixture([
      { name: 'word/document.xml', data: 'a'.repeat(3_000_000), declaredSize: 100 },
    ]);
    expect(await parse(bomb, DOCX_MEDIA_TYPE)).toMatchObject({ ok: false });
  });
  it('stops a parse at its deadline', async () => {
    await expect(
      createParseRunner({ deadlineMs: 1 })(pdfFixture(['x']), PDF_MEDIA_TYPE),
    ).rejects.toMatchObject({ code: 'PARSE_TIMEOUT' });
  });
});

describe('closing the thread’s ways out', () => {
  it('refuses fetch, sockets and console output once closed', async () => {
    const printed: string[] = [];
    const scope = {
      console: {
        log: (text: string) => printed.push(text),
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        trace: () => {},
      },
    } as unknown as typeof globalThis;
    closeThreadExits(scope);
    await expect(scope.fetch('https://example.invalid/')).rejects.toThrow('NETWORK_REFUSED');
    expect(
      () => new (scope.WebSocket as unknown as new (url: string) => unknown)('wss://x'),
    ).toThrow('NETWORK_REFUSED');
    scope.console.log('a document word');
    expect(printed).toEqual([]);
    expect(() => {
      (scope as { fetch: unknown }).fetch = () => 'reopened';
    }).toThrow();
  });
});
