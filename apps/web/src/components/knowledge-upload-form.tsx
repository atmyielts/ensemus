'use client';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import type { Classification } from '@ensemus/domain/policy';
import type { KnowledgeFormState } from '@/lib/knowledge-form-state';
import {
  sourceSharingChoices,
  sourceSharingChoiceAllowed,
  type SharingPerson,
  type SharingTeam,
} from '@/lib/knowledge-source-view';
import { uploadKnowledgeAction } from '@/server/knowledge-actions';
import { KNOWLEDGE_CLASSES } from './knowledge-view';
import { SubmitButton } from './submit-button';
import { ErrorNotice } from './ui';

/** The server enforces the same class/principal rules. A sensitivity change requires a new explicit
 * sharing choice when the old one becomes ineligible; it never silently drops a promised grant. */
export function KnowledgeUploadForm({
  organizationId,
  requestKey,
  people,
  teams,
}: {
  organizationId: string;
  requestKey: string;
  people: readonly SharingPerson[];
  teams: readonly SharingTeam[];
}) {
  const [state, action] = useActionState<KnowledgeFormState, FormData>(uploadKnowledgeAction, {});
  const [classification, setClassification] = useState<Classification>(() =>
    KNOWLEDGE_CLASSES.some((option) => option.value === state.values?.classification)
      ? (state.values!.classification as Classification)
      : 'restricted',
  );
  const [sharing, setSharing] = useState(() => state.values?.sharing ?? 'private'),
    [title, setTitle] = useState(() => state.values?.title ?? '');
  const prefix = useId(),
    notice = useRef<HTMLDivElement>(null),
    choices = sourceSharingChoices(classification, people, teams),
    selected = choices.some((choice) => choice.value === sharing) ? sharing : '';
  useEffect(() => {
    if (state.code) notice.current?.focus();
  }, [state]);
  return (
    <>
      <div className="form-width" tabIndex={-1} ref={notice}>
        <ErrorNotice code={state.code} />
      </div>
      <form className="card fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="requestKey" value={state.values?.requestKey ?? requestKey} />
        <label htmlFor={prefix + '-title'}>
          <span id={prefix + '-title-label'}>Source name</span>
          <input
            id={prefix + '-title'}
            name="title"
            aria-labelledby={prefix + '-title-label'}
            required
            maxLength={512}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label htmlFor={prefix + '-class'}>
          <span id={prefix + '-class-label'}>Sensitivity</span>
          <select
            id={prefix + '-class'}
            name="classification"
            aria-labelledby={prefix + '-class-label'}
            aria-describedby={prefix + '-class-help'}
            required
            value={classification}
            onChange={(event) => {
              const next = event.currentTarget.value as Classification;
              setClassification(next);
              if (!sourceSharingChoiceAllowed(next, sharing)) setSharing('');
            }}
          >
            {KNOWLEDGE_CLASSES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <small id={prefix + '-class-help'}>
            Choose the strongest sensitivity in the document. Restricted sources can be shared only
            with named people.
          </small>
        </label>
        <label htmlFor={prefix + '-sharing'}>
          <span id={prefix + '-sharing-label'}>Share with</span>
          <select
            id={prefix + '-sharing'}
            name="sharing"
            aria-labelledby={prefix + '-sharing-label'}
            aria-describedby={prefix + '-sharing-help'}
            required
            value={selected}
            onChange={(event) => setSharing(event.currentTarget.value)}
          >
            <option value="">Choose who can read this source</option>
            {choices.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <small id={prefix + '-sharing-help'}>
            {!selected ? 'Choose a sharing option allowed at this sensitivity. ' : ''}You remain a
            named reader. You can manage additional access after adding the source.
          </small>
        </label>
        <noscript>
          <p className="notice">
            To share with a team without JavaScript, add the file first, then use Source access on
            its page. Restricted sources always require named people.
          </p>
        </noscript>
        <label htmlFor={prefix + '-file'}>
          <span id={prefix + '-file-label'}>Document</span>
          <input
            id={prefix + '-file'}
            name="file"
            type="file"
            aria-labelledby={prefix + '-file-label'}
            aria-describedby={prefix + '-file-help'}
            accept=".txt,.md,.csv,.html,.htm,.json"
            required
          />
          <small id={prefix + '-file-help'}>
            Text, Markdown, CSV, HTML or JSON. Up to 25 MB. Choose the file again if a save is
            refused.
          </small>
        </label>
        <div className="row">
          <SubmitButton>Add source</SubmitButton>
        </div>
      </form>
    </>
  );
}
