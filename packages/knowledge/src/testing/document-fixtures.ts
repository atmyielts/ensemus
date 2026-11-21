// Small generated documents for parser tests (ADR-029 D4 addendum). Every byte is made here, from words
// in the test: no real document, and nothing downloaded. The builders can also produce the hostile cases
// a parser must refuse: a lying size, an encrypted entry, a DTD, deep nesting, a password, a scan.
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

export type ZipFixtureEntry = {
  name: string;
  data: string | Uint8Array;
  /** 8 (deflate) by default. */
  method?: 0 | 8;
  /** Declare this uncompressed size instead of the real one. */
  declaredSize?: number;
  /** Extra general-purpose flags, such as 0x0001 for encryption. */
  flags?: number;
};

/** A plain ZIP, written the way Office writes one: local headers, then the central directory. */
export function zipFixture(entries: readonly ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data) : Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name);
    const flags = 0x0800 | (entry.flags ?? 0);
    const size = entry.declaredSize ?? raw.length;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const xmlEscape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

function contentTypes(overrides: Record<string, string>) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(
    overrides,
  )
    .map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`)
    .join('')}</Types>`;
}

function rels(list: readonly { id: string; type: string; target: string; external?: boolean }[]) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL}">${list
    .map(
      (rel) =>
        `<Relationship Id="${rel.id}" Type="${REL}/${rel.type}" Target="${rel.target}"${rel.external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('')}</Relationships>`;
}

export type DocxFixtureOptions = {
  /** Raw XML inserted in the body, for hostile cases. */
  rawBody?: string;
  /** Raw text before the root element, such as a DOCTYPE. */
  prolog?: string;
  footnote?: string;
  /** Adds a hyperlink and an attached template that point outside the package. */
  externalRelationships?: boolean;
  /** Adds an embedded file and a macro project, which must never be read. */
  embedded?: { text: string };
  /** A text box written twice, as Word does: DrawingML and its VML fallback. */
  textBox?: string;
};

export function docxFixture(paragraphs: readonly string[], options: DocxFixtureOptions = {}) {
  const body =
    paragraphs
      .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
      .join('') +
    (options.textBox
      ? `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p><w:r><w:t>${xmlEscape(options.textBox)}</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>${xmlEscape(options.textBox)}</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`
      : '') +
    (options.rawBody ?? '');
  const document = `${options.prolog ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="${REL}"><w:body>${body}</w:body></w:document>`;
  const docRels: { id: string; type: string; target: string; external?: boolean }[] = [];
  const overrides: Record<string, string> = {
    'word/document.xml':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  };
  const entries: ZipFixtureEntry[] = [];
  if (options.footnote !== undefined) {
    docRels.push({ id: 'rId9', type: 'footnotes', target: 'footnotes.xml' });
    overrides['word/footnotes.xml'] =
      'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml';
    entries.push({
      name: 'word/footnotes.xml',
      data: `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote><w:p><w:r><w:t>${xmlEscape(options.footnote)}</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    });
  }
  if (options.externalRelationships) {
    docRels.push(
      { id: 'rId20', type: 'hyperlink', target: 'https://example.invalid/x', external: true },
      { id: 'rId21', type: 'attachedTemplate', target: 'file:///c:/t.dotm', external: true },
      // An escaping internal path must be dropped, not followed.
      { id: 'rId22', type: 'footnotes', target: '../../outside.xml' },
    );
  }
  if (options.embedded) {
    docRels.push({ id: 'rId30', type: 'package', target: 'embeddings/inner.docx' });
    entries.push(
      { name: 'word/embeddings/inner.docx', data: docxFixture([options.embedded.text]) },
      {
        name: 'word/vbaProject.bin',
        data: Buffer.from(`Attribute VB_Name ${options.embedded.text}`),
      },
    );
  }
  return zipFixture([
    { name: '[Content_Types].xml', data: contentTypes(overrides) },
    {
      name: '_rels/.rels',
      data: rels([{ id: 'rId1', type: 'officeDocument', target: 'word/document.xml' }]),
    },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: rels(docRels) },
    ...entries,
  ]);
}

/** Slides in presentation order, which deliberately differs from their file numbers. */
export function pptxFixture(slides: readonly (readonly string[])[]) {
  const count = slides.length;
  const entries: ZipFixtureEntry[] = [];
  const presRels: { id: string; type: string; target: string }[] = [];
  const overrides: Record<string, string> = {
    'ppt/presentation.xml':
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  };
  const ids: string[] = [];
  slides.forEach((paragraphs, index) => {
    // The first slide in order is stored as the last file.
    const file = `ppt/slides/slide${count - index}.xml`;
    presRels.push({
      id: `rId${index + 2}`,
      type: 'slide',
      target: `slides/slide${count - index}.xml`,
    });
    overrides[file] = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
    ids.push(`<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`);
    entries.push({
      name: file,
      data: `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs
        .map((p) => `<a:p><a:r><a:t>${xmlEscape(p)}</a:t></a:r></a:p>`)
        .join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    });
  });
  return zipFixture([
    { name: '[Content_Types].xml', data: contentTypes(overrides) },
    {
      name: '_rels/.rels',
      data: rels([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]),
    },
    {
      name: 'ppt/presentation.xml',
      data: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL}"><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`,
    },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels(presRels) },
    ...entries,
  ]);
}

