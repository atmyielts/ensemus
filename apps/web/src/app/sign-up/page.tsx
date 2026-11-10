import Link from 'next/link';
import { notFound } from 'next/navigation';
import { KeptInput } from '@/components/kept-field';
import { SubmitButton } from '@/components/submit-button';
import { Wordmark } from '@/components/ui';
import { safeReturnPath, withReturnPath } from '@/lib/return-path';
import { signUpAction } from '@/server/actions';
import { getRuntime } from '@/server/runtime';

export const metadata = { title: 'Create your account | Ensemus' };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string | string[] }>;
}) {
  if (!getRuntime().config.allowSignup) notFound();
  const { error, next: requested } = await searchParams;
  const next = safeReturnPath(requested);
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>Create your account</h1>
        {error && (
          <p className="notice error" role="alert">
            {error === 'rate'
              ? 'Too many attempts from here. Wait a minute, then try again.'
              : 'We could not create that account. Check your details, and use a password of at least 12 characters.'}
          </p>
        )}
        <form className="fields" action={signUpAction}>
          {next && <input type="hidden" name="next" value={next} />}
          <label>
            Name
            <KeptInput keep="name" name="name" autoComplete="name" required />
          </label>
          <label>
            Email
            <KeptInput keep="email" name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
            <small>At least 12 characters.</small>
          </label>
          <div>
            <SubmitButton working="Creating your account">Create account</SubmitButton>
          </div>
        </form>
      </div>
      <p className="below-sheet">
        Already have an account? <Link href={withReturnPath('/sign-in', next)}>Sign in</Link>
      </p>
    </main>
  );
}
