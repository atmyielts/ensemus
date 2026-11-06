// Owned by the transport slice (SEC-11). See docs/06-delivery/m4-slices.md and ADR-028 FD-10. The only file
// tree in this package allowed a socket or DNS, by lint. Every stub refuses.
import type { EndpointGuard } from '../types';

export type Resolver = (host: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;

export function createEndpointGuard(_deps: { resolve?: Resolver } = {}): EndpointGuard {
  return {
    fetchFor() {
      return () => Promise.reject(new Error('NOT_IMPLEMENTED'));
    },
  };
}
