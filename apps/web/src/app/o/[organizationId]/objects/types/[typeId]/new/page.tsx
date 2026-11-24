import { randomUUID } from 'node:crypto';
import { getObjectType } from '@ensemus/application/custom-objects';
import { PageHead, Empty, BackLink } from '@/components/ui';
import { ObjectRecordForm } from '@/components/objects/record-form';
import { requireTenant, orNotFound } from '@/server/tenant';
export const metadata = { title: 'Create record | Ensemus' };
export default async function NewObjectRecord({
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
        title={`New ${type.displayName} record`}
        description="The record will be yours. You choose who else can see it, within the limits of this type."
      />
      {type.state === 'active' ? (
        <ObjectRecordForm
          organizationId={organizationId}
          typeId={type.id}
          floor={type.classification}
          fields={type.fields}
          requestKey={randomUUID()}
        />
      ) : (
        <Empty title="This type is archived">
          It no longer takes new records. Its existing records are still there to read.
        </Empty>
      )}
    </>
  );
}
