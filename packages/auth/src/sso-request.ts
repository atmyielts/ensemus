// Bound and reject XML declarations before the pinned verifier sees stranger-controlled assertion
// bytes. This is an input fence, never a substitute for signature/audience/request/replay validation.
import { createHash } from 'node:crypto';
import { DOMParser, type Element } from '@xmldom/xmldom';
export type SamlEnvelope = {
  issuer: string;
  subject: string;
  authenticatedAt: number | null;
  bodySha256: string;
  /** Untrusted correlation data; usable only after the native verifier accepted this exact body. */
  requestId?: string | null;
  relaySha256?: string | null;
};
const ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';
// ADR-031 D9: signed assertions use sha256. The pinned library applies its algorithm allow-list to
// the redirect binding's SigAlg parameter only, never to the algorithms an HTTP-POST XML signature
// names inside itself, so its verifier would accept an RSA-SHA1 signature or a SHA-1 digest.
const SIGNED_WITH: ReadonlyArray<readonly [string, string]> = [
  ['SignatureMethod', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'],
  ['DigestMethod', 'http://www.w3.org/2001/04/xmlenc#sha256'],
];
/** Every signature and digest method anywhere in the response, in any namespace, is sha256. */
function sha256Only(root: Element): boolean {
  for (const [localName, algorithm] of SIGNED_WITH) {
    const methods = root.getElementsByTagNameNS('*', localName);
    for (let index = 0; index < methods.length; index++)
      if (methods.item(index)?.getAttribute('Algorithm') !== algorithm) return false;
  }
  return true;
}
function children(parent: Element, namespace: string, localName: string): Element[] {
  const found: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling)
    if (node.nodeType === 1) {
      const child = node as Element;
      if (child.localName === localName) {
        if (child.namespaceURI !== namespace) throw new Error('SAML_ENVELOPE_INVALID');
        found.push(child);
      }
    }
  return found;
}
function envelope(xml: string, body: Buffer): SamlEnvelope | null {
  const document = new DOMParser({
      locator: false,
      onError: () => {
        throw new Error('SAML_ENVELOPE_INVALID');
      },
    }).parseFromString(xml, 'application/xml'),
    root = document.documentElement;
  if (
    document.doctype ||
    !root ||
    root.namespaceURI !== 'urn:oasis:names:tc:SAML:2.0:protocol' ||
    root.localName !== 'Response'
  )
    return null;
  if (
    root.getElementsByTagNameNS(ASSERTION, 'EncryptedAssertion').length ||
    root.getElementsByTagNameNS('http://www.w3.org/2001/04/xmlenc#', '*').length ||
    root.getElementsByTagNameNS('http://www.w3.org/2009/xmlenc11#', '*').length ||
    root.getElementsByTagNameNS(ASSERTION, 'Assertion').length !== 1 ||
    !sha256Only(root)
  )
    return null;
  const assertions = children(root, ASSERTION, 'Assertion');
  if (assertions.length !== 1) return null;
  const assertion = assertions[0]!;
  if (assertion.getElementsByTagNameNS(ASSERTION, 'AuthnStatement').length !== 1) return null;
  const issuers = children(assertion, ASSERTION, 'Issuer'),
    subjects = children(assertion, ASSERTION, 'Subject'),
    statements = children(assertion, ASSERTION, 'AuthnStatement');
  if (issuers.length !== 1 || subjects.length !== 1 || statements.length !== 1) return null;
  const names = children(subjects[0]!, ASSERTION, 'NameID');
  if (names.length !== 1) return null;
  const issuer = issuers[0]!.textContent ?? '',
    subject = names[0]!.textContent ?? '';
  if (!issuer || !subject || issuer.length > 2048 || subject.length > 2048) return null;
  const instant = statements[0]!.getAttribute('AuthnInstant');
  let authenticatedAt: number | null = null;
  if (instant) {
    const parsed = new Date(instant).getTime();
    if (!Number.isFinite(parsed) || parsed > Date.now() + 60000) return null;
    authenticatedAt = parsed;
  }
  return {
    issuer,
    subject,
    authenticatedAt,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    requestId: root.getAttribute('InResponseTo') || null,
  };
}
const refused = () =>
  Response.json(
    { code: 'SSO_REFUSED', message: 'Company sign-in could not be completed.' },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
export async function guardSamlRequest(
  request: Request,
): Promise<{ request: Request; envelope?: SamlEnvelope } | Response> {
  if (
    request.method !== 'POST' ||
    !/^\/api\/auth\/sso\/saml2\/sp\/acs\/[^/]+$/.test(new URL(request.url).pathname)
  )
    return { request };
  const reader = request.body?.getReader();
  if (!reader) return refused();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 320 * 1024) {
        await reader.cancel();
        return refused();
      }
      chunks.push(item.value);
    }
    const body = Buffer.concat(chunks),
      media = request.headers.get('content-type')?.split(';')[0]?.trim();
    let encoded: unknown, relay: unknown;
    if (media === 'application/x-www-form-urlencoded') {
      const fields = new URLSearchParams(body.toString('utf8'));
      if (fields.getAll('SAMLResponse').length !== 1 || fields.getAll('RelayState').length > 1)
        return refused();
      encoded = fields.get('SAMLResponse');
      relay = fields.get('RelayState');
    } else if (media === 'application/json') {
      const value = JSON.parse(body.toString('utf8')) as {
        SAMLResponse?: unknown;
        RelayState?: unknown;
      };
      encoded = value?.SAMLResponse;
      relay = value?.RelayState;
    } else return refused();
    if (
      typeof encoded !== 'string' ||
      encoded.length > 256 * 1024 ||
      (relay !== undefined && relay !== null && (typeof relay !== 'string' || relay.length > 8192))
    )
      return refused();
    const compact = encoded.replace(/\s/g, '');
    if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return refused();
    const xml = Buffer.from(compact, 'base64').toString('utf8');
    if (xml.includes('\0') || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) return refused();
    const snapshot = envelope(xml, body);
    if (!snapshot) return refused();
    // Next's Request may come from a different fetch implementation. Passing that object to
    // Node's constructor can access incompatible private slots. Replay only public request data;
    // retain every header (including correlation cookies/origin), the exact bytes and cancellation.
    return {
      request: new Request(request.url, {
        method: request.method,
        headers: Array.from(request.headers.entries()),
        body: new Uint8Array(body),
        signal: request.signal,
      }),
      envelope: {
        ...snapshot,
        relaySha256:
          typeof relay === 'string' ? createHash('sha256').update(relay).digest('hex') : null,
      },
    };
  } catch {
    return refused();
  } finally {
    reader.releaseLock();
  }
}
