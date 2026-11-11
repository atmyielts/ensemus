// Text out of Word, PowerPoint and Excel files (ADR-029 D4 addendum). Only the parts that hold a document's
// own words are read: the main part a package names, its slides or sheets, and their shared strings. A
// relationship is followed only inside the package, and never when it is marked External, so a link,
// a linked template or a remote image is never fetched. Embedded files, OLE objects, macros (vbaProject),
// media, custom XML and anything else in the archive are never opened, let alone run.
import { DOCX_MEDIA_TYPE, PPTX_MEDIA_TYPE, XLSX_MEDIA_TYPE } from '@ensemus/domain/knowledge';
import { openZip, ZipRefused, type ZipArchive } from '@ensemus/knowledge/zip';
import { localName, walkXml, XmlRefused } from '@ensemus/knowledge/xml-text';

export type OfficeMediaType =
  typeof DOCX_MEDIA_TYPE | typeof PPTX_MEDIA_TYPE | typeof XLSX_MEDIA_TYPE;

export type OfficeText =
  | { ok: true; text: string }
  | {
      ok: false;
      code: 'TOO_LARGE' | 'MALFORMED_DOCUMENT' | 'ENCRYPTED_DOCUMENT' | 'EMPTY_DOCUMENT';
    };

/** Slides and sheets read from one file. Past this, the file is refused rather than cut short. */
export const MAX_OFFICE_PARTS = 2_000;

const MAIN_TYPES: Readonly<Record<OfficeMediaType, readonly string[]>> = {
  [DOCX_MEDIA_TYPE]: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
    // Read as text like any other. The macro project is a separate part that is never opened.
    'application/vnd.ms-word.document.macroEnabled.main+xml',
  ],
  [PPTX_MEDIA_TYPE]: [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  ],
  [XLSX_MEDIA_TYPE]: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  ],
};

const OFFICE_DOCUMENT_REL = /\/officeDocument$/;

/**
 * Extracts the words of an Office Open XML file. `maxBytes` bounds the UTF-8 output; past it the file
 * is refused with TOO_LARGE, and never truncated.
 */
export function extractOfficeText(
  bytes: Uint8Array,
  mediaType: OfficeMediaType,
  maxBytes: number,
): OfficeText {
  // An OLE compound file is what Office writes when a file is password protected.
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    )
  )
    return { ok: false, code: 'ENCRYPTED_DOCUMENT' };
  try {
    const zip = openZip(bytes);
    const out = new TextOutput(maxBytes);
    const main = mainPart(zip, mediaType);
    if (mediaType === DOCX_MEDIA_TYPE) wordText(zip, main, out);
    else if (mediaType === PPTX_MEDIA_TYPE) slideText(zip, main, out);
    else sheetText(zip, main, out);
    const text = out.finish();
    return text ? { ok: true, text } : { ok: false, code: 'EMPTY_DOCUMENT' };
  } catch (error) {
    if (error instanceof ZipRefused || error instanceof XmlRefused || error instanceof OutputFull)
      return { ok: false, code: error.code };
    return { ok: false, code: 'MALFORMED_DOCUMENT' };
  }
}

class OutputFull extends Error {
  readonly code = 'TOO_LARGE' as const;
}

/** Collects text, counting UTF-8 bytes as it goes, so an expanding file stops at the ceiling. */
class TextOutput {
  private parts: string[] = [];
  private bytes = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(text: string) {
    if (!text) return;
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > this.max) throw new OutputFull('TOO_LARGE');
    this.parts.push(text);
  }
  finish() {
    return this.parts
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

const malformed = () => new XmlRefused('MALFORMED_DOCUMENT');

function readXml(zip: ZipArchive, name: string): string | null {
  const bytes = zip.read(name);
  if (!bytes) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Office writes UTF-8. UTF-16 parts exist in theory and are refused rather than guessed at.
    throw malformed();
  }
}

type Relationship = { id: string; type: string; target: string };

