'use client';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { addSignerAction } from './actions';
import type { SignerFormState } from './form-state';
const INITIAL: SignerFormState = {};
export function SignerForm({
  organizationId,
  trustedKeyIds,
}: {
  organizationId: string;
  trustedKeyIds: readonly string[];
}) {
  const [state, action] = useActionState(addSignerAction, INITIAL);
  return (
    <>
      <ErrorNotice code={state.code} />
      {state.added && trustedKeyIds.includes(state.added.keyId) && (
        <div className="notice good" role="status">
          <p>{state.added.displayName} is trusted. Compare this fingerprint with the publisher:</p>
          <p className="technical-reference">{state.added.keyId}</p>
        </div>
      )}
      <form className="fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <Label>
          Publisher name<small>A name your team will recognize.</small>
          <Input name="displayName" required maxLength={120} autoComplete="off" />
        </Label>
        <Label>
          Public key
          <small>
            Paste the publisher's raw Ed25519 public key in base64. Keep the private signing key on
            the publisher's own machine.
          </small>
          <Textarea
            name="publicKey"
            required
            maxLength={64}
            rows={2}
            autoComplete="off"
            spellCheck={false}
          />
        </Label>
        <p className="muted">
          Trusting a key allows its packages to be verified. A separate person still has to publish
          a verified version before it can be used.
        </p>
        <div>
          <SubmitButton working="Adding">Trust this publisher</SubmitButton>
        </div>
      </form>
    </>
  );
}
