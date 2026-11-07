import { randomUUID } from 'node:crypto';
import {
  getObjectType,
  listObjectRecords,
  listObjectMigrations,
} from '@ensemus/application/custom-objects';
import { AppError } from '@ensemus/application';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { PageHead, Empty, ClassificationBadge, StatusBadge, ErrorNotice } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { raiseObjectTypeAction, retryObjectMigrationAction } from '@/server/object-actions';
import { requireTenant, orNotFound } from '@/server/tenant';
export const metadata = { title: 'Custom type | Ensemus' };
export default async function TypePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; typeId: string }>;
  searchParams: Promise<{
    after?: string;
    field?: string;
    equals?: string;
    error?: string;
    saved?: string;
  }>;
}) {
  const { organizationId, typeId } = await params,
    { database, context } = await requireTenant(organizationId),
    type = await orNotFound(getObjectType(database, context, typeId)),
    query = await searchParams,
    base = `/o/${organizationId}/objects`,
    path = `${base}/types/${type.id}`;
  let error = query.error;
  const filter =
    query.field && query.equals !== undefined
      ? { fieldKey: query.field, equals: query.equals }
      : undefined;
  const page = await listObjectRecords(database, context, {
    typeId,
    ...(query.after ? { after: query.after } : {}),
    ...(filter ? { filter } : {}),
  }).catch((e: unknown) => {
    if (!(e instanceof AppError) || e.code !== 'INVALID_INPUT') throw e;
    error = e.code;
    return listObjectRecords(database, context, { typeId });
  });
  const manager = canProduct(context.role, 'object_type.manage'),
    migrations = manager ? await listObjectMigrations(database, context, typeId) : [],
    classes = ['public', 'internal', 'confidential', 'restricted'];
  return (
    <OneActionAtATime>
      <Link href={base}>Back to custom records</Link>
      <PageHead
        title={type.displayName}
        description={`Records use immutable schema versions. Current version: ${type.currentVersionNumber}.`}
        actions={
          <>
            {type.state === 'active' && (
              <Link className="button" href={`${path}/new`}>
                Create record
              </Link>
            )}
            {manager && (
              <Link className="button secondary" href={`${path}/edit`}>
                Edit type fields
              </Link>
            )}
          </>
        }
      />
      <ErrorNotice code={error} />
      {query.saved && (
        <p role="status">
          The new version is saved. Existing records are updated in the background; a record that
          cannot be updated keeps its earlier version.
        </p>
      )}
      <p>
        Minimum sensitivity: <ClassificationBadge value={type.classification} />
      </p>
      {type.fields.some((f) => f.indexed) && (
        <form method="get" className="card fields">
          <label htmlFor="object-filter-field">
            Filter field
            <select id="object-filter-field" name="field" defaultValue={query.field}>
              {type.fields
                .filter((f) => f.indexed)
                .map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
            </select>
          </label>
          <label htmlFor="object-filter-value">
            Equals
            <input id="object-filter-value" name="equals" required defaultValue={query.equals} />
          </label>
          <button type="submit">Filter records</button>
          <Link href={path}>Clear filter</Link>
        </form>
      )}
      {page.items.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Readable {type.displayName} records</caption>
            <thead>
              <tr>
                <th scope="col">Record</th>
                <th scope="col">Sensitivity</th>
                <th scope="col">Schema version</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`${base}/records/${r.id}`}>{r.displayName}</Link>
                  </td>
                  <td>
                    <ClassificationBadge value={r.classification} />
                  </td>
                  <td>
                    {r.typeVersionNumber}
                    {r.typeVersionNumber < type.currentVersionNumber ? ' · earlier version' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No records match your access and filters.</Empty>
      )}
      {page.next && (
        <Link
          href={`${path}?${new URLSearchParams({ after: page.next, ...(filter ? { field: filter.fieldKey, equals: filter.equals } : {}) })}`}
        >
          Next records
        </Link>
      )}
      {manager && (
        <>
          <h2>Schema updates</h2>
          <p className="muted">
            A failed update keeps the earlier record and schema. Its owner can correct the record
            before an administrator requests a new retry. Earlier results are retained.
          </p>
          {migrations.length ? (
            <div className="list">
              {migrations.map((m) => (
                <div className="row" key={m.id}>
                  <div>
                    Version {m.from} → {m.to}
                    <p className="muted">
                      {m.migrated} updated · {m.failed} could not be updated and keep their earlier
                      version
                    </p>
                  </div>
                  <div>
                    <StatusBadge status={m.status} />
                    {m.status === 'failed' &&
                      m.to === type.currentVersionNumber &&
                      !migrations.some(
                        (job) => job.status === 'queued' || job.status === 'running',
                      ) && (
                        <form action={retryObjectMigrationAction}>
                          <input type="hidden" name="organizationId" value={organizationId} />
                          <input type="hidden" name="typeId" value={type.id} />
                          <input type="hidden" name="migrationId" value={m.id} />
                          <input type="hidden" name="version" value={type.version} />
                          <input type="hidden" name="requestKey" value={randomUUID()} />
                          <SubmitButton className="secondary">Retry remaining records</SubmitButton>
                        </form>
                      )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No schema updates have been requested.</p>
          )}
          {classes.indexOf(type.classification) < 3 && (
            <details>
              <summary>Raise minimum sensitivity</summary>
              <p>
                This also raises existing records below the new minimum. Their owners keep
                ownership; people who no longer qualify lose access. This cannot be undone on this
                type.
              </p>
              <form action={raiseObjectTypeAction} className="fields">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="typeId" value={type.id} />
                <input type="hidden" name="version" value={type.version} />
                <label htmlFor="object-floor">
                  New minimum sensitivity
                  <select id="object-floor" name="classification">
                    {classes.slice(classes.indexOf(type.classification) + 1).map((c) => (
                      <option key={c} value={c}>
                        {c[0]?.toUpperCase() + c.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
                <SubmitButton>Raise minimum</SubmitButton>
              </form>
            </details>
          )}
        </>
      )}
    </OneActionAtATime>
  );
}
