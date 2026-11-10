import { randomUUID } from 'node:crypto';
import { listMyOutcomeDrafts } from '@ensemus/application/outcomes';
import Link from 'next/link';
import { PageHead, Empty } from '@/components/ui';
import { ComposeForm } from '@/components/experience/compose-form';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Describe an outcome | Ensemus' };
export default async function ComposePage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireTenant(organizationId),
    drafts = await listMyOutcomeDrafts(database, context),
    base = `/o/${organizationId}`;
  return (
    <>
      <Link href={`${base}/work`}>All work</Link>
      <PageHead
        title="Describe an outcome"
        description="Turn a sentence into an editable private preview, then decide whether to create Work."
      />
      <p className="notice form-width">
        Suggestions use fixed rules, without a model. Only you can read these drafts, including when
        an administrator is viewing the company.
      </p>
      <ComposeForm
        organizationId={organizationId}
        requestKey={randomUUID()}
        today={new Date().toISOString().slice(0, 10)}
      />
      <section aria-labelledby="my-outcome-drafts">
        <h2 id="my-outcome-drafts">Your recent drafts</h2>
        {drafts.length ? (
          <div className="list">
            {drafts.map((d) => (
              <div className="row" key={d.id}>
                <Link href={`${base}/compose/${d.id}`}>{d.preview.title}</Link>
                <span className="muted">
                  {d.status === 'draft'
                    ? 'Needs your review'
                    : d.status === 'authorized'
                      ? 'Work created'
                      : 'Discarded'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>No private outcome drafts yet.</Empty>
        )}
      </section>
    </>
  );
}
