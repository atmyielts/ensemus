import { getWorkUnit, idSchema, listImportedRecordsForWork } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ImportHistory } from '@/components/import-history';
import { PageHead } from '@/components/ui';
import { orNotFound, requireTenant } from '@/server/tenant';

export const metadata = { title: 'Imported history | Ensemus' };

// One piece of work's history from an archive. Both reads hold to the work's own read rule, so work someone
// may not read, in this tenant or any other, is the same not found as work that does not exist.
export default async function ImportedWorkHistoryPage({
  params,
}: {
  params: Promise<{ organizationId: string; workUnitId: string }>;
}) {
  const { organizationId, workUnitId } = await params;
  const { context, database } = await requireTenant(organizationId);
  if (!can(context.role, 'license.view')) notFound();
  const id = idSchema.safeParse(workUnitId);
  if (!id.success) notFound();

  const [work, records] = await orNotFound(
    Promise.all([
      getWorkUnit(database, context, id.data),
      listImportedRecordsForWork(database, context, id.data),
    ]),
  );

  return (
    <>
      <p className="back">
        <Link href={`/o/${organizationId}/data/work`}>Imported history</Link>
      </p>
      <PageHead
        title={work.title}
        description="What came with this work from an archive. This is a record of what happened elsewhere, and nothing here can be acted on."
      />
      <p>
        <Link href={`/o/${organizationId}/work/${id.data}`}>Open this work</Link>
      </p>
      <ImportHistory records={records} />
    </>
  );
}
