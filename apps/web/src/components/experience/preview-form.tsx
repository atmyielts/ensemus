'use client';
import { useActionState, useEffect, useId, useRef } from 'react';
import type { OutcomeDraftView } from '@ensemus/application/outcomes';
import Link from 'next/link';
import { reviseOutcomeAction } from '@/server/experience-actions';
import { SubmitButton } from '../submit-button';
import { ErrorNotice } from '../ui';
export function PreviewForm({
  organizationId,
  draft,
  people,
  dependencies,
  processes,
  nextDependenciesHref,
}: {
  organizationId: string;
  draft: OutcomeDraftView;
  people: { id: string; name: string }[];
  dependencies: { id: string; title: string }[];
  processes: { key: string; name: string }[];
  nextDependenciesHref: string | null;
}) {
  const [state, action] = useActionState(reviseOutcomeAction, {}),
    prefix = useId(),
    notice = useRef<HTMLDivElement>(null),
    p = draft.preview;
  useEffect(() => {
    if (state.code) notice.current?.focus();
  }, [state]);
  const value = (key: string, initial = '') =>
    typeof state.values?.[key] === 'string' ? (state.values[key] as string) : initial;
  const selected = Array.isArray(state.values?.dependency)
    ? state.values.dependency
    : p.dependencyWorkUnitIds;
  const criteria = [
    ...p.successCriteria,
    ...(p.successCriteria.length < 20 ? [{ kind: 'none' as const, label: '' }] : []),
  ];
  return (
    <form action={action} className="card fields" key={state.revision ?? 0}>
      <h2>Edit the preview</h2>
      <div ref={notice} tabIndex={-1}>
        <ErrorNotice code={state.code} />
      </div>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="draftId" value={draft.id} />
      <input type="hidden" name="version" value={draft.version} />
      <label htmlFor={`${prefix}-title`}>Work title</label>
      <input
        id={`${prefix}-title`}
        name="title"
        required
        maxLength={200}
        defaultValue={value('title', p.title)}
      />
      <label htmlFor={`${prefix}-objective`}>Outcome</label>
      <textarea
        id={`${prefix}-objective`}
        name="objective"
        required
        maxLength={2000}
        rows={4}
        defaultValue={value('objective', p.objective)}
      />
      <label htmlFor={`${prefix}-due`}>Due date (optional)</label>
      <input
        id={`${prefix}-due`}
        name="dueAt"
        type="date"
        defaultValue={value('dueAt', p.dueAt ?? '')}
        aria-describedby={`${prefix}-due-help`}
      />
      <p id={`${prefix}-due-help`} className="muted">
        A date without a time. Unclear dates stay empty until you choose one.
      </p>
      <label htmlFor={`${prefix}-owner`}>Accountable owner</label>
      <select
        id={`${prefix}-owner`}
        name="ownerMembershipId"
        required
        defaultValue={value('ownerMembershipId', p.ownerMembershipId)}
      >
        {!people.some((person) => person.id === p.ownerMembershipId) && (
          <option value={p.ownerMembershipId}>
            Previously selected person is no longer active
          </option>
        )}
        {people.map((person) => (
          <option value={person.id} key={person.id}>
            {person.name}
          </option>
        ))}
      </select>
      <label htmlFor={`${prefix}-class`}>Sensitivity</label>
      <select
        id={`${prefix}-class`}
        name="classification"
        defaultValue={value('classification', p.classification)}
      >
        {['public', 'internal', 'confidential', 'restricted'].map((c) => (
          <option key={c} value={c}>
            {c.charAt(0).toUpperCase() + c.slice(1)}
          </option>
        ))}
      </select>
      <label htmlFor={`${prefix}-process`}>Related workflow suggestion (optional)</label>
      <select
        id={`${prefix}-process`}
        name="suggestedProcessKey"
        defaultValue={value('suggestedProcessKey', p.suggestedProcessKey ?? '')}
        aria-describedby={`${prefix}-process-help`}
      >
        <option value="">No workflow suggestion</option>
        {processes.map((process) => (
          <option value={process.key} key={process.key}>
            {process.name}
          </option>
        ))}
      </select>
      <p id={`${prefix}-process-help`} className="muted">
        A suggestion for later. Confirming this preview creates ordinary Work and does not start
        this workflow.
      </p>
      <fieldset>
        <legend>Success requirements</legend>
        <p className="muted">
          File attached; a person checks the requested name and content. Approval is required only
          if you select reviewer approval. A manual check adds no automatic completion test.
        </p>
        {criteria.map((c, i) => (
          <div key={i} className="fields">
            <label htmlFor={`${prefix}-criterion-${i}`}>
              {i < p.successCriteria.length
                ? `Requirement ${i + 1}`
                : 'Add a requirement (optional)'}
            </label>
            <input
              id={`${prefix}-criterion-${i}`}
              name={`criterion_${i}_label`}
              maxLength={200}
              defaultValue={value(`criterion_${i}_label`, c.label)}
            />
            <label htmlFor={`${prefix}-kind-${i}`}>How requirement {i + 1} is checked</label>
            <select
              id={`${prefix}-kind-${i}`}
              name={`criterion_${i}_kind`}
              defaultValue={value(`criterion_${i}_kind`, c.kind)}
            >
              <option value="none">A person checks it</option>
              <option value="artifact_named">A file is attached; a person checks it</option>
              <option value="reviewer_approved">Current Work review is approved</option>
            </select>
            {i < p.successCriteria.length && (
              <label className="check">
                <input
                  type="checkbox"
                  name={`criterion_${i}_keep`}
                  value="yes"
                  defaultChecked={state.values ? value(`criterion_${i}_keep`) === 'yes' : true}
                />
                Keep requirement {i + 1}
              </label>
            )}
          </div>
        ))}
      </fieldset>
      <fieldset>
        <legend>Work that must finish first</legend>
        <p className="muted">
          Browse 50 readable items at a time. Saved selections remain shown on every page. Save
          changes before browsing; access is checked again when you save and confirm.
        </p>
        {dependencies.length ? (
          dependencies.map((work) => (
            <label className="check" key={work.id}>
              <input
                type="checkbox"
                name="dependency"
                value={work.id}
                defaultChecked={selected.includes(work.id)}
              />
              {work.title}
            </label>
          ))
        ) : (
          <p>No readable Work is available to select.</p>
        )}
        {nextDependenciesHref && (
          <Link href={nextDependenciesHref}>
            Browse the next prerequisites (save changes first)
          </Link>
        )}
      </fieldset>
      <div>
        <SubmitButton working="Saving the preview">Save changes and review again</SubmitButton>
      </div>
    </form>
  );
}
