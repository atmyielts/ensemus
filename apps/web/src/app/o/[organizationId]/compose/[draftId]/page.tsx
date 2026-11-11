import { AppError, getWorkUnit, listDirectory, listWorkUnits } from '@ensemus/application';
import { getOutcomeDraft } from '@ensemus/application/outcomes';
import { BUNDLED_WORKFLOWS } from '@ensemus/packs/bundled';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BackLink, ClassificationBadge, Empty, PageHead } from '@/components/ui';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { PreviewForm } from '@/components/experience/preview-form';
import { ExperienceActionForm } from '@/components/experience/action-form';
import { requireTenant } from '@/server/tenant';
import { confirmOutcomeAction, discardOutcomeAction } from '@/server/experience-actions';
export const metadata = { title: 'Review an outcome | Ensemus' };
export default async function OutcomePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; draftId: string }>;
  searchParams: Promise<{ saved?: string; workAfter?: string }>;
}) {
  const { organizationId, draftId } = await params,
    { database, context } = await requireTenant(organizationId),
    base = `/o/${organizationId}`;
  let draft;
  try {
    draft = await getOutcomeDraft(database, context, draftId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }
  const query = await searchParams,
    p = draft.preview,
    people = (await listDirectory(database, context))
      .filter((person) => person.status === 'active')
      .map((person) => ({ id: person.membershipId, name: person.name })),
    page = await listWorkUnits(database, context, {
      limit: 50,
      ...(query.workAfter ? { cursor: query.workAfter } : {}),
    }),
    dependencies = page.items.map((w) => ({ id: w.id, title: w.title }));
  for (const id of p.dependencyWorkUnitIds)
    if (!dependencies.some((w) => w.id === id)) {
      try {
        const w = await getWorkUnit(database, context, id);
        dependencies.push({ id: w.id, title: w.title });
      } catch (error) {
        if (error instanceof AppError && error.code === 'NOT_FOUND') {
          dependencies.push({
            id,
            title:
              'Previously selected prerequisite is no longer readable. Remove it, or ask its owner to restore access.',
          });
        } else throw error;
      }
    }
  const owner =
    people.find((person) => person.id === p.ownerMembershipId)?.name ??
    'The selected person is no longer active';
  return (
    <OneActionAtATime>
      <BackLink href={`${base}/compose`}>Your drafts</BackLink>
      <PageHead
        title="Review your outcome"
        description="Only you can read this preview. Simple rules suggested a starting point; check it, change what you need, and you decide whether to create the work."
      />
      {(await searchParams).saved === '1' && (
        <p role="status" className="notice">
          Changes saved. Review this version before creating Work.
        </p>
      )}
      <section className="card fields" aria-labelledby="saved-preview">
        <h2 id="saved-preview">Saved preview</h2>
        <h3>{p.title}</h3>
        <p className="preserve">{p.objective}</p>
        <dl className="details">
          <div>
            <dt>Accountable owner</dt>
            <dd>{owner}</dd>
          </div>
          <div>
            <dt>Due date</dt>
            <dd>{p.dueAt ?? 'No date chosen'}</dd>
          </div>
          <div>
            <dt>Who can see this</dt>
            <dd>
              <ClassificationBadge value={p.classification} />
            </dd>
          </div>
          <div>
            <dt>Success requirements</dt>
            <dd>
              {p.successCriteria.length ? (
                <ul>
                  {p.successCriteria.map((c, i) => (
                    <li key={i}>
                      {c.label}
                      {c.kind === 'artifact_named' && (
                        <p className="muted">
                          File attached; a person checks the requested name and content.
                        </p>
                      )}
                      {c.kind === 'none' && (
                        <p className="muted">
                          Manual check; this adds no automatic completion test.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                'No additional automatic completion tests.'
              )}
            </dd>
          </div>
        </dl>
        <p className="notice">
          Creating this work starts nothing by itself: no assistant, workflow or AI model, and
          nothing is sent outside Ensemus. Its owner chooses how to do it later.
        </p>
        {(p.dataAccess.usesAgent || p.dataAccess.reachesExternalService) && (
          <p className="muted">
            Your words or the related workflow suggest{' '}
            {p.dataAccess.usesAgent ? 'possible assistant use' : ''}
            {p.dataAccess.usesAgent && p.dataAccess.reachesExternalService ? ' and ' : ''}
            {p.dataAccess.reachesExternalService ? 'an external action' : ''}. Those would need
            their own later authorization.
          </p>
        )}
        {p.uncertainties.length > 0 && (
          <p className="muted">
            Check{' '}
            {p.uncertainties
              .map((u) =>
                u === 'due_date_unclear'
                  ? 'the missing or unclear date'
                  : u === 'owner_assumed'
                    ? 'the suggested owner'
                    : 'how success will be checked',
              )
              .join(', ')}
            .
          </p>
        )}
      </section>
      {draft.status === 'draft' ? (
        <>
          <PreviewForm
            organizationId={organizationId}
            draft={draft}
            people={people}
            dependencies={dependencies}
            processes={BUNDLED_WORKFLOWS.map((b) => ({ key: b.key, name: b.name }))}
            nextDependenciesHref={
              page.nextCursor
                ? `${base}/compose/${draft.id}?workAfter=${encodeURIComponent(page.nextCursor)}`
                : null
            }
          />
          <section className="card fields" aria-labelledby="confirm-outcome">
            <h2 id="confirm-outcome">Create this Work</h2>
            <p>
              This creates the work exactly as the saved preview above shows it. Save any edits
              first: changes you have not saved are not included.
            </p>
            <ExperienceActionForm
              action={confirmOutcomeAction}
              hidden={{
                organizationId,
                draftId: draft.id,
                version: draft.version,
                previewSha256: draft.previewSha256,
              }}
              label="Confirm and create Work"
            >
              <label className="check">
                <input type="checkbox" name="confirmed" value="yes" required />I have reviewed the
                saved owner, who can see it, date and success requirements.
              </label>
            </ExperienceActionForm>
            <ExperienceActionForm
              action={discardOutcomeAction}
              hidden={{ organizationId, draftId: draft.id, version: draft.version }}
              label="Discard this draft"
              buttonClass="secondary"
            />
          </section>
        </>
      ) : draft.status === 'authorized' && draft.workUnitId ? (
        <p className="notice">
          Work was created from this exact preview.{' '}
          <Link href={`${base}/work/${draft.workUnitId}`}>Open the Work</Link>
        </p>
      ) : (
        <Empty>This private draft was discarded. Nothing was created.</Empty>
      )}
    </OneActionAtATime>
  );
}
