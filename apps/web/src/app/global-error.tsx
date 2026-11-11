'use client';

import { BrandWordmark } from '@/components/brand-wordmark';

// The last resort, for when the root layout itself fails. It replaces the whole document, so it has
// to bring its own, and it cannot rely on the stylesheet having loaded. The few rules it needs travel
// with it, in both themes, using the same paper, ink and light as the rest of Ensemus.
const STYLE = `
:root{color-scheme:light dark;--bg:#f6f5f0;--surface:#fff;--fg:#22261f;--muted:#5e6556;--line:#8a9081;--fill:#c2d45a;--fill-hover:#b4c74a;--on-fill:#22261f;--ring:#556119;--brand-light:var(--fill)}
@media (prefers-color-scheme:dark){:root{--bg:#12150f;--surface:#1a1e16;--fg:#eeebe1;--muted:#a7ad9c;--line:#6b7262;--fill:#e2ee7c;--fill-hover:#eef5a6;--on-fill:#12150f;--ring:#e2ee7c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:0.96875rem/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:28rem;margin:0 auto;padding:clamp(2rem,10vh,6rem) 1rem 3rem}
.brand{display:inline-flex;margin:0 0 2rem 0.25rem;color:var(--fg);border-radius:8px}
.brand svg{display:block;height:2rem;width:auto}
.sheet{background:var(--surface);border-radius:16px;padding:2rem;box-shadow:0 2px 4px rgb(34 38 31/5%),0 18px 40px -18px rgb(34 38 31/24%)}
h1{margin:0 0 0.5rem;font:400 2rem/1.1 "Iowan Old Style","Palatino Linotype",Georgia,serif;letter-spacing:-0.012em}
p{margin:0 0 0.75rem}
.lede{color:var(--muted);margin-bottom:1.5rem}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem 0.75rem;margin-top:1.5rem}
button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:2.625rem;padding:0.5rem 1.125rem;font:inherit;font-size:0.9375rem;font-weight:560;line-height:1.25;border-radius:8px;cursor:pointer;text-decoration:none}
button{color:var(--on-fill);background:var(--fill);border:1px solid transparent}
button:hover{background:var(--fill-hover)}
.button{color:var(--fg);background:var(--surface);border:1px solid var(--line)}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
@media (forced-colors:active){.sheet,button{border:1px solid CanvasText}}
`;

export default function GlobalError() {
  return (
    <html lang="en">
      <head>
        <title>Something went wrong | Ensemus</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* A fixed string written here, never anything from the request. */}
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        <main>
          {/* Plain links, not the client router: the app that could navigate is what failed. */}
          <a className="brand" href="/">
            <BrandWordmark />
          </a>
          <div className="sheet">
            <h1>Something went wrong</h1>
            <p className="lede" role="alert">
              This page could not be shown. Nothing you saved has been lost.
            </p>
            <p>Try again in a moment, or start again from your home page.</p>
            <div className="row">
              {/* A full reload, like the link beside it: the app that could redraw this page is what failed. */}
              <button type="button" onClick={() => window.location.reload()}>
                Try again
              </button>
              <a className="button" href="/">
                Go to your home page
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
