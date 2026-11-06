'use client';

// The last resort, for when the root layout itself fails. It replaces the whole document, so it has
// to bring its own, and it cannot rely on the stylesheet having loaded.
export default function GlobalError() {
  return (
    <html lang="en">
      <head>
        <title>Something went wrong | Ensemus</title>
      </head>
      <body>
        <main style={{ maxWidth: '32rem', margin: '4rem auto', padding: '0 1rem' }}>
          <h1>Something went wrong</h1>
          <p role="alert">This page could not be shown. Nothing you saved has been lost.</p>
          {/* A full reload, like the link beside it: the app that could redraw this page is what failed. */}
          <button type="button" onClick={() => window.location.reload()}>
            Try again
          </button>{' '}
          <a href="/">Go to your home page</a>
        </main>
      </body>
    </html>
  );
}