/** Internal relationships of a part, resolved to archive names. External ones are dropped, unread. */
function relationships(zip: ZipArchive, part: string): readonly Relationship[] {
  const slash = part.lastIndexOf('/');
  const directory = slash < 0 ? '' : part.slice(0, slash + 1);
  const xml = readXml(zip, `${directory}_rels/${part.slice(slash + 1)}.rels`);
  if (xml === null) return [];
  const found: Relationship[] = [];
  walkXml(xml, {
    open(name, attribute) {
      if (localName(name) !== 'Relationship') return;
      if ((attribute('TargetMode') ?? '').toLowerCase() === 'external') return;
      const id = attribute('Id'),
        type = attribute('Type'),
        target = attribute('Target');
      if (!id || !type || !target) return;
      const resolved = resolvePart(directory, target);
      if (resolved) found.push({ id, type, target: resolved });
    },
  });
  return found;
}

/** A target inside the package, or null for anything that escapes it or names a scheme. */
function resolvePart(directory: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.includes('\\') || target.includes('?'))
    return null;
  let path: string;
  try {
    path = decodeURIComponent(target.split('#')[0] ?? '');
  } catch {
    return null;
  }
  const segments = (path.startsWith('/') ? path.slice(1) : directory + path).split('/');
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!resolved.length) return null;
      resolved.pop();
    } else resolved.push(segment);
  }
  return resolved.length ? resolved.join('/') : null;
}

