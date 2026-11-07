'use client';
import { useActionState, useEffect, useId, useRef } from 'react';
import { composeOutcomeAction } from '@/server/experience-actions';
import { SubmitButton } from '../submit-button';
import { ErrorNotice } from '../ui';
export function ComposeForm({
  organizationId,
  requestKey,
  today,
}: {
  organizationId: string;
  requestKey: string;
  today: string;
}) {
  const [state, action] = useActionState(composeOutcomeAction, {}),
    prefix = useId(),
    notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.code) notice.current?.focus();
  }, [state]);
  const text = (key: string, initial = '') =>
    typeof state.values?.[key] === 'string' ? (state.values[key] as string) : initial;
  return (
    <form action={action} className="card fields form-width" key={state.revision ?? 0}>
      <div tabIndex={-1} ref={notice}>
        <ErrorNotice code={state.code} />
      </div>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="requestKey" value={text('requestKey', requestKey)} />
      <label htmlFor={`${prefix}-objective`}>What outcome do you want?</label>
      <textarea
        id={`${prefix}-objective`}
        name="objective"
        minLength={3}
        maxLength={2000}
        required
        rows={5}
        defaultValue={text('objective')}
        aria-describedby={`${prefix}-objective-help`}
      />
      <p id={`${prefix}-objective-help`} className="muted">
        Write it in your own words. This saves a private preview. Nothing runs and no message is
        sent.
      </p>
      <label htmlFor={`${prefix}-today`}>Today where you are</label>
      <input
        id={`${prefix}-today`}
        type="date"
        name="today"
        required
        defaultValue={text('today', today)}
        aria-describedby={`${prefix}-today-help`}
      />
      <p id={`${prefix}-today-help`} className="muted">
        Check this date. Words such as tomorrow and Friday use this value.
      </p>
      <div>
        <SubmitButton working="Preparing the preview">Review a private preview</SubmitButton>
      </div>
    </form>
  );
}
