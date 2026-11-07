import {
  getObjectRecord,
  getObjectRecordShape,
  getObjectType,
  listObjectTypes,
  listObjectRecords,
  listObjectRelations,
} from '@ensemus/application/custom-objects';
import { idSchema } from '@ensemus/application';
import { isSafeObjectLink } from '@ensemus/domain/custom-object';
import Link from 'next/link';
import { PageHead, ClassificationBadge, Empty, ErrorNotice } from '@/components/ui';
import { ObjectRecordForm } from '@/components/objects/record-form';
import { SubmitButton } from '@/components/submit-button';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import {
  deleteObjectRecordAction,
  linkObjectRecordsAction,
  unlinkObjectRecordsAction,
} from '@/server/object-actions';
import { requireTenant, orNotFound } from '@/server/tenant';
export const metadata = { title: 'Custom record | Ensemus' };
export default async function RecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; recordId: string }>;
  searchParams: Promise<{ relation?: string; target_after?: string; relation_after?: string }>;
}) {
  const { organizationId, recordId } = await params,
    { database, context } = await requireTenant(organizationId),
    record = await orNotFound(getObjectRecord(database, context, recordId)),
    shape = await getObjectRecordShape(database, context, record.id),
    type = await getObjectType(database, context, record.typeId),
    base = `/o/${organizationId}/objects`,
    types = record.canChange ? await listObjectTypes(database, context) : [];
  const query = await searchParams;
  const targetAfter = query.target_after ? idSchema.safeParse(query.target_after) : undefined,
    relationAfter = query.relation_after ? idSchema.safeParse(query.relation_after) : undefined;
  const invalidCursor =
    (targetAfter && !targetAfter.success) || (relationAfter && !relationAfter.success);
  const relations = await listObjectRelations(
    database,
    context,
    record.id,
    relationAfter?.success ? { after: relationAfter.data } : {},
  );
  const choices = [];
  for (const definition of type.relations) {
    const targetType = types.find((t) => t.slug === definition.toTypeSlug);
    if (!targetType) continue;
    const targets = await listObjectRecords(database, context, {
      typeId: targetType.id,
      limit: 100,
      ...(query.relation === definition.key && targetAfter?.success
        ? { after: targetAfter.data }
        : {}),
    });
    choices.push({ definition, targets });
  }
  return (
    <OneActionAtATime>
      <Link href={`${base}/types/${type.id}`}>Back to {type.displayName}</Link>
      <PageHead
        title={record.displayName}
        description={`Schema version ${record.typeVersionNumber}.`}
      />
      <ErrorNotice code={invalidCursor ? 'INVALID_INPUT' : undefined} />
      <p>
        Sensitivity: <ClassificationBadge value={record.classification} />
      </p>
      {record.typeVersionNumber < type.currentVersionNumber && (
        <p role="status">
          This record still uses an earlier schema. Its saved content is shown below. A failed
          update leaves that version intact.
        </p>
      )}
      <dl className="facts">
        {shape.fields.map((f) => {
          const value = Object.hasOwn(record.attributes, f.key)
            ? record.attributes[f.key]
            : undefined;
          return (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd>
                {value === null || value === undefined ? (
                  'Not specified'
                ) : f.kind === 'url' && isSafeObjectLink(value) ? (
                  <a href={value} rel="noreferrer noopener">
                    {value}
                  </a>
                ) : typeof value === 'boolean' ? (
                  value ? (
                    'Yes'
                  ) : (
                    'No'
                  )
                ) : (
                  String(value)
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {record.canChange && type.state === 'active' && (
        <details>
          <summary>Edit record</summary>
          <ObjectRecordForm
            organizationId={organizationId}
            typeId={type.id}
            fields={shape.fields}
            floor={type.classification}
            record={record}
          />
        </details>
      )}
      <h2 id="related-records">Related records</h2>
      {relations.items.length ? (
        <div className="list">
          {relations.items.map((r) => (
            <div className="row" key={r.id}>
              <div>
                <span>
                  {type.relations.find((d) => d.key === r.relationKey)?.label ?? 'Related record'}
                  :{' '}
                </span>
                <Link href={`${base}/records/${r.toRecordId}`}>{r.toDisplayName}</Link>
              </div>
              {record.canChange && (
                <form action={unlinkObjectRecordsAction}>
                  <input type="hidden" name="organizationId" value={organizationId} />
                  <input type="hidden" name="recordId" value={record.id} />
                  <input type="hidden" name="relationId" value={r.id} />
                  <SubmitButton label={`Unlink ${r.toDisplayName}`} className="secondary">
                    Unlink
                  </SubmitButton>
                </form>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty>No readable relations.</Empty>
      )}
      {relations.truncated && (
        <p>
          <Link
            href={`${base}/records/${record.id}?${new URLSearchParams({ relation_after: relations.next ?? '' })}#related-records`}
          >
            Next readable relations
          </Link>
        </p>
      )}
      {record.canChange &&
        choices.map(({ definition, targets }) => (
          <details key={definition.key} open={query.relation === definition.key}>
            <summary>Add {definition.label}</summary>
            {targets.items.filter((t) => t.id !== record.id).length ? (
              <form action={linkObjectRecordsAction} className="fields">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="recordId" value={record.id} />
                <input type="hidden" name="relationKey" value={definition.key} />
                <label htmlFor={`related-${definition.key}`}>
                  {definition.label}
                  <select required id={`related-${definition.key}`} name="toRecordId">
                    <option value="">Choose a readable record</option>
                    {targets.items
                      .filter((t) => t.id !== record.id)
                      .map((t) => (
                        <option value={t.id} key={t.id}>
                          {t.displayName}
                        </option>
                      ))}
                  </select>
                </label>
                {targets.next && (
                  <p>
                    <Link
                      href={`${base}/records/${record.id}?${new URLSearchParams({ relation: definition.key, target_after: targets.next })}#related-records`}
                    >
                      Next readable choices
                    </Link>
                  </p>
                )}
                <SubmitButton>Link record</SubmitButton>
              </form>
            ) : (
              <p>No readable target records are available.</p>
            )}
          </details>
        ))}
      {record.canChange && (
        <details>
          <summary>Remove this record</summary>
          <p>
            It will stop appearing in custom records and in content derived from it. Its old schema
            and deletion marker are retained.
          </p>
          <form action={deleteObjectRecordAction}>
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="recordId" value={record.id} />
            <input type="hidden" name="typeId" value={type.id} />
            <input type="hidden" name="version" value={record.version} />
            <SubmitButton className="danger">Remove record</SubmitButton>
          </form>
        </details>
      )}
    </OneActionAtATime>
  );
}
