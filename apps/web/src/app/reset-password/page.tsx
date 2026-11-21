import { ActionLink, Wordmark } from '@/components/ui';

export const metadata = { title: 'Password reset | Ensemus' };

export default async function ResetPasswordStatePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;
  const done = state === 'done';
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>{done ? 'Your password is changed' : 'That link doesn’t work any more'}</h1>
        <p className="lede">
          {done
            ? 'You’ve been signed out everywhere. Sign in with your new password to carry on.'
            : 'A reset link works once, for 30 minutes. Ask for a new one and use the latest email.'}
        </p>
        <div className="row">
          {done ? (
            <ActionLink href="/sign-in">Sign in</ActionLink>
          ) : (
            <ActionLink href="/forgot-password">Ask for a new link</ActionLink>
          )}
        </div>
      </div>
    </main>
  );
}
