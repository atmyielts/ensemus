import Link from 'next/link';
import { headers } from 'next/headers';
import { PageHead } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { CodeFields, FactorError } from '@/components/security/code-fields';
import { EnrollmentForm, RecoveryCodeForm } from '@/components/security/enrollment-form';
import styles from '@/components/security/security.module.css';
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
      <PageHead
        title="Authenticator app"
        description="Protect your account across every company you belong to."
        actions={<Link href={`/o/${organizationId}/security`}>Back to security</Link>}
      />
      <FactorError code={query.error} />
      {enrolled ? (
        <>
          <section className={styles.section}>
            <h2>Recovery codes</h2>
            <p>If your saved codes are missing, replace them with a new private set.</p>
            <RecoveryCodeForm
              organizationId={organizationId}
              regenerateAction={regenerateRecoveryCodesAction.bind(null, organizationId)}
            />
          </section>
          <section className={styles.section}>
            <h2>Turn off two-step sign-in</h2>
            <p>
              This removes the app and every recovery code. It also clears recent confirmations from
              all your sessions.
            </p>
            <form className="fields" action={disableSecondFactorAction.bind(null, organizationId)}>
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
                <SubmitButton working="Turning off">Turn off two-step sign-in</SubmitButton>
              </div>
            </form>
          </section>
        </>
      ) : (
        <>
          <section className={styles.section}>
            <h2>Set up your app</h2>
            <EnrollmentForm
              organizationId={organizationId}
              enableAction={enableSecondFactorAction.bind(null, organizationId)}
              finishAction={finishEnrollmentAction.bind(null, organizationId)}
            />
          </section>
          <details className={styles.section}>
            <summary>Already saved a setup key?</summary>
            <p>
              If you prepared your app during this sign-in, enter its current code to finish. An
              existing setup key is never silently replaced. If you lost it, ask the installation
              operator to reset it before starting again.
            </p>
            <form className="fields" action={finishEnrollmentAction.bind(null, organizationId)}>
              <CodeFields backup={false} />
              <div>
                <SubmitButton working="Checking">Finish setup</SubmitButton>
              </div>
            </form>
          </details>
        </>
      )}
      <p>
        Lost both your app and recovery codes? The installation operator can reset your factor after
        checking who you are.
      </p>
    </>
  );
}
