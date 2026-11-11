import { randomUUID } from 'node:crypto';
import { listBundledCatalog } from '@ensemus/application/process-runs';
import Link from 'next/link';
import {
  ActionLink,
  BackLink,
  ClassificationBadge,
  Empty,
  ErrorNotice,
  PageHead,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { requireStudio } from '@/server/studio-pages';
import { installWorkflowCatalogAction } from '@/server/process-run-actions';
const needName = {
  email_connector: 'An email connection',
  accounting_connector: 'An accounting connection',
  meeting_notes: 'Meeting notes',
} as const;
export const metadata = { title: 'Ready-made workflows | Ensemus' };
export default async function ProcessCatalogPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireStudio(organizationId),
    catalog = await listBundledCatalog(database, context),
    base = `/o/${organizationId}/studio/runs`;
  return (
    <OneActionAtATime>
      <BackLink href={base}>Workflow runs</BackLink>
      <PageHead
        title="Ready-made workflows"
        description="Workflows that come with Ensemus. Read the steps and what each one needs, then install it to start real work with it."
      />
      <ErrorNotice code={(await searchParams).error} />
      <p className="notice">
        Installing publishes the workflow for your organization, so it asks you to confirm with your
        second sign-in step if you have not done so recently. Starting one that is already installed
        does not.
      </p>
      {catalog.items.length === 0 ? (
        <Empty
          title="No ready-made workflows in this release"
          action={
            <ActionLink href={`/o/${organizationId}/studio/workflows/new`} variant="secondary">
              Build your own workflow
            </ActionLink>
          }
        >
          You can still build a workflow of your own from scratch.
        </Empty>
      ) : (
        <ul className="stack studio-cards" aria-label="Bundled workflow definitions">
          {catalog.items.map((item) => (
            <li className="card" key={item.key}>
              <div className="spread">
                <h2>{item.name}</h2>
                <span className="row">
                  {item.installed && <span className="badge done">Installed</span>}
                  <ClassificationBadge value={item.classification} />
                </span>
              </div>
              <p>{item.description}</p>
              <h3 className="gap-above">What it needs</h3>
              {item.needs.length ? (
                <ul className="list">
                  {item.needs.map((entry) => (
                    <li key={entry.need}>
                      <span>{needName[entry.need]}</span>
                      {entry.met ? (
                        <span className="badge done">Available</span>
                      ) : (
                        <span className="badge attention">Not available here</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Nothing beyond the people who do its steps.</p>
              )}
              {item.needs.some((entry) => entry.met) && (
                <p className="muted">
                  <small>Each one is checked again when a step uses it.</small>
                </p>
              )}
              <div className="divided">
                {item.installed ? (
                  <div className="spread">
                    <span className="muted">
                      Version {item.installed.versionNumber} is installed.
                    </span>
                    <ActionLink
                      href={`${base}/new?spec=${encodeURIComponent(item.installed.specId)}`}
                      variant="secondary"
                    >
                      Review {item.name} before starting
                    </ActionLink>
                  </div>
                ) : (
                  <form action={installWorkflowCatalogAction}>
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="requestKey" value={randomUUID()} />
                    <input type="hidden" name="processKey" value={item.key} />
                    <SubmitButton className="secondary" working="Installing the definition">
                      Install {item.name}
                    </SubmitButton>
                  </form>
                )}
              </div>
              <details className="gap-above">
                <summary>Technical details</summary>
                <p className="gap-above-small">
                  Catalog name: <code>{item.key}</code>
                </p>
                <p>
                  Rehearsal example: <code>{item.scenarioKey}</code>
                </p>
              </details>
            </li>
          ))}
        </ul>
      )}
      <p className="muted gap-above-large">
        Need something different?{' '}
        <Link href={`/o/${organizationId}/studio/workflows`}>Build your own workflow</Link>
      </p>
    </OneActionAtATime>
  );
}
