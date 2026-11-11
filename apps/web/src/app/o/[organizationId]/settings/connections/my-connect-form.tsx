'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { startMyConnectionAction, type MyConnectionFormState } from './actions';

const INITIAL: MyConnectionFormState = {};

export type MyCapabilityChoice = {
  id: string;
  label: string;
  description: string;
  /** Shown before consent, so the member sees exactly what the provider's page will ask for. */
  scopes: readonly string[];
};

/**
 * Starts connecting the member's own Google or Microsoft account, through Ensemus's app, for what the
 * organization lets members connect. Submitting goes to the provider's own page, and nothing is connected
 * until the member agrees there. A refused form keeps what was chosen.
 */
export function MyConnectForm({
  organizationId,
  connectorType,
  providerName,
  capabilities,
}: {
  organizationId: string;
  connectorType: 'google_workspace' | 'microsoft_365';
  providerName: string;
  capabilities: readonly MyCapabilityChoice[];
}) {
  const [state, action] = useActionState(startMyConnectionAction, INITIAL);
  const values = state.values?.connectorType === connectorType ? state.values : undefined;
  const chosen = new Set(values?.capabilities ?? capabilities.map((capability) => capability.id));
  return (
    <>
      {values && <ErrorNotice code={state.code} />}
      <form className="fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="connectorType" value={connectorType} />
        <label>
          Name
          <small>Only you see it. For example, the account you are connecting.</small>
          <input
            name="displayName"
            required
            maxLength={120}
            autoComplete="off"
            defaultValue={values?.displayName ?? providerName}
          />
        </label>
        <fieldset className="group">
          <legend>What assistants you start may do with it</legend>
          <div className="choice-list">
            {capabilities.map((capability) => (
              <label key={capability.id} className="choice">
                <input
                  type="checkbox"
                  name="capability"
                  value={capability.id}
                  defaultChecked={chosen.has(capability.id)}
                />
                <strong>{capability.label}</strong>
                <small>{capability.description}</small>
              </label>
            ))}
          </div>
        </fieldset>
        <details>
          <summary>Exactly what {providerName} will ask you to allow</summary>
          <ul className="list gap-above-small">
            {capabilities.map((capability) => (
              <li key={capability.id} className="block">
                <strong>{capability.label}</strong>
                <p className="muted technical-reference">{capability.scopes.join(', ')}</p>
              </li>
            ))}
          </ul>
        </details>
        <p className="muted">
          Next you go to {providerName}&apos;s own page to agree. You have ten minutes, and nothing
          is connected unless you agree there.
        </p>
        <div>
          <SubmitButton working={`Opening ${providerName}`}>
            Continue to {providerName}
          </SubmitButton>
        </div>
      </form>
    </>
  );
}
