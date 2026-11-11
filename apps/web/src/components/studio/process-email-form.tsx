'use client';
import { useActionState, useEffect, useId, useRef } from 'react';
import { proposeWorkflowEmailAction } from '@/server/process-run-actions';
import type { ProcessRunFormState } from '@/lib/process-run-input';
import { ErrorNotice } from '../ui';
import { SubmitButton } from '../submit-button';
export function ProcessEmailForm({
  organizationId,
  runId,
  stepKey,
  requestKey,
}: {
  organizationId: string;
  runId: string;
  stepKey: string;
  requestKey: string;
}) {
  const [state, action] = useActionState<ProcessRunFormState, FormData>(
      proposeWorkflowEmailAction,
      {},
    ),
    prefix = useId(),
    error = useRef<HTMLDivElement>(null),
    values = state.values;
  useEffect(() => {
    if (state.code) error.current?.focus();
  }, [state]);
  return (
    <form
      action={action}
      className="fields"
      aria-label="Propose this step email for approval"
      key={state.revision ?? 0}
    >
      <div ref={error} tabIndex={-1}>
        <ErrorNotice code={state.code} />
      </div>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="stepKey" value={stepKey} />
      <input type="hidden" name="requestKey" value={values?.requestKey ?? requestKey} />
      <label htmlFor={`${prefix}-to`}>Recipients</label>
      <textarea
        id={`${prefix}-to`}
        name="to"
        rows={2}
        maxLength={13000}
        required
        defaultValue={values?.to ?? ''}
        aria-describedby={`${prefix}-to-help`}
      />
      <p className="muted" id={`${prefix}-to-help`}>
        Enter up to 50 email addresses, separated by commas or new lines. These exact recipients are
        shown to the approver.
      </p>
      <label htmlFor={`${prefix}-subject`}>Email subject</label>
      <input
        id={`${prefix}-subject`}
        name="subject"
        maxLength={200}
        required
        defaultValue={values?.subject ?? ''}
      />
      <label htmlFor={`${prefix}-body`}>Email message</label>
      <textarea
        id={`${prefix}-body`}
        name="textBody"
        rows={8}
        maxLength={200000}
        required
        defaultValue={values?.textBody ?? ''}
      />
      <p className="notice">
        This saves the exact email for someone else to approve. Nothing is sent yet. Afterwards,
        follow its approval and delivery from the step’s outside action.
      </p>
      <div>
        <SubmitButton working="Saving the proposal">Propose email for approval</SubmitButton>
      </div>
    </form>
  );
}
