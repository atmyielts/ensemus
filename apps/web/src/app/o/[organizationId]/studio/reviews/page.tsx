import { listPublishReviews, type PublishReviewView } from '@ensemus/application/publish-reviews';
import Link from 'next/link';
import { BackLink, Empty, PageHead, StatusBadge, formatDateTime } from '@/components/ui';
import { requireStudio, studioRead } from '@/server/studio-pages';

export const metadata = { title: 'Publication reviews | Ensemus' };
const filters = [ ['all', 'All reviews'], ['pending', 'Waiting for a decision'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'], ['published', 'Published'] ] as const;
export default async function ReviewsPage({ params, searchParams }: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { organizationId } = await params;
  const { database, context } = await requireStudio(organizationId);
  const raw = (await searchParams).status ?? 'all';
  const status = filters.find(([key]) => key === raw)?.[0] ?? 'all';
  const reviews = await studioRead(listPublishReviews(database, context, status === 'all' ? {} : { status: status as PublishReviewView['status'] }));
  const base = `/o/${organizationId}/studio`;
  return <>
    <BackLink href={base}>Automation Studio</BackLink>
    <PageHead title="Publication reviews" description="Read the frozen definition, decide explicitly, then publish only what was approved. Reviewing starts no run." />
    <nav aria-label="Filter publication reviews"><ul className="actions">{filters.map(([key, label]) => <li key={key}><Link href={key === 'all' ? `${base}/reviews` : `${base}/reviews?status=${key}`} aria-current={status === key ? 'page' : undefined}>{label}</Link></li>)}</ul></nav>
    {reviews.length ? <><ul className="list" aria-label="Publication reviews">{reviews.map(review => <li key={review.id}><div><Link href={`${base}/reviews/${review.id}`}><strong>{review.subjectName ?? (review.subjectKind === 'agent_draft' ? 'Assistant definition review' : 'Workflow definition review')}</strong></Link><p className="muted">{review.subjectKind === 'agent_draft' ? 'Assistant' : 'Workflow'} · Requested {formatDateTime(review.createdAt)} · {review.riskLevel === 'elevated' ? 'Independent reviewer required' : 'Standard review'}</p></div><StatusBadge status={review.status} /></li>)}</ul><p className="muted">Up to 200 recent readable reviews are shown. Permission checks apply before the limit.</p></> : <Empty title="No reviews in this view">Request a review from a saved draft after its required fixed scenario has passed.</Empty>}
  </>;
}
