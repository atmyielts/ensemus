'use client';

// The last resort, for when the root layout itself fails. It replaces the whole document, so it has
// to bring its own, and it cannot rely on the stylesheet having loaded.
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Something went wrong | Ensemus</title>
      </head>
      <body>
        <main style={{ maxWidth: '32rem', margin: '4rem auto', padding: '0 1rem' }}>
          <h1>Something went wrong</h1>
          <p role="alert">This page could not be shown. Nothing you saved has been lost.</p>
          <button type="button" onClick={reset}>
            Try again
          </button>{' '}
          {/* A full reload, on purpose: the app around this page is what failed. */}
          <a href="/">Go to your home page</a>
        </main>
      </body>
    </html>
  );
}
