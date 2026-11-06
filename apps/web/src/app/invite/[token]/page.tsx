import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { safeReturnPath, withReturnPath } from '@/lib/return-path';
import { signOutAction } from '@/server/actions';
import { getRuntime } from '@/server/runtime';
import { acceptInvitationAction } from '@/server/work-actions';

export const metadata = { title: 'Invitation | Ensemus' };

// This page never reads the invitation. It shows the same thing for a real token, a guessed one and
// a used one, so holding a link reveals no organization, role or address until it is accepted. The
// only answer about a token is the one acceptance gives, and acceptance states it the same way for
// every failure.
export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; state?: string }>;
}) {
  const { token } = await params;
  const here = safeReturnPath(`/invite/${token}`);
  // Not the shape of any token we issue. Saying so reveals nothing about any real invitation.
  if (!here) notFound();

  const { auth, config } = getRuntime();
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    return (
      <main className="centered">
        <h1>You have been invited</h1>
        <p>
          Sign in with the email address this invitation was sent to, and you can accept it from
          here.
        </p>
        <p className="muted">
          You will see the organization once you accept. Until then this page shows no details,
          because anyone holding the link could read them.
        </p>
        <div className="row">
          <Link className="button" href={withReturnPath('/sign-in', here)}>
            Sign in
          </Link>
          {config.allowSignup && (
            <Link className="button quiet" href={withReturnPath('/sign-up', here)}>
              Create an account
            </Link>
          )}
        </div>
        {!config.allowSignup && (
          <p className="muted" style={{ marginTop: '1rem' }}>
            No account yet? Ask the person who invited you how to get one. If they give you a setup
            code, <Link href={withReturnPath('/setup', here)}>use it here</Link>.
          </p>
        )}
      </main>
    );
  }

  const { error, state } = await searchParams;
  if (state === 'waiting') {
    return (
      <main className="centered">
        <h1>Waiting for confirmation</h1>
        <p role="status">
          The address on your account has not been proven yet, so someone in the organization has to
          confirm it is you before you can join. They have been told. Come back once they have, or
          ask them directly.
        </p>
        <form action={signOutAction}>
          <input type="hidden" name="next" value={here} />
          <button className="link" type="submit">
            Use a different account
          </button>
        </form>
      </main>
    );
  }
  return (
    <main className="centered">
      <h1>You have been invited</h1>
      <ErrorNotice code={error} />
      <p>
        You are signed in as <strong>{session.user.email}</strong>. An invitation only works for the
        email address it was sent to.
      </p>
      <p className="muted">You will see the organization once you accept.</p>
      <form action={acceptInvitationAction} style={{ marginBottom: '1rem' }}>
        <input type="hidden" name="token" value={token} />
        <SubmitButton working="Accepting">Accept invitation</SubmitButton>
      </form>
      <form action={signOutAction}>
        <input type="hidden" name="next" value={here} />
        <button className="link" type="submit">
          Use a different account
        </button>
      </form>
    </main>
  );
}
