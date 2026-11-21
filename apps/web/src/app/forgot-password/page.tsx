import Link from 'next/link';
import { KeptInput } from '@/components/kept-field';
import { SubmitButton } from '@/components/submit-button';
import { Wordmark } from '@/components/ui';
import { forgotPasswordAction } from '@/server/account-mail-actions';
import { getRuntime } from '@/server/runtime';

export const metadata = { title: 'Reset your password | Ensemus' };

// The same answer for every address, so this page cannot be used to find out who has an account.
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;
  const { mailEnabled } = getRuntime().config;
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>Reset your password</h1>
        {!mailEnabled ? (
          <p className="lede">
            Password reset by email isn’t set up here. Ask whoever looks after Ensemus at your
            company to help you get back in.
          </p>
        ) : sent ? (
          <>
            <p className="notice good" role="status">
              If an account uses that address, we’ve sent it a link to choose a new password.
            </p>
            <p className="lede">
              The link works once, for the next 30 minutes. Nothing there after a few minutes? Check
              your spam folder, or try again.
            </p>
          </>
        ) : (
          <>
            <p className="lede">
              Enter the email address you sign in with, and we’ll send you a link to choose a new
              password.
            </p>
            {error === 'rate' && (
              <p className="notice error" role="alert">
                Too many requests from here. Wait a few minutes, then try again.
              </p>
            )}
            <form className="fields" action={forgotPasswordAction}>
              <label>
                Email
                <KeptInput
                  keep="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                />
              </label>
              <div>
                <SubmitButton working="Sending">Send me a link</SubmitButton>
              </div>
            </form>
          </>
        )}
      </div>
      <ul className="sheet-links" aria-label="Other ways in">
        <li>
          Remembered it? <Link href="/sign-in">Sign in</Link>
        </li>
      </ul>
    </main>
  );
}
