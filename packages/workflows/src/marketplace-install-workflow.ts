// Owned by the marketplace-install slice (EXP-06). See docs/06-delivery/m11b-slices.md and ADR-034 D7.
// Deterministic workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { MarketplaceInstallInput, MarketplaceInstallOutcome } from './schemas';

/** Copies one listing in, then runs skillVerificationWorkflow over the copy as a child. Grants nothing. */
export async function marketplaceInstallWorkflow(
  _input: MarketplaceInstallInput,
): Promise<MarketplaceInstallOutcome> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
