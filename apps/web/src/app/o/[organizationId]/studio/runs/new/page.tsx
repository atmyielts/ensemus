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
        description="Choose a published workflow, read its steps and give the work a name. Starting it creates real work for the people involved."
      />
      {query.installed === '1' && selected && (
        <p role="status" className="notice good">
          The workflow is installed. Read its steps below and name the work to start it.
        </p>
      )}
      {query.spec && !selected && (
        <p className="notice">
          That workflow is not available to you, so its details are hidden. Choose one of the
          workflows you can start.
        </p>
      )}
      {selected && selected.spec.steps.length === 0 ? (
        <Empty
          title="This version has no steps to run"
          action={
            <ActionLink href={`/o/${organizationId}/studio/workflows`} variant="secondary">
              Go to workflow drafts
            </ActionLink>
          }
        >
          Add steps to its draft, rehearse it and publish a new version first.
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
        <form method="get" className="card fields" aria-label="Choose a definition to review">
          <label htmlFor="choose-start-definition">
            <span id="choose-start-definition-label">Workflow</span>
            <small id="choose-start-definition-help">
              You will see its steps before anything starts.
            </small>
            <select
              id="choose-start-definition"
              name="spec"
              required
              defaultValue=""
              aria-labelledby="choose-start-definition-label"
              aria-describedby="choose-start-definition-help"
            >
              <option value="">Choose a workflow</option>
              {specs.map((spec) => (
                <option key={spec.id} value={spec.id}>
                  {spec.name} · Version {spec.versionNumber}
                </option>
              ))}
            </select>
          </label>
          <div>
            <button type="submit">Show its steps</button>
          </div>
        </form>
      ) : (
        <Empty
          title="No published workflows yet"
          action={<ActionLink href={`${base}/catalog`}>See ready-made workflows</ActionLink>}
        >
          Install a ready-made workflow, or build, rehearse and publish one of your own.
        </Empty>
      )}

      {selected && (
        <section className="card gap-above-large" aria-labelledby="selected-workflow">
          <div className="spread">
            <h2 id="selected-workflow">Its steps: {selected.name}</h2>
            <ClassificationBadge value={selected.classification} />
          </div>
          <p className="muted">
            Version {selected.versionNumber}. Each step waits for the ones listed with it; steps
            that do not wait for each other can happen at the same time.
          </p>
          <ol className="list gap-above">
            {selected.spec.steps.map((step) => (
              <li key={step.key}>
                <span>
                  <strong>{step.label}</strong>
                  <br />
                  <small>
                    {stepKindNames[step.kind]} ·{' '}
                    {step.after.length
                      ? `Waits for ${step.after.map((key) => selected.spec.steps.find((before) => before.key === key)?.label ?? 'a step that is no longer listed').join('; ')}`
                      : 'First step'}
                  </small>
                </span>
              </li>
            ))}
          </ol>
          <details className="gap-above">
            <summary>Technical details</summary>
            <p className="gap-above-small">
              Definition fingerprint: <code>{selected.specSha256}</code>
            </p>
            <p>
              Definition identifier: <code>{selected.id}</code>
            </p>
          </details>
        </section>
      )}
      <p className="muted gap-above-large">
        {selected && (
          <>
            <Link href={`${base}/new`}>Choose another workflow</Link> ·{' '}
          </>
        )}
        <Link href={`${base}/catalog`}>Ready-made workflows</Link> ·{' '}
        <Link href={`/o/${organizationId}/studio/workflows`}>Workflow drafts</Link>
      </p>
    </OneActionAtATime>
  );
}
