// Text out of a PDF, with pdf.js (Apache-2.0), in the knowledge worker's parse thread only (ADR-029 D4
// addendum). Only the text layer is read: nothing is rendered, no script runs (pdf.js runs no document
// JavaScript without a scripting sandbox, which is never loaded here, and its 6.x build has no eval or
// Function constructor left to compile fonts with), no form is filled, attachments are never asked for,
// and nothing is fetched (no URL is given, and the only files read are pdf.js's own character maps and
// font metrics). A PDF with no text layer is reported as needing OCR, not guessed.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export type PdfText =
  | { ok: true; text: string }
  | {
      ok: false;
      code:
        'TOO_LARGE' | 'MALFORMED_DOCUMENT' | 'ENCRYPTED_DOCUMENT' | 'NEEDS_OCR' | 'PARSE_FAILED';
    };

/** Pages read from one PDF. A longer file is refused, rather than half-indexed. */
export const MAX_PDF_PAGES = 5_000;
/** Text items on one page. A page drawn from millions of fragments is refused, not slowly joined. */
export const MAX_PDF_ITEMS_PER_PAGE = 200_000;

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
const WORKER_MODULE = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
let loaded: Promise<PdfJs> | null = null;

/** Loads pdf.js once per thread, with its worker code in this same thread: no second thread, no URL. */
function pdfjs(): Promise<PdfJs> {
  loaded ??= (async () => {
    // pdf.js publishes no types for its worker module, which is only ever handed back to its own API.
    const worker: unknown = await import(WORKER_MODULE);
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })();
  return loaded;
}

/**
 * pdf.js's own data: packed character maps, which CJK fonts need to map glyphs to text, and the metrics of
 * the 14 standard fonts. Read from the installed package on disk, never fetched.
 */
function packageData(): { cMapUrl: string; cMapPacked: true; standardFontDataUrl: string } | null {
  try {
    const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    return {
      cMapUrl: join(root, 'cmaps') + '/',
      cMapPacked: true,
      standardFontDataUrl: join(root, 'standard_fonts') + '/',
    };
  } catch {
    return null;
  }
}

export async function extractPdfText(
  bytes: Uint8Array,
  limits: { maxBytes: number; maxPages?: number },
): Promise<PdfText> {
  const { maxBytes, maxPages = MAX_PDF_PAGES } = limits;
  if (!startsWithPdfHeader(bytes)) return { ok: false, code: 'MALFORMED_DOCUMENT' };
  const lib = await pdfjs();
  const data = packageData();
  const task = lib.getDocument({
    // pdf.js takes ownership of what it is given, so it gets a copy.
    data: Uint8Array.from(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    stopAtErrors: false,
    verbosity: 0,
    ...(data ?? {}),
  });
  let document: Awaited<typeof task.promise> | undefined;
  try {
    try {
      document = await task.promise;
    } catch (error) {
      const name = (error as { name?: unknown }).name;
      if (name === 'PasswordException') return { ok: false, code: 'ENCRYPTED_DOCUMENT' };
      if (name === 'InvalidPDFException') return { ok: false, code: 'MALFORMED_DOCUMENT' };
      return { ok: false, code: 'PARSE_FAILED' };
    }
    // An author may forbid copying text even when anyone can open the file. That choice is honoured:
    // indexing for search is copying, and is not the accessibility exception.
    const granted: Iterable<number> | null = await document.getPermissions();
    if (granted !== null && ![...granted].includes(lib.PermissionFlag.COPY))
      return { ok: false, code: 'ENCRYPTED_DOCUMENT' };
    if (document.numPages > maxPages) return { ok: false, code: 'TOO_LARGE' };
    const pages: string[] = [];
    let size = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent({ includeMarkedContent: false });
        if (content.items.length > MAX_PDF_ITEMS_PER_PAGE) return { ok: false, code: 'TOO_LARGE' };
        const parts: string[] = [];
        for (const item of content.items) {
          if (!('str' in item)) continue;
          parts.push(item.str);
          if (item.hasEOL) parts.push('\n');
        }
        const text = parts.join('');
        size += Buffer.byteLength(text) + 2;
        if (size > maxBytes) return { ok: false, code: 'TOO_LARGE' };
        pages.push(text);
      } finally {
        page.cleanup();
      }
    }
    const text = pages
      .map((page) => page.replace(/[ \t]+\n/g, '\n').trim())
      .filter(Boolean)
      .join('\n\n');
    // Pages with no text layer are images of text. Saying so is honest; inventing words is not.
    if (!text.trim())
      return { ok: false, code: document.numPages > 0 ? 'NEEDS_OCR' : 'MALFORMED_DOCUMENT' };
    return { ok: true, text };
  } catch {
    return { ok: false, code: 'PARSE_FAILED' };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** `%PDF-` within the first KiB, as readers allow. Anything else is not opened as a PDF at all. */
function startsWithPdfHeader(bytes: Uint8Array) {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}
