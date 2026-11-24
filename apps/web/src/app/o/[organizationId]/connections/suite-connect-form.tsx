'use client';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { startSuiteConnectionAction, type SuiteConnectFormState } from '@/server/oauth-actions';

const INITIAL: SuiteConnectFormState = {};

export type SuiteCapabilityChoice = {
  id: string;
  label: string;
  description: string;
  /** Shown before consent, so an admin sees exactly what the provider's page will ask for. */
  scopes: readonly string[];
};

/**
 * Starts connecting a Google Workspace or a Microsoft 365 account. The admin chooses what Ensemus may do,
 * not scopes, and whose app to consent through. Submitting goes to the provider's own page, and nothing is
 * connected until the admin agrees there. A refused form keeps what was typed, except the client secret.
 * Without JavaScript every field shows, and the ones for another choice are ignored.
 */
export function SuiteConnectForm({
  organizationId,
  connectorType,
  providerName,
  capabilities,
  platformAvailable,
  redirectUri,
}: {
  organizationId: string;
  connectorType: 'google_workspace' | 'microsoft_365';
  providerName: string;
  capabilities: readonly SuiteCapabilityChoice[];
  platformAvailable: boolean;
  redirectUri: string;
}) {
  const [state, action] = useActionState(startSuiteConnectionAction, INITIAL);
  const values = state.values?.connectorType === connectorType ? state.values : undefined;
  const chosen = new Set(values?.capabilities ?? capabilities.map((capability) => capability.id));
  const microsoft = connectorType === 'microsoft_365';
  const prefix = `suite-${connectorType}`;
  return (
    <>
      {values && <ErrorNotice code={state.code} />}
      <form className="fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="connectorType" value={connectorType} />
        <Label>
          Name
          <small>What people see in lists. For example, the company or the purpose.</small>
          <Input
            name="displayName"
            required
            maxLength={120}
            autoComplete="off"
            defaultValue={values?.displayName ?? providerName}
          />
        </Label>
        <fieldset className="group">
          <legend>What Ensemus may do</legend>
          <div className="choice-list">
            {capabilities.map((capability) => (
              <Label key={capability.id} className="choice">
                <input
                  type="checkbox"
                  name="capability"
                  value={capability.id}
                  defaultChecked={chosen.has(capability.id)}
                />
                <strong>{capability.label}</strong>
                <small>{capability.description}</small>
              </Label>
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
        <Label>
          Drives to read
          <small>
            Optional. Drive IDs, separated by commas. Leave it empty to read every drive the account
            you connect can see.
          </small>
          <Input
            name="driveIds"
            maxLength={13_000}
            autoComplete="off"
            defaultValue={values?.driveIds ?? ''}
          />
        </Label>
        <Label>
          Whose app to connect through
          <small>
            Ensemus’s own app is the simple choice. Your own app needs the details below.
          </small>
          <NativeSelect
            key={values?.clientKind ?? ''}
            name="clientKind"
            defaultValue={values?.clientKind ?? (platformAvailable ? 'platform' : 'customer')}
          >
            <option value="platform" disabled={!platformAvailable}>
              {platformAvailable ? 'Ensemus' : 'Ensemus (not set up for your company yet)'}
            </option>
            <option value="customer">Your own app</option>
          </NativeSelect>
        </Label>
        <fieldset className="group">
          <legend>Only for your own app</legend>
          <p className="muted">
            Register this address as the redirect address in your app: <code>{redirectUri}</code>
          </p>
          <Label htmlFor={`${prefix}-client-id`}>Client ID</Label>
          <Input
            id={`${prefix}-client-id`}
            name="oauthClient"
            maxLength={512}
            autoComplete="off"
            defaultValue={values?.clientId ?? ''}
          />
          <Label htmlFor={`${prefix}-client-secret`}>
            Client secret
            <small>Sealed as soon as it arrives. Nobody can read it back, including you.</small>
          </Label>
          <Input
            id={`${prefix}-client-secret`}
            name="clientSecret"
            type="password"
            maxLength={2048}
            autoComplete="off"
          />
          {microsoft && (
            <>
              <Label htmlFor={`${prefix}-tenant`}>
                Directory (tenant) ID or domain
                <small>Your Microsoft Entra directory, where your app is registered.</small>
              </Label>
              <Input
                id={`${prefix}-tenant`}
                name="tenant"
                maxLength={253}
                autoComplete="off"
                defaultValue={values?.tenant ?? ''}
              />
            </>
          )}
        </fieldset>
        <p className="muted">
          Next you go to {providerName}&apos;s own page to agree. You have ten minutes. Nothing is
          connected unless you agree there.
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
