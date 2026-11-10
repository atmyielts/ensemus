// Native action permalink: deliberately outside /o's admitted workspace layout. No SSO exception
// serves that layout or private source. Denied rendering contains only the current POST's own values.
import type { ReactNode } from 'react';
import { AppError, idSchema } from '@ensemus/application';
import {
  getObjectRecord,
  getObjectRecordShape,
  getObjectType,
  listObjectTypes,
} from '@ensemus/application/custom-objects';
import { canProduct } from '@ensemus/domain/product-policy';
import { notFound } from 'next/navigation';
import { ObjectRecordForm } from '@/components/objects/record-form';
import { ObjectTypeForm } from '@/components/objects/type-form';
import { BackLink, Empty, PageHead, Wordmark } from '@/components/ui';
import { objectEditorDestination, type ObjectEditorScope } from '@/lib/object-editor';
import { orNotFound, requireTenantForAction } from '@/server/tenant';
export const metadata = { title: 'Resume record editor | Ensemus' };
const uuid = (value: unknown) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) notFound();
  return parsed.data;
};
type Tenant = Awaited<ReturnType<typeof requireTenantForAction>>;
async function editor(scope: ObjectEditorScope, { database, context }: Tenant): Promise<ReactNode> {
  if (scope.mode === 'record') {
    const record = await orNotFound(getObjectRecord(database, context, scope.id)),
      shape = await getObjectRecordShape(database, context, record.id),
      type = await getObjectType(database, context, record.typeId);
    if (!record.canChange || type.state !== 'active')
      return (
        <Empty>
          You can no longer edit this record. Open the original page to review your current access.
        </Empty>
      );
    return (
      <>
        <PageHead title={`Edit ${record.displayName}`} />
        <ObjectRecordForm
          organizationId={scope.organizationId}
          typeId={type.id}
          record={record}
          fields={shape.fields}
          floor={type.classification}
          canLowerSensitivity={canProduct(context.role, 'object_type.manage')}
        />
      </>
    );
  }
  if (scope.mode === 'new-record') {
    const type = await orNotFound(getObjectType(database, context, scope.typeId));
    if (type.state !== 'active') return <Empty>This type can no longer accept new records.</Empty>;
    return (
      <>
        <PageHead title={`New ${type.displayName} record`} />
        <ObjectRecordForm
          organizationId={scope.organizationId}
          typeId={type.id}
          fields={type.fields}
          floor={type.classification}
          requestKey={scope.id}
        />
      </>
    );
  }
  if (!canProduct(context.role, 'object_type.manage'))
    return <Empty>Your role cannot change record types.</Empty>;
  const types = await listObjectTypes(database, context);
  if (scope.mode === 'type') {
    const type = await orNotFound(getObjectType(database, context, scope.id));
    return (
      <>
        <PageHead title={`Edit ${type.displayName}`} />
        <ObjectTypeForm organizationId={scope.organizationId} type={type} types={types} />
      </>
    );
  }
  return (
    <>
      <PageHead title="Create record type" />
      <ObjectTypeForm organizationId={scope.organizationId} types={types} requestKey={scope.id} />
    </>
  );
}
export default async function ObjectEditorRecovery({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; mode: string; editorId: string }>;
  searchParams: Promise<{ type?: string | string[] }>;
}) {
  const input = await params,
    organizationId = uuid(input.organizationId),
    id = uuid(input.editorId),
    query = await searchParams;
  if (!['record', 'new-record', 'type', 'new-type'].includes(input.mode)) notFound();
  const scope: ObjectEditorScope =
    input.mode === 'new-record'
      ? { organizationId, id, mode: 'new-record', typeId: uuid(query.type) }
      : input.mode === 'record'
        ? { organizationId, id, mode: 'record' }
        : input.mode === 'type'
          ? { organizationId, id, mode: 'type' }
          : { organizationId, id, mode: 'new-type' };
  let content: ReactNode;
  try {
    const tenant = await requireTenantForAction(organizationId);
    content = await editor(scope, tenant);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'SSO_REQUIRED') throw error;
    content = (
      <>
        <PageHead title="Verify company sign-in" />
        {scope.mode === 'record' || scope.mode === 'new-record' ? (
          <ObjectRecordForm
            organizationId={organizationId}
            admission="sso-required"
            scope={scope}
          />
        ) : (
          <ObjectTypeForm organizationId={organizationId} admission="sso-required" scope={scope} />
        )}
      </>
    );
  }
  return (
    <main id="main" className="centered">
      <div className="sheet fields">
        <Wordmark />
        <BackLink href={objectEditorDestination(scope)}>Original editor</BackLink>
        {content}
      </div>
    </main>
  );
}
