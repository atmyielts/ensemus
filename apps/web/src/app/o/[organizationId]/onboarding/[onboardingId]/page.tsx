import { ResourceRefresh } from '@/components/resource-refresh';
import { getClientOnboarding } from '@ensemus/application/knowledge/onboarding';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { costLabel } from '@/components/knowledge-view';
import { ActionLink, BackLink, PageHead, StatusBadge, formatDateTime } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { knowledgeOrNotFound as orNotFound } from '@/server/knowledge-page';
import { onboardingOutcomeMessage } from '@/lib/onboarding-view';
export const metadata = { title: 'Client onboarding progress | Ensemus' };

/** The step each state is on. A stopped or unconfirmed onboarding is on no step, so none is marked. */
const CURRENT_STEP: Record<string, number> = {
  started: 0,
  waiting_for_brief: 1,
  waiting_for_acceptance: 2,
  waiting_for_send: 3,
  completed: 4,
};

const STEP_WORDS = { done: 'Done', current: 'Now', later: 'Not yet' } as const;

function stateSentence(state: string): string {
  switch (state) {
    case 'waiting_for_acceptance':
      return 'The brief is ready for its reviewer. They read it and its sources, then accept or reject it.';
    case 'waiting_for_send':
      return 'The welcome email is waiting for its approver to check the exact message. Once it is sent, the email service has to confirm it before this onboarding can finish.';
    case 'unknown':
      return 'Ensemus could not confirm that the welcome email was delivered. It has not been sent again automatically. Check the email and its receipt before deciding what to do.';
    case 'completed':
      return 'Done. The brief was reviewed, and the email service confirmed the welcome email was sent.';
    case 'failed':
      return 'Onboarding stopped before it could finish. Open its work to see where it got to.';
    default:
      return 'Ensemus is setting up the onboarding work. This page follows along as it moves on.';
  }
}

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ organizationId: string; onboardingId: string }>;
}) {
  const { organizationId, onboardingId } = await params,
    { context, database } = await requireTenant(organizationId),
    row = await orNotFound(getClientOnboarding(database, context, onboardingId)),
    base = `/o/${organizationId}`,
    current = CURRENT_STEP[row.state],
    tone =
      row.state === 'completed'
        ? ' good'
        : row.stateCode || row.state === 'failed' || row.state === 'unknown'
          ? ' warn'
          : '';

  const steps: { title: string; links: ReactNode }[] = [
    { title: 'Set up the client, its project and work', links: null },
    {
      title: 'Prepare the brief',
      links: row.briefWorkUnitId && (
        <Link href={`${base}/work/${row.briefWorkUnitId}`}>Prepare and review the brief</Link>
      ),
    },
    {
      title: 'A colleague reviews the brief',
      links: (row.briefArtifactId || row.reviewWorkUnitId) && (
        <>
          {row.briefWorkUnitId && row.briefArtifactId && (
            <Link
              href={`${base}/work/${row.briefWorkUnitId}/artifacts/${row.briefArtifactId}/verification`}
            >
              Review the brief and sources
            </Link>
          )}
          {row.reviewWorkUnitId && (
            <Link href={`${base}/work/${row.reviewWorkUnitId}`}>Confirm the reviewed outcome</Link>
          )}
        </>
      ),
    },
    {
      title: 'Approve and send the welcome email',
      links: row.sendWorkUnitId && (
        <Link href={`${base}/work/${row.sendWorkUnitId}`}>Welcome email and receipt</Link>
      ),
    },
  ];

  return (
    <>
      <BackLink href={`${base}/clients`}>Clients and projects</BackLink>
      <PageHead
        title="Client onboarding"
        description={`Deal ${row.dealRef}`}
        actions={
          <ActionLink href={`${base}/onboarding/${onboardingId}`} variant="secondary">
            Check progress
          </ActionLink>
        }
      />
      <div className="detail-layout">
        <div className="stack">
          <section className="card" aria-labelledby="onboarding-progress-heading">
            <h2 id="onboarding-progress-heading">Where it has got to</h2>
            <p className={`notice${tone}`}>
              {row.stateCode ? onboardingOutcomeMessage(row.stateCode) : stateSentence(row.state)}
            </p>
            <ResourceRefresh active={!['completed', 'failed', 'unknown'].includes(row.state)} />
            <ol className="step-timeline gap-above">
              {steps.map((step, index) => {
                const mark =
                  current === undefined
                    ? null
                    : index < current
                      ? 'done'
                      : index === current
                        ? 'current'
                        : 'later';
                return (
                  <li key={step.title} className={mark ? `is-${mark}` : undefined}>
                    <span className="step-what">
                      {step.title}
                      {step.links && <span className="row">{step.links}</span>}
                    </span>
                    {mark && <small>{STEP_WORDS[mark]}</small>}
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
        <aside className="stack">
          <section className="card" aria-labelledby="onboarding-summary-heading">
            <h2 id="onboarding-summary-heading">Summary</h2>
            <dl className="details">
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={row.state} />
                </dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{formatDateTime(row.createdAt)}</dd>
              </div>
              {row.finishedAt && (
                <div>
                  <dt>Finished</dt>
                  <dd>{formatDateTime(row.finishedAt)}</dd>
                </div>
              )}
              <div>
                <dt>Welcome email</dt>
                <dd>
                  {row.receipt
                    ? row.receipt.status === 'sent' &&
                      ['provider', 'reconciliation'].includes(row.receipt.basis)
                      ? 'Sent, and confirmed by the email service'
                      : row.receipt.status === 'unknown'
                        ? 'Delivery not confirmed'
                        : 'No confirmed sending receipt'
                    : 'Not sent yet'}
                </dd>
              </div>
              <div>
                <dt>AI model cost</dt>
                <dd>{costLabel(row.costMicros)}</dd>
              </div>
            </dl>
            <p className="gap-above">
              <ActionLink href={`${base}/work/${row.workUnitId}`} variant="secondary">
                Open onboarding work
              </ActionLink>
            </p>
          </section>
          {(row.stateCode || row.receipt) && (
            <details>
              <summary>Technical details</summary>
              {row.stateCode && <p>Technical code: {row.stateCode}</p>}
              {row.receipt && (
                <p>
                  Receipt basis: {row.receipt.basis}
                  {row.receipt.externalId ? ` · Reference ${row.receipt.externalId}` : ''}
                </p>
              )}
            </details>
          )}
        </aside>
      </div>
    </>
  );
}
