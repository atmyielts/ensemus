import { randomUUID } from 'node:crypto';
import { listObjectTypes } from '@ensemus/application/custom-objects';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { PageHead, Empty } from '@/components/ui';
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
      <Link href={`/o/${organizationId}/objects`}>Back to custom records</Link>
      <PageHead
        title="Create type"
        description="Define a stable shape for company records. Type sensitivity can be raised later; lowering it requires a different type."
      />
      {canProduct(context.role, 'object_type.manage') ? (
        <ObjectTypeForm
          organizationId={organizationId}
          types={await listObjectTypes(database, context)}
          requestKey={randomUUID()}
        />
      ) : (
        <Empty>Your role cannot define custom types. Ask an organization administrator.</Empty>
      )}
    </>
  );
}
