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
import { DescribedChoices, KNOWLEDGE_CLASSES, sourceLevelChoices } from './knowledge-view';
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
      <div className="form-width form-notice" tabIndex={-1} ref={notice}>
        <ErrorNotice code={state.code} />
      </div>
      <form className="card fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="requestKey" value={state.values?.requestKey ?? requestKey} />
        <label htmlFor={prefix + '-file'}>
          <span id={prefix + '-file-label'}>Document</span>
          <small id={prefix + '-file-help'}>
            Text, Markdown, CSV, HTML or JSON, up to 25 MB. If saving fails, choose the file again.
          </small>
          <input
            id={prefix + '-file'}
            name="file"
            type="file"
            aria-labelledby={prefix + '-file-label'}
            aria-describedby={prefix + '-file-help'}
            accept=".txt,.md,.csv,.html,.htm,.json"
            required
          />
        </label>
        <label htmlFor={prefix + '-title'}>
          <span id={prefix + '-title-label'}>Source name</span>
          <small id={prefix + '-title-help'}>
            The name people will see in search results and answers.
          </small>
          <input
            id={prefix + '-title'}
            name="title"
            aria-labelledby={prefix + '-title-label'}
            aria-describedby={prefix + '-title-help'}
            required
            maxLength={512}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <div className="form-section">
          <DescribedChoices
            id={prefix + '-class'}
            name="classification"
            legend="Who can see this"
            help="Choose the level of the most private thing in the document."
            options={sourceLevelChoices()}
            value={classification}
            onChange={(next) => {
              setClassification(next as Classification);
              if (!sourceSharingChoiceAllowed(next as Classification, sharing)) setSharing('');
            }}
          />
          <label htmlFor={prefix + '-sharing'}>
            <span id={prefix + '-sharing-label'}>Share with</span>
            <small id={prefix + '-sharing-help'}>
              {!selected ? 'Choose someone this level allows. ' : ''}You can always read it
              yourself, and you can add more people after it is saved.
            </small>
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
          </label>
          <noscript>
            <p className="notice">
              To share with a team without JavaScript, add the document first, then use Source
              access on its page. Restricted documents can only be shared with people you name.
            </p>
          </noscript>
        </div>
        <div className="row">
          <SubmitButton>Add source</SubmitButton>
        </div>
      </form>
    </>
  );
}
