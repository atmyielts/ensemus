'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Wordmark } from '@/components/ui';

// Shown when a page fails for a reason nobody can act on here. The cause stays in the server's logs,
// reduced to a code, and only the digest reaches the browser, for quoting to an administrator.
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Asks the server again: on its own, reset only redraws what the browser already has, which here is
  // the failure.
  const router = useRouter();
  const [, startTransition] = useTransition();
  const tryAgain = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>Something went wrong</h1>
        <p role="alert">This page could not be shown. Nothing you saved has been lost.</p>
        <div className="row">
          <button type="button" onClick={tryAgain}>
            Try again
          </button>
          <Link className="button quiet" href="/">
            Go to your home page
          </Link>
        </div>
        {error.digest && (
          <p className="muted gap-above-large">
            If this keeps happening, give your administrator this reference: {error.digest}
          </p>
        )}
      </div>
    </main>
  );
}