/** Sheets of rows. Strings go through the shared string table, numbers stay inline, as Excel writes them. */
export type SheetFixture = {
  name: string;
  rows: readonly (readonly (string | number | boolean)[])[];
};

export function xlsxFixture(sheets: readonly SheetFixture[]) {
  const shared: string[] = [];
  const index = (text: string) => {
    const at = shared.indexOf(text);
    if (at >= 0) return at;
    shared.push(text);
    return shared.length - 1;
  };
  const overrides: Record<string, string> = {
    'xl/workbook.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  };
  const wbRels: { id: string; type: string; target: string }[] = [];
  const entries: ZipFixtureEntry[] = [];
  sheets.forEach((sheet, at) => {
    const rows = sheet.rows
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row
            .map((cell, c) => {
              const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
              if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
              if (typeof cell === 'boolean')
                return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
              return `<c r="${ref}" t="s"><f>SECRET_FORMULA()</f><v>${index(cell)}</v></c>`;
            })
            .join('')}</row>`,
      )
      .join('');
    entries.push({
      name: `xl/worksheets/sheet${at + 1}.xml`,
      data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    });
    wbRels.push({ id: `rId${at + 1}`, type: 'worksheet', target: `worksheets/sheet${at + 1}.xml` });
  });
  wbRels.push({ id: 'rId99', type: 'sharedStrings', target: 'sharedStrings.xml' });
  return zipFixture([
    { name: '[Content_Types].xml', data: contentTypes(overrides) },
    {
      name: '_rels/.rels',
      data: rels([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }]),
    },
    {
      name: 'xl/workbook.xml',
      data: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheets
        .map(
          (s, at) => `<sheet name="${xmlEscape(s.name)}" sheetId="${at + 1}" r:id="rId${at + 1}"/>`,
        )
        .join('')}</sheets></workbook>`,
    },
    { name: 'xl/_rels/workbook.xml.rels', data: rels(wbRels) },
    {
      name: 'xl/sharedStrings.xml',
      data: `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
        .map((s) => `<si><t>${xmlEscape(s)}</t><rPh><t>PHONETIC</t></rPh></si>`)
        .join('')}</sst>`,
    },
    ...entries,
  ]);
}

export type PdfFixtureOptions = {
  /** Standard security handler, revision 2 (40-bit RC4), so pdf.js has to decrypt or refuse. */
  encrypt?: { userPassword: string; ownerPassword: string; permissions: number };
};

/**
 * A PDF with one page per entry. A string becomes text in Helvetica; `null` becomes a page that only
 * paints a rectangle, which is what a scan looks like to a text extractor.
 */
export function pdfFixture(pages: readonly (string | null)[], options: PdfFixtureOptions = {}) {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const id = Buffer.from(createHash('md5').update(pages.join('|')).digest());
  const encryption = options.encrypt ? standardSecurity(options.encrypt, id) : null;
  const literal = (text: string) =>
    `(${text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`;
  // Objects are numbered in the order they are added, so encryption keys can be derived per object.
  const catalog = add('');
  const pageTree = add('');
  const font = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const kids: number[] = [];
  for (const page of pages) {
    const stream =
      page === null ? '0 0 200 200 re f' : `BT /F1 12 Tf 72 720 Td ${literal(page)} Tj ET`;
    const number = objects.length + 1;
    const data = encryption
      ? encryption.encrypt(number, Buffer.from(stream, 'latin1'))
      : Buffer.from(stream, 'latin1');
    add(`<< /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${number} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const encryptRef = encryption ? add(encryption.dictionary) : null;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, at) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${at + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${
    encryptRef ? ` /Encrypt ${encryptRef} 0 R` : ''
  } /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const padded = (password: string) =>
  Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < data.length; n += 1) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

/** PDF 1.4's algorithms 3.1 to 3.4, at revision 2. Enough for a reader to have to check a password. */
function standardSecurity(
  input: { userPassword: string; ownerPassword: string; permissions: number },
  id: Buffer,
) {
  const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest();
  const owner = rc4(
    md5(padded(input.ownerPassword || input.userPassword)).subarray(0, 5),
    padded(input.userPassword),
  );
  // Revision 2 requires the unused high bits set, and the low two bits clear.
  const p = (input.permissions | 0xffffffc0) & ~3;
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(p | 0);
  const key = md5(padded(input.userPassword), owner, pBytes, id).subarray(0, 5);
  const user = rc4(key, PAD);
  return {
    dictionary: `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P ${p | 0} >>`,
    encrypt(object: number, data: Buffer) {
      const objectKey = md5(
        key,
        Buffer.from([object & 255, (object >> 8) & 255, (object >> 16) & 255, 0, 0]),
      ).subarray(0, 10);
      return rc4(objectKey, data);
    },
  };
}
