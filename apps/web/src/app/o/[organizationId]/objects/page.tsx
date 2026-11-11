import { listObjectTypes } from '@ensemus/application/custom-objects';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { PageHead, Empty, ClassificationBadge, ErrorNotice, ActionLink } from '@/components/ui';
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
    base = `/o/${organizationId}/objects`,
    manager = canProduct(context.role, 'object_type.manage');
  return (
    <div className="stack">
      <PageHead
        title="Custom records"
        description="A custom record is a list your company keeps in its own shape, such as suppliers or equipment, with the fields your team chooses."
        actions={
          manager && types.length ? (
            <ActionLink href={`${base}/new`}>Create record type</ActionLink>
          ) : undefined
        }
      />
      <ErrorNotice code={(await searchParams).error} />
      {types.length ? (
        <section className="card" aria-labelledby="types-heading">
          <div className="section-heading">
            <h2 id="types-heading">Record types</h2>
            <p>Open a type to see its records or add one.</p>
          </div>
          <ul className="list">
            {types.map((t) => (
              <li key={t.id}>
                <div>
                  <Link href={`${base}/types/${t.id}`}>{t.displayName}</Link>
                  <br />
                  <small>
                    {t.fields.length} {t.fields.length === 1 ? 'field' : 'fields'} · field layout
                    version {t.currentVersionNumber}
                  </small>
                </div>
                <ClassificationBadge value={t.classification} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Empty
          title="No record types yet"
          action={
            manager ? <ActionLink href={`${base}/new`}>Create record type</ActionLink> : undefined
          }
        >
          {manager
            ? 'Create a type, such as Suppliers or Equipment, and choose the fields your team fills in for each one.'
            : 'An administrator can set up record types, such as Suppliers or Equipment, for your team to fill in.'}
        </Empty>
      )}
    </div>
  );
}
