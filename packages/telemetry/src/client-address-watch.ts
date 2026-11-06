// Notices when everyone seems to be arriving from one private address, which is what a proxy in front
// looks like when ENSEMUS_TRUSTED_PROXIES does not name it, and everyone then shares one sign-in allowance
// (ADR-037 D9). It only ever raises a warning. It refuses nothing and keeps no address after its window.
import { isIP } from 'node:net';

const MINUTE_MS = 60_000;

export type ClientAddressWatchOptions = {
  /** Called once when the pattern appears, and again at most every `repeatEveryMs` while it lasts. */
  onSuspected: (facts: { identities: number }) => void;
  now?: () => number;
  windowMs?: number;
  minIdentities?: number;
  repeatEveryMs?: number;
};

export type ClientAddressWatch = {
  /**
   * One authenticated request. `clientAddress` is what the proxy told the app, and `identity` an opaque
   * ID. Neither ever appears in what `onSuspected` is given, or in anything written anywhere.
   */
  observe(clientAddress: string | null, identity: string): void;
};

function isNonPublicIpv4(address: string): boolean {
  const [first = 0, second = 0] = address.split('.').map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

/** The eight groups of an address `isIP` has already accepted, with no zone. */
function ipv6Groups(address: string): number[] {
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  let text = address;
  if (tail.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    text = `${address.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const groupsIn = (part: string) =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));
  const [before = '', after = ''] = text.split('::');
  const left = groupsIn(before);
  const right = groupsIn(after);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function isNonPublicIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  const [first = 0, , , , , sixth = 0, seventh = 0, eighth = 0] = groups;
  const leadingZeros = groups.findIndex((group) => group !== 0);
  if (leadingZeros === 5 && sixth === 0xffff) {
    return isNonPublicIpv4(
      [seventh >> 8, seventh & 0xff, eighth >> 8, eighth & 0xff].map(String).join('.'),
    );
  }
  if (leadingZeros === 7 && eighth === 1) return true;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** Whether this is an address no ordinary client on the internet would arrive from. */
export function isNonPublicAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return isNonPublicIpv4(address);
    case 6:
      // A zone only says which interface, and a link-local address stays link-local on any of them.
      return isNonPublicIpv6(address.split('%', 1)[0] as string);
    default:
      // Junk must not be able to raise a warning.
      return false;
  }
}

export function createClientAddressWatch(options: ClientAddressWatchOptions): ClientAddressWatch {
  const {
    onSuspected,
    now = Date.now,
    windowMs = 10 * MINUTE_MS,
    minIdentities = 5,
    repeatEveryMs = 60 * MINUTE_MS,
  } = options;

  // This survives the window, and it is only a time.
  let lastSuspectedAt: number | undefined;

  // Everything below goes when the window ends.
  let windowStartedAt: number | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let soleAddress: string | undefined;
  /** This window can no longer match, so nothing more needs to be held for it. */
  let ruledOut = false;
  const identities = new Set<string>();

  const rememberNothing = () => {
    soleAddress = undefined;
    identities.clear();
  };

  const endWindow = () => {
    clearTimeout(expiry);
    expiry = undefined;
    windowStartedAt = undefined;
    ruledOut = false;
    rememberNothing();
  };

  const startWindow = (at: number) => {
    windowStartedAt = at;
    // The next request would also end it, but there may not be one, and nothing here may outlast the
    // window. The timer does not keep a process alive.
    expiry = setTimeout(endWindow, windowMs);
    expiry.unref();
  };

  return {
    observe(clientAddress, identity) {
      if (clientAddress === null) return;
      const at = now();
      if (windowStartedAt !== undefined && at - windowStartedAt >= windowMs) endWindow();
      if (windowStartedAt === undefined) startWindow(at);
      if (ruledOut) return;

      // A public or unreadable first address is never kept: anything after it is a second address.
      const sameAddress =
        soleAddress === undefined ? isNonPublicAddress(clientAddress) : soleAddress === clientAddress;
      if (!sameAddress) {
        ruledOut = true;
        rememberNothing();
        return;
      }
      soleAddress = clientAddress;

      if (identities.size < minIdentities) identities.add(identity);
      if (identities.size < minIdentities) return;
      if (lastSuspectedAt !== undefined && at - lastSuspectedAt < repeatEveryMs) return;
      lastSuspectedAt = at;
      onSuspected({ identities: identities.size });
    },
  };
}
