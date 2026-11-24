'use client';
import { Card } from '@/components/ui/card';

import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

import { useActionState, useEffect, useRef } from 'react';
import { reviseBusinessProposalAction } from '@/server/business-revision-actions';
import type { BusinessProposalFormState } from '@/lib/business-proposal-form';
import type { BusinessRevisionField } from '@/lib/business-revision-input';
import { ErrorNotice } from './ui';
import { SubmitButton } from './submit-button';
export function BusinessRevisionForm({
  organizationId,
  externalActionId,
  version,
  requestKey,
  fields,
  approvers,
}: {
  organizationId: string;
  externalActionId: string;
  version: number;
  requestKey: string;
  fields: readonly BusinessRevisionField[];
  approvers: readonly { id: string; label: string }[];
}) {
  const [state, action] = useActionState(
    reviseBusinessProposalAction,
    {} as BusinessProposalFormState,
    `/o/${organizationId}/external-actions/${externalActionId}?edit=1`,
  );
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.code) errorRef.current?.focus();
  }, [state.code, state.revision]);
  const value = (name: string, fallback = '') => state.values?.[name] ?? fallback;
  return (
    <Card asChild>
      <section className="card stack" aria-labelledby="business-revision-heading">
        <h2 id="business-revision-heading">Change the proposal</h2>
        <p>
          This replaces the earlier proposal and approval. Nothing is attempted until the new
          proposal is independently approved.
        </p>
        <p className="muted">
          Change the proposed values below. The source record and version stay the same. To change
          the target, fields or number of invoice lines, start a new proposal.
        </p>
        <div ref={errorRef} tabIndex={-1}>
          {state.code && <ErrorNotice code={state.code} />}
        </div>
        <form action={action} className="fields" key={state.revision ?? 0}>
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="externalActionId" value={externalActionId} />
          <input type="hidden" name="version" value={version} />
          <input type="hidden" name="requestKey" value={requestKey} />
          {fields.map((field) => (
            <div className="stack" key={field.name}>
              <Label htmlFor={'revision-' + field.name}>{field.label}</Label>
              {field.multiline ? (
                <Textarea
                  id={'revision-' + field.name}
                  name={field.name}
                  defaultValue={value(field.name, field.value)}
                  required={field.required}
                  maxLength={field.maxLength}
                  rows={4}
                />
              ) : (
                <Input
                  id={'revision-' + field.name}
                  name={field.name}
                  defaultValue={value(field.name, field.value)}
                  required={field.required}
                  maxLength={field.maxLength}
                />
              )}
              {field.clearable && (
                <Label className="check">
                  <input
                    type="checkbox"
                    name={'clear.' + field.name}
                    defaultChecked={
                      value('clear.' + field.name, field.cleared ? 'on' : '') === 'on'
                    }
                  />
                  Clear this field instead
                </Label>
              )}
            </div>
          ))}
          <Label htmlFor="revision-reviewer">Who approves the replacement?</Label>
          <NativeSelect
            id="revision-reviewer"
            name="reviewer"
            required
            defaultValue={value('reviewer')}
          >
            <option value="">Choose a person</option>
            {approvers.map((person) => (
              <option key={person.id} value={person.id}>
                {person.label}
              </option>
            ))}
          </NativeSelect>
          <div>
            <SubmitButton>Request a replacement review</SubmitButton>
          </div>
        </form>
      </section>
    </Card>
  );
}
