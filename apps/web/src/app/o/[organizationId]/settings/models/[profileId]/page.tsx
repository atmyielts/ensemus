import {
  getModelProfile,
  latestRateCardFor,
  listModelProfiles,
  needsReviewInterlock,
} from '@ensemus/application/ai-model-profiles';
import { loadModelEgressSettings } from '@ensemus/config';
import { listModelQualifications } from '@ensemus/application/knowledge/model-jobs';
import type { ProviderKind } from '@ensemus/domain/ai';
import { can } from '@ensemus/domain/policy';
import { notFound } from 'next/navigation';
import { ConfirmForm } from '@/components/confirm-form';
import { SubmitButton } from '@/components/submit-button';
import { BackLink, ErrorNotice, formatDate, PageHead } from '@/components/ui';
import { orNotFound, requireTenant } from '@/server/tenant';
import {
  addRateCardAction,
  attachKeyAction,
  disableProfileAction,
  requestProbeAction,
  updateProfileAction,
} from '../actions';
import { microsToUsd, PROVIDER_LABEL, RETENTION_LABEL, STATUS_LOOK } from '../model-form';
import { ProfileFields } from '../profile-fields';
import { QualificationPanel } from '../qualification-panel';

export const metadata = { title: 'Model | Ensemus' };

/** What happens next, in words, for each status. A person should never have to guess why it is idle. */
const NEXT_STEP: Record<string, string> = {
  draft: 'Test this model to start using it.',
  probing:
    'A test is waiting for its result. Refresh to check its progress. A test that may have been paid for is never repeated automatically.',
  probe_failed:
    'The last test failed, so nothing is being sent to this model. Check the address and the key, then test it again.',
  active: 'This model passed its test, and assistants can use it.',
  disabled: 'This model is turned off. Test it again to bring it back.',
};

