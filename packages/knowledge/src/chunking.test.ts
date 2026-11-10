import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chunkText, estimateTokens } from './chunking';

describe('deterministic chunking', () => {
  it('has no empty chunks, no fabricated text and stable hashes and UTF-16 offsets', () => {
    const text = 'First 😀 sentence. Another sentence.\n\n'.repeat(180);
    const chunks = chunkText(text, { targetTokens: 40, overlapTokens: 6 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunkText(text, { targetTokens: 40, overlapTokens: 6 })).toEqual(chunks);
    for (const [ordinal, chunk] of chunks.entries()) {
      expect(chunk.ordinal).toBe(ordinal);
      expect(chunk.text).toBe(text.slice(chunk.charStart, chunk.charEnd));
      expect(chunk.text.trim()).not.toBe('');
      expect(chunk.sha256).toBe(createHash('sha256').update(chunk.text).digest('hex'));
      expect(chunk.tokenEstimate).toBe(estimateTokens(chunk.text));
      expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(32768);
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    expect(chunks[0]?.charStart).toBe(0);
    expect(chunks.at(-1)?.charEnd).toBe(text.trimEnd().length);
  });
  it('bounds a huge line and makes progress with overlap', () => {
    const text = '😀'.repeat(25000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => Buffer.byteLength(c.text) <= 32768)).toBe(true);
    expect(chunks.at(-1)?.charEnd).toBe(text.length);
  });
  it('refuses impossible options and too many chunks rather than truncating', () => {
    expect(() => chunkText('text', { targetTokens: 1, overlapTokens: 1 })).toThrow();
    expect(() => chunkText('x'.repeat(100000), { targetTokens: 1, overlapTokens: 0 })).toThrow(
      'TOO_LARGE',
    );
    expect(chunkText('   ')).toEqual([]);
  });
});
