import { listMyPendingApprovals } from '@ensemus/application';
import Link from 'next/link';
import { Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Approvals | Ensemus' };

const TOOL_WORDS: Record<string, string> = { 'work.review': 'Review this work' };

export default async function ApprovalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const base = `/o/${organizationId}`;
  const pending = await listMyPendingApprovals(database, context);

  return (
    <>
      <PageHead title="Approvals" description="Decisions waiting for you, soonest first." />
      <ErrorNotice code={error} />
      {pending.length === 0 ? (
        <Empty action={<Link href={`${base}/work`}>Go to your work</Link>}>
          No approvals are waiting for you. When someone asks you to review something, it appears
          here.
        </Empty>
      ) : (
        <div className="card">
          <ul className="list">
            {pending.map((approval) => (
              <li key={approval.id}>
                <span>
                  <Link href={`${base}/approvals/${approval.id}`}>{approval.workTitle}</Link>
                  <br />
                  <small>{TOOL_WORDS[approval.toolName] ?? 'A proposed action'}</small>
                </span>
                <span className="row">
                  <small className="nowrap">Until {formatDateTime(approval.expiresAt)}</small>
                  <span className="badge attention">Waiting</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
