import { AppError } from '@ensemus/application';
import { listMyAnswers } from '@ensemus/application/knowledge/answers';
import Link from 'next/link';
import {
  PageHead,
  Empty,
  ErrorNotice,
  StatusBadge,
  ActionLink,
  formatDateTime,
} from '@/components/ui';
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
  const ask = `/o/${organizationId}/knowledge/ask`,
    empty = !page.items.length;
  return (
    <>
      <PageHead
        title="My answers"
        description="The questions you have asked and their answers. Only you can see them."
        actions={empty ? undefined : <ActionLink href={ask}>Ask a question</ActionLink>}
      />
      <ErrorNotice code={error} />
      {empty ? (
        <Empty title="No questions yet" action={<ActionLink href={ask}>Ask a question</ActionLink>}>
          Ask about your company&rsquo;s documents, and each answer is kept here with the passages
          it came from.
        </Empty>
      ) : (
        <section className="card" aria-labelledby="answers-heading">
          <h2 id="answers-heading" className="visually-hidden">
            Your questions
          </h2>
          <ul className="list">
            {page.items.map((answer) => (
              <li key={answer.id}>
                <div>
                  <Link href={`/o/${organizationId}/knowledge/answers/${answer.id}`}>
                    {answer.question}
                  </Link>
                  <br />
                  <small>Asked {formatDateTime(answer.createdAt)}</small>
                </div>
                <StatusBadge status={answer.state} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {page.next && (
        <p className="link-line">
          <Link href={`?cursor=${encodeURIComponent(page.next)}`}>More answers</Link>
        </p>
      )}
    </>
  );
}
