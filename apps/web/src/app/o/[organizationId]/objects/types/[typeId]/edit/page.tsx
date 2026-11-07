import { getObjectType, listObjectTypes } from '@ensemus/application/custom-objects';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { ObjectTypeForm } from '@/components/objects/type-form';
import { PageHead, Empty } from '@/components/ui';
import { requireTenant, orNotFound } from '@/server/tenant';
export const metadata = { title: 'Edit custom type | Ensemus' };
export default async function EditObjectType({
  params,
}: {
  params: Promise<{ organizationId: string; typeId: string }>;
}) {
  const { organizationId, typeId } = await params,
    { database, context } = await requireTenant(organizationId),
    type = await orNotFound(getObjectType(database, context, typeId));
  return (
    <>
      <Link href={`/o/${organizationId}/objects/types/${type.id}`}>Back to {type.displayName}</Link>
      <PageHead
        title={`Edit ${type.displayName}`}
        description="Save a new immutable version. Existing records keep their content while safe changes are applied in the background."
      />
      {canProduct(context.role, 'object_type.manage') ? (
        <ObjectTypeForm
          organizationId={organizationId}
          type={type}
          types={await listObjectTypes(database, context)}
        />
      ) : (
        <Empty>Your role cannot change type definitions.</Empty>
      )}
    </>
  );
}
