// Owned by the transport slice (SEC-11). What an endpoint may look like, before any DNS or socket, so the
// web tier can refuse a bad address at the form and the worker can refuse it again (ADR-028 FD-10). Pure:
// the address rules are here too, so the guard in @ensemus/intelligence applies the same ones to a DNS answer.
import type { ProviderKind } from '@ensemus/domain/ai';

/** An operator's setting, read by the caller. Tenants can never add to it. */
export type EndpointSettings = {
  /** From `ENSEMUS_PRIVATE_MODEL_ENDPOINTS`. Origins that may be private or plain HTTP. */
  privateEndpoints: readonly string[];
};

export type EndpointCheck =
  | { ok: true; host: string; port: number; viaPrivateAllowlist: boolean }
  | { ok: false; code: 'MODEL_ENDPOINT_NOT_ALLOWED' };

const REFUSED: EndpointCheck = { ok: false, code: 'MODEL_ENDPOINT_NOT_ALLOWED' };

/** A hosted kind reaches its provider's own host and nothing else, whatever a profile row says. */
const HOSTED_HOSTS: Partial<Record<ProviderKind, readonly string[]>> = {
  openai_hosted: ['api.openai.com'],
  anthropic_hosted: ['api.anthropic.com'],
};
const HOSTED_PATH = '/v1';

/**
 * Names that only mean something inside a network. The guard would refuse their DNS answer anyway, and
 * refusing them here tells a person at the form rather than a worker at the first call.
 */
const INTERNAL_SUFFIXES = [
  'localhost',
  'localdomain',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'home.arpa',
] as const;

export type AddressClass =
  /** Routable on the public internet. */
  | 'public'
  /** Inside a network. Only the operator's list can allow it. */
  | 'private'
  /** Never a model: metadata services, link-local, unspecified, multicast and reserved ranges. */
  | 'forbidden';

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    // No leading zeros: some resolvers read those as octal, so the value would be ambiguous.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseIpv6(text: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(':')) return null;
  let source = text;
  const tail: number[] = [];
  const lastColon = source.lastIndexOf(':');
  if (source.includes('.')) {
    const v4 = parseIpv4(source.slice(lastColon + 1));
    if (!v4) return null;
    tail.push(...v4);
    source = source.slice(0, lastColon + 1);
    // `::1.2.3.4` leaves `::`, and `1:2:3:4:5:6:1.2.3.4` leaves `...:6:`, which loses its last colon.
    if (!source.endsWith('::')) source = source.slice(0, -1);
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const groups = (half: string | undefined) => (half ? half.split(':') : []);
  const head = groups(halves[0]);
  const rest = groups(halves[1]);
  const total = head.length + rest.length + tail.length / 2;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const toBytes = (group: string) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  };
  const bytes: number[] = [];
  for (const group of head) {
    const pair = toBytes(group);
    if (!pair) return null;
    bytes.push(...pair);
  }
  bytes.push(...new Array<number>((8 - total) * 2).fill(0));
  for (const group of rest) {
    const pair = toBytes(group);
    if (!pair) return null;
    bytes.push(...pair);
  }
  bytes.push(...tail);
  return bytes.length === 16 ? bytes : null;
}

/** The IPv4 address inside an IPv4-mapped IPv6 address, which connects to that IPv4 host. */
function unmapped(bytes: number[]): number[] {
  const isMapped =
    bytes.length === 16 &&
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  return isMapped ? bytes.slice(12) : bytes;
}

const stripBrackets = (host: string) =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

function parseAddress(address: string): number[] | null {
  const text = stripBrackets(address);
  const bytes = parseIpv4(text) ?? parseIpv6(text);
  return bytes ? unmapped(bytes) : null;
}

/** Whether a host is an address and not a name. A URL's host keeps the brackets on IPv6. */
export function isAddressLiteral(host: string): boolean {
  return parseAddress(host) !== null;
}