export default async function ModelProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; profileId: string }>;
  searchParams: Promise<{ error?: string; qualification_after?: string }>;
}) {
  const { organizationId, profileId } = await params;
  const { error, qualification_after: after } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const canManage = can(context.role, 'model.manage');
  const canActivate = can(context.role, 'model.activate');
  if (!canManage && !canActivate) notFound();
  const profile = await orNotFound(getModelProfile(database, context, profileId));
  const [rateCard, all] = await Promise.all([
    latestRateCardFor(database, context, profile.id),
    listModelProfiles(database, context),
  ]);
  const qualifications =
    canActivate && can(context.role, 'budget.manage')
      ? await listModelQualifications(database, context, { profileId, ...(after ? { after } : {}) })
      : null;

  const kind = profile.provider_kind as ProviderKind;
  // Only whether it is set reaches the page. The operator's reference stays on the server.
  const keysAllowed =
    !needsReviewInterlock(kind) || Boolean(loadModelEgressSettings().credentialsReviewed);
  const needsKey = kind !== 'local_openai_compatible';
  const look = STATUS_LOOK[profile.status] ?? { label: profile.status, tone: '' };
  const identity = (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="profileId" value={profile.id} />
      <input type="hidden" name="version" value={profile.version} />
    </>
  );

  return (
    <>
      <BackLink href={`/o/${organizationId}/settings/models`}>All models</BackLink>
      <PageHead
        title={profile.alias}
        description={PROVIDER_LABEL[profile.provider_kind] ?? profile.provider_kind}
      />
      <ErrorNotice code={error} />
      <div className="stack">
        <section className="card" aria-labelledby="state-heading">
          <h2 id="state-heading">Where it stands</h2>
          <dl className="facts">
            <div>
              <dt>Status</dt>
              <dd>
                <span className={`badge ${look.tone}`}>{look.label}</span>
              </dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{profile.model_id}</dd>
            </div>
            <div>
              <dt>Address</dt>
              <dd>{profile.endpoint_url}</dd>
            </div>
            <div>
              <dt>Terms</dt>
              <dd>{RETENTION_LABEL[profile.retention_basis] ?? profile.retention_basis}</dd>
            </div>
            {profile.qualified_at && (
              <div>
                <dt>Passed its test</dt>
                <dd>{formatDate(new Date(profile.qualified_at))}</dd>
              </div>
            )}
          </dl>
          <p className="muted gap-above">{NEXT_STEP[profile.status]}</p>
          {canActivate && (
            <form className="inline-form gap-above" action={requestProbeAction}>
              {identity}
              <SubmitButton
                className="quiet"
                label={`${profile.status === 'probing' ? 'Ask for the test again' : 'Test this model'}: ${profile.alias}`}
              >
                {profile.status === 'probing' ? 'Ask for the test again' : 'Test this model'}
              </SubmitButton>
            </form>
          )}
        </section>

        {qualifications && (
          <QualificationPanel
            organizationId={organizationId}
            profile={profile}
            evidence={qualifications.items}
            nextCursor={qualifications.nextCursor}
          />
        )}

        <section className="card" aria-labelledby="key-heading">
          <h2 id="key-heading">Key</h2>
          <p className="muted">
            {profile.has_credential
              ? 'A key is on file. Nobody can see it again, here or anywhere. To change it, enter a new one.'
              : needsKey
                ? 'No key is on file, so this model cannot be tested yet.'
                : 'No key is on file. A model on your own network may not need one.'}
          </p>
          {canManage &&
            (keysAllowed ? (
              <form className="fields gap-above" action={attachKeyAction}>
                {identity}
                <label>
                  {profile.has_credential ? 'New key' : 'Key'}
                  <input
                    type="password"
                    name="key"
                    required
                    maxLength={8192}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <small>
                    It is sealed as soon as you save it, and it is good only for this model at this
                    address. Saving it means the model has to pass its test again.
                  </small>
                </label>
                <div>
                  <SubmitButton>Save key</SubmitButton>
                </div>
              </form>
            ) : (
              <p className="notice warn gap-above" role="status">
                Keys for this kind of model are not turned on for your company yet. Whoever set up
                Ensemus for your company turns them on after their security review.
              </p>
            ))}
        </section>

        <section className="card" aria-labelledby="cost-heading">
          <h2 id="cost-heading">What it costs</h2>
          <p className="muted">
            {rateCard
              ? `Your estimate, version ${rateCard.version}: $${microsToUsd(rateCard.inputMicrosPerMtok)} for each million input tokens and $${microsToUsd(rateCard.outputMicrosPerMtok)} for each million output tokens.`
              : 'No estimate yet. Assistants cannot use this model until it has one, because what they spend could not be measured.'}
          </p>
          {canManage && (
            <form className="inline-form gap-above" action={addRateCardAction}>
              {identity}
              <label>
                Dollars per million input tokens
                <input name="inputUsd" required inputMode="decimal" maxLength={16} />
              </label>
              <label>
                Dollars per million output tokens
                <input name="outputUsd" required inputMode="decimal" maxLength={16} />
              </label>
              <SubmitButton className="quiet" label={`Save estimate for ${profile.alias}`}>
                Save estimate
              </SubmitButton>
            </form>
          )}
        </section>

        {canManage && (
          <section className="card" aria-labelledby="edit-heading">
            <h2 id="edit-heading">Details</h2>
            <form className="fields gap-above" action={updateProfileAction} key={profile.version}>
              {identity}
              <ProfileFields
                profile={profile}
                others={all
                  .filter((other) => other.id !== profile.id)
                  .map(({ id, alias }) => ({ id, alias }))}
                text={(field) => <input autoComplete="off" {...field} />}
              />
              <div>
                <SubmitButton label={`Save details of ${profile.alias}`}>Save details</SubmitButton>
              </div>
            </form>
          </section>
        )}

        {canManage && profile.status !== 'disabled' && (
          <section className="card" aria-labelledby="off-heading">
            <h2 id="off-heading">Turn it off</h2>
            <p className="muted gap-above-small">
              Assistants stop using it at their next step. You can test it and turn it on again
              later.
            </p>
            <div className="gap-above">
              <ConfirmForm
                action={disableProfileAction}
                fields={identity}
                summary="Turn off"
                summaryLabel={`Turn off ${profile.alias}`}
                consequence={`Turn off ${profile.alias} now. Assistants using it stop at their next step, and nothing else is sent to it.`}
                confirmLabel="Turn off"
                confirmFullLabel={`Turn off ${profile.alias}`}
              />
            </div>
          </section>
        )}
      </div>
    </>
  );
}
