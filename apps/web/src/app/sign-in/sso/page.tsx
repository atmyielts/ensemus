import Link from 'next/link';
import { SubmitButton } from '@/components/submit-button';
import { Wordmark } from '@/components/ui';
import { safeReturnPath, withReturnPath } from '@/lib/return-path';
import { startSsoSignInAction } from '@/server/sso-actions';
export const metadata = { title: 'Company sign-in | Ensemus' };
export default async function SsoSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string | string[] }>;
}) {
  const query = await searchParams,
    next = safeReturnPath(query.next);
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>Sign in through your company</h1>
        <p>Enter your work email to continue with your company’s identity provider.</p>
        {query.error && (
          <p className="notice error" role="alert">
            {query.error === 'rate'
              ? 'Too many attempts. Wait a minute before trying again.'
              : 'Company sign-in could not be completed. Check your work email or ask your company administrator.'}
          </p>
        )}
        <form className="fields" action={startSsoSignInAction}>
          {next && <input type="hidden" name="next" value={next} />}
          <label>
            Work email
            <input type="email" name="email" autoComplete="username" maxLength={320} required />
          </label>
          <div>
            <SubmitButton working="Continuing">Continue with company sign-in</SubmitButton>
          </div>
        </form>
      </div>
      <p className="below-sheet">
        <Link href={withReturnPath('/sign-in', next)}>Sign in with a password</Link>
      </p>
    </main>
  );
}
