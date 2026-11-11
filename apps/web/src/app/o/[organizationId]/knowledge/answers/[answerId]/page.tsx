import { ResourceRefresh } from '@/components/resource-refresh';
import { getAnswer } from '@ensemus/application/knowledge/answers';
import Link from 'next/link';
import { KnowledgeCitation, costLabel } from '@/components/knowledge-view';
import {
  PageHead,
  StatusBadge,
  ClassificationBadge,
  ActionLink,
  BackLink,
  formatDateTime,
} from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { knowledgeOrNotFound as orNotFound } from '@/server/knowledge-page';
export const metadata = { title: 'Knowledge answer | Ensemus' };
export default async function AnswerPage({
  params,
}: {
  params: Promise<{ organizationId: string; answerId: string }>;
}) {
  const { organizationId, answerId } = await params,
    { context, database } = await requireTenant(organizationId),
    answer = await orNotFound(getAnswer(database, context, answerId)),
    waiting = ['queued', 'running'].includes(answer.state);
  return (
    <>
      <div>
        <BackLink href={`/o/${organizationId}/knowledge/answers`}>Back to my answers</BackLink>
        <PageHead title={answer.question} />
      </div>
      <ResourceRefresh active={waiting} />
      <div className="detail-layout">
        <div className="stack">
          {waiting ? (
            <p className="notice" role="status">
              {answer.state === 'queued'
                ? 'Your question is waiting its turn. The answer appears here when it is ready.'
                : 'Your answer is being written from your documents now.'}{' '}
              <Link href={`/o/${organizationId}/knowledge/answers/${answerId}`}>
                Check for an update
              </Link>
            </p>
          ) : answer.state === 'answered' ? (
            <>
              <section className="card answer" aria-labelledby="answer-heading">
                <h2 id="answer-heading">Answer</h2>
                <p className="pre-wrap answer-text">{answer.answerText}</p>
              </section>
              <section className="stack" aria-label="Sources for this answer">
                <div className="section-intro">
                  <h2>Where this answer comes from</h2>
                  <p>
                    Each passage is quoted from a document you can read. Open a document to see the
                    passage in its place.
                  </p>
                </div>
                {answer.citations.map((citation) => (
                  <KnowledgeCitation
                    key={citation.ordinal}
                    organizationId={organizationId}
                    citation={citation}
                  />
                ))}
              </section>
            </>
          ) : (
            <p className="notice">
              {answer.state === 'no_evidence'
                ? 'No passage in your documents answers this. Try asking more specifically, or add a document that covers it.'
                : answer.state === 'refused'
                  ? 'This question could not be answered with your current access and the AI models your company allows at its level of privacy.'
                  : 'The answer could not be finished. Check that the documents are still available, then ask again.'}
            </p>
          )}
          {answer.refusalCode && (
            <details>
              <summary>Technical details</summary>
              <p className="technical-reference">{answer.refusalCode}</p>
            </details>
          )}
        </div>
        <aside className="card">
          <dl className="details">
            <div>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={answer.state} />
              </dd>
            </div>
            <div>
              <dt>How private</dt>
              <dd>
                <ClassificationBadge value={answer.questionClassification} />
              </dd>
            </div>
            <div>
              <dt>Asked</dt>
              <dd>{formatDateTime(answer.createdAt)}</dd>
            </div>
            {answer.state === 'answered' && (
              <div>
                <dt>AI model cost</dt>
                <dd>{costLabel(answer.costMicros)}</dd>
              </div>
            )}
          </dl>
          <p className="gap-above-large">
            <ActionLink variant="secondary" href={`/o/${organizationId}/knowledge/ask`}>
              Ask another question
            </ActionLink>
          </p>
        </aside>
      </div>
    </>
  );
}
