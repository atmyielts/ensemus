import { createPackService } from '@ensemus/application/packs';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConfirmForm } from '@/components/confirm-form';
import { CapabilityRequest } from '@/components/packs/capability-request';
import {
  itemHref,
  ITEM_KIND_WORDS,
  LEFT_OUT_WORDS,
  PackStatusBadge,
} from '@/components/packs/words';
import { Empty, ErrorNotice, PageHead } from '@/components/ui';
import { activatePackAction, rollbackPackAction } from '@/server/pack-actions';
import { webProductPorts } from '@/server/product-ports';
import { orNotFound, requireTenant } from '@/server/tenant';

export const metadata = { title: 'Review a pack | Ensemus' };

export default async function PackInstallationPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; installationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, installationId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  if (!canProduct(context.role, 'pack.manage')) notFound();
  const base = `/o/${organizationId}`;
  const service = createPackService({ toolCatalog: webProductPorts().toolCatalog });
  const review = await orNotFound(service.getPackReview(database, context, installationId));
  const { installation } = review;
  const reviewing = installation.status === 'reviewing';
  const undecided = review.requests.filter((request) => request.decision === 'pending').length;
  const hidden = (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="installationId" value={installation.id} />
      <input type="hidden" name="expectedVersion" value={installation.version} />
    </>
  );

  return (
    <>
      <PageHead
        title={`${review.name} ${installation.packVersion}`}
        description={review.description}
        actions={<PackStatusBadge status={installation.status} />}
      />
      <ErrorNotice code={error} />
      <p>
        <Link href={`${base}/packs`}>Back to packs</Link>
      </p>
      <p className="notice">
        Accepting something here records your decision and grants no permission. It changes
        nobody&apos;s role. No agent or workflow can run because of it: each one starts as a draft,
        and has to pass a simulation and a review like any other.
      </p>
      {review.toolCatalog === 'unavailable' && (
        <p className="notice warn">
          The list of tools cannot be read on this deployment yet. You can still decide, and anything
          that names a tool will be left out for now.
        </p>
      )}
      <div className="stack">
        <section className="card" aria-labelledby="requests-heading">
          <h2 id="requests-heading">What this pack asks for</h2>
          {review.requests.length === 0 ? (
            <Empty>This version asks for nothing.</Empty>
          ) : (
            <ul className="list">
              {review.requests.map((request) => (
                <CapabilityRequest
                  key={request.key}
                  organizationId={organizationId}
                  installationId={installation.id}
                  request={request}
                  canDecide={reviewing}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="makes-heading">
          <h2 id="makes-heading">{reviewing ? 'What it would make' : 'What it made'}</h2>
          {review.willMake.length === 0 ? (
            <Empty>
              {reviewing
                ? 'Nothing yet, with the decisions made so far.'
                : 'This version made nothing.'}
            </Empty>
          ) : (
            <ul className="list">
              {review.willMake.map((item) => {
                const made = installation.items.find(
                  (row) => row.kind === item.kind && row.key === item.key,
                );
                const href = made ? itemHref(base, made) : null;
                return (
                  <li key={`${item.kind}-${item.key}`}>
                    <span>{href ? <Link href={href}>{item.name}</Link> : item.name}</span>
                    <small>{ITEM_KIND_WORDS[item.kind] ?? 'Item'}</small>
                  </li>
                );
              })}
            </ul>
          )}
          {review.leftOut.length > 0 && (
            <>
              <h3>Left out</h3>
              <ul className="list">
                {review.leftOut.map((item) => (
                  <li key={item.name}>
                    <span>{item.name}</span>
                    <small>
                      {LEFT_OUT_WORDS[item.reason] ?? 'It cannot be made here.'}
                      {item.subject ? ` (${item.subject})` : ''}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {reviewing && (
          <section className="card" aria-labelledby="activate-heading">
            <h2 id="activate-heading">Activate</h2>
            {review.canActivate ? (
              <ConfirmForm
                action={activatePackAction}
                fields={hidden}
                summary="Activate this version"
                consequence="Make the record types and drafts listed above. I understand they can do nothing until each is simulated, reviewed and published."
                confirmLabel="Activate"
                confirmFullLabel={`Activate ${review.name} ${installation.packVersion}`}
              />
            ) : (
              <p className="muted">
                {undecided === 1
                  ? 'One thing is still to be decided before this can be activated.'
                  : `${undecided} things are still to be decided before this can be activated.`}
              </p>
            )}
          </section>
        )}

        {review.canRollback && (
          <section className="card" aria-labelledby="rollback-heading">
            <h2 id="rollback-heading">Go back to the earlier version</h2>
            <p className="muted">
              Drafts only this version made are archived, unless they have been published. Record
              types stay, with every record in them.
            </p>
            <ConfirmForm
              action={rollbackPackAction}
              fields={hidden}
              summary="Roll back this version"
              consequence="Archive the unpublished drafts this version made, and make the earlier version active again."
              confirmLabel="Roll back"
              confirmFullLabel={`Roll back ${review.name} ${installation.packVersion}`}
            />
          </section>
        )}

        {review.rollback && (
          <section className="card" aria-labelledby="after-rollback-heading">
            <h2 id="after-rollback-heading">After the rollback</h2>
            {review.rollback.published.length > 0 ? (
              <>
                <h3>Published, and yours to decide on</h3>
                <p className="muted">
                  These went through their own review, so a rollback left them as they are.
                </p>
                <ul className="list">
                  {review.rollback.published.map((item) => {
                    const href = itemHref(base, item);
                    return (
                      <li key={item.id}>
                        <span>{href ? <Link href={href}>{item.name}</Link> : item.name}</span>
                        <small>{ITEM_KIND_WORDS[item.kind] ?? 'Item'}</small>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="muted">Nothing this version made had been published.</p>
            )}
            {review.rollback.keptTypes.length > 0 && (
              <>
                <h3>Kept, with their records</h3>
                <ul className="list">
                  {review.rollback.keptTypes.map((item) => (
                    <li key={item.id}>
                      <Link href={`${base}/objects`}>{item.name}</Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {review.rollback.archived.length > 0 && (
              <>
                <h3>Archived</h3>
                <ul className="list">
                  {review.rollback.archived.map((item) => (
                    <li key={item.id}>
                      <span>{item.name}</span>
                      <small>{ITEM_KIND_WORDS[item.kind] ?? 'Item'}</small>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
    </>
  );
}
