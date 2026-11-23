'use client';
import { useActionState } from 'react';
import { ErrorNotice } from '@/components/ui';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/submit-button';
import { saveProvider } from './actions';

export function ProviderForm({
  organizationId,
  kind,
  requestKey,
  options,
}: {
  organizationId: string;
  kind: 'model' | 'source';
  requestKey: string;
  options: readonly { id: string; name: string }[];
}) {
  const path = '/o/' + organizationId + '/meetings/providers';
  const [state, action] = useActionState(saveProvider.bind(null, organizationId, kind), {}, path);
  const draft = state.draft;
  return (
    <details className="group" open={state.code ? true : undefined}>
      <summary>{kind === 'model' ? 'Approve a model' : 'Approve a notes connection'}</summary>
      <form className="fields form-width" action={action} key={state.revision ?? 0}>
        <input type="hidden" name="requestKey" value={requestKey} />
        <ErrorNotice code={state.code} />
        <Label>
          {kind === 'model' ? 'Model profile' : 'Notes connection'}
          <NativeSelect name="target" defaultValue={draft?.target ?? ''} required>
            <option value="" disabled>
              Choose a provider
            </option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </NativeSelect>
        </Label>
        {kind === 'model' && (
          <fieldset className="fields">
            <legend>Allowed purposes</legend>
            <Label className="check">
              <input
                type="checkbox"
                name="purpose"
                value="summarize"
                defaultChecked={draft?.purposes.includes('summarize')}
              />
              Summarize notes
            </Label>
            <Label className="check">
              <input
                type="checkbox"
                name="purpose"
                value="extract_items"
                defaultChecked={draft?.purposes.includes('extract_items')}
              />
              Suggest work and decisions
            </Label>
          </fieldset>
        )}
        <Label>
          Highest classification
          <NativeSelect name="maxClass" defaultValue={draft?.maxClass ?? 'internal'}>
            <option value="public">Public</option>
            <option value="internal">Internal</option>
            <option value="confidential">Confidential</option>
          </NativeSelect>
        </Label>
        <Label>
          Terms reference
          <Input name="terms" defaultValue={draft?.terms} maxLength={200} required />
        </Label>
        <Label>
          Expires at (UTC)
          <Input name="expiry" defaultValue={draft?.expiry} type="datetime-local" required />
        </Label>
        <div>
          <SubmitButton>Approve provider</SubmitButton>
        </div>
      </form>
    </details>
  );
}
