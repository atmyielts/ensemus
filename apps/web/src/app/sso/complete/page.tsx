import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { completeSsoSignIn } from '@ensemus/application/sso';
import { Wordmark } from '@/components/ui';
import { safeReturnPath } from '@/lib/return-path';
import { getRuntime } from '@/server/runtime';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Company sign-in | Ensemus' };
export default async function SsoComplete({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const runtime = getRuntime(),
    session = await runtime.auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in/sso?error=refused');
  // Neither URL provider/email/subject fields nor an ordinary password session is SAML evidence.
  const identity = await runtime.sso.verifiedSession({
    sessionId: session.session.id,
    userId: session.user.id,
  });
  const result = identity
    ? await completeSsoSignIn(runtime.app, identity)
    : { outcome: 'refused' as const };
  if (result.outcome === 'member') {
    const next = safeReturnPath((await searchParams).next),
      base = `/o/${result.organizationId}`;
    redirect(next && (next === base || next.startsWith(`${base}/`)) ? next : base);
  }
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>
          {result.outcome === 'no_membership'
            ? 'Ask to join your company'
            : 'Company sign-in needs attention'}
        </h1>
        <p>
          {result.outcome === 'no_membership'
            ? 'Your identity was confirmed. A company administrator still needs to invite you before you can open this workspace.'
            : 'Your company access or sign-in configuration changed. Ask your company administrator to check it before signing in again.'}
        </p>
        <Link className="button" href="/">
          View your companies
        </Link>
      </div>
    </main>
  );
}
