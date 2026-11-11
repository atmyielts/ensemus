import { getApproval, listDirectory } from '@ensemus/application';
import { getAgentActionForApproval } from '@ensemus/application/ai-tool-approvals';
import { effectiveApprovalStatus } from '@ensemus/domain/approval';
import { EMAIL_SEND_TOOL } from '@ensemus/domain/external-action';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ConfirmForm } from '@/components/confirm-form';
import { DraftScope, KeptTextarea } from '@/components/kept-field';
import { ExactEmail } from '@/components/receipt-email';
import { SubmitButton } from '@/components/submit-button';
import {
  BackLink,
  ClassificationBadge,
  ErrorNotice,
  formatBytes,
  formatDateTime,
  PageHead,
  StatusBadge,
} from '@/components/ui';
import { orNotFound, requireTenant } from '@/server/tenant';
import { decideApprovalAction } from '@/server/work-actions';
import {
  AgentFacts,
  AgentInconsistent,
  AgentPayload,
  agentRisk,
  agentToolWords,
  suiteOf,
} from './agent-action';

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
    return 'Not assessed. Ensemus has no description of this action, so read its technical details before deciding.';
  }
  const stakes = holdsWork
    ? 'This work is paused until you decide. Approving lets it carry on, and denying stops it for good.'
    : 'Your decision is recorded as a review of this work, and it does not start or stop anything.';
  const sensitivity = SENSITIVE.has(classification)
    ? ' This work is sensitive, so check that nothing here should stay with fewer people.'
    : '';
  return `${stakes} Nothing outside Ensemus changes.${sensitivity}`;
}

