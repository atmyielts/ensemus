// F13 (review round 6): a page's notFound() in Next.js 16.4.5 is a 404 whose document is an empty
// error shell that only client JavaScript fills in, so a browser without JavaScript showed a blank
// page. The container entrypoint writes a <noscript> copy of the not-found page into that one
// document (apps/web/no-script-not-found.mjs). These hold what it changes, and everything it must
// leave alone, over a real HTTP server with the compression middleware Next.js itself uses.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOLD_LIMIT,
  NOT_FOUND_COPY,
  decodeBody,
  installNoScriptNotFound,
  withNoScriptNotFound,
} from '../../apps/web/no-script-not-found.mjs';

const nextRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
type Middleware = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
const compression = nextRequire('next/dist/compiled/compression') as () => Middleware;

// What Next.js 16.4.5 sends for a page that calls notFound(), trimmed to its shape.
const SHELL =
  '<!DOCTYPE html><html id="__next_error__"><head><meta charSet="utf-8"/>' +
  '<meta name="robots" content="noindex"/><title>Not found | Ensemus</title></head>' +
  '<body><div hidden=""><!--$--><!--/$--></div><script>self.__next_f=[]</script></body></html>';
const PAGE =
  '<!DOCTYPE html><html lang="en"><head><title>Ensemus</title></head>' +
  '<body><main><h1>Page not found</h1></main></body></html>';

