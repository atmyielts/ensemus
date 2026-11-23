'use client';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Input } from '@/components/ui/input';

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
        <Label>
          Kind
          <NativeSelect
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
          </NativeSelect>
        </Label>
        <Label>
          Name
          <small>What people choose from. For example, the team or the purpose.</small>
          <Input
            name="displayName"
            required
            maxLength={120}
            autoComplete="off"
            defaultValue={values?.displayName ?? ''}
          />
        </Label>
        <fieldset className="group">
          <legend>For email</legend>
          <Label>
            Sends as
            <small>The one address this connection may send from.</small>
            <Input
              name="fromAddress"
              type="email"
              autoComplete="off"
              defaultValue={values?.fromAddress ?? ''}
            />
          </Label>
          <Label>
            Sender name
            <small>Optional.</small>
            <Input
              name="fromName"
              maxLength={120}
              autoComplete="off"
              defaultValue={values?.fromName ?? ''}
            />
          </Label>
          <Label>
            Name on your mail server&apos;s certificate
            <small>Optional. Ensemus checks the certificate against this name.</small>
            <Input
              name="tlsServerName"
              maxLength={253}
              autoComplete="off"
              defaultValue={values?.tlsServerName ?? ''}
            />
          </Label>
          <Label>
            Credential
            <small>Sealed as soon as it arrives. Nobody can read it back, including you.</small>
            <Input name="credential" type="password" maxLength={4096} autoComplete="off" />
          </Label>
        </fieldset>
        <div>
          <SubmitButton>Add connection</SubmitButton>
        </div>
      </form>
    </>
  );
}
