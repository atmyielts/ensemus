'use client';

import { useActionState, useId } from 'react';
import { ErrorNotice } from '@/components/ui';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { SubmitButton } from '@/components/submit-button';
import { createWorkFromProposal } from './proposal-actions';

export function ProposalWorkForm({
  target,
  initial,
  people,
  requestKey,
}: {
  target: { organizationId: string; meetingId: string; itemId: string; version: number };
  initial: { title: string; objective: string; owner: string; due: string };
  people: readonly { id: string; name: string }[];
  requestKey: string;
}) {
  const [state, action, pending] = useActionState(createWorkFromProposal.bind(null, target), {});
  const ownerId = useId();
  const draft = state.draft ?? initial;
  return (
    <details className="group" open={state.code ? true : undefined}>
      <summary>Create work from suggestion</summary>
      <form action={action} key={state.revision ?? 0} className="form-width">
        <input type="hidden" name="requestKey" value={requestKey} />
        <ErrorNotice code={state.code} />
        <fieldset className="fields min-w-0" disabled={pending}>
          <Label>
            Title
            <Input name="title" maxLength={300} defaultValue={draft.title} required />
          </Label>
          <Label>
            Objective
            <Textarea name="objective" maxLength={10000} defaultValue={draft.objective} />
          </Label>
          <div className="grid gap-2">
            <Label htmlFor={ownerId}>Owner</Label>
            <NativeSelect id={ownerId} name="owner" defaultValue={draft.owner} required>
              <option value="" disabled>
                Choose an owner
              </option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Label>
            Due at (UTC)
            <Input name="due" type="datetime-local" defaultValue={draft.due} />
          </Label>
          <div>
            <SubmitButton working="Creating work">Create work</SubmitButton>
          </div>
        </fieldset>
      </form>
    </details>
  );
}
