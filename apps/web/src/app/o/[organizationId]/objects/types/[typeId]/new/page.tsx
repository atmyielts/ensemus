import { randomUUID } from 'node:crypto';
import { getObjectType } from '@ensemus/application/custom-objects';
import Link from 'next/link';
import { PageHead, Empty } from '@/components/ui';
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
      <Link href={`/o/${organizationId}/objects/types/${type.id}`}>Back to {type.displayName}</Link>
      <PageHead
        title={`New ${type.displayName} record`}
        description={`Schema version ${type.currentVersionNumber}. New records belong to you and cannot be less sensitive than this type.`}
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
        <Empty>This type has been archived. It cannot accept new records.</Empty>
      )}
    </>
  );
}
