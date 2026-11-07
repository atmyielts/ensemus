import { listModelProfiles } from '@ensemus/application/ai-model-profiles';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { KeptInput } from '@/components/kept-field';
import { SubmitButton } from '@/components/submit-button';
import { Empty, ErrorNotice, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { createProfileAction } from './actions';
import { PROVIDER_LABEL, STATUS_LOOK } from './model-form';
import { ProfileFields } from './profile-fields';

export const metadata = { title: 'Models | Ensemus' };

export default async function ModelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const canManage = can(context.role, 'model.manage');
  // A member has no reason to know which addresses hold the company's keys, so this page is not there.
  if (!canManage && !can(context.role, 'model.activate')) notFound();
  const profiles = await listModelProfiles(database, context);

  return (
    <>
      <PageHead
        title="Models"
        description="The AI models this organization has approved. An agent can only use one that is active here."
        actions={
          can(context.role, 'model.activate') && can(context.role, 'budget.manage') ? (
            <Link href={`/o/${organizationId}/settings/models/workloads`}>
              Knowledge workload approvals
            </Link>
          ) : undefined
        }
      />
      <ErrorNotice code={error} />
      <div className="stack">
        <section className="card" aria-labelledby="models-heading">
          <h2 id="models-heading">Approved models</h2>
          {profiles.length === 0 ? (
            <Empty>{canManage ? 'None yet. Add the first below.' : 'None yet.'}</Empty>
          ) : (
            <ul className="list">
              {profiles.map((profile) => {
                const look = STATUS_LOOK[profile.status] ?? { label: profile.status, tone: '' };
                return (
                  <li key={profile.id}>
                    <span>
                      <Link href={`/o/${organizationId}/settings/models/${profile.id}`}>
                        {profile.alias}
                      </Link>{' '}
                      <small>
                        {PROVIDER_LABEL[profile.provider_kind] ?? profile.provider_kind},{' '}
                        {profile.has_credential ? 'key on file' : 'no key on file'}
                      </small>
                    </span>
                    <span className={`badge ${look.tone}`}>{look.label}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {canManage && (
          <section className="card" aria-labelledby="add-model-heading">
            <h2 id="add-model-heading">Add a model</h2>
            <p className="muted">
              A new model cannot be used until it has passed a test. You add its key on the next
              page.
            </p>
            <form className="fields" action={createProfileAction}>
              <input type="hidden" name="organizationId" value={organizationId} />
              <label>
                Who provides it
                <select name="providerKind" required defaultValue="">
                  <option value="" disabled>
                    Choose a provider
                  </option>
                  {Object.entries(PROVIDER_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <ProfileFields
                profile={null}
                others={profiles.map(({ id, alias }) => ({ id, alias }))}
                text={({ name, defaultValue, ...rest }) => (
                  <KeptInput keep={`model-${name}`} name={name} autoComplete="off" {...rest} />
                )}
              />
              <div>
                <SubmitButton>Add model</SubmitButton>
              </div>
            </form>
          </section>
        )}
      </div>
    </>
  );
}
