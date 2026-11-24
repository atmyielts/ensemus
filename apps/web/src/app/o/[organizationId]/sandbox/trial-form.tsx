'use client';

import { startTransition, useActionState, useId, useState } from 'react';
import { ErrorNotice } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { startSandboxTrial } from './actions';
import type { SandboxTrialFormState } from './trial-submission';

const initial: SandboxTrialFormState = {};
const labels = { public: 'Public', internal: 'Internal', confidential: 'Confidential' } as const;

export function SandboxTrialForm({
  organizationId,
  skillVersionId,
  requestToken,
  classifications,
}: {
  organizationId: string;
  skillVersionId: string;
  requestToken: string;
  classifications: readonly (keyof typeof labels)[];
}) {
  const [state, action, pending] = useActionState(
    startSandboxTrial.bind(null, organizationId, skillVersionId, requestToken),
    initial,
  );
  const [input, setInput] = useState(state.input ?? '{}');
  const [classification, setClassification] = useState<string>(
    state.classification && classifications.includes(state.classification)
      ? state.classification
      : classifications.includes('internal')
        ? 'internal'
        : 'public',
  );
  const field = useId();
  return (
    <form
      method="post"
      action={`/o/${organizationId}/sandbox/trials/${skillVersionId}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="grid max-w-2xl gap-4"
    >
      <input type="hidden" name="requestToken" value={requestToken} />
      <ErrorNotice code={state.code} />
      <div className="grid gap-1.5">
        <Label htmlFor={`${field}-classification`}>Input classification</Label>
        <NativeSelect
          id={`${field}-classification`}
          name="classification"
          value={classification}
          onChange={(event) => setClassification(event.target.value)}
        >
          {classifications.map((value) => (
            <option key={value} value={value}>
              {labels[value]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid min-w-0 gap-1.5">
        <Label htmlFor={field}>JSON input</Label>
        <Textarea
          id={field}
          name="input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="min-h-32 resize-y font-mono text-sm"
          rows={6}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          required
          aria-describedby={`${field}-hint${state.invalidJson ? ` ${field}-error` : ''}`}
          aria-invalid={state.invalidJson || undefined}
        />
        <small id={`${field}-hint`} className="text-muted-foreground">
          Use JSON that matches this version’s input schema. Maximum 1 MiB.
        </small>
        {state.invalidJson && (
          <p id={`${field}-error`} role="alert" className="text-sm text-destructive">
            Enter valid JSON.
          </p>
        )}
      </div>
      <div>
        <Button type="submit" disabled={pending} aria-busy={pending} className="w-full sm:w-auto">
          Run trial
        </Button>
        <span className="pending" role="status">
          {pending ? 'Queuing trial' : ''}
        </span>
      </div>
    </form>
  );
}
