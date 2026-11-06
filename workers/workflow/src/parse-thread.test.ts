import { describe, expect, it } from 'vitest';
import { createParseRunner } from './parse-thread';

describe('the isolated parser', () => {
  it('parses in a real worker and leaves the caller buffer intact', async () => {
    const bytes = Buffer.from('Thread-owned text');
    expect(await createParseRunner()(bytes, 'text/plain')).toEqual({
      ok: true,
      text: 'Thread-owned text',
      parserVersion: 'v1',
    });
    expect(bytes.toString()).toBe('Thread-owned text');
  });
  it('refuses unsupported formats in the worker', async () => {
    expect(await createParseRunner()(Buffer.from('bytes'), 'application/pdf')).toEqual({
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
    });
  });
  it('terminates a worker at its deadline and exposes only a code', async () => {
    await expect(
      createParseRunner({ deadlineMs: 1 })(Buffer.alloc(1024), 'text/plain'),
    ).rejects.toMatchObject({ code: 'PARSE_TIMEOUT', message: 'PARSE_TIMEOUT' });
  });
});
