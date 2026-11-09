// A page that calls notFound() is answered by Next.js 16.4.5 with a real 404 whose document is an
// empty error shell, <html id="__next_error__"><head>...</head><body></body>, that only client
// JavaScript fills in. A browser without JavaScript is shown a blank page. Next.js offers no way for a
// page to keep that 404 and render its own markup, so the container entrypoint (start.mjs) wraps the
// HTTP server the standalone build starts, and for that exact shell, and nothing else, writes a
// <noscript> copy of the not-found page into its body. The status, every header but the length and
// encoding, and everything a browser running scripts sees stay as Next.js sent them. See
// docs/02-architecture/10-nextjs-application-and-authorization.md, "Not found without JavaScript".
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

/** How the error shell starts. React escapes `<` in text and Next.js in inline data, so it is markup. */
const ERROR_SHELL = /^\s*(?:<!doctype html>\s*)?<html id="__next_error__"/i;
/** The shell is a few kilobytes. Anything this large is passed on untouched, as it came. */
export const HOLD_LIMIT = 1024 * 1024;

/** The words of app/not-found.tsx, which a unit test holds to that file. */
export const NOT_FOUND_COPY = {
  title: 'Page not found',
  body: 'This page does not exist, or you do not have access to it.',
  home: 'Go to your home page',
};

// The error shell links no stylesheet, so the few rules it needs travel with it, in both themes.
const NO_SCRIPT_NOT_FOUND =
  '<noscript>' +
  '<style>' +
  ':root{color-scheme:light dark}' +
  'body{margin:0;background:#fff;color:#202020;' +
  'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}' +
  '.no-script-not-found{box-sizing:border-box;max-width:34rem;margin:12vh auto;padding:0 16px}' +
  '.no-script-not-found a{color:#2346b5}' +
  '@media (prefers-color-scheme:dark){body{background:#161615;color:#f0f0ec}' +
  '.no-script-not-found a{color:#9db4f5}}' +
  '</style>' +
  '<main class="no-script-not-found">' +
  '<p><a href="/">Ensemus</a></p>' +
  `<h1>${NOT_FOUND_COPY.title}</h1>` +
  `<p>${NOT_FOUND_COPY.body}</p>` +
  `<p><a href="/">${NOT_FOUND_COPY.home}</a></p>` +
  '</main>' +
  '</noscript>';

/**
 * The error shell with the not-found page written into it for browsers without JavaScript, or null
 * when this is any other document. With scripts on, a <noscript> is inert, and Next.js renders the
 * page into the document as before.
 * @param {string} html
 * @returns {string | null}
 */
export function withNoScriptNotFound(html) {
  const shell = ERROR_SHELL.exec(html);
  if (!shell) return null;
  const rest = html.slice(shell[0].length);
  const attributes = /^[^>]*>/.exec(rest);
  const body = /<body(?:\s[^>]*)?>/i.exec(rest);
  if (!attributes || !body) return null;
  const bodyEnd = body.index + body[0].length;
  // The shell names no language; the rest of the product says English (app/layout.tsx).
  const opening = /\slang=/i.test(attributes[0]) ? shell[0] : `${shell[0]} lang="en"`;
  return opening + rest.slice(0, bodyEnd) + NO_SCRIPT_NOT_FOUND + rest.slice(bodyEnd);
}

/**
 * The body as sent, before the content coding the compression middleware applied; null when the
 * coding is not one Next.js uses, the bytes do not decode, or they come to more than any shell.
 * @param {Buffer} body
 * @param {string} coding
 * @returns {Buffer | null}
 */
