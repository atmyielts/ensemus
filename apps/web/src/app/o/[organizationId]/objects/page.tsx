import { listObjectTypes } from '@ensemus/application/custom-objects';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { PageHead, Empty, ClassificationBadge, ErrorNotice } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Custom records | Ensemus' };
export default async function ObjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireTenant(organizationId),
    types = await listObjectTypes(database, context),
    base = `/o/${organizationId}/objects`;
  return (
    <>
      <Link href={`/o/${organizationId}/knowledge`}>Company knowledge</Link>
      <PageHead
        title="Custom records"
        description="Company data with its own fields, validation and access rules."
        actions={
          canProduct(context.role, 'object_type.manage') ? (
            <Link className="button" href={`${base}/new`}>
              Create type
            </Link>
          ) : undefined
        }
      />
      <ErrorNotice code={(await searchParams).error} />
      {types.length ? (
        <div className="list">
          {types.map((t) => (
            <div className="row" key={t.id}>
              <div>
                <Link href={`${base}/types/${t.id}`}>{t.displayName}</Link>
                <p className="muted">
                  Schema version {t.currentVersionNumber} · {t.fields.length} fields
                </p>
              </div>
              <ClassificationBadge value={t.classification} />
            </div>
          ))}
        </div>
      ) : (
        <Empty>
          No custom types yet. An organization administrator can define the fields your company
          needs.
        </Empty>
      )}
    </>
  );
}
