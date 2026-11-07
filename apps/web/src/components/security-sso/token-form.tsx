'use client';
import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { issueScimTokenAction } from '@/server/sso-actions';
export type TokenState =
  { status: 'empty' } | { status: 'ready'; token: string } | { status: 'error' };
export function TokenForm({
  organizationId,
  connectionId,
}: {
  organizationId: string;
  connectionId: string;
}) {
  const [state, action] = useActionState(
    issueScimTokenAction.bind(null, organizationId, connectionId),
    { status: 'empty' } as TokenState,
  );
  return (
    <form className="fields" action={action}>
      {state.status === 'error' && (
        <p className="notice error" role="alert">
          A provisioning token could not be created. Refresh the page and confirm your identity
          before trying again.
        </p>
      )}
      {state.status === 'ready' ? (
        <div className="notice" role="status">
          <p>Save this provisioning token now. It is shown once.</p>
          <code style={{ overflowWrap: 'anywhere' }}>{state.token}</code>
          <p>
            Store it in your identity provider’s protected provisioning settings. Never send it in a
            URL or email.
          </p>
        </div>
      ) : (
        <div>
          <SubmitButton working="Creating token">Create provisioning token</SubmitButton>
        </div>
      )}
    </form>
  );
}
