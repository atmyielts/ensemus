import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SubmitButton } from '@/components/submit-button';
import { Wordmark } from '@/components/ui';
import { resetPasswordAction } from '@/server/account-mail-actions';

export const metadata = { title: 'Choose a new password | Ensemus' };

const ERRORS: Record<string, string> = {
  match: 'The two passwords were not the same. Type them again.',
  weak: 'Use a password of at least 12 characters, and no more than 128.',
  rate: 'Too many attempts from here. Wait a minute, then try again.',
};

// This page never checks the link. It looks the same for a real token, a used one and a guessed one,
// and only choosing a password tells the two apart, through Better Auth's limits.
export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  if (!/^[A-Za-z0-9._~-]{16,2048}$/.test(token)) notFound();
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>Choose a new password</h1>
        <p className="lede">
          Once it’s saved, you’re signed out everywhere else, and you sign in again with the new
          password.
        </p>
        {error && (
          <p className="notice error" role="alert">
            {ERRORS[error] ?? 'That did not work. Try again.'}
          </p>
        )}
        <form className="fields" action={resetPasswordAction}>
          <input type="hidden" name="token" value={token} />
          <label>
            New password
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
            <small>At least 12 characters. A short sentence is easy to remember.</small>
          </label>
          <label>
            Type it again
            <input
              name="confirm"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </label>
          <div>
            <SubmitButton working="Saving">Save new password</SubmitButton>
          </div>
        </form>
      </div>
      <ul className="sheet-links" aria-label="Other ways in">
        <li>
          Need a new link? <Link href="/forgot-password">Ask for another</Link>
        </li>
      </ul>
    </main>
  );
}
