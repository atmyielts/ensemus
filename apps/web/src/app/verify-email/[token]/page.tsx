import { notFound } from 'next/navigation';
import { verificationPurposeOf } from '@ensemus/auth';
import { SubmitButton } from '@/components/submit-button';
import { Wordmark } from '@/components/ui';
import { verifyEmailAction } from '@/server/account-mail-actions';

export const metadata = { title: 'Confirm your email address | Ensemus' };

const WORDS = {
  verify: {
    title: 'Confirm your email address',
    lede: 'One click and we know this address is yours. Then we can tell you when something needs you, and help you back in if you forget your password.',
    button: 'Confirm my email address',
  },
  approve_change: {
    title: 'Approve the new email address',
    lede: 'You asked to move your Ensemus account to a new email address. Approve it here, and we’ll send one last link to the new address.',
    button: 'Approve the change',
  },
  finish_change: {
    title: 'Use this email address',
    lede: 'Confirm, and your Ensemus account moves to this address. You sign in with it from now on.',
    button: 'Use this address',
  },
} as const;

// A button, not the link itself, so a mail program that opens links to check them changes nothing.
export default async function VerifyEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  if (!/^[A-Za-z0-9._~-]{16,2048}$/.test(token)) notFound();
  const purpose = verificationPurposeOf(token);
  const words = WORDS[purpose];
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>{words.title}</h1>
        <p className="lede">{words.lede}</p>
        {error === 'rate' && (
          <p className="notice error" role="alert">
            Too many attempts from here. Wait a minute, then try again.
          </p>
        )}
        <form action={verifyEmailAction}>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="purpose" value={purpose} />
          <SubmitButton working="Confirming">{words.button}</SubmitButton>
        </form>
      </div>
    </main>
  );
}
