import {
  AppError,
  listExternalActions,
  listExternalActionsNeedingReview,
  type ExternalActionSummary,
} from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReceiptStatusBadge } from '@/components/receipt-status';
import { Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'External actions | Ensemus' };

function ActionRow({ base, action }: { base: string; action: ExternalActionSummary }) {
  return (
    <li>
      <span>
        <Link href={`${base}/external-actions/${action.id}`}>
          {action.subject ?? 'An action outside Ensemus'}
        </Link>{' '}
        <small>
          For <Link href={`${base}/work/${action.workUnitId}`}>{action.workTitle}</Link>,{' '}
          {formatDateTime(action.updatedAt)}
        </small>
      </span>
      <ReceiptStatusBadge status={action.status} statusReason={action.statusReason} />
    </li>
  );
}

export default async function ExternalActionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; after?: string }>;
}) {
  const { organizationId } = await params;
  const { error, after } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const base = `/o/${organizationId}`;
  const [needingReview, page] = await Promise.all([
    listExternalActionsNeedingReview(database, context),
    // A cursor only ever comes from the link below, so one that does not read is a bad address.
    listExternalActions(database, context, after ? { after } : {}).catch((failure: unknown) => {
      if (failure instanceof AppError && failure.code === 'INVALID_INPUT') notFound();
      throw failure;
    }),
  ]);
  const manages = can(context.role, 'connection.manage');

  return (
    <>
      <PageHead
        title="External actions"
        description="What Ensemus was asked to do outside itself, on work you can see, and what is known about how each one went."
        actions={
          manages ? (
            <Link className="button quiet" href={`${base}/connections`}>
              Connections
            </Link>
          ) : undefined
        }
      />
      <ErrorNotice code={error} />
      <div className="stack">
        {needingReview.length > 0 && (
          <section className="card" aria-labelledby="decision-heading">
            <h2 id="decision-heading">Needs a decision</h2>
            <p className="notice unknown">
              Nobody can say whether these were sent, and Ensemus will not try them again by itself.
              Open each one to see what to look for, then say what you found.
            </p>
            <ul className="list">
              {needingReview.map((action) => (
                <ActionRow key={action.id} base={base} action={action} />
              ))}
            </ul>
          </section>
        )}
        <section className="card" aria-labelledby="everything-heading">
          <h2 id="everything-heading">Everything you can see</h2>
          {page.items.length === 0 ? (
            <Empty action={<Link href={`${base}/work`}>Go to your work</Link>}>
              {after
                ? 'Nothing further.'
                : 'Nothing yet. An email proposed on a piece of work appears here, once someone proposes one.'}
            </Empty>
          ) : (
            <ul className="list">
              {page.items.map((action) => (
                <ActionRow key={action.id} base={base} action={action} />
              ))}
            </ul>
          )}
          {page.next && (
            <p className="gap-above">
              <Link href={`${base}/external-actions?after=${encodeURIComponent(page.next)}`}>
                Show older ones
              </Link>
            </p>
          )}
        </section>
      </div>
    </>
  );
}
