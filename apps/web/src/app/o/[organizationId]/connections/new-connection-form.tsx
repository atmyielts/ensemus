'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import {
  createConnectionFormAction,
  type ConnectionFormState,
} from '@/server/external-action-actions';

const INITIAL: ConnectionFormState = {};

/**
 * Adds a connection. A refused form comes back with what was typed, except the credential, which never
 * returns to the page. There is no field for a host: an operator sets where connectors may connect.
 */
export function NewConnectionForm({
  organizationId,
  connectors,
  requestKey,
}: {
  organizationId: string;
  connectors: ReadonlyArray<{ type: string; label: string }>;
  requestKey: string;
}) {
  const [state, action] = useActionState(createConnectionFormAction, INITIAL);
  const values = state.values;
  return (
    <>
      <ErrorNotice code={state.code} />
      {state.created && (
        <p className="notice good" role="status">
          Connection added. Any credential you gave is sealed, and cannot be read back.
        </p>
      )}
      <form className="fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <label>
          Kind
          <select
            key={values?.connectorType ?? ''}
            name="connectorType"
            required
            defaultValue={values?.connectorType ?? ''}
          >
            <option value="" disabled>
              Choose a kind
            </option>
            {connectors.map((connector) => (
              <option key={connector.type} value={connector.type}>
                {connector.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <small>What people choose from. For example, the team or the purpose.</small>
          <input
            name="displayName"
            required
            maxLength={120}
            autoComplete="off"
            defaultValue={values?.displayName ?? ''}
          />
        </label>
        <fieldset className="group">
          <legend>For email</legend>
          <label>
            Sends as
            <small>The one address this connection may send from.</small>
            <input
              name="fromAddress"
              type="email"
              autoComplete="off"
              defaultValue={values?.fromAddress ?? ''}
            />
          </label>
          <label>
            Sender name
            <small>Optional.</small>
            <input
              name="fromName"
              maxLength={120}
              autoComplete="off"
              defaultValue={values?.fromName ?? ''}
            />
          </label>
          <label>
            Name on your mail server&apos;s certificate
            <small>Optional. Ensemus checks the certificate against this name.</small>
            <input
              name="tlsServerName"
              maxLength={253}
              autoComplete="off"
              defaultValue={values?.tlsServerName ?? ''}
            />
          </label>
          <label>
            Credential
            <small>Sealed as soon as it arrives. Nobody can read it back, including you.</small>
            <input name="credential" type="password" maxLength={4096} autoComplete="off" />
          </label>
        </fieldset>
        <div>
          <SubmitButton>Add connection</SubmitButton>
        </div>
      </form>
    </>
  );
}
