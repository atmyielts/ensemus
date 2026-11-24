// Deterministic workflow code. Bundle bytes stay in the Activities that read and copy them.
import {
  ActivityFailure,
  ApplicationFailure,
  executeChild,
  isCancellation,
  proxyActivities,
} from '@temporalio/workflow';
import {
  skillVerificationWorkflowIdFor,
  type MarketplaceInstallInput,
  type MarketplaceInstallOutcome,
} from './schemas';
import type { MarketplaceInstallActivities } from './marketplace-install-activities';
import { skillVerificationWorkflow } from './skill-verification-workflow';

const { materializeListing } = proxyActivities<
  Pick<MarketplaceInstallActivities, 'materializeListing'>
>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '8 minutes',
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
});

// The copy is bounded, but recording its terminal outcome survives longer database outages.
const { finishListingInstall } = proxyActivities<
  Pick<MarketplaceInstallActivities, 'finishListingInstall'>
>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '2 seconds', maximumInterval: '1 minute' },
});

/** Copies a listing and waits for ordinary skill verification of the tenant's own bytes. */
export async function marketplaceInstallWorkflow(
  input: MarketplaceInstallInput,
): Promise<MarketplaceInstallOutcome> {
  let step;
  try {
    step = await materializeListing(input);
  } catch (error) {
    if (isCancellation(error)) throw error;
    const cause = error instanceof ActivityFailure ? error.cause : error;
    const code =
      cause instanceof ApplicationFailure && cause.type === 'MARKETPLACE_BUNDLE_PENDING'
        ? 'BUNDLE_UNAVAILABLE'
        : 'INSTALL_ERROR';
    return finishListingInstall({ ...input, outcome: { ok: false, code } });
  }

  if (step.step === 'settled') return step.outcome;
  if (step.step === 'failed')
    return finishListingInstall({ ...input, outcome: { ok: false, code: step.code } });

  const child = { organizationId: input.organizationId, skillVersionId: step.skillVersionId };
  let verified = false;
  try {
    verified =
      (await executeChild(skillVerificationWorkflow, {
        workflowId: skillVerificationWorkflowIdFor(child),
        args: [child],
      })) === 'verified';
  } catch (error) {
    if (isCancellation(error)) throw error;
  }
  const outcome = verified
    ? ({ ok: true } as const)
    : ({ ok: false, code: 'VERIFICATION_REJECTED' } as const);
  return finishListingInstall({ ...input, outcome });
}
