import { listAccountExports } from '@ensemus/application/saas/exports';
import { can } from '@ensemus/domain/policy';
import { notFound } from 'next/navigation';
import { BackLink, PageHead } from '@/components/ui';
import { ExportList } from '@/components/export-list';
import { ExportRequestForm } from '@/components/export-request-form';
import { orNotFound, requireAccountTenant } from '@/server/tenant';
export const metadata = { title: 'Export your data | Ensemus' };
export default async function AccountExportsPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireAccountTenant(organizationId);
  if (!can(context.role, 'organization.export')) notFound();
  const exports = await orNotFound(listAccountExports(database, context));
  return (
    <>
      <BackLink href={`/o/${organizationId}/account`}>Account</BackLink>
      <PageHead
        title="Export your data"
        description="Prepare an encrypted copy of this organization, including while service is paused."
      />
      <section className="card stack" aria-labelledby="account-export-request">
        <h2 id="account-export-request">Prepare an export</h2>
        <p>
          Only an organization owner can request or download an export. It is encrypted to a public
          key you supply; the matching private key stays with you.
        </p>
        <p>
          Restricted records are left out. The archive records what was included and omitted.
          Preparing an export does not restore service, import data or begin deletion.
        </p>
        <ExportRequestForm organizationId={organizationId} account />
      </section>
      <section className="stack gap-above-large" aria-labelledby="account-export-list">
        <h2 id="account-export-list">Your exports</h2>
        <p>
          Refresh this page to see progress. A download appears after the background export finishes
          its checks.
        </p>
        <p>
          <a href={`/o/${organizationId}/account/exports`}>Refresh exports</a>
        </p>
        <ExportList organizationId={organizationId} exports={exports} />
      </section>
    </>
  );
}
