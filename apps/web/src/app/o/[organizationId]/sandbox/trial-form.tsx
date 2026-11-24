'use client';

import { useActionState, useId, useState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { startSandboxTrial, type SandboxTrialFormState } from './actions';

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
  const [input, setInput] = useState('{}');
  const [classification, setClassification] = useState<string>(
    classifications.includes('internal') ? 'internal' : 'public',
  );
  const field = useId();
  const [state, action] = useActionState(
    startSandboxTrial.bind(null, organizationId, skillVersionId, requestToken),
    initial,
    `/o/${organizationId}/skills/versions/${skillVersionId}`,
  );
  return (
    <form action={action} className="grid max-w-2xl gap-4">
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
        <SubmitButton working="Queuing trial" className="w-full sm:w-auto">
          Run trial
        </SubmitButton>
      </div>
    </form>
  );
}
