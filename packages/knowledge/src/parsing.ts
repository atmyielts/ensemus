// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md. Turns untrusted bytes into plain
// text. Pure and synchronous, so the knowledge worker can run it in a worker thread with a memory limit
// and a deadline. Refuses what it does not recognize, and never truncates to fit.
import type { KnowledgeCode } from '@ensemus/domain/knowledge';

export const PARSER_VERSION = 'v1';

export type ParsedDocument =
  | { ok: true; text: string; parserVersion: string }
  | { ok: false; code: Extract<KnowledgeCode, 'UNSUPPORTED_FORMAT' | 'EMPTY_DOCUMENT' | 'UNREADABLE_ENCODING' | 'TOO_LARGE'> };

/**
 * Decodes and extracts text from one of `INGESTIBLE_MEDIA_TYPES`. HTML keeps its visible text only, with
 * scripts, styles and comments gone, which is not a sanitizer: the output is never rendered as HTML.
 */
export function parseDocument(_bytes: Uint8Array, _mediaType: string): ParsedDocument {
  throw new Error('NOT_IMPLEMENTED');
}
