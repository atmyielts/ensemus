import { AppError } from '@ensemus/application';
import { getPulseSignal } from '@ensemus/application/pulse';
import { createPulseMetadataReaders } from '@ensemus/application/pulse-metadata';
import { notFound } from 'next/navigation';
import { BackLink, Empty, PageHead, formatDateTime } from '@/components/ui';
import { PulseSignalRow } from '@/components/pulse/view';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Pulse source evidence | Ensemus' };
export default async function PulseEvidencePage({
  params,
}: {
  params: Promise<{ organizationId: string; signalKey: string }>;
}) {
  const { organizationId, signalKey } = await params;
  const { database, context } = await requireTenant(organizationId);
  const base = `/o/${organizationId}/pulse`;
  let signal;
  try {
    signal = await getPulseSignal(database, context, createPulseMetadataReaders(), signalKey);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    if (error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE')
      return (
        <>
          <BackLink href={base}>Back to Company Pulse</BackLink>
          <PageHead title="This record cannot be read right now" />
          <Empty>
            The record behind this signal could not be read just now. Go back to Pulse, or open the
            related work once it is available again.
          </Empty>
        </>
      );
    throw error;
  }
  return (
    <>
      <BackLink href={base}>Back to Company Pulse</BackLink>
      <PageHead
        title="Where this signal comes from"
        description="Pulse worked this out again just now, from the record below and only what you can see."
      />
      <div className="stack">
        <section aria-labelledby="fact-heading">
          <h2 id="fact-heading">What is recorded</h2>
          <div className="card">
            <PulseSignalRow organizationId={organizationId} signal={signal} showControls={false} />
          </div>
        </section>
        <details className="card">
          <summary>Technical details</summary>
          <dl className="facts gap-above">
            {signal.evidence.map((item) => (
              <div key={`${item.kind}:${item.id}`}>
                <dt>{item.kind.replaceAll('_', ' ')}</dt>
                <dd>
                  <span className="technical-reference">{item.id}</span> · {item.reasonCode} ·{' '}
                  {formatDateTime(item.observedAt)}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </>
  );
}
