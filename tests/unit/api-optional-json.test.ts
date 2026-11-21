import { describe, expect, it, vi } from 'vitest';
import { addTrustedSignerSchema as schema } from '@ensemus/contracts/skills';
vi.mock('../../apps/web/node_modules/server-only/index.js', () => ({}));
const { readJson, readOptionalJson } = await import('../../apps/web/src/server/api');
const payload = { display_name: 'Generated', public_key_base64: 'A'.repeat(43) + '=' };
const request = (bytes: Uint8Array | null, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api', {
    method: 'POST',
    headers,
    ...(bytes === null
      ? {}
      : {
          body: new ReadableStream({
            start(controller) {
              if (bytes.length) controller.enqueue(bytes);
              controller.close();
            },
          }),
          duplex: 'half',
        }),
  } as RequestInit);
const encoded = (text: string) => new TextEncoder().encode(text);

describe('an optional JSON body through a real request stream', () => {
  it('accepts absent and empty streaming bodies while the required reader remains strict', async () => {
    expect(await readOptionalJson(request(null), schema)).toBeUndefined();
    expect(await readOptionalJson(request(new Uint8Array()), schema)).toBeUndefined();
    await expect(
      readJson(request(new Uint8Array(), { 'content-type': 'application/json' }), schema),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('counts bytes instead of trusting a zero declared length, and requires JSON for nonempty bodies', async () => {
    const bytes = encoded(JSON.stringify(payload));
    expect(
      await readOptionalJson(
        request(bytes, { 'content-type': 'application/json', 'content-length': '0' }),
        schema,
      ),
    ).toEqual(payload);
    await expect(readOptionalJson(request(bytes), schema)).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
    await expect(
      readOptionalJson(
        request(new Uint8Array(256 * 1024 + 1), {
          'content-type': 'application/json',
          'content-length': '0',
        }),
        schema,
      ),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
  it('retains schema and UTF-8 refusals', async () => {
    for (const bytes of [encoded('{"extra":true}'), new Uint8Array([255])])
      await expect(
        readOptionalJson(request(bytes, { 'content-type': 'application/json' }), schema),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
