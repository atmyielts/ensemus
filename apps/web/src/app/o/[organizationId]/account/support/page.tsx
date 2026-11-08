import {
  getPublishedCoverage,
  listTickets,
  supportContentWritable,
} from '@ensemus/application/saas/support';
import { withinCoverage } from '@ensemus/saas/support';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { Empty, PageHead, formatDateTime } from '@/components/ui';
import { orNotFound, requireAccountTenant } from '@/server/tenant';
import { SupportMessageForm } from './message-form';
export const metadata = { title: 'Support | Ensemus' };
const labels: Record<string, string> = {
  open: 'Open',
  waiting_on_customer: 'Waiting for your reply',
  waiting_on_support: 'Waiting for support',
  resolved: 'Resolved',
  closed: 'Closed',
};
export default async function SupportPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireAccountTenant(organizationId),
    [tickets, coverage, writable] = await Promise.all([
      orNotFound(listTickets(database, context)),
      getPublishedCoverage(database),
      orNotFound(supportContentWritable(database, context)),
    ]);
  return (
    <div className="stack">
      <PageHead
        title="Support"
        description="Ask for help with your account, billing, incidents or security."
        actions={<Link href={`/o/${organizationId}/account`}>Account</Link>}
      />
      <p className="notice">
        Support sees what you write in your tickets. It has no default access to your organization's
        work or other records.
      </p>
      <section className="stack" aria-labelledby="support-coverage">
        <h2 id="support-coverage">Coverage</h2>
        {coverage ? (
          <>
            <p>
              {withinCoverage(coverage.windows, coverage.timezone, new Date())
                ? 'Within'
                : 'Outside'}{' '}
              published coverage. Times below use {coverage.timezone}.
            </p>
            <ul>
              {coverage.windows.map((window, index) => (
                <li key={index}>
                  {
                    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
                      window.day
                    ]
                  }{' '}
                  · {window.from}–{window.to}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>No support coverage hours have been published.</p>
        )}
      </section>
      <section className="stack" aria-labelledby="support-tickets">
        <h2 id="support-tickets">Your tickets</h2>
        {tickets.length === 0 ? (
          <Empty>No support tickets are visible to you yet.</Empty>
        ) : (
          <ul className="list">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <div>
                  <Link href={`/o/${organizationId}/account/support/${ticket.id}`}>
                    {ticket.subject}
                  </Link>
                  <p className="muted">
                    {labels[ticket.status]} · Updated {formatDateTime(ticket.updatedAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {writable ? (
        <section className="stack" aria-labelledby="support-new">
          <h2 id="support-new">Open a ticket</h2>
          <SupportMessageForm organizationId={organizationId} />
        </section>
      ) : (
        <p className="notice" role="status">
          Erasure has started. Existing tickets are read-only.
        </p>
      )}
      {can(context.role, 'break_glass.authorize') && (
        <Link href={`/o/${organizationId}/account/break-glass`}>
          Review support access requests
        </Link>
      )}
    </div>
  );
}
