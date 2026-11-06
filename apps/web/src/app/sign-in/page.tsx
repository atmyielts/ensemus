import Link from 'next/link';
import { KeptInput } from '@/components/kept-field';
import { SubmitButton } from '@/components/submit-button';
import { Wordmark } from '@/components/ui';
import { safeReturnPath, withReturnPath } from '@/lib/return-path';
import { signInAction } from '@/server/actions';
import { getRuntime } from '@/server/runtime';

export const metadata = { title: 'Sign in | Ensemus' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string | string[] }>;
}) {
  const { error, next: requested } = await searchParams;
  const next = safeReturnPath(requested);
  const { allowSignup } = getRuntime().config;
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>Sign in to Ensemus</h1>
        {error && (
          <p className="notice error" role="alert">
            {error === 'rate'
              ? 'Too many attempts from here. Wait a minute, then try again.'
              : 'That email and password did not match.'}
          </p>
        )}
        <form className="fields" action={signInAction}>
          {next && <input type="hidden" name="next" value={next} />}
          <label>
            Email
            <KeptInput keep="email" name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <div>
            <SubmitButton working="Signing in">Sign in</SubmitButton>
          </div>
        </form>
      </div>
      {allowSignup ? (
        <p className="below-sheet">
          New here? <Link href={withReturnPath('/sign-up', next)}>Create an account</Link>
        </p>
      ) : (
        <p className="below-sheet">
          Given a setup code? <Link href={withReturnPath('/setup', next)}>Use it here</Link>
        </p>
      )}
    </main>
  );
}
