import { randomUUID } from 'node:crypto';
import { listBundledCatalog } from '@ensemus/application/process-runs';
import Link from 'next/link';
import { ActionLink, BackLink, ClassificationBadge, ErrorNotice, PageHead } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { requireStudio } from '@/server/studio-pages';
import { installWorkflowCatalogAction } from '@/server/process-run-actions';
const needName = {
  email_connector: 'Supported email connection',
  accounting_connector: 'Supported accounting connection',
  meeting_notes: 'Meeting notes input',
} as const;
export const metadata = { title: 'Bundled workflows | Ensemus' };
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
        title="Bundled workflow definitions"
        description="Inspect the saved steps and requirements before starting real work. Installation publishes a definition; it does not qualify a model, provider or delivery path."
      />
      <ErrorNotice code={(await searchParams).error} />
      <p className="notice">
        Installing requires your existing publication permission and recent native MFA. Starting an
        already approved version has no additional MFA requirement. Missing requirements are shown
        explicitly and may stop a later step.
      </p>
      <ul className="fields" aria-label="Bundled workflow definitions">
        {catalog.items.map((item) => (
          <li className="card fields" key={item.key}>
            <div className="row">
              <h2>{item.name}</h2>
              <ClassificationBadge value={item.classification} />
            </div>
            <p>{item.description}</p>
            {item.needs.length ? (
              <ul>
                {item.needs.map((entry) => (
                  <li key={entry.need}>
                    {needName[entry.need]}:{' '}
                    {entry.met
                      ? 'An active connection is recorded here; actual use is checked again.'
                      : 'Not available on this workspace.'}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No connector requirement is recorded for this definition.</p>
            )}
            {item.installed ? (
              <>
                <p>
                  Installed version {item.installed.versionNumber}. No run has been started by this
                  page.
                </p>
                <ActionLink
                  href={`${base}/new?spec=${encodeURIComponent(item.installed.specId)}`}
                  variant="secondary"
                >
                  Review {item.name} before starting
                </ActionLink>
              </>
            ) : (
              <form action={installWorkflowCatalogAction} className="fields">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="requestKey" value={randomUUID()} />
                <input type="hidden" name="processKey" value={item.key} />
                <div>
                  <SubmitButton working="Installing the definition">
                    Install {item.name}
                  </SubmitButton>
                </div>
              </form>
            )}
            <details>
              <summary>Definition details</summary>
              <p>
                Catalog definition: <code>{item.key}</code>
              </p>
              <p>
                Fixed synthetic scenario: <code>{item.scenarioKey}</code>. It is a rules rehearsal,
                not provider qualification.
              </p>
            </details>
          </li>
        ))}
      </ul>
      <p>
        <Link href={`/o/${organizationId}/studio/workflows`}>
          Prepare your own workflow definition
        </Link>
      </p>
    </OneActionAtATime>
  );
}
