import { randomUUID } from 'node:crypto';
import { idSchema, AppError } from '@ensemus/application';
import { listStartableSpecs } from '@ensemus/application/process-runs';
import { getProcessSpec } from '@ensemus/application/process-specs';
import Link from 'next/link';
import { ActionLink, BackLink, Empty, PageHead, ClassificationBadge } from '@/components/ui';
import { ProcessStartForm } from '@/components/studio/process-start-form';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { stepKindNames } from '@/lib/process-run-present';
import { requireStudio } from '@/server/studio-pages';
export const metadata = { title: 'Start workflow | Ensemus' };
export default async function StartProcessPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ spec?: string; installed?: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireStudio(organizationId),
    query = await searchParams,
    base = `/o/${organizationId}/studio/runs`,
    specs = [...(await listStartableSpecs(database, context))],
    parsed = idSchema.safeParse(query.spec);
  let selected: Awaited<ReturnType<typeof getProcessSpec>> | null = null;
  if (parsed.success) {
    try {
      selected = await getProcessSpec(database, context, parsed.data);
    } catch (error) {
      if (!(error instanceof AppError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code)))
        throw error;
    }
  }
  if (selected && !specs.some((spec) => spec.id === selected.id)) specs.unshift(selected);
  return (
    <OneActionAtATime>
      <BackLink href={base}>Workflow runs</BackLink>
      <PageHead
        title="Start an approved workflow"
        description="Choose the immutable version and name its real work. Starting queues a background worker; it does not certify model quality or outside delivery."
      />
      {query.installed === '1' && selected && (
        <p role="status" className="notice">
          The definition is installed. Review this version and name the work before starting it.
        </p>
      )}
      {query.spec && !selected && (
        <p className="notice">
          The requested definition is not currently available to you. Its private details are
          hidden; explicitly choose an available version.
        </p>
      )}
      {selected && selected.spec.steps.length === 0 ? (
        <Empty title="This saved version has no executable steps">
          Add work to a draft, rehearse it and publish a new version before starting. No run is
          created from an empty definition.
        </Empty>
      ) : selected ? (
        <ProcessStartForm
          organizationId={organizationId}
          specs={[
            {
              id: selected.id,
              name: selected.name,
              versionNumber: selected.versionNumber,
              classification: selected.classification,
            },
          ]}
          requestKey={randomUUID()}
          selectedSpecId={selected.id}
        />
      ) : specs.length ? (
        <form method="get" className="fields" aria-label="Choose a definition to review">
          <label htmlFor="choose-start-definition">Saved workflow version</label>
          <select id="choose-start-definition" name="spec" required defaultValue="">
            <option value="">Choose a workflow to review</option>
            {specs.map((spec) => (
              <option key={spec.id} value={spec.id}>
                {spec.name} - Version {spec.versionNumber}
              </option>
            ))}
          </select>
          <div>
            <button type="submit">Review selected workflow</button>
          </div>
          <p className="muted">
            This opens its exact saved steps before you name and start real work.
          </p>
        </form>
      ) : (
        <Empty
          title="No startable saved definitions"
          action={<ActionLink href={`${base}/catalog`}>Browse bundled definitions</ActionLink>}
        >
          Prepare, rehearse and publish a workflow, or install a bundled definition. Unavailable
          references and permissions can still prevent a later step.
        </Empty>
      )}

      {selected && (
        <section className="card fields" aria-labelledby="selected-workflow">
          <div className="row">
            <h2 id="selected-workflow">Selected saved version: {selected.name}</h2>
            <ClassificationBadge value={selected.classification} />
          </div>
          <p>
            Version {selected.versionNumber}. These are the saved steps, not completed work.
            Dependencies determine their order; separate paths may progress in parallel.
          </p>
          <ol>
            {selected.spec.steps.map((step) => (
              <li key={step.key}>
                {step.label} <span className="muted">({stepKindNames[step.kind]})</span>
                <p className="muted">
                  {step.after.length
                    ? `Waits for all: ${step.after.map((key) => selected.spec.steps.find((before) => before.key === key)?.label ?? 'Unavailable saved step').join('; ')}.`
                    : 'No earlier step is required.'}
                </p>
              </li>
            ))}
          </ol>
          <details>
            <summary>Definition snapshot details</summary>
            <p>
              Definition hash: <code>{selected.specSha256}</code>
            </p>
            <p>
              Definition identifier: <code>{selected.id}</code>
            </p>
          </details>
        </section>
      )}
      <p>
        {selected && (
          <>
            <Link href={`${base}/new`}>Choose another workflow</Link> ·{' '}
          </>
        )}
        <Link href={`${base}/catalog`}>Bundled definitions and requirements</Link> ·{' '}
        <Link href={`/o/${organizationId}/studio/workflows`}>Workflow drafts</Link>
      </p>
    </OneActionAtATime>
  );
}