describe('the document it changes', () => {
  it('writes the not-found page into the error shell, for browsers without JavaScript only', () => {
    const changed = withNoScriptNotFound(SHELL);
    expect(changed).not.toBeNull();
    const html = changed ?? '';
    expect(html.startsWith('<!DOCTYPE html><html id="__next_error__" lang="en"><head>')).toBe(true);
    // Straight after <body>, inside <noscript>, so a browser running scripts ignores it.
    const body = html.indexOf('<body>') + '<body>'.length;
    expect(html.slice(body).startsWith('<noscript>')).toBe(true);
    const fallback = html.slice(body, html.indexOf('</noscript>') + '</noscript>'.length);
    expect(fallback).toContain(`<h1>${NOT_FOUND_COPY.title}</h1>`);
    expect(fallback).toContain(NOT_FOUND_COPY.body);
    expect(fallback).toContain(`<a href="/">${NOT_FOUND_COPY.home}</a>`);
    expect(fallback).not.toContain('<script');
    // Nothing of the shell is lost: removing what was added gives it back exactly.
    expect(html.replace(fallback, '').replace(' lang="en"', '')).toBe(SHELL);
  });

  it('says the same as the not-found page itself', () => {
    const page = readFileSync(
      new URL('../../apps/web/src/app/not-found.tsx', import.meta.url),
      'utf8',
    );
    for (const words of Object.values(NOT_FOUND_COPY)) expect(page).toContain(words);
  });

  it('keeps a language the shell already names', () => {
    const named = SHELL.replace(
      '<html id="__next_error__">',
      '<html id="__next_error__" lang="cy">',
    );
    const html = withNoScriptNotFound(named) ?? '';
    expect(html).toContain('<html id="__next_error__" lang="cy">');
    expect(html).not.toContain('lang="en"');
  });

  it('leaves every other document alone', () => {
    expect(withNoScriptNotFound(PAGE)).toBeNull();
    // The marker as text a page shows, or inside data, is not the document element.
    const quoted = PAGE.replace(
      '<h1>Page not found</h1>',
      '<p>&lt;html id=&quot;__next_error__&quot;&gt;</p><script>"<html id=\\"__next_error__\\""</script>',
    );
    expect(withNoScriptNotFound(quoted)).toBeNull();
    expect(withNoScriptNotFound(SHELL.replace('<body>', ''))).toBeNull();
    expect(withNoScriptNotFound('')).toBeNull();
  });

  it('decodes only the codings Next.js applies, and refuses bytes that do not decode', () => {
    const plain = Buffer.from('x');
    expect(decodeBody(plain, 'identity')).toBe(plain);
    expect(decodeBody(Buffer.from('not gzip'), 'gzip')).toBeNull();
    expect(decodeBody(plain, 'compress')).toBeNull();
    expect(decodeBody(Buffer.alloc(HOLD_LIMIT + 1), 'identity')).toBeNull();
    expect(decodeBody(gzipSync(Buffer.alloc(HOLD_LIMIT + 1)), 'gzip')).toBeNull();
    expect(decodeBody(gzipSync(plain), 'gzip')?.toString()).toBe('x');
  });
});

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A server made the way the standalone build makes one, after the entrypoint has installed this. */
async function serve(handler: Handler) {
  const fake = { createServer: http.createServer } as unknown as typeof http;
  installNoScriptNotFound(fake);
  installNoScriptNotFound(fake); // a second install wraps nothing twice
  const compress = compression();
  const server = fake.createServer((req, res) => {
    // Next.js's router server applies compression before it renders (router-server.js).
    compress(req, res, () => undefined);
    void handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function request(
  port: number,
  options: { method?: string; encoding?: string; onFirstByte?: () => void } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/o/org/assistants/run',
        method: options.method ?? 'GET',
        headers: options.encoding ? { 'accept-encoding': options.encoding } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          if (!chunks.length) options.onFirstByte?.();
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const decoded = (reply: Reply) =>
  (reply.headers['content-encoding'] === 'gzip' ? gunzipSync(reply.body) : reply.body).toString();

/** Streams a document as Next.js does: headers flushed, then chunks, each flushed, then the end. */
function nextLike(status: number, type: string, html: string): Handler {
  return (_req, res) => {
    res.statusCode = status;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, max-age=0, must-revalidate');
    res.setHeader('X-Frame-Options', 'DENY');
    res.flushHeaders();
    const half = Math.floor(html.length / 2);
    for (const part of [html.slice(0, half), html.slice(half)]) {
      res.write(part);
      (res as http.ServerResponse & { flush?: () => void }).flush?.();
    }
    res.end();
  };
}

describe('over HTTP, behind the compression Next.js uses', () => {
  it('sends the error shell with the not-found page, at the same 404, compressed or not', async () => {
    const port = await serve(nextLike(404, 'text/html; charset=utf-8', SHELL));
    for (const encoding of ['gzip', 'gzip, deflate, br', undefined]) {
      const reply = await request(port, encoding ? { encoding } : {});
      expect(reply.status).toBe(404);
      // Sent as it now is, so it says so: no coding, and its true length.
      expect(reply.headers['content-encoding']).toBeUndefined();
      expect(Number(reply.headers['content-length'])).toBe(reply.body.length);
      expect(reply.headers['x-frame-options']).toBe('DENY');
      expect(reply.headers['cache-control']).toContain('no-store');
      expect(reply.body.toString()).toBe(withNoScriptNotFound(SHELL));
    }
  });

  it('passes any other 404 page on exactly as it came, still compressed', async () => {
    const port = await serve(nextLike(404, 'text/html; charset=utf-8', PAGE));
    const reply = await request(port, { encoding: 'gzip' });
    expect(reply.status).toBe(404);
    expect(reply.headers['content-encoding']).toBe('gzip');
    expect(decoded(reply)).toBe(PAGE);
  });

  it('does not touch a shell that is not a 404, or a 404 that is not HTML', async () => {
    for (const [status, type, body] of [
      [500, 'text/html; charset=utf-8', SHELL],
      [200, 'text/html; charset=utf-8', SHELL],
      [404, 'application/json', '{"code":"NOT_FOUND"}'],
      [404, 'text/x-component', SHELL],
    ] as const) {
      const port = await serve(nextLike(status, type, body));
      const reply = await request(port, { encoding: 'gzip' });
      expect(reply.status).toBe(status);
      expect(decoded(reply)).toBe(body);
    }
  });

  it('does not hold back a page that is still streaming', async () => {
    let firstByte!: () => void;
    const arrived = new Promise<void>((resolve) => (firstByte = resolve));
    const port = await serve(async (_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.flushHeaders();
      res.write('<!DOCTYPE html><html lang="en"><body>');
      (res as http.ServerResponse & { flush?: () => void }).flush?.();
      // The rest is only sent once the client has the start: held, this would never end.
      await arrived;
      res.end('</body></html>');
    });
    const reply = await request(port, { encoding: 'gzip', onFirstByte: firstByte });
    expect(decoded(reply)).toBe('<!DOCTYPE html><html lang="en"><body></body></html>');
  });

  it('passes an error shell too large to be one on untouched, and leaves HEAD alone', async () => {
    const huge = SHELL.replace('</body>', `<p>${'x'.repeat(HOLD_LIMIT)}</p></body>`);
    const port = await serve(nextLike(404, 'text/html; charset=utf-8', huge));
    // Compressed, it is held but decodes to more than any shell; plain, it is let go once too large.
    for (const encoding of ['gzip', undefined]) {
      const reply = await request(port, encoding ? { encoding } : {});
      expect(reply.status).toBe(404);
      const text = decoded(reply);
      expect(text.length).toBe(huge.length);
      expect(text === huge).toBe(true);
    }

    const small = await serve(nextLike(404, 'text/html; charset=utf-8', SHELL));
    const head = await request(small, { method: 'HEAD' });
    expect(head.status).toBe(404);
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBeUndefined();
  });
});
