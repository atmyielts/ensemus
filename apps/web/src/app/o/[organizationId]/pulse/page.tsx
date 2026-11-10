import Link from 'next/link';
import { getCompanyPulse } from '@ensemus/application/pulse';
import { createPulseMetadataReaders } from '@ensemus/application/pulse-metadata';
import { Empty, ErrorNotice, PageHead, formatDateTime } from '@/components/ui';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { PulsePartialNotice, PulseSignalGroup } from '@/components/pulse/view';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Company Pulse | Ensemus' };
export default async function PulsePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ dismissed?: string; error?: string }>;
}) {
  const { organizationId } = await params,
    query = await searchParams;
  const { database, context } = await requireTenant(organizationId);
  const view = await getCompanyPulse(database, context, createPulseMetadataReaders(), {
    includeDismissed: query.dismissed === 'true',
  });
  const base = `/o/${organizationId}`,
    open = view.signals.filter((signal) => signal.personalState === 'open');
  const attention = open.filter((signal) => signal.severity === 'attention'),
    watch = open.filter((signal) => signal.severity === 'watch');
  const snoozed = view.signals.filter((signal) => signal.personalState === 'snoozed'),
    dismissed = view.signals.filter((signal) => signal.personalState === 'dismissed');
  return (
    <OneActionAtATime>
      <Link href={base}>Back to workspace</Link>
      <PageHead
        title="Company Pulse"
        description="Facts from work you can read, with links to their records. This is not a score for people or a prediction of what caused an outcome."
      />
      <ErrorNotice code={query.error} />
      <PulsePartialNotice partial={view.partial} organizationId={organizationId} />
      <dl className="facts">
        <dt>Open work reviewed</dt>
        <dd>{view.summary.openWork}</dd>
        <dt>Overdue among reviewed work</dt>
        <dd>{view.summary.overdue}</dd>
        <dt>Pending approvals reviewed</dt>
        <dd>{view.summary.waitingOnApproval}</dd>
        <dt>Open attention signals</dt>
        <dd>{view.summary.needsDecision}</dd>
      </dl>
      <p className="muted">
        Updated {formatDateTime(view.generatedAt)}. Dismissal and snooze affect only your view. An
        external action with unconfirmed delivery is never treated as sent.
      </p>
      {open.length === 0 && (
        <Empty title="No open signals in the records reviewed">
          Pulse checked readable work, pending approvals, external actions and available
          assistant/process outcomes. Snoozed or dismissed signals may be below; this does not
          establish that every area is clear.
        </Empty>
      )}
      <PulseSignalGroup
        organizationId={organizationId}
        id="attention-heading"
        title="Needs attention"
        signals={attention}
      />
      <PulseSignalGroup
        organizationId={organizationId}
        id="watch-heading"
        title="Coming up"
        signals={watch}
      />
      <PulseSignalGroup
        organizationId={organizationId}
        id="snoozed-heading"
        title="Snoozed for you"
        signals={snoozed}
      />
      <p>
        <Link href={query.dismissed === 'true' ? `${base}/pulse` : `${base}/pulse?dismissed=true`}>
          {query.dismissed === 'true' ? 'Hide dismissed signals' : 'Review dismissed signals'}
        </Link>
      </p>
      <PulseSignalGroup
        organizationId={organizationId}
        id="dismissed-heading"
        title="Dismissed for you"
        signals={dismissed}
      />
    </OneActionAtATime>
  );
}
