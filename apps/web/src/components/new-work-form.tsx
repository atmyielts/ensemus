'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef } from 'react';
import type { NewWorkFormState } from '@/lib/form-state';
import { createWorkFormAction } from '@/server/work-actions';
import { SubmitButton } from './submit-button';
import { ErrorNotice } from './ui';

// Each sentence states what the permission rules in @ensemus/domain/policy actually do.
const WHO_CAN_SEE = [
  {
    value: 'public',
    label: 'Public',
    who: 'Everyone in your organization. Nothing in it is secret.',
  },
  { value: 'internal', label: 'Internal', who: 'Everyone in your organization.' },
  {
    value: 'confidential',
    label: 'Confidential',
    who: 'Only the people on this work, plus your organization’s owners and admins.',
  },
  {
    value: 'restricted',
    label: 'Restricted',
    who: 'Only the people on this work. Owners and admins cannot see it unless they are on it.',
  },
];

const INITIAL: NewWorkFormState = {};

/** The new work form. A refused save comes back with everything typed, and names the field at fault. */
export function NewWorkForm({
  organizationId,
  projects,
  requestKey,
  canAskForReceipt = false,
}: {
  organizationId: string;
  /** One rendered form makes one piece of work, however many times it is sent. */
  requestKey: string;
  projects: Array<{ id: string; name: string; clientName: string | null }>;
  /** Whether this organization has a connection that could give an outside system's receipt. */
  canAskForReceipt?: boolean;
}) {
  const [state, action] = useActionState(createWorkFormAction, INITIAL);
  const form = useRef<HTMLFormElement>(null);
  const notice = useRef<HTMLDivElement>(null);
  // The button is at the bottom and the problem is usually at the top, so go to where it is.
  useEffect(() => {
    if (!state.code) return;
    const field = state.field ? form.current?.elements.namedItem(state.field) : null;
    if (field instanceof HTMLElement) field.focus();
    else notice.current?.scrollIntoView();
  }, [state]);
  const values = state.values;
  const ticked = (kind: string) => values?.criteria.includes(kind) ?? false;

  return (
    <>
      <div className="form-width" ref={notice}>
        <ErrorNotice code={state.code} />
      </div>
      <form ref={form} className="card fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <label>
          What should be true when this is done?
          <small>A short title, such as “The spring brochure is printed”.</small>
          {state.field === 'title' && (
            <small className="field-error" id="title-error">
              Write what should be true when this is done. It cannot be only spaces.
            </small>
          )}
          <input
            name="title"
            required
            maxLength={300}
            autoComplete="off"
            defaultValue={values?.title ?? ''}
            aria-invalid={state.field === 'title'}
            aria-describedby={state.field === 'title' ? 'title-error' : undefined}
          />
        </label>
        <label>
          Details
          <small>Optional. Anything someone needs to know to do this well.</small>
          <textarea name="objective" maxLength={10000} defaultValue={values?.objective ?? ''} />
        </label>
        <label>
          Due date
          <small>Optional.</small>
          {state.field === 'dueAt' && (
            <small className="field-error" id="due-error">
              That is not a date.
            </small>
          )}
          <input
            name="dueAt"
            type="date"
            defaultValue={values?.dueAt ?? ''}
            aria-invalid={state.field === 'dueAt'}
            aria-describedby={state.field === 'dueAt' ? 'due-error' : undefined}
          />
        </label>
        {projects.length > 0 && (
          <label>
            Project
            <small>Optional.</small>
            {/* The key brings a refused choice back: React only reads defaultValue on a new select. */}
            <select
              key={values?.projectId ?? ''}
              name="projectId"
              defaultValue={values?.projectId ?? ''}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.clientName ? `${project.name} (${project.clientName})` : project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="form-section">
          <h2 id="who-can-see-heading">Who can see this</h2>
          <fieldset
            className="group"
            aria-labelledby="who-can-see-heading"
            aria-describedby="who-can-see-help"
          >
            <small id="who-can-see-help">
              This covers the work and its files, and it cannot be changed afterwards.
            </small>
            <div className="choice-list">
              {WHO_CAN_SEE.map((option) => (
                <label key={option.value} className="choice">
                  <input
                    type="radio"
                    name="classification"
                    value={option.value}
                    required
                    defaultChecked={(values?.classification ?? 'internal') === option.value}
                  />
                  <strong>{option.label}</strong>
                  <small>{option.who}</small>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="form-section">
          <h2 id="done-when-heading">Done when</h2>
          <fieldset
            className="group"
            aria-labelledby="done-when-heading"
            aria-describedby="done-when-help"
          >
            <small id="done-when-help">
              It cannot be marked done until what you tick is true. Tick nothing, and its owner
              confirms it themselves.
            </small>
            <label className="check">
              <input
                type="checkbox"
                name="criteria"
                value="artifact_exists"
                defaultChecked={ticked('artifact_exists')}
              />
              Someone attaches a file
            </label>
            <label className="check">
              <input
                type="checkbox"
                name="criteria"
                value="reviewer_approved"
                defaultChecked={ticked('reviewer_approved')}
              />
              A reviewer approves
            </label>
            {/* Only with a connection that can act. With none, nothing could ever satisfy it. */}
            {canAskForReceipt && (
              <label className="check">
                <input
                  type="checkbox"
                  name="criteria"
                  value="external_receipt"
                  defaultChecked={ticked('external_receipt')}
                />
                The outside system confirms it happened
              </label>
            )}
          </fieldset>
        </div>
        <div className="form-section">
          <h2 id="plan-heading">How it gets done</h2>
          <fieldset className="group" aria-labelledby="plan-heading" aria-describedby="plan-help">
            <label className="check">
              <input
                type="checkbox"
                name="executionPlan"
                value="checklist"
                defaultChecked={values?.executionPlan ?? false}
              />
              Ensemus runs the checklist plan
            </label>
            <small id="plan-help">
              Leave this off and people do the work and update it. Turn it on and, once someone
              presses Run the plan, Ensemus adds a checklist, asks for any review and sends the work
              for checking. A person still marks it done.
            </small>
          </fieldset>
        </div>
        <div className="row">
          <SubmitButton>Create work</SubmitButton>
          <Link className="button secondary" href={`/o/${organizationId}/work`}>
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
