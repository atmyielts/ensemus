import Link from 'next/link';
import { Wordmark } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { CodeFields, FactorError } from '@/components/security/code-fields';
import { safeReturnPath, withReturnPath } from '@/lib/return-path';
import { completeTwoFactorSignInAction } from '@/server/security-actions';
export const metadata = { title: 'Confirm sign-in | Ensemus' };
export const dynamic = 'force-dynamic';
export default async function TwoFactorSignInPage({
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
        <h1>Confirm your sign-in</h1>
        <p className="lede">
          One more step. Enter the code your authenticator app shows now, or one of the recovery
          codes you saved.
        </p>
        <FactorError code={query.error} />
        <form className="fields" action={completeTwoFactorSignInAction}>
          {next && <input type="hidden" name="next" value={next} />}
          <CodeFields />
          <div>
            <SubmitButton working="Confirming">Confirm sign-in</SubmitButton>
          </div>
        </form>
      </div>
      <ul className="sheet-links" aria-label="Other ways in">
        <li>
          <Link href={withReturnPath('/sign-in', next)}>
            Start again with your email and password
          </Link>
        </li>
        <li>
          Lost your phone and your recovery codes? Ask whoever runs Ensemus for your company to
          reset your two-step sign-in.
        </li>
      </ul>
    </main>
  );
}
