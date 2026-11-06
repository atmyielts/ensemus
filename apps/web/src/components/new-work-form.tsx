'use client';

import Link from 'next/link';
import { useActionState } from 'react';
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

const groupStyle = { border: 0, margin: 0, padding: 0, display: 'grid', gap: '0.375rem' };
const legendStyle = { padding: 0, fontWeight: 540 };

const INITIAL: NewWorkFormState = {};

/** The new work form. A refused save comes back with everything typed, and names the field at fault. */
export function NewWorkForm({
  organizationId,
  projects,
}: {
  organizationId: string;
  projects: Array<{ id: string; name: string; clientName: string | null }>;
}) {
  const [state, action] = useActionState(createWorkFormAction, INITIAL);
  const values = state.values;
  const ticked = (kind: string) => values?.criteria.includes(kind) ?? false;

  return (
    <>
      <ErrorNotice code={state.code} />
      <form className="card fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
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
            <select name="projectId" defaultValue={values?.projectId ?? ''}>
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
        <fieldset style={groupStyle}>
          <legend style={legendStyle}>How will we know it is done?</legend>
          <small>Optional. Work cannot be marked done until what you tick here is true.</small>
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
        </fieldset>
        <fieldset style={groupStyle}>
          <legend style={legendStyle}>Plan</legend>
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
