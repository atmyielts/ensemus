'use client';
import { useActionState } from 'react';
import { requestOffboardingFormAction } from '@/server/offboarding-actions';
import { AccountActionNotice } from '@/components/account-action-notice';
import { SubmitButton } from '@/components/submit-button';
export type OffboardingFormState = {
  values: { confirmName: string };
  code?: string;
  requested?: boolean;
};
export function OffboardingRequestForm({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const [state, action] = useActionState(
    requestOffboardingFormAction,
    { values: { confirmName: '' } },
    `/o/${organizationId}/account/leave`,
  );
  return (
    <form className="fields form-width" action={action}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <AccountActionNotice
        code={state.code}
        organizationId={organizationId}
        returnTo={`/o/${organizationId}/account/leave`}
      />
      {state.requested && (
        <p className="notice" role="status">
          Your offboarding request is recorded. Review its current status above.
        </p>
      )}
      <label>
        Organization name
        <input
          name="confirmName"
          required
          maxLength={120}
          autoComplete="off"
          defaultValue={state.values.confirmName}
          aria-describedby="leave-name-help"
        />
      </label>
      <small id="leave-name-help">Type {organizationName} exactly to confirm.</small>
      <label className="check">
        <input type="checkbox" name="confirm" value="yes" required />I understand that new work will
        stop and offboarding will begin. This request does not erase data automatically.
      </label>
      <div>
        <SubmitButton className="danger" working="Requesting offboarding">
          Request offboarding
        </SubmitButton>
      </div>
    </form>
  );
}
