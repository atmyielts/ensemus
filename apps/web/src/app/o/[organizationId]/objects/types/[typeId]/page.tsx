import { randomUUID } from 'node:crypto';
import {
  getObjectType,
  listObjectRecords,
  listObjectMigrations,
} from '@ensemus/application/custom-objects';
import { AppError } from '@ensemus/application';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import {
  PageHead,
  Empty,
  ClassificationBadge,
  StatusBadge,
  ErrorNotice,
  ActionLink,
  BackLink,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { raiseObjectTypeAction, retryObjectMigrationAction } from '@/server/object-actions';
import { requireTenant, orNotFound } from '@/server/tenant';
export const metadata = { title: 'Custom type | Ensemus' };
const LEVEL: Record<string, string> = {
  public: 'Public',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
};
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
      <BackLink href={base}>Back to custom records</BackLink>
      <PageHead
        title={type.displayName}
        description="Each record here follows the same fields. Open one to see or change it."
        actions={
          <>
            {type.state === 'active' && <ActionLink href={`${path}/new`}>Create record</ActionLink>}
            {manager && (
              <ActionLink variant="secondary" href={`${path}/edit`}>
                Edit type fields
              </ActionLink>
            )}
          </>
        }
      />
      <ErrorNotice code={error} />
      {query.saved && (
        <p className="notice good" role="status">
          The new version is saved. Existing records are updated in the background; a record that
          cannot be updated keeps its earlier version.
        </p>
      )}
      <dl className="facts type-summary">
        <div>
          <dt>Who can see records, at the least</dt>
          <dd>
            <ClassificationBadge value={type.classification} />
          </dd>
        </div>
        <div>
          <dt>Fields</dt>
          <dd>{type.fields.length}</dd>
        </div>
        <div>
          <dt>Field layout version</dt>
          <dd>{type.currentVersionNumber}</dd>
        </div>
      </dl>
      <section className="card" aria-labelledby="records-heading">
        <h2 id="records-heading">Records</h2>
        {type.fields.some((f) => f.indexed) && (
          <form method="get" className="inline-form filter">
            <label htmlFor="object-filter-field">
              Filter by
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
            <button type="submit" className="secondary">
              Filter records
            </button>
            {filter && (
              <span className="link-line">
                <Link href={path}>Clear filter</Link>
              </span>
            )}
          </form>
        )}
        {page.items.length ? (
          <div className="table-wrap">
            <table className="work-table">
              <caption className="visually-hidden">Readable {type.displayName} records</caption>
              <thead>
                <tr>
                  <th scope="col">Record</th>
                  <th scope="col">Who can see this</th>
                  <th scope="col">Field layout</th>
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
                      Version {r.typeVersionNumber}
                      {r.typeVersionNumber < type.currentVersionNumber ? ' (earlier)' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={filter ? 'No records match this filter' : 'No records yet'}>
            {filter
              ? 'Try another value, or clear the filter to see every record you can read.'
              : type.state === 'active'
                ? 'Records you create, and records others share with you, appear here.'
                : 'This type has been archived, so it no longer takes new records.'}
          </Empty>
        )}
        {page.next && (
          <p className="link-line gap-above">
            <Link
              href={`${path}?${new URLSearchParams({ after: page.next, ...(filter ? { field: filter.fieldKey, equals: filter.equals } : {}) })}`}
            >
              Next records
            </Link>
          </p>
        )}
      </section>
      {manager && (
        <section className="settings-section" aria-labelledby="updates-heading">
          <div className="section-intro">
            <h2 id="updates-heading">Updates to existing records</h2>
            <p>
              When you change the fields, existing records are updated in the background. A record
              that cannot be updated keeps its earlier version, and its owner can correct it before
              you retry.
            </p>
          </div>
          {migrations.length ? (
            <div className="card">
              <ul className="list">
                {migrations.map((m) => (
                  <li key={m.id}>
                    <div>
                      Version {m.from} → {m.to}
                      <br />
                      <small>
                        {m.migrated} updated · {m.failed} could not be updated and keep their
                        earlier version
                      </small>
                    </div>
                    <div className="row">
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
                            <SubmitButton className="secondary">
                              Retry remaining records
                            </SubmitButton>
                          </form>
                        )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted">The fields have not changed since this type was created.</p>
          )}
          {classes.indexOf(type.classification) < 3 && (
            <details className="gap-above-large">
              <summary>Make records of this type more private</summary>
              <p className="gap-above-small">
                This also moves existing records up to the new level. Their owners keep them, and
                people who no longer qualify lose access. You cannot undo this for this type.
              </p>
              <form action={raiseObjectTypeAction} className="fields">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="typeId" value={type.id} />
                <input type="hidden" name="version" value={type.version} />
                <label htmlFor="object-floor">
                  New lowest level
                  <select id="object-floor" name="classification">
                    {classes.slice(classes.indexOf(type.classification) + 1).map((c) => (
                      <option key={c} value={c}>
                        {LEVEL[c]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="row">
                  <SubmitButton className="danger">Make more private</SubmitButton>
                </div>
              </form>
            </details>
          )}
        </section>
      )}
    </OneActionAtATime>
  );
}
