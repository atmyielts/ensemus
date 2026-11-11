import { describe, expect, it } from 'vitest';
import {
  DOCX_MEDIA_TYPE,
  INGESTIBLE_EXTENSIONS,
  INGESTIBLE_MEDIA_TYPES,
  PDF_MEDIA_TYPE,
  PPTX_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
} from '@ensemus/domain/knowledge';
import { extractOfficeText } from './ooxml';
import { parseDocument } from './parsing';
import { extractPdfText } from './pdf';
import { openZip, ZipRefused } from './zip';
import { walkXml } from './xml-text';
import {
  docxFixture,
  pdfFixture,
  pptxFixture,
  xlsxFixture,
  zipFixture,
} from './testing/document-fixtures';

const text = (value: string) => ({ ok: true, text: value, parserVersion: 'v2' });
const refused = (code: string) => ({ ok: false, code });

describe('PDF text', () => {
  it('reads every page of the text layer, in order', async () => {
    expect(
      await parseDocument(pdfFixture(['Quarterly plan', 'Second (page)']), PDF_MEDIA_TYPE),
    ).toEqual(text('Quarterly plan\n\nSecond (page)'));
  });
  it('says a scan needs OCR, and invents nothing for it', async () => {
    expect(await parseDocument(pdfFixture([null, null]), PDF_MEDIA_TYPE)).toEqual(
      refused('NEEDS_OCR'),
    );
  });
  it('refuses a password-protected PDF plainly, without trying a password', async () => {
    const locked = pdfFixture(['Hidden words'], {
      encrypt: { userPassword: 'generated-password', ownerPassword: 'owner', permissions: -1 },
    });
    expect(await parseDocument(locked, PDF_MEDIA_TYPE)).toEqual(refused('ENCRYPTED_DOCUMENT'));
  });
  it('honours an author forbidding text copying, and reads one that allows it', async () => {
    const noCopy = pdfFixture(['Sealed words'], {
      encrypt: { userPassword: '', ownerPassword: 'owner', permissions: ~0x10 },
    });
    expect(await parseDocument(noCopy, PDF_MEDIA_TYPE)).toEqual(refused('ENCRYPTED_DOCUMENT'));
    const open = pdfFixture(['Permitted words'], {
      encrypt: { userPassword: '', ownerPassword: 'owner', permissions: -1 },
    });
    expect(await parseDocument(open, PDF_MEDIA_TYPE)).toEqual(text('Permitted words'));
  });
  it('refuses what is not a PDF, and a broken one, by code only', async () => {
    expect(await parseDocument(Buffer.from('plain words'), PDF_MEDIA_TYPE)).toEqual(
      refused('MALFORMED_DOCUMENT'),
    );
    const truncated = pdfFixture(['Cut short']).subarray(0, 40);
    const result = await parseDocument(truncated, PDF_MEDIA_TYPE);
    expect(result.ok).toBe(false);
    expect(['MALFORMED_DOCUMENT', 'PARSE_FAILED', 'NEEDS_OCR']).toContain(
      (result as { code: string }).code,
    );
  });
  it('refuses too many pages and too much text rather than cutting either short', async () => {
    const pages = pdfFixture(['one', 'two', 'three']);
    expect(await extractPdfText(pages, { maxBytes: 1_000, maxPages: 2 })).toEqual(
      refused('TOO_LARGE'),
    );
    expect(await extractPdfText(pages, { maxBytes: 6 })).toEqual(refused('TOO_LARGE'));
  });
});

describe('Word text', () => {
  it('reads paragraphs, footnotes and a text box once', async () => {
    const file = docxFixture(['First & foremost', 'Second'], {
      footnote: 'A footnote',
      textBox: 'In a box',
    });
    expect(await parseDocument(file, DOCX_MEDIA_TYPE)).toEqual(
      text('First & foremost\nSecond\nIn a box\n\nA footnote'),
    );
  });
  it('never reads embedded files, macros or anything outside the package', async () => {
    const file = docxFixture(['Visible'], {
      externalRelationships: true,
      embedded: { text: 'EMBEDDED_SECRET' },
    });
    const parsed = await parseDocument(file, DOCX_MEDIA_TYPE);
    expect(parsed).toEqual(text('Visible'));
  });
  it('refuses a document type declaration, so no entity is ever defined or fetched', async () => {
    const laughs = docxFixture(['x'], {
      prolog:
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>',
    });
    expect(await parseDocument(laughs, DOCX_MEDIA_TYPE)).toEqual(refused('MALFORMED_DOCUMENT'));
    const external = docxFixture(['x'], {
      prolog: '<!DOCTYPE d [<!ENTITY ext SYSTEM "file:///etc/passwd">]>',
    });
    expect(await parseDocument(external, DOCX_MEDIA_TYPE)).toEqual(refused('MALFORMED_DOCUMENT'));
  });
  it('refuses nesting deep enough to exhaust a parser', async () => {
    const deep = docxFixture([], { rawBody: '<w:p>'.repeat(400) + '</w:p>'.repeat(400) });
    expect(await parseDocument(deep, DOCX_MEDIA_TYPE)).toEqual(refused('MALFORMED_DOCUMENT'));
  });
  it('refuses a password-protected Office file, which is an OLE container', async () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504),
    ]);
    expect(await parseDocument(ole, DOCX_MEDIA_TYPE)).toEqual(refused('ENCRYPTED_DOCUMENT'));
  });
  it('refuses a presentation labelled as a Word file', async () => {
    expect(await parseDocument(pptxFixture([['Slide']]), DOCX_MEDIA_TYPE)).toEqual(
      refused('MALFORMED_DOCUMENT'),
    );
  });
  it('refuses rather than truncates when the text passes the ceiling', () => {
    expect(extractOfficeText(docxFixture(['x'.repeat(100)]), DOCX_MEDIA_TYPE, 50)).toEqual(
      refused('TOO_LARGE'),
    );
  });
});

