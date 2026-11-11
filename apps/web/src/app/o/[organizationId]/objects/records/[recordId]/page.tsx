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
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { PageHead, ClassificationBadge, Empty, ErrorNotice, BackLink } from '@/components/ui';
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
    choices.push({
      definition,
      targets: targets.items.filter((t) => t.id !== record.id),
      next: targets.next,
    });
  }
  return (
    <OneActionAtATime>
      <BackLink href={`${base}/types/${type.id}`}>Back to {type.displayName}</BackLink>
      <PageHead title={record.displayName} />
      <ErrorNotice code={invalidCursor ? 'INVALID_INPUT' : undefined} />
      <div className="detail-layout">
        <div className="stack">
          {record.typeVersionNumber < type.currentVersionNumber && (
            <p className="notice" role="status">
              This record still uses an earlier version of the fields. What it holds is shown below.
              If an update fails, that version stays as it is.
            </p>
          )}
          <section className="card" aria-labelledby="record-details-heading">
            <h2 id="record-details-heading">Details</h2>
            {shape.fields.length ? (
              <dl className="details">
                {shape.fields.map((f) => {
                  const value = Object.hasOwn(record.attributes, f.key)
                    ? record.attributes[f.key]
                    : undefined;
                  return (
                    <div key={f.key}>
                      <dt>{f.label}</dt>
                      <dd>
                        {value === null || value === undefined ? (
                          <span className="muted">Not specified</span>
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
            ) : (
              <p className="muted">This type has no fields beyond the record name.</p>
            )}
          </section>
          {record.canChange && type.state === 'active' && (
            <ObjectRecordForm
              organizationId={organizationId}
              typeId={type.id}
              fields={shape.fields}
              floor={type.classification}
              record={record}
              canLowerSensitivity={canProduct(context.role, 'object_type.manage')}
            />
          )}
          <section className="card" aria-labelledby="related-records">
            <h2 id="related-records">Related records</h2>
            {relations.items.length ? (
              <ul className="list">
                {relations.items.map((r) => (
                  <li key={r.id}>
                    <div>
                      <Link href={`${base}/records/${r.toRecordId}`}>{r.toDisplayName}</Link>
                      <br />
                      <small>
                        {type.relations.find((d) => d.key === r.relationKey)?.label ??
                          'Related record'}
                      </small>
                    </div>
                    {record.canChange && (
                      <form action={unlinkObjectRecordsAction}>
                        <input type="hidden" name="organizationId" value={organizationId} />
                        <input type="hidden" name="recordId" value={record.id} />
                        <input type="hidden" name="relationId" value={r.id} />
                        <SubmitButton label={`Unlink ${r.toDisplayName}`} className="ghost">
                          Unlink
                        </SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>
                {type.relations.length
                  ? 'Records connected to this one that you can read appear here.'
                  : 'This type does not connect to other records.'}
              </Empty>
            )}
            {relations.truncated && (
              <p className="link-line gap-above">
                <Link
                  href={`${base}/records/${record.id}?${new URLSearchParams({ relation_after: relations.next ?? '' })}#related-records`}
                >
                  Next readable relations
                </Link>
              </p>
            )}
            {record.canChange &&
              choices.map(({ definition, targets, next }) => (
                <details
                  key={definition.key}
                  open={query.relation === definition.key}
                  className="gap-above"
                >
                  <summary>Add {definition.label}</summary>
                  {targets.length ? (
                    <form action={linkObjectRecordsAction} className="inline-form gap-above-small">
                      <input type="hidden" name="organizationId" value={organizationId} />
                      <input type="hidden" name="recordId" value={record.id} />
                      <input type="hidden" name="relationKey" value={definition.key} />
                      <label htmlFor={`related-${definition.key}`}>
                        {definition.label}
                        <select required id={`related-${definition.key}`} name="toRecordId">
                          <option value="">Choose a readable record</option>
                          {targets.map((t) => (
                            <option value={t.id} key={t.id}>
                              {t.displayName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <SubmitButton className="secondary">Link record</SubmitButton>
                      {next && (
                        <p className="link-line">
                          <Link
                            href={`${base}/records/${record.id}?${new URLSearchParams({ relation: definition.key, target_after: next })}#related-records`}
                          >
                            Next readable choices
                          </Link>
                        </p>
                      )}
                    </form>
                  ) : (
                    <p className="muted gap-above-small">
                      There are no records you can read to connect yet.
                    </p>
                  )}
                </details>
              ))}
          </section>
        </div>
        <aside className="card">
          <dl className="details">
            <div>
              <dt>Who can see this</dt>
              <dd>
                <ClassificationBadge value={record.classification} />
              </dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>
                <Link href={`${base}/types/${type.id}`}>{type.displayName}</Link>
              </dd>
            </div>
            <div>
              <dt>Field layout</dt>
              <dd>Version {record.typeVersionNumber}</dd>
            </div>
          </dl>
          {record.canChange && (
            <details className="gap-above-large">
              <summary>Remove this record</summary>
              <p className="muted gap-above-small">
                It stops appearing in custom records and in anything made from it. A marker that it
                was removed is kept, with its earlier field layout.
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
        </aside>
      </div>
    </OneActionAtATime>
  );
}
