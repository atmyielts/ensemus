import Link from 'next/link';
import { AppError } from '@ensemus/application';
import { getPulseSignal } from '@ensemus/application/pulse';
import { createPulseMetadataReaders } from '@ensemus/application/pulse-metadata';
import { notFound } from 'next/navigation';
import { Empty, PageHead, formatDateTime } from '@/components/ui';
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
          <Link href={base}>Back to Company Pulse</Link>
          <PageHead title="Source temporarily unavailable" />
          <Empty>
            The source record could not be read. Return to Pulse or open the related work after this
            source is available.
          </Empty>
        </>
      );
    throw error;
  }
  return (
    <>
      <Link href={base}>Back to Company Pulse</Link>
      <PageHead
        title="Pulse source evidence"
        description="The current signal was recomputed from this record under your current access."
      />
      <h2>Current recorded fact</h2>
      <PulseSignalRow organizationId={organizationId} signal={signal} showControls={false} />
      <details>
        <summary>Record details</summary>
        <dl className="facts">
          {signal.evidence.map((item) => (
            <div key={`${item.kind}:${item.id}`}>
              <dt>{item.kind.replaceAll('_', ' ')}</dt>
              <dd>
                {item.id} · {item.reasonCode} · {formatDateTime(item.observedAt)}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}
