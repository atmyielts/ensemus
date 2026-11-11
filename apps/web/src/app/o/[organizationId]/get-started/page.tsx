import { getOnboarding } from '@ensemus/application/onboarding';
import { canProduct } from '@ensemus/domain/product-policy';
import { BUNDLED_WORKFLOWS } from '@ensemus/packs/bundled';
import Link from 'next/link';
import { ActionLink, Empty, PageHead } from '@/components/ui';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { ExperienceActionForm } from '@/components/experience/action-form';
import { SETUP_COPY, setupStateLabel } from '@/lib/onboarding-copy';
import { requireTenant } from '@/server/tenant';
import { webProductPorts } from '@/server/product-ports';
import { getRuntime } from '@/server/runtime';
import { decideSetupAction, firstSimulationAction } from '@/server/experience-actions';
export const metadata = { title: 'Company setup | Ensemus' };
export default async function CompanySetupPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireTenant(organizationId),
    base = `/o/${organizationId}`;
  if (!canProduct(context.role, 'onboarding.manage'))
    return (
      <>
        <PageHead title="Company setup" />
        <Empty
          title="Setup is for owners and administrators"
          action={
            <ActionLink variant="secondary" href={`${base}/compose`}>
              Describe an outcome
            </ActionLink>
          }
        >
          An organization owner or administrator manages company setup. You can still create and do
          your own Work.
        </Empty>
      </>
    );
  const view = await getOnboarding(database, context, webProductPorts()),
    first = BUNDLED_WORKFLOWS[0],
    mode = getRuntime().config.mode;
  return (
    <OneActionAtATime>
      <PageHead
        title="Set up your company"
        description="A few steps to get your company ready. Adding AI models and knowledge sources is optional: everything else works without them."
      />
      <section className="card stack" aria-labelledby="setup-responsibilities">
        <h2 id="setup-responsibilities">Data and model responsibilities</h2>
        <p>
          Your company uses Ensemus{' '}
          {mode === 'sovereign'
            ? 'on its own servers'
            : mode === 'byom'
              ? 'with its own AI model'
              : 'Cloud'}
          . Your company decides who can see its information, how sensitive each piece is, and which
          AI models it may be sent to. Before adding sensitive information, review who each source
          is shared with, how long records are kept, and what each AI model’s company does with
          data.
        </p>
        <p>
          Adding a model or a knowledge source does not make it ready to use, or prove that it
          connects. Check its status on its own page. Work needs no AI model, and actions outside
          Ensemus need their own approval.
        </p>
      </section>
      <p role="status" className="notice gap-above-large">
        {view.finished
          ? view.completionRecorded
            ? 'Core setup was confirmed. The required records are currently present.'
            : 'The required records are present. Confirm core setup below.'
          : view.completionRecorded
            ? 'Core setup was confirmed earlier. Some required records need attention now.'
            : 'Complete the required steps below. Optional AI setup does not block your company.'}
      </p>
      <div className="stack">
        {view.steps.map((step) => {
          const copy = SETUP_COPY[step.key];
          return (
            <section className="card stack" key={step.key} aria-labelledby={`setup-${step.key}`}>
              <div className="spread">
                <h2 id={`setup-${step.key}`}>{copy.title}</h2>
                <span
                  className={`badge ${step.state === 'done' ? 'done' : step.state === 'to_do' ? 'attention' : ''}`}
                >
                  {setupStateLabel(step.state)}
                </span>
              </div>
              <p className="muted">{copy.description}</p>
              <p className="link-line">
                <Link href={base + copy.path}>{copy.link}</Link>
              </p>
              {step.key === 'responsibility_statement' && step.state !== 'done' && (
                <ExperienceActionForm
                  action={decideSetupAction}
                  hidden={{ organizationId, step: step.key, decision: 'acknowledged' }}
                  label="Acknowledge responsibilities"
                >
                  <label className="check">
                    <input type="checkbox" name="confirmed" value="yes" required />I have read the
                    data and model responsibilities above.
                  </label>
                </ExperienceActionForm>
              )}
              {step.optional && step.state !== 'done' && step.state !== 'skipped' && (
                <ExperienceActionForm
                  action={decideSetupAction}
                  hidden={{ organizationId, step: step.key, decision: 'skipped' }}
                  label={`Skip ${step.key === 'model_provider' ? 'model setup' : 'a knowledge source'} for now`}
                />
              )}
              {step.key === 'first_simulation' && first && (
                <>
                  <ExperienceActionForm
                    action={firstSimulationAction}
                    hidden={{ organizationId, processKey: first.key }}
                    label={view.latestSimulation ? 'Rehearse again' : 'Run the first rehearsal'}
                  />
                  {view.latestSimulation && (
                    <p>
                      Latest current rehearsal:{' '}
                      {view.latestSimulation.usable
                        ? 'Passed the fixed scenario'
                        : view.latestSimulation.status === 'queued'
                          ? 'Waiting for the worker'
                          : view.latestSimulation.status === 'running'
                            ? 'In progress'
                            : 'Needs attention'}
                      .{' '}
                      <Link href={`${base}/studio/simulations/${view.latestSimulation.id}`}>
                        Read the rehearsal report
                      </Link>
                    </p>
                  )}
                  <p className="muted">
                    A passed rehearsal verifies the fixed scenario only. No real email, model or
                    external provider was used.
                  </p>
                  {view.latestSimulation && !view.latestSimulation.usable && (
                    <p className="link-line">
                      <Link href={`${base}/get-started`}>Refresh the current status</Link>
                    </p>
                  )}
                </>
              )}
            </section>
          );
        })}
      </div>
      {view.finished && !view.completionRecorded && (
        <section className="card stack gap-above-large" aria-labelledby="confirm-setup">
          <h2 id="confirm-setup">Confirm core setup</h2>
          <p>
            This records one historical confirmation. It does not activate a model, start execution
            or certify an external provider.
          </p>
          <ExperienceActionForm
            action={decideSetupAction}
            hidden={{ organizationId, step: 'responsibility_statement', decision: 'acknowledged' }}
            label="Confirm core setup"
          >
            <label className="check">
              <input type="checkbox" name="confirmed" value="yes" required />I reviewed the current
              records and responsibility statement.
            </label>
          </ExperienceActionForm>
        </section>
      )}
      <p className="gap-above-large">
        <ActionLink href={`${base}/work`}>Go to your work</ActionLink>
      </p>
    </OneActionAtATime>
  );
}
