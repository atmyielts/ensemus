import { createPackService, type PackCatalogEntry } from '@ensemus/application/packs';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PackStatusBadge } from '@/components/packs/words';
import { SubmitButton } from '@/components/submit-button';
import { Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { requestPackInstallAction } from '@/server/pack-actions';
import { webProductPorts } from '@/server/product-ports';
import { orNotFound, requireTenant } from '@/server/tenant';

export const metadata = { title: 'Packs | Ensemus' };

function VersionAction({
  organizationId,
  entry,
  base,
}: {
  organizationId: string;
  entry: PackCatalogEntry;
  base: string;
}) {
  const { installation, upgrade } = entry;
  if (installation?.status === 'reviewing') {
    return installation.version === entry.version ? (
      <Link href={`${base}/packs/installations/${installation.id}`}>Continue the review</Link>
    ) : (
      <small className="muted">Finish the review that is open first.</small>
    );
  }
  if (installation?.version === entry.version) {
    return <Link href={`${base}/packs/installations/${installation.id}`}>See what it made</Link>;
  }
  // Going back is a rollback from the installed version's page, and it is never a new install.
  if (upgrade?.refused) {
    return <small className="muted">This version cannot replace the one installed.</small>;
  }
  return (
    <form action={requestPackInstallAction}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="packKey" value={entry.key} />
      <input type="hidden" name="version" value={entry.version} />
      <SubmitButton className="quiet" label={`Review ${entry.name} ${entry.version}`}>
        Review what it asks for
      </SubmitButton>
    </form>
  );
}

export default async function PacksPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  if (!canProduct(context.role, 'pack.manage')) notFound();
  const base = `/o/${organizationId}`;
  const service = createPackService({ toolCatalog: webProductPorts().toolCatalog });
  const [catalog, history] = await Promise.all([
    orNotFound(service.listPackCatalog(database, context)),
    orNotFound(service.listPackInstallations(database, context)),
  ]);

  return (
    <>
      <PageHead
        title="Packs"
        description="Ready-made record types and drafts for a department. A pack comes with this release, and nothing is downloaded."
      />
      <ErrorNotice code={error} />
      <p className="notice">
        Installing a pack grants no permission and changes nobody&apos;s role. You decide each thing
        it asks for, and what it makes starts as a draft that can do nothing until a person has
        simulated, reviewed and published it.
      </p>
      <div className="stack">
        <section className="card" aria-labelledby="catalog-heading">
          <h2 id="catalog-heading">Available in this release</h2>
          {catalog.length === 0 ? (
            <Empty>This release has no packs to offer.</Empty>
          ) : (
            <ul className="list">
              {catalog.map((entry) => (
                <li key={`${entry.key}-${entry.version}`} className="block">
                  <div className="row">
                    <strong>{entry.name}</strong>
                    <small className="muted">Version {entry.version}</small>
                    {entry.upgrade?.needsReview && !entry.upgrade.refused && (
                      <span className="badge active">Asks for something new</span>
                    )}
                  </div>
                  <p>{entry.description}</p>
                  <VersionAction organizationId={organizationId} entry={entry} base={base} />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="history-heading">
          <h2 id="history-heading">In this organization</h2>
          {history.length === 0 ? (
            <Empty>No pack has been reviewed or installed here yet.</Empty>
          ) : (
            <ul className="list">
              {history.map((row) => (
                <li key={row.id}>
                  <span>
                    <Link href={`${base}/packs/installations/${row.id}`}>
                      {row.packKey} {row.packVersion}
                    </Link>
                    <br />
                    <small>
                      {row.activatedAt ? (
                        <>Activated {formatDateTime(row.activatedAt)}</>
                      ) : (
                        <>Asked for {formatDateTime(row.createdAt)}</>
                      )}
                    </small>
                  </span>
                  <PackStatusBadge status={row.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
