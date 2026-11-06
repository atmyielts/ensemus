// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md. Turns untrusted bytes into plain
// text. Pure and synchronous, so the knowledge worker can run it in a worker thread with a memory limit
// and a deadline. Refuses what it does not recognize, and never truncates to fit.
import type { KnowledgeCode } from '@ensemus/domain/knowledge';
import { INGESTIBLE_MEDIA_TYPES, MAX_DOCUMENT_BYTES } from '@ensemus/domain/knowledge';

export const PARSER_VERSION = 'v1';

export type ParsedDocument =
  | { ok: true; text: string; parserVersion: string }
  | {
      ok: false;
      code: Extract<
        KnowledgeCode,
        'UNSUPPORTED_FORMAT' | 'EMPTY_DOCUMENT' | 'UNREADABLE_ENCODING' | 'TOO_LARGE'
      >;
    };

/**
 * Decodes and extracts text from one of `INGESTIBLE_MEDIA_TYPES`. HTML keeps its visible text only, with
 * scripts, styles and comments gone, which is not a sanitizer: the output is never rendered as HTML.
 */
export function parseDocument(bytes: Uint8Array, mediaType: string): ParsedDocument {
  if (!(INGESTIBLE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    return { ok: false, code: 'UNSUPPORTED_FORMAT' };
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return { ok: false, code: 'TOO_LARGE' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // PostgreSQL text cannot hold NUL. Refuse rather than silently changing the source.
    if (text.includes('\0')) return { ok: false, code: 'UNREADABLE_ENCODING' };
    if (mediaType === 'application/json') text = JSON.stringify(JSON.parse(text), null, 2);
    if (mediaType === 'text/html') text = htmlText(text);
  } catch {
    return { ok: false, code: 'UNREADABLE_ENCODING' };
  }
  text = text.replace(/\r\n?/g, '\n').trim();
  if (!text) return { ok: false, code: 'EMPTY_DOCUMENT' };
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) return { ok: false, code: 'TOO_LARGE' };
  return { ok: true, text, parserVersion: PARSER_VERSION };
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

// A bounded scan, rather than nested regular expressions over a stranger's entire file. This is text
// extraction, not HTML sanitization: the result is never used as markup.
function htmlText(html: string): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let position = 0;
  while (position < html.length) {
    const tag = html.indexOf('<', position);
    if (tag < 0) {
      parts.push(html.slice(position));
      break;
    }
    parts.push(html.slice(position, tag));
    if (html.startsWith('<!--', tag)) {
      const end = html.indexOf('-->', tag + 4);
      position = end < 0 ? html.length : end + 3;
      parts.push(' ');
      continue;
    }
    let end = tag + 1;
    let quote = '';
    for (; end < html.length; end += 1) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === html.length) break;
    const name = /^\s*\/?\s*([a-z0-9]+)/i.exec(html.slice(tag + 1, end))?.[1]?.toLowerCase();
    position = end + 1;
    if ((name === 'script' || name === 'style') && !/^\s*\//.test(html.slice(tag + 1, end))) {
      const close = lower.indexOf(`</${name}`, position);
      const closeEnd = close < 0 ? -1 : html.indexOf('>', close);
      position = closeEnd < 0 ? html.length : closeEnd + 1;
      parts.push(' ');
    } else if (name && /^(p|div|br|h[1-6]|li|tr|section|article|pre|blockquote)$/.test(name)) {
      parts.push('\n');
    }
  }
  return parts
    .join('')
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{1,12});/gi, (whole, entity: string) => {
      if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? whole;
      const value =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
        ? String.fromCodePoint(value)
        : '\uFFFD';
    })
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}
