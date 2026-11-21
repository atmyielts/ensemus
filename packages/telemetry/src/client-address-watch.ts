// Notices when everyone seems to be arriving from one private address, which is what a proxy in front
// looks like when ENSEMUS_TRUSTED_PROXIES does not name it, and everyone then shares one sign-in allowance
// (ADR-037 D9). It only ever raises a warning. It refuses nothing and keeps no address after its window.
//
// STUB: the proxy-warning slice in docs/06-delivery/hx-slices.md fills this in. The signatures are fixed.

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

/** Whether this is an address no ordinary client on the internet would arrive from. */
export function isNonPublicAddress(_address: string): boolean {
  throw Object.assign(new Error('Not implemented'), { code: 'NOT_IMPLEMENTED' });
}

export function createClientAddressWatch(_options: ClientAddressWatchOptions): ClientAddressWatch {
  throw Object.assign(new Error('Not implemented'), { code: 'NOT_IMPLEMENTED' });
}
