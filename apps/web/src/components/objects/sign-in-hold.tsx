'use client';
import { useEffect, useRef } from 'react';
import type { ObjectFormState } from '@/lib/object-input';
import {
  objectEditorDestination,
  objectSubmissionMatches,
  type ObjectEditorScope,
} from '@/lib/object-editor';
import { ActionLink, ErrorNotice, ReloadLink } from '../ui';
import { SubmitButton } from '../submit-button';
/** No schema/source props, fetches, persistence, or blank invented editor. Only this POST's values. */
export function ObjectSignInHold({
  scope,
  state,
  action,
}: {
  scope: ObjectEditorScope;
  state: ObjectFormState;
  action: (form: FormData) => void;
}) {
  const notice = useRef<HTMLDivElement>(null),
    submitted = state.code === 'SSO_REQUIRED' && objectSubmissionMatches(scope, state.values),
    values = submitted ? state.values : undefined;
  useEffect(() => {
    if (submitted) notice.current?.focus();
  }, [submitted, state.revision]);
  const label =
    values?.intent === 'add-field'
      ? 'Retry adding the field'
      : values?.intent === 'add-relation'
        ? 'Retry adding the connection'
        : 'Retry these changes';
  return (
    <section className="fields" aria-label="Company sign-in needed">
      <div ref={notice} tabIndex={-1}>
        <ErrorNotice code="SSO_REQUIRED" />
      </div>
      <p>
        {submitted
          ? 'Your submitted values are held on this page. No changes have been saved. Verify company sign-in in another tab, then return here to retry with the original version.'
          : 'Verify company sign-in before opening this editor. No record or field layout has been loaded.'}
      </p>
      <div>
        <ActionLink href="/sign-in/sso" target="_blank" variant="secondary">
          Verify company sign-in in another tab
        </ActionLink>
      </div>
      {values && (
        <>
          <details>
            <summary>Review the submitted values</summary>
            <p>
              These are the values you submitted, without loading the saved record or field layout.
            </p>
            <dl className="facts">
              {Object.entries(values).map(([name, value]) => (
                <div key={name}>
                  <dt>
                    <code>{name}</code>
                  </dt>
                  <dd>{value || 'Blank'}</dd>
                </div>
              ))}
            </dl>
          </details>
          <form
            action={action}
            key={state.revision ?? 0}
            className="fields"
            aria-label="Retry submitted changes"
          >
            {Object.entries(values).map(([name, value]) => (
              <input type="hidden" key={name} name={name} value={value} />
            ))}
            <SubmitButton working="Checking sign-in and retrying">{label}</SubmitButton>
          </form>
        </>
      )}
      <p>
        <ReloadLink href={objectEditorDestination(scope)}>
          {submitted
            ? 'Discard submitted values and open the original page'
            : 'Open the original page after verification'}
        </ReloadLink>
      </p>
    </section>
  );
}
