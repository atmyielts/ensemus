import {
  getOrganizationImport,
  listDirectory,
  listImportedPeople,
  listOrganizationExports,
} from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConfirmForm } from '@/components/confirm-form';
import { ExportList } from '@/components/export-list';
import { ExportRequestForm } from '@/components/export-request-form';
import { ImportPeople } from '@/components/import-people';
import { ImportSummary } from '@/components/import-summary';
import { ErrorNotice, PageHead } from '@/components/ui';
import { requestImportAction } from '@/server/sovereign-actions';
import { findOrganizationImportId } from '@/server/sovereign-runtime';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Export and import | Ensemus' };

const FINISHED = new Set(['completed', 'completed_with_warnings']);

// Taking your organization's data out, and bringing an archive in (COMM-05). An archive holds nearly all of
// a tenant, so only an owner does either (ADR-030). The worker makes an archive, and an operator's command
// reads one, so the only thing this page ever handles is a public key.
export default async function DataPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { organizationId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  // The same not found as anything else a member may not see, and neither page is in their navigation.
  if (!can(context.role, 'license.view')) notFound();

  const historyLink = (
    <Link href={`/o/${organizationId}/data/work`}>History that came with imported work</Link>
  );

  if (!can(context.role, 'organization.export')) {
    return (
      <>
        <PageHead title="Export and import" />
        <section className="panel" data-denied="data">
          <h2>Only an owner can do this</h2>
          <p>
            An archive holds nearly everything in an organization, so only an owner can export one,
            import one or link the people in it. Ask an owner of this organization if you need one.
          </p>
          <p>{historyLink}</p>
          <p>
            <Link href={`/o/${organizationId}/data/definitions`}>Review imported definitions</Link>
          </p>
        </section>
      </>
    );
  }

  const [exports, importId, people, directory] = await Promise.all([
    listOrganizationExports(database, context),
    findOrganizationImportId(database, context),
    listImportedPeople(database, context),
    listDirectory(database, context),
  ]);
  const importView = importId ? await getOrganizationImport(database, context, importId) : null;
  const linked = new Set(people.map((person) => person.targetMembershipId));
  // Someone already linked cannot be linked again, and a disabled member cannot take on anyone's work.
  const candidates = directory.filter(
    (person) => person.status === 'active' && !linked.has(person.membershipId),
  );

  return (
    <>
      <PageHead
        title="Export and import"
        description="Take a copy of this organization with you, or bring one in."
      />
      <ErrorNotice code={typeof error === 'string' ? error : undefined} />
      <div className="stack">
        <section className="panel" aria-labelledby="data-export">
          <h2 id="data-export">Export this organization</h2>
          <p>
            An archive is sealed to a key you hold, so nobody running this deployment can read it.
            Restricted work is left out, because it is limited to the people on it, and each export
            says how much was left out.
          </p>
          <ExportRequestForm organizationId={organizationId} />
          <h3 className="gap-above-large">Your exports</h3>
          <ExportList organizationId={organizationId} exports={exports} />
        </section>

        <section className="panel" aria-labelledby="data-import">
          <h2 id="data-import">Import an archive</h2>
          {importView ? (
            <ImportSummary organizationId={organizationId} view={importView} />
          ) : (
            <>
              <p>
                An archive goes into a new, empty organization, and an organization takes only one.
                If this one already holds work, clients, projects, teams, files or other members,
                create a new organization for it.
              </p>
              <p>
                Bringing one in starts nothing: no work runs, nothing is sent, and approvals come
                across as history. Nobody gets an account from it.
              </p>
              <ConfirmForm
                action={requestImportAction}
                fields={<input type="hidden" name="organizationId" value={organizationId} />}
                summary="Take an archive into this organization"
                consequence="This organization will take one archive, and it cannot take a second."
                confirmLabel="Get this organization ready"
              />
            </>
          )}
        </section>

        <section className="panel" aria-labelledby="data-people">
          <h2 id="data-people">People from the archive</h2>
          <ImportPeople
            organizationId={organizationId}
            people={people}
            candidates={candidates}
            everyone={directory}
          />
        </section>

        {importView && FINISHED.has(importView.status) && (
          <section className="panel" aria-labelledby="data-history">
            <h2 id="data-history">History</h2>
            <p>
              <Link href={`/o/${organizationId}/data/definitions`}>
                Review imported definitions and settings
              </Link>
            </p>
            <p>
              Approvals, decisions and status changes from the archive are kept as a record, by
              work. {historyLink}.
            </p>
          </section>
        )}
      </div>
    </>
  );
}
