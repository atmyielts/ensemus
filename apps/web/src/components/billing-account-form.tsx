'use client';

import { useActionState } from 'react';
import type { BillingAccountInput } from '@ensemus/application/saas/subscriptions';
import { saveBillingAccountFormAction } from '@/server/billing-actions';
import { SubmitButton } from './submit-button';
import { ErrorNotice } from './ui';

export type BillingAccountFormState = {
  values: BillingAccountInput;
  version: number | null;
  code?: string;
  saved?: boolean;
};

export function BillingAccountForm({
  organizationId,
  account,
}: {
  organizationId: string;
  account: (BillingAccountInput & { version: number }) | null;
}) {
  const [state, action] = useActionState(
    saveBillingAccountFormAction,
    {
      values: account ?? {
        billingName: '',
        billingEmail: '',
        countryCode: '',
        regionCode: '',
        postalCode: null,
        taxId: null,
      },
      version: account?.version ?? null,
    },
    `/o/${organizationId}/account/billing`,
  );
  const v = state.values;
  return (
    <form className="fields form-width" action={action}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="version" value={state.version ?? ''} />
      <ErrorNotice code={state.code} />
      {state.saved && (
        <p className="notice good" role="status">
          Billing details saved.
        </p>
      )}
      <label>
        Billing name
        <input
          name="billingName"
          autoComplete="organization"
          required
          maxLength={200}
          defaultValue={v.billingName}
        />
      </label>
      <label>
        Billing email
        <input
          name="billingEmail"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          defaultValue={v.billingEmail}
        />
      </label>
      <label>
        Country code
        <input
          name="countryCode"
          autoComplete="country"
          required
          pattern="[A-Z]{2}"
          maxLength={2}
          defaultValue={v.countryCode}
          aria-describedby="billing-country-help"
        />
        <small id="billing-country-help">Use the two-letter uppercase country code.</small>
      </label>
      <label>
        Region code <small>Optional</small>
        <input name="regionCode" maxLength={16} pattern="[A-Z0-9-]*" defaultValue={v.regionCode} />
      </label>
      <label>
        Postal code <small>Optional</small>
        <input
          name="postalCode"
          autoComplete="postal-code"
          maxLength={32}
          defaultValue={v.postalCode ?? ''}
        />
      </label>
      <label>
        Tax identification <small>Optional</small>
        <input name="taxId" autoComplete="off" maxLength={64} defaultValue={v.taxId ?? ''} />
      </label>
      <div>
        <SubmitButton working="Saving billing details">Save billing details</SubmitButton>
      </div>
    </form>
  );
}
