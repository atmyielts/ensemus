import { randomUUID } from 'node:crypto';
import { listMyOutcomeDrafts } from '@ensemus/application/outcomes';
import Link from 'next/link';
import { BackLink, Empty, PageHead } from '@/components/ui';
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
      <BackLink href={`${base}/work`}>All work</BackLink>
      <PageHead
        title="Describe an outcome"
        description="Say what you want in a sentence. You get a private preview to check and edit, then decide whether to create the work."
      />
      <p className="notice form-width">
        Suggestions come from simple fixed rules, not an AI model. Only you can read these drafts,
        even when an administrator is viewing the company.
      </p>
      <ComposeForm
        organizationId={organizationId}
        requestKey={randomUUID()}
        today={new Date().toISOString().slice(0, 10)}
      />
      <section className="gap-above-large form-width" aria-labelledby="my-outcome-drafts">
        <h2 id="my-outcome-drafts">Your recent drafts</h2>
        {drafts.length ? (
          <ul className="list card">
            {drafts.map((d) => (
              <li key={d.id}>
                <Link href={`${base}/compose/${d.id}`}>{d.preview.title}</Link>
                <small>
                  {d.status === 'draft'
                    ? 'Needs your review'
                    : d.status === 'authorized'
                      ? 'Work created'
                      : 'Discarded'}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            No drafts yet. Each outcome you describe is kept here until you create it or discard it.
          </Empty>
        )}
      </section>
    </>
  );
}
