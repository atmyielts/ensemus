'use client';
import { useActionState, useEffect, useId, useRef } from 'react';
import { startWorkflowRunAction } from '@/server/process-run-actions';
import type { ProcessRunFormState } from '@/lib/process-run-input';
import { ErrorNotice } from '../ui';
import { SubmitButton } from '../submit-button';
export function ProcessStartForm({
  organizationId,
  specs,
  requestKey,
  selectedSpecId,
}: {
  organizationId: string;
  specs: readonly { id: string; name: string; versionNumber: number; classification: string }[];
  requestKey: string;
  selectedSpecId?: string;
}) {
  const [state, action] = useActionState<ProcessRunFormState, FormData>(startWorkflowRunAction, {}),
    prefix = useId(),
    error = useRef<HTMLDivElement>(null),
    values = state.values;
  useEffect(() => {
    if (state.code) error.current?.focus();
  }, [state]);
  const selected = values?.specId ?? selectedSpecId ?? '',
    missing = selected && !specs.some((spec) => spec.id === selected);
  return (
    <form
      action={action}
      className="card fields"
      aria-label="Start an approved workflow"
      key={state.revision ?? 0}
    >
      <div ref={error} tabIndex={-1}>
        <ErrorNotice code={state.code} />
      </div>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="requestKey" value={values?.requestKey ?? requestKey} />
      <label htmlFor={`${prefix}-spec`}>Workflow</label>
      <select
        id={`${prefix}-spec`}
        name="specId"
        defaultValue={selected}
        required
        aria-describedby={`${prefix}-definition-help`}
      >
        <option value="">Choose a saved workflow</option>
        {missing && (
          <option value={selected}>Previously selected workflow is not currently available</option>
        )}
        {specs.map((spec) => (
          <option key={spec.id} value={spec.id}>
            {spec.name} · Version {spec.versionNumber} ·{' '}
            {spec.classification === 'restricted'
              ? 'Restricted'
              : spec.classification === 'confidential'
                ? 'Confidential'
                : spec.classification === 'public'
                  ? 'Public'
                  : 'Internal'}
          </option>
        ))}
      </select>
      <small id={`${prefix}-definition-help`}>
        The work keeps this version even if the workflow changes later. Access, connections and
        budget are checked again at each step.
      </small>
      <label htmlFor={`${prefix}-title`}>Name this work</label>
      <input
        id={`${prefix}-title`}
        name="title"
        maxLength={200}
        required
        defaultValue={values?.title ?? ''}
        autoComplete="off"
      />
      <label htmlFor={`${prefix}-due`}>Due date (optional)</label>
      <input id={`${prefix}-due`} name="dueAt" type="date" defaultValue={values?.dueAt ?? ''} />
      <p className="notice">
        Starting creates real work for the people in this workflow. They still confirm their own
        steps, and any email waits for someone to approve the exact message before it is sent.
      </p>
      <div>
        <SubmitButton working="Requesting the workflow">Start this workflow</SubmitButton>
      </div>
    </form>
  );
}
