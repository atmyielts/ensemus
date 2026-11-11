// AWS Signature Version 4, checked the way AWS documents it, for the fake model server's Bedrock route. It is
// written from the published algorithm and not from the signer the adapter uses, and tests/contract proves it
// against AWS's own worked examples, so a request the fake accepts was signed correctly and not merely in the
// same way as this file. Tests only: nothing here is a production verifier.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { URLSearchParams } from 'node:url';

const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

/** RFC 3986 encoding, which leaves only unreserved characters bare. */
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Every service but S3 encodes each path segment twice. The path on the wire is already encoded once, so it
 * is encoded once more here, segment by segment.
 */
export function canonicalUri(wirePath) {
  const path = wirePath.replace(/\/+/g, '/');
  return path
    .split('/')
    .map((segment) => encode(segment))
    .join('/');
}

export function canonicalQuery(search) {
  const params = new URLSearchParams(search);
  return [...params]
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([k1, v1], [k2, v2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export function signingKey(secretAccessKey, date, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
}

/**
 * The signature for a request, from its parts. `headers` maps lowercase names to values, and must hold every
 * header in `signedHeaders`.
 */
export function signatureFor({
  method,
  path,
  search = '',
  headers,
  signedHeaders,
  body,
  secretAccessKey,
  datetime,
  region,
  service,
}) {
  const canonicalHeaders = signedHeaders
    .map(
      (name) =>
        `${name}:${String(headers[name] ?? '')
          .trim()
          .replace(/\s+/g, ' ')}\n`,
    )
    .join('');
  const payloadHash = headers['x-amz-content-sha256'] ?? sha256Hex(body ?? '');
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(path),
    canonicalQuery(search),
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');
  const date = datetime.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, datetime, scope, sha256Hex(canonicalRequest)].join('\n');
  return createHmac('sha256', signingKey(secretAccessKey, date, region, service))
    .update(stringToSign)
    .digest('hex');
}

const AUTHORIZATION =
  /^AWS4-HMAC-SHA256 Credential=([A-Z0-9]+)\/(\d{8})\/([a-z0-9-]+)\/([a-z0-9-]+)\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/;

/**
 * Whether a request is signed by a key in `secrets` (access key ID to secret), for this region and service,
 * within five minutes of `now`. Answers a reason code, never anything from the request.
 */
export function verifySigV4(request, { secrets, region, service, now = new Date() }) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return 'absent';
  const match = AUTHORIZATION.exec(header);
  if (!match) return 'malformed';
  const [, accessKeyId, date, signedRegion, signedService, signedList, signature] = match;
  const secret = secrets.get(accessKeyId);
  if (!secret) return 'unknown_key';
  if (signedRegion !== region || signedService !== service) return 'wrong_scope';
  const datetime = request.headers['x-amz-date'];
  if (
    typeof datetime !== 'string' ||
    !/^\d{8}T\d{6}Z$/.test(datetime) ||
    !datetime.startsWith(date)
  ) {
    return 'bad_date';
  }
  const signedAt = Date.UTC(
    Number(datetime.slice(0, 4)),
    Number(datetime.slice(4, 6)) - 1,
    Number(datetime.slice(6, 8)),
    Number(datetime.slice(9, 11)),
    Number(datetime.slice(11, 13)),
    Number(datetime.slice(13, 15)),
  );
  if (Math.abs(now.getTime() - signedAt) > 5 * 60_000) return 'stale';
  const signedHeaders = signedList.split(';');
  if (!signedHeaders.includes('host') || !signedHeaders.includes('x-amz-date')) {
    return 'unsigned_header';
  }
  if (request.headers['x-amz-security-token'] && !signedHeaders.includes('x-amz-security-token')) {
    return 'unsigned_header';
  }
  const [path, search = ''] = request.path.split('?');
  const expected = signatureFor({
    method: request.method,
    path,
    search,
    headers: request.headers,
    signedHeaders,
    body: request.raw,
    secretAccessKey: secret,
    datetime,
    region,
    service,
  });
  const ok = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  return ok ? 'valid' : 'bad_signature';
}
