import { AppError, listWorkUnits } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Empty, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Imported history | Ensemus' };

type WorkPage = Awaited<ReturnType<typeof listWorkUnits>>;

// Work pages stay as they are, so imported history is reached from here, a piece of work at a time. Only work
// this person could already read is listed, because the list comes from the same rule the work pages use.
export default async function ImportedWorkListPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
}) {
  const { organizationId } = await params;
  const { cursor } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  if (!can(context.role, 'license.view')) notFound();

  let page: WorkPage;
  try {
    page = await listWorkUnits(database, context, typeof cursor === 'string' ? { cursor } : {});
  } catch (error) {
    // The address holds the cursor, so a damaged one is a mistyped link and not a failure.
    if (error instanceof AppError && error.code === 'INVALID_INPUT') notFound();
    throw error;
  }
  const base = `/o/${organizationId}/data`;

  return (
    <>
      <p className="back">
        <Link href={base}>Export and import</Link>
      </p>
      <PageHead
        title="Imported history"
        description="Choose a piece of work to read what came with it from an archive. Work made here has none."
      />
      {page.items.length === 0 ? (
        <Empty>There is no work here that you can read.</Empty>
      ) : (
        <ul className="list">
          {page.items.map((work) => (
            <li key={work.id}>
              <Link href={`${base}/work/${work.id}`}>{work.title}</Link>
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor && (
        <p className="gap-above">
          <Link href={`${base}/work?cursor=${encodeURIComponent(page.nextCursor)}`}>
            Next page
          </Link>
        </p>
      )}
    </>
  );
}
