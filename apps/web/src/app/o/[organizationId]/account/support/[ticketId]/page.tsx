import { getTicket, supportContentWritable } from '@ensemus/application/saas/support';
import Link from 'next/link';
import { ConfirmForm } from '@/components/confirm-form';
import { ErrorNotice, PageHead, formatDateTime } from '@/components/ui';
import { closeTicketAction } from '@/server/support-actions';
import { orNotFound, requireAccountTenant } from '@/server/tenant';
import { SupportMessageForm } from '../message-form';
export const metadata = { title: 'Support ticket | Ensemus' };
export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; ticketId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, ticketId } = await params,
    { database, context } = await requireAccountTenant(organizationId),
    [ticket, writable] = await Promise.all([
      orNotFound(getTicket(database, context, ticketId)),
      orNotFound(supportContentWritable(database, context)),
    ]);
  return (
    <div className="stack">
      <PageHead
        title={ticket.subject}
        description={`${ticket.category} · ${ticket.status.replaceAll('_', ' ')}`}
        actions={<Link href={`/o/${organizationId}/account/support`}>All tickets</Link>}
      />
      <ErrorNotice code={(await searchParams).error} />
      <p className="notice">
        This conversation is visible to support and your organization's administrators. Keep secrets
        and credentials out of messages.
      </p>
      <ol className="list">
        {ticket.messages.map((message) => (
          <li key={message.id}>
            <article className="stack">
              <div>
                <strong>
                  {message.authorKind === 'support' ? 'Support' : 'Your organization'}
                </strong>
                <p className="muted">{formatDateTime(message.createdAt)}</p>
              </div>
              <p className="pre-wrap">{message.body}</p>
            </article>
          </li>
        ))}
      </ol>
      {!writable ? (
        <p className="notice" role="status">
          Erasure has started. This conversation is read-only.
        </p>
      ) : ticket.status === 'closed' ? (
        <p className="notice">
          This ticket is closed. You can open a new ticket for another issue.
        </p>
      ) : (
        <>
          <section className="stack" aria-labelledby="ticket-reply">
            <h2 id="ticket-reply">Reply</h2>
            <SupportMessageForm
              organizationId={organizationId}
              ticket={{ id: ticket.id, version: ticket.version }}
            />
          </section>
          <ConfirmForm
            action={closeTicketAction}
            summary="Close this ticket"
            consequence="This conversation is finished. Any new issue will need a new ticket."
            confirmLabel="Close ticket"
            fields={
              <>
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="ticketId" value={ticket.id} />
                <input type="hidden" name="version" value={ticket.version} />
              </>
            }
          />
        </>
      )}
    </div>
  );
}
