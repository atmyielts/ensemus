import { headers } from 'next/headers';
import { ActionLink, BackLink, PageHead } from '@/components/ui';
import { FactorError } from '@/components/security/code-fields';
import { IdentityConfirmationForm } from '@/components/security/identity-confirmation-form';
import { accountEnrollmentPath, safeAccountStepUpReturn } from '@/lib/step-up';
import { confirmAccountIdentityAction } from '@/server/account-security-actions';
import { getRuntime } from '@/server/runtime';
import { requireAccountTenant } from '@/server/tenant';

export const metadata = { title: 'Confirm it is you | Ensemus' };
export const dynamic = 'force-dynamic';
export default async function AccountConfirmPage({
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
        title="Confirm it is you"
        description="Confirm your identity to continue with your account request, including while service is paused."
      />
      <section className="sheet stack form-width">
        <p>
          If you opened this page from a form, leave that tab open. Enter the code your
          authenticator app shows now, then go back to that tab and send your request again.
        </p>
        {enrolled ? (
          <IdentityConfirmationForm
            action={confirmAccountIdentityAction.bind(null, organizationId)}
            next={next}
            error={query.error}
          />
        ) : (
          <>
            <FactorError code={query.error} />
            <p>
              Add an authenticator app before making this change. You can set one up even while
              service is paused.
            </p>
            <div>
              <ActionLink href={accountEnrollmentPath(organizationId, next)}>
                Set up authenticator app
              </ActionLink>
            </div>
          </>
        )}
        <p className="divided">
          <ActionLink variant="secondary" href={next}>
            Back to your account request
          </ActionLink>
        </p>
      </section>
    </>
  );
}
