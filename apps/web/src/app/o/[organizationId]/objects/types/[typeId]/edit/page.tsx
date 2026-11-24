import { getObjectType, listObjectTypes } from '@ensemus/application/custom-objects';
import { canProduct } from '@ensemus/domain/product-policy';
import { ObjectTypeForm } from '@/components/objects/type-form';
import { PageHead, Empty, BackLink } from '@/components/ui';
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
      <BackLink href={`/o/${organizationId}/objects/types/${type.id}`}>
        Back to {type.displayName}
      </BackLink>
      <PageHead
        title={`Edit ${type.displayName}`}
        description="Saving creates a new version of the fields. Existing records keep what they hold while they are updated in the background."
      />
      {canProduct(context.role, 'object_type.manage') ? (
        <ObjectTypeForm
          organizationId={organizationId}
          type={type}
          types={await listObjectTypes(database, context)}
        />
      ) : (
        <Empty title="Changing record types is not part of your role">
          Ask an administrator in your organization to change these fields.
        </Empty>
      )}
    </>
  );
}
