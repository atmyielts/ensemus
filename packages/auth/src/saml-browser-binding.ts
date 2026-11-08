// Browser proof is separate from a SAML signature/request ID. The pinned ACS deliberately skips
// its normal state-cookie check, so a valid assertion alone must never select another browser's user.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';

export const SAML_BROWSER_COOKIE = '__Host-ensemus-saml-browser';
export const SAML_BROWSER_TTL_SECONDS = 300;
export const SAML_BROWSER_PREFIX = 'ensemus-saml-browser:v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export const samlHash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export type SamlBrowserIntent = {
  version: 1;
  mode: 'signin';
  phase: 'prepared' | 'consumed';
  requestId: string;
  relaySha256: string;
  providerId: string;
  issuer: string;
  domain: string;
  boundary: string;
  rawConfigSha256: string;
  browserProofSha256: string;
};
export function samlIntentBinding(intent: SamlBrowserIntent): string {
  return samlHash(
    JSON.stringify([
      intent.version,
      intent.mode,
      intent.requestId,
      intent.relaySha256,
      intent.providerId,
      intent.issuer,
      intent.domain,
      intent.boundary,
      intent.rawConfigSha256,
      intent.browserProofSha256,
    ]),
  );
}
/** Parse only a native-generated, bounded AuthnRequest. This never accepts an assertion. */
export function nativeSamlRedirect(
  value: unknown,
): { url: string; requestId: string; relaySha256: string } | null {
  try {
    if (typeof value !== 'string' || value.length > 196608) return null;
    const url = new URL(value),
      requests = url.searchParams.getAll('SAMLRequest'),
      relays = url.searchParams.getAll('RelayState');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      requests.length !== 1 ||
      relays.length !== 1
    )
      return null;
    const encoded = requests[0]!,
      relay = relays[0]!;
    if (
      !encoded ||
      encoded.length > 131072 ||
      !relay ||
      relay.length > 8192 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      return null;
    const xml = inflateRawSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 65536 }).toString(
      'utf8',
    );
    if (xml.includes('\0') || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) return null;
    const document = new DOMParser({
        locator: false,
        onError: () => {
          throw new Error('NATIVE_SAML_REQUEST_INVALID');
        },
      }).parseFromString(xml, 'application/xml'),
      root = document.documentElement;
    if (
      document.doctype ||
      !root ||
      root.localName !== 'AuthnRequest' ||
      root.namespaceURI !== 'urn:oasis:names:tc:SAML:2.0:protocol'
    )
      return null;
    const requestId = root.getAttribute('ID');
    if (!requestId || !/^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/.test(requestId)) return null;
    return { url: url.href, requestId, relaySha256: samlHash(relay) };
  } catch {
    return null;
  }
}
export function parseSamlIntent(value: string): SamlBrowserIntent | null {
  try {
    if (value.length > 16384) return null;
    const row = JSON.parse(value) as SamlBrowserIntent;
    if (
      !row ||
      row.version !== 1 ||
      row.mode !== 'signin' ||
      !['prepared', 'consumed'].includes(row.phase) ||
      Object.keys(row).some(
        (key) =>
          ![
            'version',
            'mode',
            'phase',
            'requestId',
            'relaySha256',
            'providerId',
            'issuer',
            'domain',
            'boundary',
            'rawConfigSha256',
            'browserProofSha256',
          ].includes(key),
      ) ||
      typeof row.requestId !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/.test(row.requestId) ||
      typeof row.providerId !== 'string' ||
      !row.providerId ||
      row.providerId.length > 200 ||
      typeof row.issuer !== 'string' ||
      !row.issuer ||
      row.issuer.length > 2048 ||
      typeof row.domain !== 'string' ||
      !row.domain ||
      row.domain.length > 253 ||
      ![row.relaySha256, row.boundary, row.rawConfigSha256, row.browserProofSha256].every(
        (item) => typeof item === 'string' && HASH.test(item),
      )
    )
      return null;
    return row;
  } catch {
    return null;
  }
}
type BrowserProof = { version: 1; mode: 'signin'; id: string; binding: string; proof: string };
const signature = (key: string, payload: string) =>
  createHmac('sha256', key).update(`ensemus-saml-browser:v1:${payload}`).digest('base64url');
export function issueSamlBrowserProof(
  key: string,
  id: string,
  intent: SamlBrowserIntent,
  proof = randomBytes(32).toString('base64url'),
): { value: string; proof: string } {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      mode: intent.mode,
      id,
      binding: samlIntentBinding(intent),
      proof,
    } satisfies BrowserProof),
  ).toString('base64url');
  return { value: `${payload}.${signature(key, payload)}`, proof };
}
export function readSamlBrowserProof(key: string, cookie: string | undefined): BrowserProof | null {
  try {
    if (!cookie || cookie.length > 2048) return null;
    const pieces = cookie.split('.');
    if (
      pieces.length !== 2 ||
      !/^[A-Za-z0-9_-]+$/.test(pieces[0]!) ||
      !/^[A-Za-z0-9_-]{43}$/.test(pieces[1]!)
    )
      return null;
    const expected = Buffer.from(signature(key, pieces[0]!)),
      supplied = Buffer.from(pieces[1]!);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const row = JSON.parse(Buffer.from(pieces[0]!, 'base64url').toString('utf8')) as BrowserProof;
    return Object.keys(row).every((key) =>
      ['version', 'mode', 'id', 'binding', 'proof'].includes(key),
    ) &&
      row.version === 1 &&
      row.mode === 'signin' &&
      UUID.test(row.id) &&
      HASH.test(row.binding) &&
      /^[A-Za-z0-9_-]{43}$/.test(row.proof)
      ? row
      : null;
  } catch {
    return null;
  }
}
export function matchesSamlBrowserProof(
  proof: BrowserProof,
  intent: SamlBrowserIntent,
  id: string,
): boolean {
  return (
    proof.id === id &&
    proof.mode === intent.mode &&
    proof.binding === samlIntentBinding(intent) &&
    samlHash(proof.proof) === intent.browserProofSha256
  );
}
export function samlBrowserCookie(value: string, maxAge = SAML_BROWSER_TTL_SECONDS): string {
  return `${SAML_BROWSER_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=None`;
}
export function samlBrowserCookieValue(header: string | null): string | undefined {
  if (!header || header.length > 16384) return undefined;
  const values = header
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${SAML_BROWSER_COOKIE}=`));
  return values.length === 1 ? values[0]!.slice(SAML_BROWSER_COOKIE.length + 1) : undefined;
}
