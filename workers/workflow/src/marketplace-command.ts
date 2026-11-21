// Owned by the marketplace-operator slice (EXP-06). See docs/06-delivery/m11b-slices.md and ADR-034 D5, D6.
// What `node dist/marketplace-operator.js` does. Answers with the exit status: 0 when done, 2 when it refused.
//   queue
//   show <org> <submission>                 prints the manifest, and writes the bundle to a path you name
//   start-review <org> <submission>
//   review-payload <org> <submission> ...   prints exactly the bytes a reviewer signs, on their own machine
//   record-review <org> <submission> ...    takes the attestation and its signature, and checks them first
//   list <org> <submission>                 checks every signature and the bytes, copies them, and lists
//   delist <listing> stop_new|revoke <code>
//   suspend-publisher <publisher> / reinstate-publisher <publisher>
// The server never sees a private key. A reviewer signs elsewhere, and hands over the signature.
import type { MarketplaceReviewKeys, ObjectStore } from '@ensemus/application';
import type { openMarketplaceOperatorDatabase } from '@ensemus/database/marketplace-operator';
import { createLogger } from '@ensemus/telemetry';

export const log = createLogger('marketplace-operator');

export type MarketplaceCommandDeps = {
  db: ReturnType<typeof openMarketplaceOperatorDatabase>['db'];
  store: ObjectStore;
  reviewKeys: MarketplaceReviewKeys;
  print: (line: string) => void;
};

export async function marketplaceCommand(
  _argv: readonly string[],
  _deps: MarketplaceCommandDeps,
): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}
