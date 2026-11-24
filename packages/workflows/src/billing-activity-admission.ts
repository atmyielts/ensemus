import { ApplicationFailure } from '@temporalio/common';

/** A deployment that has billing disabled cannot resolve the refusal by retrying this activity. */
export function requireBillingActivity(billingEnabled: boolean | undefined): void {
  if (billingEnabled !== true)
    throw ApplicationFailure.nonRetryable(
      'Billing is not available on this deployment.',
      'BILLING_NOT_ENABLED',
    );
}
