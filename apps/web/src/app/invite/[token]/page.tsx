import { readClaimedInvitation } from '@ensemus/application';
import { isRestoreAdmissionDenied } from '@ensemus/database';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice, Wordmark } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { safeReturnPath, withReturnPath } from '@/lib/return-path';
import { registerInvitedAccountAction, signOutAction } from '@/server/actions';
import { getRuntime } from '@/server/runtime';
import { acceptInvitationAction } from '@/server/work-actions';

export const metadata = { title: 'Invitation | Ensemus' };

// Signed-out visitors see a generic page. Only the signed-in claimant can see their request state,
// and continuing to an organization still requires an active membership there.
export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; state?: string; registration?: string }>;
}) {
  const { token } = await params;
  const here = safeReturnPath(`/invite/${token}`);
  // Not the shape of any token we issue. Saying so reveals nothing about any real invitation.
  if (!here) notFound();

  const { app, config, readInteractiveSession } = getRuntime();
  const session = await readInteractiveSession(await headers()).catch((error: unknown) => {
    if (isRestoreAdmissionDenied(error)) redirect('/restoring');
    throw error;
  });
  const { error, state, registration } = await searchParams;

  if (!session) {
    return (
      <main className="centered">
        <Wordmark />
        <div className="sheet">
          <h1>You have been invited</h1>
          <p className="lede">
            Use the email address your inviter gave you to sign in or create an account.
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
          {!config.allowSignup && (
            <details className="gap-above-large" open={Boolean(registration) || undefined}>
              <summary>Create an account</summary>
              <form className="fields gap-above-large" action={registerInvitedAccountAction}>
                <input type="hidden" name="token" value={token} />
                {registration === 'refused' && (
                  <p className="notice error" role="alert">
                    We couldn’t create an account. Check the invited address and your details. If
                    you already have an account, sign in.
                  </p>
                )}
                {registration === 'rate' && (
                  <p className="notice error" role="alert">
                    Too many attempts. Wait a minute before trying again.
                  </p>
                )}
                <Label>
                  Name
                  <Input name="name" autoComplete="name" required maxLength={200} />
                </Label>
                <Label>
                  Invited email address
                  <Input
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    maxLength={320}
                  />
                </Label>
                <Label>
                  Password
                  <Input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                  />
                  <small>Use at least 12 characters.</small>
                </Label>
                <div>
                  <SubmitButton working="Creating your account">Create account</SubmitButton>
                </div>
              </form>
            </details>
          )}
          <p className="muted gap-above-large">
            You will see which organization invited you once you accept. Until then this page keeps
            those details private, because anyone holding the link could read them.
          </p>
        </div>
        {!config.allowSignup && (
          <ul className="sheet-links" aria-label="Other ways in">
            <li>
              Already have a setup code?{' '}
              <Link href={withReturnPath('/setup', here)}>Use it here</Link>.
            </li>
          </ul>
        )}
      </main>
    );
  }

  const { id: userId, email, emailVerified } = session.user;
  const invitation = await readClaimedInvitation(app, { token, userId, email });
  if (invitation?.status === 'joined') redirect(`/o/${invitation.organizationId}`);

  if (!error && invitation?.status === 'awaiting_confirmation' && !emailVerified) {
    return (
      <main className="centered">
        <Wordmark />
        <div className="sheet">
          <h1>Waiting for confirmation</h1>
          <p className="lede" role="status">
            Your request was sent. Ask the person who invited you to confirm it, then check your
            access here.
          </p>
          <div className="row gap-above-large">
            <Button asChild>
              <a href={here}>Check access</a>
            </Button>
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
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>You have been invited</h1>
        <p className="lede">
          Accept to join the organization that invited you. You will see which one it is once you
          have joined.
        </p>
        <ErrorNotice
          code={error ?? (state === 'waiting' && !invitation ? 'INVITATION_INVALID' : undefined)}
        />
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
