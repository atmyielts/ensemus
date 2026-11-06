import { describe, it, expect } from 'vitest';
import {
  readBoundedBody,
  readKnowledgeUpload,
  uploadMediaType,
} from '../../apps/web/src/lib/knowledge-input';

describe('bounded knowledge upload input', () => {
  it('counts undeclared streamed bytes and cancels an oversized body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.enqueue(new Uint8Array([4, 5]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readBoundedBody(
        new Request('http://example.invalid', {
          method: 'POST',
          body,
          duplex: 'half',
        } as RequestInit),
        4,
      ),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  });
  it('preserves one-byte chunk order without relying on Content-Length', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const byte of [1, 2, 3, 4]) c.enqueue(new Uint8Array([byte]));
        c.close();
      },
    });
    expect(
      await readBoundedBody(
        new Request('http://example.invalid', {
          method: 'POST',
          body,
          duplex: 'half',
        } as RequestInit),
        4,
      ),
    ).toEqual(Buffer.from([1, 2, 3, 4]));
  });
  it('refuses duplicate metadata, invalid metadata, and unsupported binary types', async () => {
    const form = new FormData();
    form.set('file', new File(['text'], 'sample.txt', { type: 'text/plain' }));
    form.append('metadata', '{}');
    form.append('metadata', '{}');
    await expect(
      readKnowledgeUpload(new Request('http://example.invalid', { method: 'POST', body: form })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(() =>
      uploadMediaType(new File(['data'], 'sample.pdf', { type: 'application/pdf' })),
    ).toThrow();
  });
  it('accepts exact classified metadata and returns bytes, never a filename path', async () => {
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({ title: 'Generated source', classification: 'restricted', grants: [] }),
    );
    form.set('file', new File(['Generated words.'], '../sample.md'));
    expect(
      await readKnowledgeUpload(
        new Request('http://example.invalid', { method: 'POST', body: form }),
      ),
    ).toEqual({
      metadata: { title: 'Generated source', classification: 'restricted', grants: [] },
      mediaType: 'text/markdown',
      body: Buffer.from('Generated words.'),
    });
  });
});
