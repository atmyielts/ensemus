import Link from 'next/link';
import { headers } from 'next/headers';
import { BackLink, PageHead } from '@/components/ui';
import { CodeFields, FactorError } from '@/components/security/code-fields';
import { EnrollmentForm } from '@/components/security/enrollment-form';
import { SubmitButton } from '@/components/submit-button';
import { accountEnrollmentPath, accountStepUpPath, safeAccountStepUpReturn } from '@/lib/step-up';
import {
  enableAccountSecondFactorAction,
  finishAccountEnrollmentAction,
} from '@/server/account-security-actions';
import { getRuntime } from '@/server/runtime';
import { requireAccountTenant } from '@/server/tenant';

export const metadata = { title: 'Set up authenticator app | Ensemus' };
export const dynamic = 'force-dynamic';
export default async function AccountEnrollmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ next?: string | string[]; error?: string }>;
}) {
  const { organizationId } = await params,
    { actor } = await requireAccountTenant(organizationId),
    query = await searchParams,
    next = safeAccountStepUpReturn(organizationId, query.next);
  const enrolled = await getRuntime().mfa.isEnrolled(
    { sessionId: actor.sessionId, userId: actor.userId },
    await headers(),
  );
  return (
    <>
      <BackLink href={`/o/${organizationId}/account`}>Account</BackLink>
      <PageHead
        title="Set up authenticator app"
        description="Protect your account and continue your request while service is paused."
      />
      <section className="sheet fields">
        <p>
          Keep your original request open in its tab. Setup does not submit that request or change
          your organization's service standing.
        </p>
        <FactorError code={query.error} />
        {enrolled ? (
          <>
            <p>Your authenticator app is already set up.</p>
            <Link className="button" href={accountStepUpPath(organizationId, next)}>
              Confirm your identity
            </Link>
          </>
        ) : (
          <>
            <EnrollmentForm
              organizationId={organizationId}
              enableAction={enableAccountSecondFactorAction.bind(null, organizationId, next)}
              finishAction={finishAccountEnrollmentAction.bind(null, organizationId, next)}
              permalink={accountEnrollmentPath(organizationId, next)}
            />
            <details>
              <summary>Already saved a setup key?</summary>
              <p>
                Enter its current code to finish. An existing setup is never replaced. If the key is
                lost, ask your installation operator to check your identity and reset it.
              </p>
              <form
                className="fields"
                action={finishAccountEnrollmentAction.bind(null, organizationId, next)}
              >
                <CodeFields backup={false} />
                <div>
                  <SubmitButton working="Checking">Finish setup</SubmitButton>
                </div>
              </form>
            </details>
          </>
        )}
        <p>
          <Link href={next}>Back to your account request</Link>
        </p>
      </section>
    </>
  );
}
