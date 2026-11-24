import Link from 'next/link';
import { getCompanyPulse } from '@ensemus/application/pulse';
import { createPulseMetadataReaders } from '@ensemus/application/pulse-metadata';
import { BackLink, Empty, ErrorNotice, PageHead, formatDateTime } from '@/components/ui';
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
  const summary = [
    ['Open work', view.summary.openWork],
    ['Overdue', view.summary.overdue],
    ['Approvals waiting', view.summary.waitingOnApproval],
    ['Need attention', view.summary.needsDecision],
  ] as const;
  return (
    <OneActionAtATime>
      <BackLink href={base}>Back to home</BackLink>
      <PageHead
        title="Company Pulse"
        description="What needs a look across the work you can see: what is late, stuck or about to run out. Pulse shows facts from the records, with a link to each. It never scores people, and it does not guess why something happened."
      />
      <ErrorNotice code={query.error} />
      <PulsePartialNotice partial={view.partial} organizationId={organizationId} />
      <section className="pulse-summary" aria-labelledby="pulse-summary-heading">
        <h2 id="pulse-summary-heading" className="visually-hidden">
          In numbers
        </h2>
        <dl>
          {summary.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <p>
          <small>
            Checked {formatDateTime(view.generatedAt)}, from work you can see. An email nobody has
            confirmed is never counted as sent.
          </small>
        </p>
      </section>
      <div className="stack pulse-groups">
        {open.length === 0 && (
          <Empty title="Nothing needs a look right now">
            Pulse checked the work, approvals, emails and assistant activity you can see, and found
            nothing late, stuck or failed. It only knows what is recorded here, so this is not a
            promise that everything is fine.
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
        <PulseSignalGroup
          organizationId={organizationId}
          id="dismissed-heading"
          title="Dismissed for you"
          signals={dismissed}
        />
        <p className="link-line">
          <Link
            href={query.dismissed === 'true' ? `${base}/pulse` : `${base}/pulse?dismissed=true`}
          >
            {query.dismissed === 'true' ? 'Hide dismissed signals' : 'Review dismissed signals'}
          </Link>
        </p>
      </div>
    </OneActionAtATime>
  );
}
