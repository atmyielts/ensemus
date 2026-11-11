import { randomUUID } from 'node:crypto';
import { getExternalActionDetail, getWorkDetail, listDirectory } from '@ensemus/application';
import { emailSendPayloadSchema } from '@ensemus/contracts/external-actions';
import { canReadWork, type Classification } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DraftScope } from '@/components/kept-field';
import { NewEmailForm } from '@/components/new-email-form';
import { ExactEmail } from '@/components/receipt-email';
import { ReceiptList } from '@/components/receipt-list';
import { ReceiptStatusBadge } from '@/components/receipt-status';
import { messageIdHint, statusExplanation } from '@/components/receipt-words';
import { ResolveForm } from '@/components/resolve-form';
import { SubmitButton } from '@/components/submit-button';
import { BackLink, ErrorNotice, formatDateTime, PageHead, personLabel } from '@/components/ui';
import { retryExternalActionAction } from '@/server/external-action-actions';
import { getRuntime } from '@/server/runtime';
import { orNotFound, requireTenant } from '@/server/tenant';

export const metadata = { title: 'External action | Ensemus' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ExternalActionPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; externalActionId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, externalActionId } = await params;
  const { error } = await searchParams;
  const { actor, context, database } = await requireTenant(organizationId);
  if (!UUID.test(externalActionId)) notFound();
  const action = await orNotFound(getExternalActionDetail(database, context, externalActionId));
  const base = `/o/${organizationId}`;
  const facts = {
    status: action.status,
    statusReason: action.statusReason,
    resolvedByName: action.resolvedByName,
  };
  const hint = messageIdHint(action);
  const connectorsEnabled = getRuntime().config.connectorsEnabled;
  const mayAsk = connectorsEnabled && (action.canRetry || action.canRevise);

  // Who can be asked to decide, by the same rule the service applies when it is asked.
  const [work, members] = mayAsk
    ? await Promise.all([
        orNotFound(getWorkDetail(database, context, action.workUnitId)),
        listDirectory(database, context),
      ])
    : [null, []];
  const onWork = new Set(work?.people.map((person) => person.membershipId));
  const approvers = work
    ? members
        .filter(
          (member) =>
            member.status === 'active' &&
            member.membershipId !== context.membershipId &&
            canReadWork(
              {
                classification: work.work.classification as Classification,
                ownerMembershipId: work.work.ownerMembershipId,
                isAssigned: onWork.has(member.membershipId),
              },
              { membershipId: member.membershipId, role: member.role },
            ),
        )
        .map((member) => ({ id: member.membershipId, label: personLabel(member) }))
    : [];
  const mail = emailSendPayloadSchema.safeParse(action.payload);

  return (
    <DraftScope account={actor.userId}>
      <BackLink href={`${base}/external-actions`}>Back to external actions</BackLink>
      <PageHead title={action.subject ?? 'External action'} />
      <ErrorNotice code={error} />
      <div className="stack">
        <section className="card" aria-labelledby="what-happened-heading">
          <h2 id="what-happened-heading">What happened</h2>
          <dl className="facts">
            <div>
              <dt>Status</dt>
              <dd>
                <ReceiptStatusBadge {...facts} />
              </dd>
            </div>
            <div>
              <dt>Work</dt>
              <dd>
                <Link href={`${base}/work/${action.workUnitId}`}>{action.workTitle}</Link>
              </dd>
            </div>
            <div>
              <dt>Goes through</dt>
              <dd>{action.connectionName}</dd>
            </div>
            <div>
              <dt>Last changed</dt>
              <dd>{formatDateTime(action.updatedAt)}</dd>
            </div>
          </dl>
          {action.status === 'unknown' ? (
            <div className="notice unknown gap-above flush">
              <p>{statusExplanation(facts)}</p>
              <p className="gap-above">
                {hint.whole ? 'Message-ID: ' : 'The Message-ID starts with: '}
                <code>{hint.value}</code>
              </p>
              {!action.canResolve && (
                <p className="gap-above">
                  The accountable owner of this work or an organization admin says what they found.
                </p>
              )}
            </div>
          ) : (
            <p className="gap-above">{statusExplanation(facts)}</p>
          )}
          {action.status === 'sent' && action.externalId && (
            <p className="muted">
              Message-ID: <code>{action.externalId}</code>
            </p>
          )}
          {action.resolutionReason && (
            <>
              <h3 className="gap-above-large">
                What {action.resolvedByName ?? 'someone no longer here'} found
              </h3>
              <p className="pre-wrap">{action.resolutionReason}</p>
            </>
          )}
          {action.approvalId && (
            <p className="gap-above">
              <Link href={`${base}/approvals/${action.approvalId}`}>See its approval</Link>
            </p>
          )}
          {action.supersedesId && (
            <p className="gap-above">
              <Link href={`${base}/external-actions/${action.supersedesId}`}>
                See the version this replaced
              </Link>
            </p>
          )}
          {action.retryOfId && (
            <p className="gap-above">
              <Link href={`${base}/external-actions/${action.retryOfId}`}>
                See the action this asks for again
              </Link>
            </p>
          )}
        </section>

        {action.canResolve && (
          <section className="card" aria-labelledby="resolve-heading">
            <h2 id="resolve-heading">Say what you found</h2>
            <ResolveForm
              organizationId={organizationId}
              externalActionId={action.id}
              version={action.version}
            />
          </section>
        )}

        {action.canRetry && connectorsEnabled && (
          <section className="card" aria-labelledby="retry-heading">
            <h2 id="retry-heading">Ask for it again</h2>
            {approvers.length === 0 ? (
              <p className="muted">Nobody else who can see this work is able to approve it.</p>
            ) : (
              <form className="inline-form" action={retryExternalActionAction}>
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="id" value={action.id} />
                <label>
                  Who approves it this time?
                  <select name="approverMembershipId" required defaultValue="">
                    <option value="" disabled>
                      Choose a person
                    </option>
                    {approvers.map((approver) => (
                      <option key={approver.id} value={approver.id}>
                        {approver.label}
                      </option>
                    ))}
                  </select>
                </label>
                <SubmitButton className="secondary">Ask for approval</SubmitButton>
                <small>
                  This makes a new action with the same words, and it needs its own approval.
                  Nothing goes until someone gives it.
                </small>
              </form>
            )}
          </section>
        )}

        <section className="card" aria-labelledby="exact-heading">
          <h2 id="exact-heading">Exactly what this covers</h2>
          <ExactEmail payload={action.payload} />
          {action.canRevise && connectorsEnabled && mail.success && (
            <details className="gap-above">
              <summary>Change what would be sent</summary>
              {approvers.length === 0 ? (
                <p className="muted">Nobody else who can see this work is able to approve it.</p>
              ) : (
                <NewEmailForm
                  organizationId={organizationId}
                  target={{ kind: 'revise', externalActionId: action.id, version: action.version }}
                  connections={[]}
                  approvers={approvers}
                  requestKey={randomUUID()}
                  defaults={{
                    to: mail.data.to.join(', '),
                    cc: mail.data.cc?.join(', ') ?? '',
                    bcc: mail.data.bcc?.join(', ') ?? '',
                    replyTo: mail.data.reply_to ?? '',
                    subject: mail.data.subject,
                    textBody: mail.data.text_body,
                  }}
                />
              )}
            </details>
          )}
        </section>

        <section className="card" aria-labelledby="receipts-heading">
          <h2 id="receipts-heading">Receipts</h2>
          <p className="muted">
            {action.attemptCount === 0
              ? 'Ensemus has not tried to send this.'
              : action.attemptCount === 1
                ? 'Ensemus has tried to send this once.'
                : `Ensemus has tried ${action.attemptCount} times, and every earlier try definitely did not go.`}
          </p>
          <ReceiptList receipts={action.receipts} />
        </section>

        <details className="card">
          <summary>Technical details</summary>
          <dl>
            <dt>What the approval binds</dt>
            <dd>
              <code>{action.requestHash}</code>
            </dd>
          </dl>
          <pre tabIndex={0} aria-label="The exact action, as stored">
            {JSON.stringify(action.payload, null, 2)}
          </pre>
        </details>
      </div>
    </DraftScope>
  );
}
