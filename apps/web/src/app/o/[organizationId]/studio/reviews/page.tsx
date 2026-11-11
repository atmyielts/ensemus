import { listPublishReviews, type PublishReviewView } from '@ensemus/application/publish-reviews';
import Link from 'next/link';
import {
  ActionLink,
  BackLink,
  Empty,
  PageHead,
  StatusBadge,
  formatDateTime,
} from '@/components/ui';
import { requireStudio, studioRead } from '@/server/studio-pages';

export const metadata = { title: 'Publication reviews | Ensemus' };
const filters = [
  ['all', 'All'],
  ['pending', 'Waiting for a decision'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['cancelled', 'Cancelled'],
  ['published', 'Published'],
] as const;
export default async function ReviewsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { organizationId } = await params;
  const { database, context } = await requireStudio(organizationId);
  const raw = (await searchParams).status ?? 'all';
  const status = filters.find(([key]) => key === raw)?.[0] ?? 'all';
  const reviews = await studioRead(
    listPublishReviews(
      database,
      context,
      status === 'all' ? {} : { status: status as PublishReviewView['status'] },
    ),
  );
  const base = `/o/${organizationId}/studio`;
  return (
    <>
      <BackLink href={base}>Automation Studio</BackLink>
      <PageHead
        title="Publication reviews"
        description="Before an assistant or workflow reaches your team, a colleague reads exactly what was built and approves it. Approving starts nothing; publishing is a separate step."
      />
      <nav className="section-navigation" aria-label="Filter publication reviews">
        {filters.map(([key, label]) => (
          <Link
            key={key}
            href={key === 'all' ? `${base}/reviews` : `${base}/reviews?status=${key}`}
            aria-current={status === key ? 'page' : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
      {reviews.length ? (
        <div className="card">
          <ul className="list" aria-label="Publication reviews">
            {reviews.map((review) => (
              <li key={review.id}>
                <span>
                  <Link href={`${base}/reviews/${review.id}`}>
                    {review.subjectName ??
                      (review.subjectKind === 'agent_draft'
                        ? 'Assistant review'
                        : 'Workflow review')}
                  </Link>
                  <br />
                  <small>
                    {review.subjectKind === 'agent_draft' ? 'Assistant' : 'Workflow'} · Requested{' '}
                    {formatDateTime(review.createdAt)}
                    {review.riskLevel === 'elevated'
                      ? ' · Needs someone other than the requester'
                      : ''}
                  </small>
                </span>
                <StatusBadge status={review.status} />
              </li>
            ))}
          </ul>
          <p className="studio-next-step">The 200 most recent reviews you can read are shown.</p>
        </div>
      ) : (
        <Empty
          title={status === 'all' ? 'No reviews yet' : 'No reviews in this view'}
          action={
            status === 'all' ? (
              <ActionLink href={`${base}/agents`} variant="secondary">
                Go to assistant drafts
              </ActionLink>
            ) : (
              <ActionLink href={`${base}/reviews`} variant="secondary">
                Show all reviews
              </ActionLink>
            )
          }
        >
          {status === 'all'
            ? 'A review starts from a draft once its rehearsal has passed. Open a draft and choose “Ask for a review”.'
            : 'Nothing here has this status right now.'}
        </Empty>
      )}
    </>
  );
}
