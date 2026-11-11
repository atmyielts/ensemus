import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice, Wordmark } from '@/components/ui';
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
        <Wordmark />
        <div className="sheet">
          <h1>You have been invited</h1>
          <p className="lede">
            Sign in with the email address this invitation was sent to, and you can accept it from
            here.
          </p>
          <div className="row">
            <Link className="button" href={withReturnPath('/sign-in', here)}>
              Sign in
            </Link>
            {config.allowSignup && (
              <Link className="button secondary" href={withReturnPath('/sign-up', here)}>
                Create an account
              </Link>
            )}
          </div>
          <p className="muted gap-above-large">
            You will see which organization invited you once you accept. Until then this page keeps
            those details private, because anyone holding the link could read them.
          </p>
        </div>
        {!config.allowSignup && (
          <ul className="sheet-links" aria-label="Other ways in">
            <li>
              No account yet? Ask the person who invited you how to get one. If they give you a
              setup code, <Link href={withReturnPath('/setup', here)}>use it here</Link>.
            </li>
          </ul>
        )}
      </main>
    );
  }

  const { error, state } = await searchParams;
  if (state === 'waiting') {
    return (
      <main className="centered">
        <Wordmark />
        <div className="sheet">
          <h1>Waiting for confirmation</h1>
          <p className="lede" role="status">
            Your email address has not been confirmed yet, so someone in the organization needs to
            confirm it is you before you can join. We have let them know. Come back once they have,
            or ask them directly.
          </p>
          <form action={signOutAction}>
            <input type="hidden" name="next" value={here} />
            <button className="link" type="submit">
              Use a different account
            </button>
          </form>
        </div>
      </main>
    );
  }
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>You have been invited</h1>
        <p className="lede">
          Accept to join the organization that invited you. You will see which one it is once you
          have joined.
        </p>
        <ErrorNotice code={error} />
        <p>
          You are signed in as <strong>{session.user.email}</strong>. An invitation only works for
          the email address it was sent to.
        </p>
        <div className="row gap-above-large">
          <form action={acceptInvitationAction}>
            <input type="hidden" name="token" value={token} />
            <SubmitButton working="Accepting">Accept invitation</SubmitButton>
          </form>
          <form action={signOutAction}>
            <input type="hidden" name="next" value={here} />
            <button className="link" type="submit">
              Use a different account
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
