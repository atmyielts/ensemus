import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { isRestoreAdmissionDenied } from '@ensemus/database';
import { SubmitButton } from '@/components/submit-button';
import { Wordmark } from '@/components/ui';
import { safeReturnPath, withReturnPath } from '@/lib/return-path';
import { startSsoSignInAction, startSsoSelfLinkAction } from '@/server/sso-actions';
import { getRuntime } from '@/server/runtime';
export const metadata = { title: 'Company sign-in | Ensemus' };
export default async function SsoSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string | string[] }>;
}) {
  const query = await searchParams,
    next = safeReturnPath(query.next),
    current = await getRuntime()
      .readInteractiveSession(await headers())
      .catch((error: unknown) => {
        if (isRestoreAdmissionDenied(error)) redirect('/restoring');
        throw error;
      });
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
              : query.error === 'connect'
                ? 'We could not connect company sign-in. Check your password, or sign in again before trying. Your administrator may need to check your company access.'
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
        {current && (
          <section aria-labelledby="connect-company-heading" className="stack">
            <h2 id="connect-company-heading">Connect company sign-in to this account</h2>
            <p>
              Already use this Ensemus account? Confirm that you want your company identity provider
              to sign you in as {current.user.email}. Your name and email stay the same.
            </p>
            <form className="fields" action={startSsoSelfLinkAction}>
              {next && <input type="hidden" name="next" value={next} />}
              <label>
                Password for this Ensemus account
                <input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  maxLength={128}
                  aria-describedby="connect-password-help"
                />
              </label>
              <p className="muted" id="connect-password-help">
                Enter your password if this account has one. If you use another identity provider
                instead, verify with it again within the last five minutes.
              </p>
              <label className="check">
                <input type="checkbox" name="consent" value="yes" required />I want to connect
                company sign-in to this Ensemus account.
              </label>
              <div>
                <SubmitButton working="Connecting">Connect company sign-in</SubmitButton>
              </div>
            </form>
          </section>
        )}
      </div>
      <p className="below-sheet">
        <Link href={withReturnPath('/sign-in', next)}>Sign in with a password</Link>
        {!current && (
          <> to connect company sign-in to an existing account. Then return to this page.</>
        )}
      </p>
    </main>
  );
}