describe('PowerPoint and Excel text', () => {
  it('reads slides in presentation order, not file order', async () => {
    expect(
      await parseDocument(
        pptxFixture([['Opening'], ['Middle', 'detail'], ['Close']]),
        PPTX_MEDIA_TYPE,
      ),
    ).toEqual(text('Opening\n\nMiddle\ndetail\n\nClose'));
  });
  it('reads cached cell values, never formulas or phonetic guides', async () => {
    const book = xlsxFixture([
      {
        name: 'Revenue',
        rows: [
          ['Region', 'Total'],
          ['North', 12.5, true],
        ],
      },
      { name: 'Notes', rows: [['Region']] },
    ]);
    const parsed = await parseDocument(book, XLSX_MEDIA_TYPE);
    expect(parsed).toEqual(text('Revenue\nRegion\tTotal\nNorth\t12.5\tTRUE\n\nNotes\nRegion'));
    expect(JSON.stringify(parsed)).not.toMatch(/SECRET_FORMULA|PHONETIC/);
  });
});

describe('the ZIP reader', () => {
  const plain = (data: string) => [{ name: 'a.xml', data }];
  it('reads an entry and refuses what is not an archive', () => {
    expect(Buffer.from(openZip(zipFixture(plain('<a/>'))).read('a.xml')!).toString()).toBe('<a/>');
    expect(() => openZip(Buffer.from('not a zip at all, just words'))).toThrow(ZipRefused);
  });
  it('stops a bomb at its declared size, not at the heap', () => {
    const bomb = zipFixture([{ name: 'a.xml', data: 'a'.repeat(5_000_000), declaredSize: 1_000 }]);
    expect(() => openZip(bomb).read('a.xml')).toThrow(
      expect.objectContaining({ code: 'TOO_LARGE' }),
    );
  });
  it('refuses a ratio no document has, entries past the limits, and a total past the ceiling', () => {
    const dense = zipFixture(plain('a'.repeat(4_000_000)));
    expect(() => openZip(dense)).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
    const many = zipFixture(Array.from({ length: 5 }, (_, i) => ({ name: `${i}.xml`, data: 'x' })));
    expect(() =>
      openZip(many, { maxEntries: 4, maxEntryBytes: 100, maxTotalBytes: 100, maxRatio: 200 }),
    ).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
    const twice = zipFixture([
      { name: 'a.xml', data: 'x'.repeat(60) },
      { name: 'b.xml', data: 'y'.repeat(60) },
    ]);
    const archive = openZip(twice, {
      maxEntries: 10,
      maxEntryBytes: 100,
      maxTotalBytes: 100,
      maxRatio: 200,
    });
    archive.read('a.xml');
    expect(() => archive.read('b.xml')).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
  });
  it('refuses encrypted entries, duplicate names and names that escape', () => {
    expect(() => openZip(zipFixture([{ name: 'a.xml', data: 'x', flags: 0x0001 }]))).toThrow(
      expect.objectContaining({ code: 'ENCRYPTED_DOCUMENT' }),
    );
    expect(() =>
      openZip(
        zipFixture([
          { name: 'a.xml', data: 'x' },
          { name: 'a.xml', data: 'y' },
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: 'MALFORMED_DOCUMENT' }));
    expect(() => openZip(zipFixture([{ name: '../a.xml', data: 'x' }]))).toThrow(
      expect.objectContaining({ code: 'MALFORMED_DOCUMENT' }),
    );
  });
  it('refuses an entry whose bytes do not match its checksum', () => {
    const archive = zipFixture([{ name: 'a.xml', data: 'abcdef', method: 0 }]);
    const tampered = Buffer.from(archive);
    tampered[30 + 'a.xml'.length] = 'z'.charCodeAt(0);
    expect(() => openZip(tampered).read('a.xml')).toThrow(
      expect.objectContaining({ code: 'MALFORMED_DOCUMENT' }),
    );
  });
});

describe('the XML tokenizer', () => {
  it('decodes only predefined entities and character references', () => {
    const seen: string[] = [];
    walkXml('<a>&lt;b&gt; &amp; &#65; &undefined;</a>', { text: (t) => seen.push(t) });
    expect(seen.join('')).toBe('<b> & A &undefined;');
  });
  it('refuses unbalanced or stray markup', () => {
    expect(() => walkXml('<a><b></a>', {})).toThrow();
    expect(() => walkXml('<a>', {})).toThrow();
    expect(() => walkXml('text<a/>', {})).toThrow();
  });
});

describe('the formats list', () => {
  it('names an extension for every format, and only formats it parses', () => {
    for (const type of INGESTIBLE_MEDIA_TYPES)
      expect(Object.values(INGESTIBLE_EXTENSIONS)).toContain(type);
    for (const type of Object.values(INGESTIBLE_EXTENSIONS))
      expect(INGESTIBLE_MEDIA_TYPES).toContain(type);
  });
});
