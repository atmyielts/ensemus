import { ActionLink, Wordmark } from '@/components/ui';

export const metadata = { title: 'Email address | Ensemus' };

const STATES: Record<string, { title: string; lede: string }> = {
  verified: {
    title: 'Your email address is confirmed',
    lede: 'Thank you. We’ll use it to tell you when something needs you.',
  },
  approved: {
    title: 'Nearly done',
    lede: 'We’ve sent a link to your new email address. Open it there to finish the move.',
  },
  changed: {
    title: 'Your email address is changed',
    lede: 'Sign in with your new address from now on.',
  },
  expired: {
    title: 'That link has run out',
    lede: 'Links like this work for 24 hours. Ask for a new one from your account’s security page.',
  },
  invalid: {
    title: 'That link doesn’t work',
    lede: 'It may have been used already, or copied only in part. Ask for a new one from your account’s security page.',
  },
};

export default async function VerifyEmailStatePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;
  const words = STATES[state ?? ''] ?? STATES.invalid!;
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>{words.title}</h1>
        <p className="lede">{words.lede}</p>
        <div className="row">
          <ActionLink href="/">Go to Ensemus</ActionLink>
        </div>
      </div>
    </main>
  );
}
