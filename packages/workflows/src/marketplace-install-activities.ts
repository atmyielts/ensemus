// Owned by the marketplace-install slice (EXP-06). See docs/06-delivery/m11b-slices.md and ADR-034 D7.
import type {
  MarketplaceInstallInput,
  MarketplaceInstallOutcome,
  MarketplaceInstallStep,
} from './schemas';
import type { SkillActivityDeps } from './skill-deps';

/** On the platform queue. Holds the review keys, which are public, and no secret. */
export function createMarketplaceInstallActivities(_deps: SkillActivityDeps) {
  return {
    /**
     * Checks the listing's attestation against this deployment's review keys, its publisher signature and
     * the bytes against the digest, and only then copies them in. A delisted listing, an unknown reviewer
     * or a changed byte fails here, with a fixed code, whatever the row says.
     */
    async materializeListing(_input: MarketplaceInstallInput): Promise<MarketplaceInstallStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
    /** Settles the installation, from what the child verification ended on. */
    async finishListingInstall(
      _input: MarketplaceInstallInput & { verified: boolean },
    ): Promise<MarketplaceInstallOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type MarketplaceInstallActivities = ReturnType<typeof createMarketplaceInstallActivities>;
