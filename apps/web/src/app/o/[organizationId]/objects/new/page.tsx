import { randomUUID } from 'node:crypto';
import { listObjectTypes } from '@ensemus/application/custom-objects';
import { canProduct } from '@ensemus/domain/product-policy';
import { PageHead, Empty, BackLink } from '@/components/ui';
import { ObjectTypeForm } from '@/components/objects/type-form';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Create custom type | Ensemus' };
export default async function NewObjectType({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireTenant(organizationId);
  return (
    <>
      <BackLink href={`/o/${organizationId}/objects`}>Back to custom records</BackLink>
      <PageHead
        title="Create record type"
        description="Name the kind of record, such as Suppliers or Equipment, and choose the fields your team fills in. You can add more fields later."
      />
      {canProduct(context.role, 'object_type.manage') ? (
        <ObjectTypeForm
          organizationId={organizationId}
          types={await listObjectTypes(database, context)}
          requestKey={randomUUID()}
        />
      ) : (
        <Empty title="Creating record types is not part of your role">
          Ask an administrator in your organization to set up the record type.
        </Empty>
      )}
    </>
  );
}