/** The subject of a proposed email, when the stored action has one to name it by. */
function subjectOf(action: unknown) {
  const payload = (action as { payload?: { subject?: unknown } } | null)?.payload;
  return typeof payload?.subject === 'string' && payload.subject.trim() ? payload.subject : null;
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
  const [members, agent] = await Promise.all([
    listDirectory(database, context),
    orNotFound(getAgentActionForApproval(database, context, approvalId)),
  ]);
  const base = `/o/${organizationId}`;

  // A pending approval past its time can no longer be decided, so it is not shown as open.
  const status = effectiveApprovalStatus(approval);
  const pending = status === 'pending';
  const requestedByMe = approval.requestedByMembershipId === context.membershipId;
  const canDecide = isMine && pending && !requestedByMe;
  const requesterName = approval.requestedByMembershipId
    ? (members.find((m) => m.membershipId === approval.requestedByMembershipId)?.name ??
      'Someone no longer here')
    : null;
  const requester = requesterName ?? 'Ensemus, as part of the plan';
  // Only the approval that paused the work can release it (see decideApproval).
  const holdingWork = approval.holdsWork && work.status === 'awaiting_approval';
  const isReview = approval.toolName === 'work.review';
  const isEmail = approval.toolName === EMAIL_SEND_TOOL;
  const suite = agent ? suiteOf(agent) : null;
  const agentWords = agent ? agentToolWords(agent) : null;
  const subject = isEmail ? subjectOf(approval.action) : null;

  // The title names the decision itself, in the words someone would use for it.
  const title = isReview
    ? `Review “${work.title}”`
    : agentWords
      ? `${agentWords} for “${work.title}”`
      : isEmail
        ? subject
          ? `Send the email “${subject}”`
          : `Send an email for “${work.title}”`
        : `Approve an action on “${work.title}”`;

  // One sentence: who asked, whom, and by when (or how it ended).
  const asker = requestedByMe
    ? 'You'
    : agent
      ? `The assistant ${agent.agentName}`
      : (requesterName ?? 'Ensemus');
  const whom = isMine
    ? requestedByMe
      ? 'yourself'
      : 'you'
    : (approverName ?? 'someone who is no longer here');
  // Ensemus asks on its own only as a step of the work's plan, and the sentence says so.
  const byThePlan = !requestedByMe && !agent && !requesterName;
  const decided = approval.decidedAt ? formatDateTime(approval.decidedAt) : null;
  const ending: ReactNode = pending ? (
    <>to decide by {formatDateTime(approval.expiresAt)}.</>
  ) : status === 'approved' ? (
    <>to decide, and it was approved{decided && <> on {decided}</>}.</>
  ) : status === 'denied' ? (
    <>to decide, and it was denied{decided && <> on {decided}</>}.</>
  ) : status === 'expired' ? (
    <>to decide, and the time ran out on {formatDateTime(approval.expiresAt)}.</>
  ) : (
    <>to decide, and it was closed without a decision{decided && <> on {decided}</>}.</>
  );
  const sentence = (
    <>
      {asker} asked {whom}
      {byThePlan ? ', as part of the plan,' : ''} {ending}
    </>
  );

  const bound = (decision: 'approve' | 'deny') => (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="approvalId" value={approval.id} />
      <input type="hidden" name="shownHash" value={approval.actionHash} />
      <input type="hidden" name="decision" value={decision} />
    </>
  );

  const affects = isReview
    ? ({
        0: 'This work. No files are attached to it.',
        1: 'This work, and one file.',
      }[files.length + missingFileCount] ??
      `This work, and ${files.length + missingFileCount} files.`)
    : isEmail
      ? 'Everyone listed in the email below.'
      : suite || agent?.email
        ? 'Exactly what is shown below, and nothing else.'
        : 'Described in the technical details.';

  const ifApproved = isEmail
    ? 'If you approve, Ensemus sends exactly this, once, through your mail server.'
    : agent
      ? 'If you approve, the assistant makes exactly this change, once.'
      : holdingWork
        ? 'If you approve, the work carries on from where it paused.'
        : 'If you approve, it is recorded as the review of this work.';

  const stateNotice =
    isMine && pending && requestedByMe ? (
      <p className="notice warn flush">
        You asked for this approval, so someone else has to decide it. Ask for a new review from
        another person once this one has closed.
      </p>
    ) : status === 'expired' ? (
      <p className="notice warn flush">
        The time to decide has passed, so this can no longer be approved.{' '}
        {holdingWork
          ? 'The work it paused stops at the next periodic check, unless someone asks for a new review first.'
          : approval.holdsWork && work.status === 'cancelled'
            ? 'The work it paused has stopped.'
            : 'Ask for a new review if it is still needed.'}
      </p>
    ) : status === 'cancelled' ? (
      <p className="notice flush">
        {isEmail
          ? 'This was closed, so it cannot be spent. Someone changed what would be sent, the work stopped, or the person asked lost access to it.'
          : 'This was closed without a decision, because the work changed, finished or was reopened, or the person asked lost access to it.'}
      </p>
    ) : !isMine && pending ? (
      <p className="notice flush">{approverName ?? 'Someone else'} decides this one.</p>
    ) : null;

  return (
    <DraftScope account={actor.userId}>
      <BackLink href={`${base}/approvals`}>Back to approvals</BackLink>
      <PageHead title={title} description={sentence} />
      <ErrorNotice code={error} />
      <div className="detail-layout">
        <div className="stack">
          {agent && <AgentInconsistent view={agent} />}
          {stateNotice}

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
                    {decision.reason && (
                      <p className="pre-wrap gap-above-small">{decision.reason}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card" aria-labelledby="summary-heading">
            <h2 id="summary-heading">{pending ? 'What would change' : 'What was asked'}</h2>
            <dl className="approval-pairs">
              <div className="wide">
                <dt>Asked for</dt>
                <dd>
                  {agentWords ??
                    TOOL_WORDS[approval.toolName] ??
                    'An action Ensemus has no description for'}
                </dd>
              </div>
              <div className="wide">
                <dt>Applies to</dt>
                <dd>
                  <span className="row">
                    <Link href={`${base}/work/${work.id}`}>{work.title}</Link>
                    <StatusBadge status={work.status} />
                    <ClassificationBadge value={work.classification} />
                  </span>
                </dd>
              </div>
              {/* What is at stake only matters while it can still be decided. */}
              {pending && (
                <div className="wide">
                  <dt>What could happen</dt>
                  <dd>
                    {agent
                      ? agentRisk(agent, suite)
                      : riskOf(approval.toolName, work.classification, holdingWork)}
                  </dd>
                </div>
              )}
              <div>
                <dt>What this affects</dt>
                <dd>{affects}</dd>
              </div>
              {/* Once decided or closed, when it would have run out no longer matters. */}
              {(pending || status === 'expired') && (
                <div>
                  <dt>{status === 'expired' ? 'Expired' : 'Decide by'}</dt>
                  <dd>{formatDateTime(approval.expiresAt)}</dd>
                </div>
              )}
            </dl>
          </section>

          {isReview && (
            <section className="card" aria-labelledby="covers-heading">
              <h2 id="covers-heading">What this review covers</h2>
              <p>
                The title and objective of{' '}
                <Link href={`${base}/work/${work.id}`}>{work.title}</Link>, as they stood when this
                was asked for. The work last changed on {formatDateTime(work.updatedAt)}.
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
                  {missingFileCount === 1 ? 'One file' : `${missingFileCount} files`} this covered
                  has since been deleted.
                </p>
              )}
            </section>
          )}

          {agent && <AgentPayload view={agent} suite={suite} />}
          {isEmail && (
            <section className="card" aria-labelledby="email-heading">
              <h2 id="email-heading">The exact email</h2>
              <ExactEmail payload={(approval.action as { payload?: unknown }).payload} />
            </section>
          )}

          {canDecide && (
            <section className="card approval-decision" aria-labelledby="decide-heading">
              <h2 id="decide-heading">Your decision is needed</h2>
              <form className="fields" action={decideApprovalAction}>
                {bound('approve')}
                <p>
                  {ifApproved}{' '}
                  <span className="muted">
                    Your approval covers exactly what is shown here. If anything changes, it needs a
                    new approval.
                  </span>
                </p>
                <label>
                  Note for approving
                  <small>Optional. People on this work can read it.</small>
                  <KeptTextarea keep="approve" name="reason" maxLength={2000} rows={3} />
                </label>
                <div>
                  <SubmitButton>Approve</SubmitButton>
                </div>
              </form>
              <div className="divided">
                {holdingWork ? (
                  <ConfirmForm
                    action={decideApprovalAction}
                    fields={bound('deny')}
                    summary="Deny instead"
                    reasonLabel="Why are you denying this? People on this work can read it."
                    consequence="Deny this and stop the work for good. It cannot be restarted."
                    confirmLabel="Deny and stop the work"
                  />
                ) : (
                  <details className="confirm">
                    <summary>Deny instead</summary>
                    <form className="fields" action={decideApprovalAction}>
                      {bound('deny')}
                      <p>
                        {isEmail
                          ? 'If you deny it, it is not sent, and it will not be without a new approval.'
                          : agent
                            ? 'If you deny it, the assistant does not make this change.'
                            : 'If you deny it, the work stays as it is, without your approval.'}
                      </p>
                      <label>
                        Reason for denying
                        <small>Optional. People on this work can read it.</small>
                        <KeptTextarea keep="deny" name="reason" maxLength={2000} rows={3} />
                      </label>
                      <div>
                        <SubmitButton className="danger">Deny</SubmitButton>
                      </div>
                    </form>
                  </details>
                )}
              </div>
            </section>
          )}
        </div>

        <aside className="stack">
          <section className="card" aria-labelledby="about-heading">
            <h2 id="about-heading">About this approval</h2>
            <dl className="approval-pairs">
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={status === 'cancelled' ? 'closed' : status} />
                </dd>
              </div>
              {agent ? (
                <AgentFacts view={agent} />
              ) : (
                <div>
                  <dt>Asked by</dt>
                  <dd>{requester}</dd>
                </div>
              )}
              <div>
                <dt>Who decides</dt>
                <dd>
                  {isMine
                    ? approverName
                      ? `You (${approverName})`
                      : 'You'
                    : (approverName ?? 'Someone no longer here')}
                </dd>
              </div>
              {approval.decidedAt && (
                <div>
                  <dt>{status === 'approved' || status === 'denied' ? 'Decided' : 'Closed'}</dt>
                  <dd>{formatDateTime(approval.decidedAt)}</dd>
                </div>
              )}
            </dl>
          </section>
          <details className="card">
            <summary>Technical details</summary>
            <pre tabIndex={0} aria-label="The exact action, as stored">
              {JSON.stringify(approval.action, null, 2)}
            </pre>
          </details>
        </aside>
      </div>
    </DraftScope>
  );
}
