import { AppError } from '@ensemus/application';
import { listMyAnswers } from '@ensemus/application/knowledge/answers';
import Link from 'next/link';
import { PageHead, Empty, ErrorNotice, StatusBadge, formatDateTime } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'My knowledge answers | Ensemus' };
export default async function AnswersPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { organizationId } = await params,
    { context, database } = await requireTenant(organizationId),
    query = await searchParams;
  let error: string | undefined;
  const page = await listMyAnswers(database, context, {
    ...(query.cursor ? { after: query.cursor } : {}),
  }).catch((failure: unknown) => {
    if (!(failure instanceof AppError) || failure.code !== 'INVALID_INPUT') throw failure;
    error = 'INVALID_INPUT';
    return listMyAnswers(database, context, {});
  });
  return (
    <>
      <PageHead
        title="My answers"
        description="Only your questions and answers that you can still access."
        actions={
          <Link className="button" href={`/o/${organizationId}/knowledge/ask`}>
            Ask a question
          </Link>
        }
      />
      <ErrorNotice code={error} />
      {!page.items.length ? (
        <Empty>No answers are available. Ask a question to start.</Empty>
      ) : (
        <div className="stack">
          {page.items.map((answer) => (
            <article className="card" key={answer.id}>
              <h2>
                <Link href={`/o/${organizationId}/knowledge/answers/${answer.id}`}>
                  {answer.question}
                </Link>
              </h2>
              <StatusBadge status={answer.state} />
              <p className="muted">{formatDateTime(answer.createdAt)}</p>
            </article>
          ))}
        </div>
      )}
      {page.next && <Link href={`?cursor=${encodeURIComponent(page.next)}`}>More answers</Link>}
    </>
  );
}