function contentTypeOf(zip: ZipArchive, part: string): string | null {
  const xml = readXml(zip, '[Content_Types].xml');
  if (xml === null) throw malformed();
  let override: string | null = null;
  let byExtension: string | null = null;
  const extension = part.slice(part.lastIndexOf('.') + 1).toLowerCase();
  walkXml(xml, {
    open(name, attribute) {
      const local = localName(name);
      if (local === 'Override' && (attribute('PartName') ?? '').replace(/^\//, '') === part)
        override = attribute('ContentType') ?? null;
      if (local === 'Default' && (attribute('Extension') ?? '').toLowerCase() === extension)
        byExtension = attribute('ContentType') ?? null;
    },
  });
  return override ?? byExtension;
}

/** The part the package's own relationships name as its document, checked against its declared type. */
function mainPart(zip: ZipArchive, mediaType: OfficeMediaType): string {
  const main = relationships(zip, '').find((rel) => OFFICE_DOCUMENT_REL.test(rel.type))?.target;
  if (!main || !zip.has(main)) throw malformed();
  const declared = contentTypeOf(zip, main);
  if (!declared || !MAIN_TYPES[mediaType].includes(declared)) throw malformed();
  return main;
}

function wordText(zip: ZipArchive, main: string, out: TextOutput) {
  wordPart(readXml(zip, main) ?? '', out);
  // Footnotes and endnotes are part of what an author wrote. Headers, footers, comments and tracked
  // deletions are not read, and field instructions (which hold link targets) are skipped below.
  for (const rel of relationships(zip, main)) {
    if (/\/(footnotes|endnotes)$/.test(rel.type)) {
      const xml = readXml(zip, rel.target);
      if (xml !== null) {
        out.push('\n\n');
        wordPart(xml, out);
      }
    }
  }
}

function wordPart(xml: string, out: TextOutput) {
  let inText = 0;
  // Word writes a text box twice, as DrawingML in mc:Choice and VML in mc:Fallback. Read it once.
  let fallback = 0;
  walkXml(xml, {
    open(name, _attribute, selfClosing) {
      if (name === 'mc:Fallback' && !selfClosing) fallback += 1;
      if (fallback) return;
      const local = localName(name);
      if (local === 't' && !selfClosing) inText += 1;
      else if (local === 'tab') out.push('\t');
      else if (local === 'br' || local === 'cr') out.push('\n');
    },
    close(name) {
      if (name === 'mc:Fallback') {
        fallback -= 1;
        return;
      }
      if (fallback) return;
      const local = localName(name);
      if (local === 't' && inText) inText -= 1;
      else if (local === 'p') out.push('\n');
      else if (local === 'tc') out.push('\t');
    },
    text(text) {
      if (inText && !fallback) out.push(text);
    },
  });
}

function slideText(zip: ZipArchive, main: string, out: TextOutput) {
  const rels = relationships(zip, main);
  const order: string[] = [];
  walkXml(readXml(zip, main) ?? '', {
    open(name, attribute) {
      if (localName(name) !== 'sldId') return;
      const id = attribute('r:id');
      const slide = rels.find((rel) => rel.id === id && /\/slide$/.test(rel.type));
      if (slide && !order.includes(slide.target)) order.push(slide.target);
    },
  });
  if (order.length > MAX_OFFICE_PARTS) throw new OutputFull('TOO_LARGE');
  for (const [index, slide] of order.entries()) {
    const xml = readXml(zip, slide);
    if (xml === null) continue;
    if (index) out.push('\n\n');
    drawingText(xml, out);
  }
}

/** DrawingML: `a:t` runs, a paragraph break at each `a:p`, and a line break at `a:br`. */
function drawingText(xml: string, out: TextOutput) {
  let inText = 0;
  walkXml(xml, {
    open(name, _attribute, selfClosing) {
      if (name === 'a:t' && !selfClosing) inText += 1;
      else if (name === 'a:br') out.push('\n');
    },
    close(name) {
      if (name === 'a:t' && inText) inText -= 1;
      else if (name === 'a:p') out.push('\n');
    },
    text(text) {
      if (inText) out.push(text);
    },
  });
}

function sheetText(zip: ZipArchive, main: string, out: TextOutput) {
  const rels = relationships(zip, main);
  const shared: string[] = [];
  const sharedPart = rels.find((rel) => /\/sharedStrings$/.test(rel.type))?.target;
  if (sharedPart) {
    const xml = readXml(zip, sharedPart);
    if (xml !== null) {
      let current: string[] | null = null;
      let inText = 0;
      // Phonetic guides (`rPh`) repeat a string's reading, and are not part of its value.
      let phonetic = 0;
      walkXml(xml, {
        open(name, _attribute, selfClosing) {
          const local = localName(name);
          if (local === 'si' && !selfClosing) current = [];
          else if (local === 'si') shared.push('');
          else if (local === 'rPh' && !selfClosing) phonetic += 1;
          else if (local === 't' && !selfClosing) inText += 1;
        },
        close(name) {
          const local = localName(name);
          if (local === 'si' && current) {
            shared.push(current.join(''));
            current = null;
          } else if (local === 'rPh' && phonetic) phonetic -= 1;
          else if (local === 't' && inText) inText -= 1;
        },
        text(text) {
          if (inText && !phonetic && current) (current as string[]).push(text);
        },
      });
    }
  }
  const sheets: { name: string; part: string }[] = [];
  walkXml(readXml(zip, main) ?? '', {
    open(name, attribute) {
      if (localName(name) !== 'sheet') return;
      const id = attribute('r:id');
      const part = rels.find((rel) => rel.id === id && /\/worksheet$/.test(rel.type))?.target;
      if (part) sheets.push({ name: attribute('name') ?? '', part });
    },
  });
  if (sheets.length > MAX_OFFICE_PARTS) throw new OutputFull('TOO_LARGE');
  for (const [index, sheet] of sheets.entries()) {
    const xml = readXml(zip, sheet.part);
    if (xml === null) continue;
    if (index) out.push('\n\n');
    if (sheet.name) out.push(`${sheet.name}\n`);
    let type = '';
    let cellCount = 0;
    let inValue = 0;
    let inInline = 0;
    let value: string[] = [];
    walkXml(xml, {
      open(name, attribute, selfClosing) {
        const local = localName(name);
        if (local === 'c') {
          type = attribute('t') ?? 'n';
          value = [];
          if (selfClosing) value = [];
        } else if (local === 'v' && !selfClosing) inValue += 1;
        else if (local === 'is' && !selfClosing) inInline += 1;
        else if (local === 't' && inInline && !selfClosing) inValue += 1;
      },
      close(name) {
        const local = localName(name);
        if (local === 'v' || (local === 't' && inInline)) {
          if (inValue) inValue -= 1;
        } else if (local === 'is' && inInline) inInline -= 1;
        else if (local === 'c') {
          const raw = value.join('');
          let cell = raw;
          if (type === 's') {
            const index = Number(raw);
            if (!Number.isInteger(index) || index < 0 || index >= shared.length) throw malformed();
            cell = shared[index] ?? '';
          } else if (type === 'b') cell = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
          // Formulas (`f`) are never evaluated; a cell shows its cached value, as a reader would see.
          if (cell) {
            out.push(cellCount ? `\t${cell}` : cell);
            cellCount += 1;
          }
          value = [];
        } else if (local === 'row') {
          if (cellCount) out.push('\n');
          cellCount = 0;
        }
      },
      text(text) {
        if (inValue) value.push(text);
      },
    });
  }
}