/** Whether two spellings are one address, so a mapped form cannot hide from a comparison. */
export function sameAddress(a: string, b: string): boolean {
  const left = parseAddress(a);
  const right = parseAddress(b);
  if (!left || !right || left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

const inV4 = (bytes: number[], first: number, second: number, prefixBits: number) => {
  const value = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
  const net = (first << 8) | second;
  const mask = prefixBits === 0 ? 0 : (0xffff << (16 - prefixBits)) & 0xffff;
  return (value & mask) === (net & mask);
};

const isV4 = (bytes: number[], a: number, b: number, c: number, d: number) =>
  bytes[0] === a && bytes[1] === b && bytes[2] === c && bytes[3] === d;

function classifyIpv4(bytes: number[]): AddressClass {
  // Metadata services that sit outside the ranges below: Alibaba Cloud's, in shared address space, and
  // Azure's WireServer, which is in public address space. A hostile DNS answer can name either.
  if (isV4(bytes, 100, 100, 100, 200) || isV4(bytes, 168, 63, 129, 16)) return 'forbidden';

  if (inV4(bytes, 10, 0, 8)) return 'private';
  if (inV4(bytes, 127, 0, 8)) return 'private';
  if (inV4(bytes, 172, 16, 12)) return 'private';
  if (inV4(bytes, 192, 168, 16)) return 'private';
  if (inV4(bytes, 100, 64, 10)) return 'private';

  if (inV4(bytes, 0, 0, 8)) return 'forbidden';
  if (inV4(bytes, 169, 254, 16)) return 'forbidden';
  if (inV4(bytes, 198, 18, 15)) return 'forbidden';
  if ((bytes[0] ?? 0) >= 224) return 'forbidden';
  const threeOctets = ((bytes[0] ?? 0) << 16) | ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  const reservedSlash24 = [0xc00000, 0xc00002, 0xc05863, 0xc63364, 0xcb0071];
  if (reservedSlash24.includes(threeOctets)) return 'forbidden';
  return 'public';
}

function classifyIpv6(bytes: number[]): AddressClass {
  const word = (index: number) => ((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0);
  const isLoopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (isLoopback) return 'private';
  // AWS's metadata service over IPv6, which is inside the unique-local range allowed below.
  if (
    word(0) === 0xfd00 &&
    word(1) === 0x0ec2 &&
    [2, 3, 4, 5, 6].every((index) => word(index) === 0) &&
    word(7) === 0x0254
  ) {
    return 'forbidden';
  }
  // fc00::/7, unique-local.
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return 'private';
  // Only global unicast, 2000::/3, can be public. That also leaves out ::, link-local, multicast, the
  // IPv4-compatible and NAT64 forms, each of which could otherwise carry a private IPv4 address.
  if (((bytes[0] ?? 0) & 0xe0) !== 0x20) return 'forbidden';
  // 2001::/23 is special-purpose and holds Teredo, 2001:db8::/32 and 3fff::/20 are documentation, and
  // 2002::/16 is 6to4, which embeds an IPv4 address that a relay would then connect to.
  if (word(0) === 0x2001 && word(1) < 0x0200) return 'forbidden';
  if (word(0) === 0x2001 && word(1) === 0x0db8) return 'forbidden';
  if (word(0) === 0x2002) return 'forbidden';
  if (word(0) === 0x3fff && word(1) < 0x1000) return 'forbidden';
  return 'public';
}

/** What an address is. Anything unparseable is `forbidden`, so a surprise fails closed. */
export function classifyAddress(address: string): AddressClass {
  const bytes = parseAddress(address);
  if (!bytes) return 'forbidden';
  return bytes.length === 4 ? classifyIpv4(bytes) : classifyIpv6(bytes);
}

function isInternalName(hostname: string): boolean {
  const name = hostname.replace(/\.$/, '').toLowerCase();
  if (!name.includes('.')) return true;
  return INTERNAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

function parseEndpoint(endpointUrl: string): URL | null {
  // The adapter hands this exact text to a provider package, which builds its request URL by joining
  // strings. So it has to mean the same thing to everyone: no whitespace or control characters, which a
  // URL parser removes, no backslashes, which it rewrites, and no query or fragment, which would swallow
  // the path a provider package appends and which the endpoint digest does not cover.
  if (!endpointUrl || /[^\x21-\x7e]|[\\?#]/.test(endpointUrl)) return null;
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url;
}

const portOf = (url: URL) => (url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80);

function originOf(entry: string): string | null {
  try {
    const url = new URL(entry);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function onOperatorList(url: URL, settings: EndpointSettings): boolean {
  return settings.privateEndpoints.some((entry) => originOf(entry) === url.origin);
}

/**
 * Hosted kinds have a fixed host list in code. `openai_compatible` needs an HTTPS public address, and
 * `local_openai_compatible` must be on the operator's list. Nothing an operator lists can name cloud
 * metadata or another address that is `forbidden`. A name is checked again at connect time, by the guard
 * in @ensemus/intelligence, which is what stops a public name that resolves somewhere private.
 */
export function checkEndpoint(
  kind: ProviderKind,
  endpointUrl: string,
  settings: EndpointSettings,
): EndpointCheck {
  const url = parseEndpoint(endpointUrl);
  if (!url) return REFUSED;
  const port = portOf(url);
  if (port === 0) return REFUSED;
  const host = url.hostname;
  const isLiteral = isAddressLiteral(host);
  if (isLiteral && classifyAddress(host) === 'forbidden') return REFUSED;
  const accepted = (viaPrivateAllowlist: boolean): EndpointCheck => ({
    ok: true,
    host,
    port,
    viaPrivateAllowlist,
  });

  switch (kind) {
    case 'openai_hosted':
    case 'anthropic_hosted': {
      const hosts = HOSTED_HOSTS[kind] ?? [];
      if (url.protocol !== 'https:' || port !== 443 || !hosts.includes(host)) return REFUSED;
      return url.pathname.replace(/\/$/, '') === HOSTED_PATH ? accepted(false) : REFUSED;
    }
    case 'openai_compatible': {
      if (onOperatorList(url, settings)) return accepted(true);
      if (url.protocol !== 'https:') return REFUSED;
      if (isLiteral) return classifyAddress(host) === 'public' ? accepted(false) : REFUSED;
      return isInternalName(host) ? REFUSED : accepted(false);
    }
    case 'local_openai_compatible':
      return onOperatorList(url, settings) ? accepted(true) : REFUSED;
    default:
      // The row's kind is checked by the schema, and an unknown one still gets nothing.
      return REFUSED;
  }
}
