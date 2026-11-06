'use client';

import Link from 'next/link';

// Shown when a page fails for a reason nobody can act on here. The cause stays in the server's logs,
// reduced to a code, and only the digest reaches the browser, for quoting to an administrator.
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="centered">
      <h1>Something went wrong</h1>
      <p role="alert">This page could not be shown. Nothing you saved has been lost.</p>
      <div className="row">
        <button type="button" onClick={reset}>
          Try again
        </button>
        <Link className="button quiet" href="/">
          Go to your home page
        </Link>
      </div>
      {error.digest && (
        <p className="muted" style={{ marginTop: '1rem' }}>
          If this keeps happening, give your administrator this reference: {error.digest}
        </p>
      )}
    </main>
  );
}
