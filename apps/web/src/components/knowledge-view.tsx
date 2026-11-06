import Link from 'next/link';
import { ClassificationBadge, formatDateTime } from './ui';
import type { ReactNode } from 'react';
import { safeKnowledgeSourceUrl, knowledgeCostLabel } from '@/lib/knowledge-view';

export const KNOWLEDGE_CLASSES = [
  { value: 'restricted', label: 'Restricted' },
  { value: 'confidential', label: 'Confidential' },
  { value: 'internal', label: 'Internal' },
  { value: 'public', label: 'Public' },
];
export function SourceLink({ url, children }: { url: string | null; children?: ReactNode }) {
  const safe = safeKnowledgeSourceUrl(url);
  if (!safe) return null;
  return (
    <a href={safe} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer">
      {children ?? 'Open original source'}
    </a>
  );
}
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
  return (
    <article className="card">
      <h3>
        <Link href={`/o/${organizationId}/knowledge/sources/${citation.sourceId}`}>
          {citation.title}
        </Link>
      </h3>
      <blockquote className="pre-wrap">{citation.excerpt}</blockquote>
      <p className="muted">
        {citation.freshness === 'superseded'
          ? 'A newer source version is available. Review this passage before using it.'
          : 'Source passage'}
        {citation.sourceModifiedAt ? ` · Updated ${formatDateTime(citation.sourceModifiedAt)}` : ''}
      </p>
      {citation.sourceVersion && <p className="muted">Version {citation.sourceVersion}</p>}
      <SourceLink url={citation.sourceUrl ?? null} />
    </article>
  );
}
export function QuestionSensitivity({ value }: { value: string }) {
  return (
    <p>
      Question sensitivity: <ClassificationBadge value={value} />
    </p>
  );
}
export const costLabel = knowledgeCostLabel;
