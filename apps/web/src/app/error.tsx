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
        <p className="lede" role="alert">
          This page could not be shown. Nothing you saved has been lost.
        </p>
        <p>Try again in a moment, or start again from your home page.</p>
        <div className="row gap-above-large">
          <button type="button" onClick={tryAgain}>
            Try again
          </button>
          <Link className="button secondary" href="/">
            Go to your home page
          </Link>
        </div>
        {error.digest && (
          <details className="error-reference gap-above-large">
            <summary>If this keeps happening</summary>
            <p>
              Give your administrator this reference, so they can find what went wrong:{' '}
              <code>{error.digest}</code>
            </p>
          </details>
        )}
      </div>
    </main>
  );
}
