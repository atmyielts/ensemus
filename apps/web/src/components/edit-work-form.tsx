'use client';

import { useActionState, useState } from 'react';
import type { WorkDraft, WorkFormState } from '@/lib/form-state';
import { updateWorkFormAction } from '@/server/work-actions';
import { SubmitButton } from './submit-button';
import { ErrorNotice } from './ui';

const INITIAL: WorkFormState = {};

const sameContent = (a: WorkDraft, b: WorkDraft) =>
  a.title === b.title && a.objective === b.objective && a.dueAt === b.dueAt;

const contentOf = ({ title, objective, dueAt }: WorkDraft): WorkDraft => ({
  title,
  objective,
  dueAt,
});

type Latest = WorkDraft & { version: number };

/**
 * Edits a Work Unit's details without ever discarding what someone typed. The saved version stays the
 * one this draft started from, so a change made meanwhile is refused, not overwritten. When the page
 * refreshes underneath, a status change just moves the draft on to the new version, and a change to
 * the same text is explained, with both versions in view, for the person to decide.
 */
export function EditWorkForm({
  organizationId,
  workId,
  current,
}: {
  organizationId: string;
  workId: string;
  current: Latest;
}) {
  const [state, action] = useActionState(updateWorkFormAction, INITIAL);
  const [draft, setDraft] = useState<WorkDraft>(state.values ?? contentOf(current));
  const [base, setBase] = useState<Latest>(current);
  const [seen, setSeen] = useState<WorkFormState>(INITIAL);

  // The server refused because of a newer version. Saving again now is a knowing choice.
  if (state !== seen) {
    setSeen(state);
    if (state.latest) setBase(state.latest);
  }

  if (current.version > base.version) {
    const moved = !sameContent(base, current);
    const edited = !sameContent(draft, base);
    if (!edited) {
      setBase(current);
      setDraft(contentOf(current));
    } else if (!moved || sameContent(draft, current)) {
      setBase(current);
    }
  }

  const changedUnderneath =
    current.version > base.version &&
    !sameContent(base, current) &&
    !sameContent(draft, base) &&
    !sameContent(draft, current);
  const conflict: WorkDraft | null = changedUnderneath
    ? current
    : state.code === 'VERSION_CONFLICT' && state.latest
      ? state.latest
      : null;

  const set = (name: keyof WorkDraft) => (event: { target: { value: string } }) =>
    setDraft((previous) => ({ ...previous, [name]: event.target.value }));

  return (
    <form className="fields" action={action} style={{ marginTop: '0.75rem' }}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="id" value={workId} />
      <input type="hidden" name="version" value={base.version} />
      {state.code !== 'VERSION_CONFLICT' && <ErrorNotice code={state.code} />}
      {conflict && (
        <div className="notice warn" role="status">
          <p style={{ marginTop: 0 }}>
            This changed while you were editing. Your text is still below. Saving replaces what is
            there now:
          </p>
          <dl>
            <dt>Title</dt>
            <dd>{conflict.title}</dd>
            <dt>Objective</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{conflict.objective || 'None'}</dd>
            <dt>Due date</dt>
            <dd>{conflict.dueAt || 'None'}</dd>
          </dl>
          {changedUnderneath && (
            <button className="quiet" type="button" onClick={() => setBase(current)}>
              Keep my text
            </button>
          )}
        </div>
      )}
      <label>
        Title
        {state.field === 'title' && (
          <small className="field-error" id="edit-title-error">
            Write what should be true when this is done.
          </small>
        )}
        <input
          name="title"
          required
          maxLength={300}
          value={draft.title}
          onChange={set('title')}
          aria-invalid={state.field === 'title'}
          aria-describedby={state.field === 'title' ? 'edit-title-error' : undefined}
        />
      </label>
      <label>
        Objective
        <textarea
          name="objective"
          maxLength={10000}
          value={draft.objective}
          onChange={set('objective')}
        />
      </label>
      <label>
        Due date
        <small>The whole of that day, in UTC.</small>
        {state.field === 'dueAt' && (
          <small className="field-error" id="edit-due-error">
            That is not a date.
          </small>
        )}
        <input
          name="dueAt"
          type="date"
          value={draft.dueAt}
          onChange={set('dueAt')}
          aria-invalid={state.field === 'dueAt'}
          aria-describedby={state.field === 'dueAt' ? 'edit-due-error' : undefined}
        />
      </label>
      <div>
        <SubmitButton>Save changes</SubmitButton>
      </div>
    </form>
  );
}
