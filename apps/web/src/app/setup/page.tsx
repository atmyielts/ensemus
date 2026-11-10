import Link from 'next/link';
import { KeptInput } from '@/components/kept-field';
import { SubmitButton } from '@/components/submit-button';
import { Wordmark } from '@/components/ui';
import { safeReturnPath, withReturnPath } from '@/lib/return-path';
import { completeSetupAction } from '@/server/actions';

export const metadata = { title: 'Set up your account | Ensemus' };

const ERRORS: Record<string, string> = {
  code: 'That setup code does not work. It may have been used already, or run out. Ask whoever runs this deployment for a new one.',
  details:
    'We could not create that account, and your setup code still works. Check your details, and use a password of at least 12 characters.',
};

/**
 * For someone whose operator gave them a setup code, which is how an account gets made where sign-up
 * is off. Holding the code is the only thing that lets anyone through. Without one this page does
 * nothing, whatever is sent to it.
 */
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string | string[] }>;
}) {
  const { error, next: requested } = await searchParams;
  const next = safeReturnPath(requested);
  const problem = error === 'code' || error === 'details' ? ERRORS[error] : undefined;
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>Set up your account</h1>
        <p className="muted">
          Whoever runs this deployment gives you a setup code. It works once, for one account, and
          you can create your organization as soon as you are in.
        </p>
        {problem && (
          <p className="notice error" role="alert">
            {problem}
          </p>
        )}
        <form className="fields" action={completeSetupAction}>
          {next && <input type="hidden" name="next" value={next} />}
          <label>
            Setup code
            <input name="code" required autoComplete="off" spellCheck={false} />
          </label>
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
