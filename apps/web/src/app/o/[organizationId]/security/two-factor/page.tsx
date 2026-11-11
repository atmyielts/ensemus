import { headers } from 'next/headers';
import { BackLink, PageHead } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { CodeFields, FactorError } from '@/components/security/code-fields';
import { EnrollmentForm, RecoveryCodeForm } from '@/components/security/enrollment-form';
import {
  disableSecondFactorAction,
  finishEnrollmentAction,
  enableSecondFactorAction,
  regenerateRecoveryCodesAction,
} from '@/server/security-actions';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Authenticator app | Ensemus' };
export const dynamic = 'force-dynamic';
export default async function SecondFactorPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { actor } = await requireTenant(organizationId);
  const query = await searchParams;
  const enrolled = await getRuntime().mfa.isEnrolled(
    { sessionId: actor.sessionId, userId: actor.userId },
    await headers(),
  );
  return (
    <>
      <BackLink href={`/o/${organizationId}/security`}>Back to security</BackLink>
      <PageHead
        title="Authenticator app"
        description="Two-step sign-in asks for a code from your phone as well as your password. It protects your account in every company you belong to."
      />
      <FactorError code={query.error} />
      {enrolled ? (
        <div className="stack">
          <section className="card" aria-labelledby="recovery-heading">
            <h2 id="recovery-heading">Recovery codes</h2>
            <p>
              Recovery codes let you sign in when your phone is not with you. If you can’t find
              yours, replace them with a new set.
            </p>
            <div className="gap-above">
              <RecoveryCodeForm
                organizationId={organizationId}
                regenerateAction={regenerateRecoveryCodesAction.bind(null, organizationId)}
              />
            </div>
          </section>
          <section className="card" aria-labelledby="turn-off-heading">
            <h2 id="turn-off-heading">Turn off two-step sign-in</h2>
            <p>
              This removes the app and every recovery code. It also clears recent confirmations from
              all your sessions.
            </p>
            <form
              className="fields gap-above"
              action={disableSecondFactorAction.bind(null, organizationId)}
            >
              <label>
                Password, if you use one
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={128}
                />
              </label>
              <CodeFields />
              <div>
                <SubmitButton className="danger" working="Turning off">
                  Turn off two-step sign-in
                </SubmitButton>
              </div>
            </form>
          </section>
        </div>
      ) : (
        <div className="stack">
          <section className="card" aria-labelledby="setup-heading">
            <h2 id="setup-heading">Set up your app</h2>
            <ol className="setup-steps">
              <li>
                Have an authenticator app on your phone. Any app that makes time-based codes works.
              </li>
              <li>Confirm your password below, and Ensemus shows you a setup key.</li>
              <li>
                Add the key to your app, save your recovery codes, then enter the code your app
                shows.
              </li>
            </ol>
            <div className="divided">
              <EnrollmentForm
                organizationId={organizationId}
                enableAction={enableSecondFactorAction.bind(null, organizationId)}
                finishAction={finishEnrollmentAction.bind(null, organizationId)}
              />
            </div>
          </section>
          <details>
            <summary>Already saved a setup key?</summary>
            <div className="gap-above-small">
              <p>
                If you prepared your app during this sign-in, enter its current code to finish. An
                existing setup key is never silently replaced. If you lost it, ask whoever set up
                Ensemus for your company to reset it before starting again.
              </p>
              <form
                className="fields gap-above"
                action={finishEnrollmentAction.bind(null, organizationId)}
              >
                <CodeFields backup={false} />
                <div>
                  <SubmitButton working="Checking">Finish setup</SubmitButton>
                </div>
              </form>
            </div>
          </details>
        </div>
      )}
      <p className="muted gap-above-large">
        Lost both your app and your recovery codes? Whoever set up Ensemus for your company can
        reset it, after checking it’s you.
      </p>
    </>
  );
}
