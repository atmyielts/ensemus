'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef } from 'react';
import type { NewWorkFormState } from '@/lib/form-state';
import { createWorkFormAction } from '@/server/work-actions';
import { SubmitButton } from './submit-button';
import { ErrorNotice } from './ui';

// Each sentence states what the permission rules in @ensemus/domain/policy actually do.
const SENSITIVITY = [
  {
    value: 'public',
    label: 'Public',
    who: 'Everyone in this organization. Nothing in it is secret.',
  },
  { value: 'internal', label: 'Internal', who: 'Everyone in this organization.' },
  {
    value: 'confidential',
    label: 'Confidential',
    who: 'The people on this work, plus organization owners and admins.',
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
          Objective
          <small>Optional. Any detail someone needs to do this well.</small>
          <textarea name="objective" maxLength={10000} defaultValue={values?.objective ?? ''} />
        </label>
        <label>
          Due date
          <small>Optional. The whole of that day, in UTC.</small>
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
        <div style={{ display: 'grid', gap: '0.375rem' }}>
          <label>
            Sensitivity
            <small>Who can see this work and its files. It cannot be changed afterwards.</small>
            <select
              key={values?.classification ?? ''}
              name="classification"
              defaultValue={values?.classification ?? 'internal'}
              aria-describedby="sensitivity"
            >
              {SENSITIVITY.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <dl id="sensitivity">
            {SENSITIVITY.map((option) => (
              <div key={option.value} style={{ display: 'contents' }}>
                <dt>{option.label}</dt>
                <dd>{option.who}</dd>
              </div>
            ))}
          </dl>
        </div>
        <fieldset className="group">
          <legend>How will we know it is done?</legend>
          <small>
            Work cannot be marked done until what you tick here is true. With nothing ticked, its
            accountable owner has to confirm it themselves.
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
        <fieldset className="group">
          <legend>Plan</legend>
          <label className="check">
            <input
              type="checkbox"
              name="executionPlan"
              value="checklist"
              defaultChecked={values?.executionPlan ?? false}
            />
            Ensemus runs the checklist plan
          </label>
          <small>
            Only once someone presses Run the plan. Ensemus then adds a checklist file, asks for a
            review if a reviewer must approve, and sends the work for checking. It never marks the
            work done: a person does that once the evidence is there. Without a plan, people do the
            work and update its status.
          </small>
        </fieldset>
        <div className="row">
          <SubmitButton>Create work</SubmitButton>
          <Link className="button quiet" href={`/o/${organizationId}/work`}>
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
