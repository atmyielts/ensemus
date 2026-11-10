import { ResourceRefresh } from '@/components/resource-refresh';
import { getAnswer } from '@ensemus/application/knowledge/answers';
import Link from 'next/link';
import { KnowledgeCitation, QuestionSensitivity, costLabel } from '@/components/knowledge-view';
import { PageHead, StatusBadge } from '@/components/ui';
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
    answer = await orNotFound(getAnswer(database, context, answerId));
  return (
    <>
      <Link href={`/o/${organizationId}/knowledge/answers`}>Back to my answers</Link>
      <PageHead title="Knowledge answer" />
      <ResourceRefresh active={['queued', 'running'].includes(answer.state)} />
      <h2 className="pre-wrap">{answer.question}</h2>
      <QuestionSensitivity value={answer.questionClassification} />
      <div>
        <StatusBadge status={answer.state} />
      </div>
      {['queued', 'running'].includes(answer.state) ? (
        <p className="notice" role="status">
          {answer.state === 'queued'
            ? 'Your question is waiting to be processed.'
            : 'An answer is being prepared.'}{' '}
          <Link href={`/o/${organizationId}/knowledge/answers/${answerId}`}>
            Check for an update
          </Link>
        </p>
      ) : answer.state === 'answered' ? (
        <>
          <p className="pre-wrap">{answer.answerText}</p>
          <p className="muted">Model cost: {costLabel(answer.costMicros)}</p>
          <section className="stack" aria-label="Sources for this answer">
            <h2>Sources</h2>
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
            ? 'No suitable source passages were found. Try adding a relevant source or asking more specifically.'
            : answer.state === 'refused'
              ? 'This question could not be answered under the current access and model policy.'
              : 'The answer could not be completed. You can check the source state before asking again.'}
        </p>
      )}
      {answer.refusalCode && (
        <details>
          <summary>Processing details</summary>
          <p>{answer.refusalCode}</p>
        </details>
      )}
      <Link href={`/o/${organizationId}/knowledge/ask`}>Ask another question</Link>
    </>
  );
}