export function decodeBody(body, coding) {
  const limit = { maxOutputLength: HOLD_LIMIT };
  try {
    switch (coding.trim().toLowerCase()) {
      case '':
      case 'identity':
        return body.length > HOLD_LIMIT ? null : body;
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(body, limit);
      case 'deflate':
        return inflateSync(body, limit);
      case 'br':
        return brotliDecompressSync(body, limit);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** @param {unknown} chunk @param {unknown} encoding */
const toBuffer = (chunk, encoding) =>
  Buffer.isBuffer(chunk)
    ? chunk
    : typeof chunk === 'string'
      ? Buffer.from(chunk, /** @type {BufferEncoding} */ (encoding ?? 'utf8'))
      : Buffer.from(/** @type {Uint8Array} */ (chunk));

/**
 * Holds back a 404 HTML document until it has ended, then sends it on, with the not-found page
 * written in when it is the error shell. Every other response is passed straight through from its
 * first byte, so streaming pages and event streams are not held. Installed below the compression
 * middleware, so what it holds may be compressed; it is decoded, and the changed document is sent
 * uncompressed.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function holdNotFoundShell(req, res) {
  if (req.method === 'HEAD') return;
  const original = {
    writeHead: res.writeHead,
    write: res.write,
    end: res.end,
    flushHeaders: res.flushHeaders,
  };
  /** @type {'undecided' | 'hold' | 'pass'} */
  let mode = 'undecided';
  /** @type {unknown[]} */
  let head = [];
  /** @type {Buffer[]} */
  let held = [];
  let size = 0;

  const decide = () => {
    if (mode !== 'undecided') return;
    const type = String(res.getHeader('content-type') ?? '');
    mode =
      res.statusCode === 404 && /^text\/html\b/i.test(type) && !res.headersSent ? 'hold' : 'pass';
  };
  const writeHeadOnce = () => {
    original.writeHead.apply(res, head.length ? head : [res.statusCode]);
  };
  /** @param {unknown} chunk @param {unknown} encoding */
  const keep = (chunk, encoding) => {
    if (chunk === undefined || chunk === null) return;
    const bytes = toBuffer(chunk, encoding);
    held.push(bytes);
    size += bytes.length;
  };
  // Too large to be the shell: send what is held as it came, and pass the rest straight through.
  const spill = () => {
    mode = 'pass';
    writeHeadOnce();
    for (const bytes of held) original.write.call(res, bytes);
    held = [];
  };

  res.writeHead = /** @type {typeof res.writeHead} */ (
    function writeHead(/** @type {unknown[]} */ ...args) {
      if (mode === 'undecided') {
        // Headers passed here would be applied after any change made at the end, so only the plain
        // form, a status and perhaps a reason, is ever held.
        const plain =
          typeof args[0] === 'number' &&
          (args.length === 1 || (args.length === 2 && typeof args[1] === 'string'));
        if (plain) {
          res.statusCode = /** @type {number} */ (args[0]);
          decide();
        } else mode = 'pass';
        if (mode === 'hold') head = args;
      }
      if (mode === 'hold') return res;
      return original.writeHead.apply(res, /** @type {never} */ (args));
    }
  );

  res.flushHeaders = function flushHeaders() {
    decide();
    if (mode === 'hold') return;
    original.flushHeaders.call(res);
  };

  res.write = /** @type {typeof res.write} */ (
    function write(/** @type {unknown} */ chunk, /** @type {unknown} */ encoding, cb) {
      decide();
      if (mode !== 'hold') return original.write.apply(res, /** @type {never} */ (arguments));
      const callback = typeof encoding === 'function' ? encoding : cb;
      keep(chunk, typeof encoding === 'string' ? encoding : undefined);
      if (size > HOLD_LIMIT) spill();
      if (typeof callback === 'function') process.nextTick(callback);
      return true;
    }
  );

  res.end = /** @type {typeof res.end} */ (
    function end(/** @type {unknown} */ chunk, /** @type {unknown} */ encoding, cb) {
      decide();
      if (mode !== 'hold') return original.end.apply(res, /** @type {never} */ (arguments));
      let callback = cb;
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      keep(chunk, typeof encoding === 'string' ? encoding : undefined);
      mode = 'pass';
      const body = Buffer.concat(held);
      held = [];
      const coding = String(res.getHeader('content-encoding') ?? 'identity');
      const decoded = decodeBody(body, coding);
      const changed = decoded ? withNoScriptNotFound(decoded.toString('utf8')) : null;
      if (changed === null) {
        writeHeadOnce();
        return original.end.call(res, body, callback);
      }
      const out = Buffer.from(changed, 'utf8');
      res.removeHeader('content-encoding');
      res.removeHeader('etag');
      res.setHeader('content-length', out.length);
      writeHeadOnce();
      return original.end.call(res, out, callback);
    }
  );
}

const INSTALLED = Symbol.for('ensemus.noScriptNotFound');

/**
 * Wraps every request listener given to `http.createServer` from now on. The standalone server
 * Next.js builds creates its one server with a listener, so call this before importing it.
 * @param {typeof import('node:http')} http
 */
export function installNoScriptNotFound(http) {
  const create = /** @type {typeof http.createServer & { [INSTALLED]?: true }} */ (
    http.createServer
  );
  if (create[INSTALLED]) return;
  const wrapped = /** @type {typeof http.createServer & { [INSTALLED]?: true }} */ (
    function createServer(/** @type {unknown[]} */ ...args) {
      const at = args.findIndex((arg) => typeof arg === 'function');
      if (at >= 0) {
        const listener = /** @type {import('node:http').RequestListener} */ (args[at]);
        args[at] = function request(
          /** @type {import('node:http').IncomingMessage} */ req,
          /** @type {import('node:http').ServerResponse} */ res,
        ) {
          holdNotFoundShell(req, res);
          return listener.call(this, req, res);
        };
      }
      return create.apply(http, /** @type {never} */ (args));
    }
  );
  wrapped[INSTALLED] = true;
  http.createServer = wrapped;
}
