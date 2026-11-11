'use client';
import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
export type TokenState =
  { status: 'empty' } | { status: 'ready'; token: string } | { status: 'error' };
// The server parent supplies a stable, already-bound native action reference.
export function TokenForm({
  issueAction,
}: {
  issueAction: (previous: TokenState, form: FormData) => Promise<TokenState>;
}) {
  const [state, action] = useActionState(issueAction, { status: 'empty' } as TokenState);
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
          <p>Copy this provisioning token now. It is shown only once.</p>
          <p className="mono gap-above-small">{state.token}</p>
          <p className="gap-above-small">
            Paste it into your sign-in service’s provisioning settings, where it is kept protected.
            Never send it in a link or an email.
          </p>
        </div>
      ) : (
        <div>
          <SubmitButton className="secondary" working="Creating token">
            Create provisioning token
          </SubmitButton>
        </div>
      )}
    </form>
  );
}
