// Next.js 16.4.5 drops Content-Length from every Route Handler response and sends the body chunked: see
// FORBIDDEN_HEADERS in next/dist/server/send-response.js, which skips content-length, content-encoding
// and transfer-encoding whatever the route set, and pipeToNodeResponse in next/dist/server/pipe-readable.js,
// which flushes the headers before the first byte. So a download whose exact length is known also states
// it in DECLARED_LENGTH_HEADER, which Next.js passes on like any other header. The proxy
// (infrastructure/compose/proxy/Caddyfile) sends that value to the client as Content-Length, and never
// passes the header itself on. Only the app can set it: it is a header of the app's response, which no
// client writes. A body that turns out longer or shorter than declared breaks the download instead of
// arriving as a whole-looking file of another length.

/** Read by the proxy from the app's response only, and removed before the response leaves. */
export const DECLARED_LENGTH_HEADER = 'X-Ensemus-Body-Length';

/** The headers that state a body's exact length in bytes, for the app and for the proxy in front of it. */
export function declaredLength(bytes: number): Record<string, string> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError('A declared body length is a whole number of bytes.');
  }
  const value = String(bytes);
  return { 'Content-Length': value, [DECLARED_LENGTH_HEADER]: value };
}
