import Link from 'next/link';
import { formatDateTime } from './ui';
import type { ReactNode } from 'react';
import { safeKnowledgeSourceUrl, knowledgeCostLabel } from '@/lib/knowledge-view';

export const KNOWLEDGE_CLASSES = [
  { value: 'restricted', label: 'Restricted' },
  { value: 'confidential', label: 'Confidential' },
  { value: 'internal', label: 'Internal' },
  { value: 'public', label: 'Public' },
];

/** A level of privacy with the words that explain it, shown as one described choice. */
export type DescribedChoice = { value: string; label: string; description: string };

/** What each level means for a document. It matches who the document may be shared with. */
const SOURCE_LEVEL_MEANING: Record<string, string> = {
  public: 'Nothing private in it. You can share it with everyone in the company.',
  internal: 'For people in the company. You can share it with everyone here.',
  confidential: 'Business-sensitive. You can share it with named people and teams.',
  restricted: 'The most private. You can share it only with people you name.',
};
/** What each level means for a question someone asks. */
const QUESTION_LEVEL_MEANING: Record<string, string> = {
  public: 'Nothing private in the question.',
  internal: 'Everyday company matters.',
  confidential: 'Business-sensitive details, such as prices, plans or contracts.',
  restricted: 'The most private details, such as personal information about someone.',
};
const LEVEL_ORDER = ['public', 'internal', 'confidential', 'restricted'];
const levelChoices = (meaning: Record<string, string>, allowed?: readonly string[]) =>
  LEVEL_ORDER.filter((value) => !allowed || allowed.includes(value)).map((value) => ({
    value,
    label: KNOWLEDGE_CLASSES.find((option) => option.value === value)?.label ?? value,
    description: meaning[value] ?? '',
  }));
/** Levels for a document, from the most open to the most private. */
export const sourceLevelChoices = (allowed?: readonly string[]) =>
  levelChoices(SOURCE_LEVEL_MEANING, allowed);
/** Levels for a question, from the most open to the most private. */
export const questionLevelChoices = () => levelChoices(QUESTION_LEVEL_MEANING);

/**
 * One radio per choice, each with a line that says what it means. It is a native radio group, so it
 * submits without JavaScript under the same `name` and values a select would.
 */
export function DescribedChoices({
  id,
  name,
  legend,
  help,
  options,
  value,
  defaultValue,
  onChange,
  required = true,
}: {
  id: string;
  name: string;
  legend: string;
  help?: ReactNode;
  options: readonly DescribedChoice[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  required?: boolean;
}) {
  return (
    <fieldset
      className="group described-choices"
      aria-describedby={help ? `${id}-help` : undefined}
    >
      <legend>{legend}</legend>
      {help && <small id={`${id}-help`}>{help}</small>}
      <div className="choice-list">
        {options.map((option) => (
          <label className="choice" key={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              required={required}
              {...(onChange
                ? {
                    checked: value === option.value,
                    onChange: () => onChange(option.value),
                  }
                : { defaultChecked: (value ?? defaultValue) === option.value })}
            />
            <strong>{option.label}</strong>
            <small>{option.description}</small>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SourceLink({ url, children }: { url: string | null; children?: ReactNode }) {
  const safe = safeKnowledgeSourceUrl(url);
  if (!safe) return null;
  return (
    <a href={safe} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer">
      {children ?? 'Open original source'}
    </a>
  );
}

/** A passage an answer or fact rests on: the words first, then where they came from and how fresh. */
export function KnowledgeCitation({
  organizationId,
  citation,
}: {
  organizationId: string;
  citation: {
    sourceId: string;
    title: string;
    excerpt: string;
    freshness?: string;
    sourceVersion?: string | null;
    sourceModifiedAt?: Date | null;
    sourceUrl?: string | null;
  };
}) {
  const superseded = citation.freshness === 'superseded';
  return (
    <article className="card citation">
      <blockquote className="pre-wrap">{citation.excerpt}</blockquote>
      <footer className="citation-source">
        <h3>
          <Link href={`/o/${organizationId}/knowledge/sources/${citation.sourceId}`}>
            {citation.title}
          </Link>
        </h3>
        <p className="muted">
          {superseded ? 'From an earlier version of this document' : 'From the current version'}
          {citation.sourceVersion ? <> (version {citation.sourceVersion})</> : null}
          {citation.sourceModifiedAt ? (
            <> · last changed {formatDateTime(citation.sourceModifiedAt)}</>
          ) : null}
        </p>
        {superseded && (
          <p className="notice warn flush">
            A newer version of this document has arrived since. Check this passage before you rely
            on it.
          </p>
        )}
        <SourceLink url={citation.sourceUrl ?? null} />
      </footer>
    </article>
  );
}
export const costLabel = knowledgeCostLabel;
