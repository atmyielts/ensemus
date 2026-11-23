'use client';
import { useActionState, useEffect, useState } from 'react';
import { useKept } from '@/components/kept-field';
import { BUSINESS_STREAMS, type BusinessConnectorType } from '@ensemus/domain/business-connector';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import {
  createConnectionFormAction,
  type ConnectionFormState,
} from '@/server/external-action-actions';
const INITIAL: ConnectionFormState = {};
const GROUP_NAMES: Record<string, string> = {
  'crm.accounts': 'Companies',
  'crm.contacts': 'Contacts',
  'crm.deals': 'Deals',
  'ticketing.tickets': 'Tickets',
  'ticketing.comments': 'Ticket comments',
  'accounting.invoices': 'Invoices',
  'accounting.bills': 'Bills',
  'accounting.payments': 'Payment records',
};
export function BusinessConnectionForm({
  organizationId,
  type,
  requestKey,
}: {
  organizationId: string;
  type: BusinessConnectorType;
  requestKey: string;
}) {
  const [state, action] = useActionState(createConnectionFormAction, INITIAL);
  type SafeDraft = {
    displayName: string;
    tlsServerName: string;
    streams: string[];
    allowWrites: boolean;
  };
  const kept = useKept<SafeDraft>(`business-setup:${type}`);
  const empty: SafeDraft = { displayName: '', tlsServerName: '', streams: [], allowWrites: false };
  const [values, setValues] = useState<SafeDraft>(() => state.values ?? kept.read() ?? empty);
  const change = (patch: Partial<SafeDraft>) => {
    const next = { ...values, ...patch };
    setValues(next);
    kept.write(next);
  };
  useEffect(() => {
    if (state.created) {
      kept.forget();
      setValues({ displayName: '', tlsServerName: '', streams: [], allowWrites: false });
    } else if (state.values) {
      const { displayName, tlsServerName, streams, allowWrites } = state.values;
      const next = { displayName, tlsServerName, streams, allowWrites };
      setValues(next);
      kept.write(next);
    }
  }, [state, kept]);
  return (
    <details className="gap-above" open={state.code || state.created ? true : undefined}>
      <summary>Set up connection</summary>
      <div className="gap-above">
        <ErrorNotice code={state.code} />
        {state.created && (
          <p className="notice good" role="status">
            Connection added. Selected records will appear after a successful sync, with their
            source permissions.
          </p>
        )}
        <form className="fields" action={action}>
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="connectorType" value={type} />
          <input type="hidden" name="requestKey" value={requestKey} />
          <Label>
            Name
            <Input
              name="displayName"
              required
              maxLength={120}
              autoComplete="off"
              value={values.displayName}
              onChange={(event) => change({ displayName: event.target.value })}
            />
          </Label>
          <fieldset className="group">
            <legend>Records to import</legend>
            <p className="muted">
              Choose what to keep in Ensemus. Only people authorized at the source can read it here.
              Leaving all groups clear imports nothing.
            </p>
            <div className="choice-list">
              {Object.keys(BUSINESS_STREAMS[type]).map((stream) => (
                <Label className="check" key={stream}>
                  <input
                    type="checkbox"
                    name="streams"
                    value={stream}
                    checked={values.streams.includes(stream)}
                    onChange={(event) =>
                      change({
                        streams: event.target.checked
                          ? [...values.streams, stream]
                          : values.streams.filter((value) => value !== stream),
                      })
                    }
                  />
                  {GROUP_NAMES[stream] ?? stream}
                </Label>
              ))}
            </div>
          </fieldset>
          <fieldset className="group">
            <legend>Permissions Ensemus may use</legend>
            <p className="muted">
              Read the selected records using this credential. The source system must also allow
              each request.
            </p>
            <Label className="check">
              <input
                type="checkbox"
                name="allowWrites"
                value="yes"
                checked={values.allowWrites}
                onChange={(event) => change({ allowWrites: event.target.checked })}
              />
              Allow proposals for reviewed changes
            </Label>
            <p className="muted">
              Every change still needs an independent approval. Accounting can create invoice drafts
              and edit notes; it cannot pay, transfer or post money.
            </p>
          </fieldset>
          <Label>
            Adapter certificate name
            <small>
              Provided by whoever set up this adapter. Ensemus checks its certificate against this
              name; this does not choose its network destination.
            </small>
            <Input
              name="tlsServerName"
              required
              maxLength={253}
              autoComplete="off"
              value={values.tlsServerName}
              onChange={(event) => change({ tlsServerName: event.target.value })}
            />
          </Label>
          <Label>
            Credential
            <small>
              Sealed on arrival and never shown again. Re-enter it after a refused submission.
            </small>
            <Input name="credential" type="password" required maxLength={4096} autoComplete="off" />
          </Label>
          <div>
            <SubmitButton>Add connection</SubmitButton>
          </div>
        </form>
      </div>
    </details>
  );
}
