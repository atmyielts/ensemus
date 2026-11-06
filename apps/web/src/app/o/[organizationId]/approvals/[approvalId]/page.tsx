import { getApproval } from '@ensemus/application';
import { listMembers } from '@ensemus/database';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SubmitButton } from '@/components/submit-button';
import {
  ClassificationBadge,
  ErrorNotice,
  formatBytes,
  formatDateTime,
  PageHead,
  StatusBadge,
} from '@/components/ui';
import { orNotFound, requireTenant } from '@/server/tenant';
import { decideApprovalAction } from '@/server/work-actions';

export const metadata = { title: 'Approval | Ensemus' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TOOL_WORDS: Record<string, string> = {
  'work.review': 'Review this work and decide whether it is acceptable',
};

const SENSITIVE = new Set(['confidential', 'restricted']);

/** What is at stake, said plainly. An action nobody described is treated as a warning, not as safe. */
function riskOf(toolName: string, classification: string, holdsWork: boolean) {
  if (toolName !== 'work.review') {
    return 'Not assessed. Ensemus has no description of this action, so read its technical details below before deciding.';
  }
  const stakes = holdsWork
    ? 'This work is paused until you decide. Approving lets it carry on, and denying stops it for good.'
    : 'Your decision is recorded as a review of this work, and it does not start or stop anything.';
  const sensitivity = SENSITIVE.has(classification)
    ? ' This work is sensitive, so check that nothing here should stay with fewer people.'
    : '';
  return `${stakes} Nothing outside Ensemus changes.${sensitivity}`;
}

export default async function ApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; approvalId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, approvalId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  if (!UUID.test(approvalId)) notFound();
  const { approval, work, approverName, isMine, files, missingFileCount, decisions } =
    await orNotFound(getApproval(database, context, approvalId));
  const members = await listMembers(database, context);
  const base = `/o/${organizationId}`;

  // A pending approval past its time can no longer be decided, so it is not shown as open.
  const expired = approval.status === 'pending' && approval.expiresAt.getTime() <= Date.now();
  const status = expired ? 'expired' : approval.status;
  const requestedByMe = approval.requestedByMembershipId === context.membershipId;
  const canDecide = isMine && status === 'pending' && !requestedByMe;
  const requester = approval.requestedByMembershipId
    ? (members.find((m) => m.membershipId === approval.requestedByMembershipId)?.name ??
      'Someone no longer here')
    : 'Ensemus, as part of the plan';
  // Only the approval that paused the work can release it (see decideApproval).
  const holdingWork = approval.holdsWork && work.status === 'awaiting_approval';
  const isReview = approval.toolName === 'work.review';

  const bound = (decision: 'approve' | 'deny') => (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="approvalId" value={approval.id} />
      <input type="hidden" name="shownHash" value={approval.actionHash} />
      <input type="hidden" name="decision" value={decision} />
    </>
  );

  return (
    <>
      <p>
        <Link href={`${base}/approvals`}>Back to approvals</Link>
      </p>
      <PageHead
        title={canDecide ? 'Your decision is needed' : 'Approval'}
        description="This covers exactly what is shown here. If the work changes, it needs a new approval."
      />
      <ErrorNotice code={error} />
      <div className="stack">
        <section className="card" aria-labelledby="summary-heading">
          <h2 id="summary-heading">What is being asked</h2>
          <dl>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={status === 'cancelled' ? 'closed' : status} />
            </dd>
            <dt>Action</dt>
            <dd>{TOOL_WORDS[approval.toolName] ?? 'An action Ensemus has no description for'}</dd>
            <dt>Destination</dt>
            <dd>
              <span className="row">
                <Link href={`${base}/work/${work.id}`}>{work.title}</Link>
                <StatusBadge status={work.status} />
                <ClassificationBadge value={work.classification} />
              </span>
            </dd>
            <dt>Risk</dt>
            <dd>{riskOf(approval.toolName, work.classification, holdingWork)}</dd>
            <dt>What this affects</dt>
            <dd>
              {isReview
                ? `This work, and ${files.length + missingFileCount === 1 ? 'one file' : `${files.length + missingFileCount} files`}.`
                : 'Described in the technical details below.'}
            </dd>
            <dt>Asked by</dt>
            <dd>{requester}</dd>
            <dt>Who decides</dt>
            <dd>{isMine ? `You (${approverName ?? 'unknown'})` : (approverName ?? 'Unknown')}</dd>
            <dt>{status === 'expired' ? 'Expired' : 'Valid until'}</dt>
            <dd>{formatDateTime(approval.expiresAt)}</dd>
            {approval.decidedAt && (
              <>
                <dt>{status === 'cancelled' ? 'Closed' : 'Decided'}</dt>
                <dd>{formatDateTime(approval.decidedAt)}</dd>
              </>
            )}
          </dl>
        </section>

        {isReview && (
          <section className="card" aria-labelledby="covers-heading">
            <h2 id="covers-heading">What this review covers</h2>
            <p>
              The title and objective of <Link href={`${base}/work/${work.id}`}>{work.title}</Link>,
              as they stood when this was asked for. The work last changed on{' '}
              {formatDateTime(work.updatedAt)}.
            </p>
            {files.length === 0 && missingFileCount === 0 ? (
              <p className="muted">No files were attached.</p>
            ) : (
              <ul className="list">
                {files.map((file) => (
                  <li key={file.id}>
                    <a href={`${base}/work/${work.id}/files/${file.id}`}>{file.name}</a>
                    <small>{formatBytes(file.sizeBytes)}</small>
                  </li>
                ))}
              </ul>
            )}
            {missingFileCount > 0 && (
              <p className="notice warn">
                {missingFileCount === 1 ? 'One file' : `${missingFileCount} files`} this covered has
                since been deleted.
              </p>
            )}
          </section>
        )}

        {decisions.length > 0 && (
          <section className="card" aria-labelledby="decision-heading">
            <h2 id="decision-heading">Decision</h2>
            <ul className="list">
              {decisions.map((decision) => (
                <li key={decision.decidedAt.toISOString()} style={{ display: 'block' }}>
                  <strong>
                    {decision.decision === 'approve' ? 'Approved' : 'Denied'} by{' '}
                    {decision.actorName}
                  </strong>{' '}
                  <small>{formatDateTime(decision.decidedAt)}</small>
                  {decision.reason && (
                    <p style={{ margin: '0.25rem 0 0', whiteSpace: 'pre-wrap' }}>
                      {decision.reason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <details className="card">
          <summary>Technical details</summary>
          <pre tabIndex={0} aria-label="The exact action, as stored">
            {JSON.stringify(approval.action, null, 2)}
          </pre>
        </details>

        {canDecide && (
          <section className="card" aria-labelledby="decide-heading">
            <h2 id="decide-heading">Decide</h2>
            <div
              className="columns"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))' }}
            >
              <form className="fields" action={decideApprovalAction}>
                {bound('approve')}
                <label>
                  Note for approving
                  <small>Optional. People on this work can read it.</small>
                  <textarea name="reason" maxLength={2000} />
                </label>
                <small>
                  {holdingWork
                    ? 'The work carries on from where it paused.'
                    : 'This is recorded as the review of this work.'}
                </small>
                <div>
                  <SubmitButton>Approve</SubmitButton>
                </div>
              </form>
              <form className="fields" action={decideApprovalAction}>
                {bound('deny')}
                <label>
                  Reason for denying
                  <small>Optional. People on this work can read it.</small>
                  <textarea name="reason" maxLength={2000} />
                </label>
                <small>
                  {holdingWork
                    ? 'The work stops, and it cannot be restarted.'
                    : 'The work stays as it is, without your approval.'}
                </small>
                <div>
                  <SubmitButton className="danger">Deny</SubmitButton>
                </div>
              </form>
            </div>
          </section>
        )}

        {isMine && status === 'pending' && requestedByMe && (
          <p className="notice warn">
            You asked for this approval, so someone else has to decide it. Ask for a new review from
            another person once this one has closed.
          </p>
        )}
        {status === 'expired' && (
          <p className="notice warn">
            The time to decide has passed, so this can no longer be approved.{' '}
            {approval.holdsWork
              ? 'The work it paused is being stopped.'
              : 'Ask for a new review if it is still needed.'}
          </p>
        )}
        {status === 'cancelled' && (
          <p className="notice">
            This was closed without a decision, because the work changed, finished or was reopened,
            or the person asked lost access to it.
          </p>
        )}
        {!isMine && status === 'pending' && (
          <p className="notice">{approverName ?? 'Someone else'} decides this one.</p>
        )}
      </div>
    </>
  );
}
