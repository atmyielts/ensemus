import Link from 'next/link';
import { PageHead } from '@/components/ui';
import { FactorError } from '@/components/security/code-fields';
import { IdentityConfirmationForm } from '@/components/security/identity-confirmation-form';
import { safeStepUpReturn } from '@/lib/step-up';
import { confirmIdentityAction } from '@/server/security-actions';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Confirm it is you | Ensemus' };
export default async function ConfirmIdentityPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; next?: string | string[] }>;
}) {
  const { organizationId } = await params;
  const { actor } = await requireTenant(organizationId);
  const query = await searchParams,
    next = safeStepUpReturn(organizationId, query.next);
  const { getRuntime } = await import('@/server/runtime');
  const { headers } = await import('next/headers');
  const enrolled = await getRuntime().mfa.isEnrolled(
    { sessionId: actor.sessionId, userId: actor.userId },
    await headers(),
  );
  return (
    <>
      <PageHead
        title="Confirm it is you"
        description="This change needs a recent code from your authenticator app or a saved recovery code."
      />
      <section className="sheet">
        {enrolled ? (
          <IdentityConfirmationForm
            action={confirmIdentityAction.bind(null, organizationId)}
            next={next}
            error={query.error}
          />
        ) : (
          <>
            <FactorError code={query.error} />
            <p>Add an authenticator app before making this change.</p>
            <Link className="button" href={`/o/${organizationId}/security/two-factor`}>
              Set up authenticator app
            </Link>
          </>
        )}
        <p>
          <Link href={next}>Cancel</Link>
        </p>
      </section>
    </>
  );
}
