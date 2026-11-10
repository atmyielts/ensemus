import { getApproval, listDirectory } from '@ensemus/application';
import { effectiveApprovalStatus } from '@ensemus/domain/approval';
import { EMAIL_SEND_TOOL } from '@ensemus/domain/external-action';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConfirmForm } from '@/components/confirm-form';
import { DraftScope, KeptTextarea } from '@/components/kept-field';
import { ExactEmail } from '@/components/receipt-email';
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
import { AgentAction } from './agent-action';

export const metadata = { title: 'Approval | Ensemus' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TOOL_WORDS: Record<string, string> = {
  'work.review': 'Review this work and decide whether it is acceptable',
  [EMAIL_SEND_TOOL]: 'Send an email through your mail server, exactly as written below',
};

const SENSITIVE = new Set(['confidential', 'restricted']);

/** What is at stake, said plainly. An action nobody described is treated as a warning, not as safe. */
function riskOf(toolName: string, classification: string, holdsWork: boolean) {
  if (toolName === EMAIL_SEND_TOOL) {
    const sensitivity = SENSITIVE.has(classification)
      ? ' This work is sensitive, so check that nothing here should stay inside.'
      : '';
    return `This leaves your organization, and it cannot be taken back once it goes. Your approval covers exactly what is shown here, so changing any of it needs a new approval.${sensitivity}`;
  }
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
  const { actor, context, database } = await requireTenant(organizationId);
  if (!UUID.test(approvalId)) notFound();
  const { approval, work, approverName, isMine, files, missingFileCount, decisions } =
    await orNotFound(getApproval(database, context, approvalId));
  const members = await listDirectory(database, context);
  const base = `/o/${organizationId}`;

  // A pending approval past its time can no longer be decided, so it is not shown as open.
  const status = effectiveApprovalStatus(approval);
  const requestedByMe = approval.requestedByMembershipId === context.membershipId;
  const canDecide = isMine && status === 'pending' && !requestedByMe;
  const requester = approval.requestedByMembershipId
    ? (members.find((m) => m.membershipId === approval.requestedByMembershipId)?.name ??
      'Someone no longer here')
    : 'Ensemus, as part of the plan';
  // Only the approval that paused the work can release it (see decideApproval).
  const holdingWork = approval.holdsWork && work.status === 'awaiting_approval';
  const isReview = approval.toolName === 'work.review';
  const isEmail = approval.toolName === EMAIL_SEND_TOOL;

  const bound = (decision: 'approve' | 'deny') => (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="approvalId" value={approval.id} />
      <input type="hidden" name="shownHash" value={approval.actionHash} />
      <input type="hidden" name="decision" value={decision} />
    </>
  );

  return (
    <DraftScope account={actor.userId}>
      <p className="back">
        <Link href={`${base}/approvals`}>Back to approvals</Link>
      </p>
      <PageHead
        title={canDecide ? 'Your decision is needed' : 'Approval'}
        description="This covers exactly what is shown here. If the work changes, it needs a new approval."
      />
      <ErrorNotice code={error} />
      <div className="stack">
        <section className="card" aria-labelledby="summary-heading">
          <h2 id="summary-heading">
            {status === 'pending' ? 'What is being asked' : 'What was asked'}
          </h2>
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
            {/* What is at stake only matters while it can still be decided. */}
            {status === 'pending' && (
              <>
                <dt>Risk</dt>
                <dd>{riskOf(approval.toolName, work.classification, holdingWork)}</dd>
              </>
            )}
            <dt>What this affects</dt>
            <dd>
              {isReview
                ? ({
                    0: 'This work. No files are attached to it.',
                    1: 'This work, and one file.',
                  }[files.length + missingFileCount] ??
                  `This work, and ${files.length + missingFileCount} files.`)
                : isEmail
                  ? 'Everyone listed in the email below.'
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

        <AgentAction organizationId={organizationId} approvalId={approvalId} />
        {isEmail && (
          <section className="card" aria-labelledby="email-heading">
            <h2 id="email-heading">The exact email</h2>
            <ExactEmail payload={(approval.action as { payload?: unknown }).payload} />
          </section>
        )}

        {decisions.length > 0 && (
          <section className="card" aria-labelledby="decision-heading">
            <h2 id="decision-heading">Decision</h2>
            <ul className="list">
              {decisions.map((decision) => (
                <li key={decision.decidedAt.toISOString()} className="block">
                  <strong>
                    {decision.decision === 'approve' ? 'Approved' : 'Denied'} by{' '}
                    {decision.actorName}
                  </strong>{' '}
                  <small>{formatDateTime(decision.decidedAt)}</small>
                  {decision.reason && <p className="pre-wrap gap-above-small">{decision.reason}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {canDecide && (
          <section className="card" aria-labelledby="decide-heading">
            <h2 id="decide-heading">Decide</h2>
            <div className="decide">
              <form className="fields" action={decideApprovalAction}>
                {bound('approve')}
                <label>
                  Note for approving
                  <small>Optional. People on this work can read it.</small>
                  <KeptTextarea keep="approve" name="reason" maxLength={2000} />
                </label>
                <small>
                  {isEmail
                    ? 'Ensemus then sends exactly this, once, through your mail server.'
                    : holdingWork
                      ? 'The work carries on from where it paused.'
                      : 'This is recorded as the review of this work.'}
                </small>
                <div>
                  <SubmitButton>Approve</SubmitButton>
                </div>
              </form>
              {holdingWork ? (
                <ConfirmForm
                  action={decideApprovalAction}
                  fields={bound('deny')}
                  summary="Deny"
                  reasonLabel="Why are you denying this? People on this work can read it."
                  consequence="Deny this and stop the work for good. It cannot be restarted."
                  confirmLabel="Deny and stop the work"
                />
              ) : (
                <form className="fields" action={decideApprovalAction}>
                  {bound('deny')}
                  <label>
                    Reason for denying
                    <small>Optional. People on this work can read it.</small>
                    <KeptTextarea keep="deny" name="reason" maxLength={2000} />
                  </label>
                  <small>
                    {isEmail
                      ? 'It is not sent, and it will not be without a new approval.'
                      : 'The work stays as it is, without your approval.'}
                  </small>
                  <div>
                    <SubmitButton className="danger">Deny</SubmitButton>
                  </div>
                </form>
              )}
            </div>
          </section>
        )}

        {isMine && status === 'pending' && requestedByMe && (
          <p className="notice warn flush">
            You asked for this approval, so someone else has to decide it. Ask for a new review from
            another person once this one has closed.
          </p>
        )}
        {status === 'expired' && (
          <p className="notice warn flush">
            The time to decide has passed, so this can no longer be approved.{' '}
            {holdingWork
              ? 'The work it paused stops at the next periodic check, unless someone asks for a new review first.'
              : approval.holdsWork && work.status === 'cancelled'
                ? 'The work it paused has stopped.'
                : 'Ask for a new review if it is still needed.'}
          </p>
        )}
        {status === 'cancelled' && (
          <p className="notice flush">
            {isEmail
              ? 'This was closed, so it cannot be spent. Someone changed what would be sent, the work stopped, or the person asked lost access to it.'
              : 'This was closed without a decision, because the work changed, finished or was reopened, or the person asked lost access to it.'}
          </p>
        )}
        {!isMine && status === 'pending' && (
          <p className="notice flush">{approverName ?? 'Someone else'} decides this one.</p>
        )}

        <details className="card">
          <summary>Technical details</summary>
          <pre tabIndex={0} aria-label="The exact action, as stored">
            {JSON.stringify(approval.action, null, 2)}
          </pre>
        </details>
      </div>
    </DraftScope>
  );
}
