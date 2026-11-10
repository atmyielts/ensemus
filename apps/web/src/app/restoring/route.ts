export const dynamic = 'force-dynamic';

// Where a person lands while their organization's database is behind the tombstone ledger (ADR-026).
// A route, because a page cannot answer 503. It names no organization, so anyone may see it.
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Being restored - Ensemus</title>
  </head>
  <body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem">
    <h1>This organization is being restored</h1>
    <p>
      Your administrator is restoring it from a backup, and it stays unavailable until that is
      finished. Try again later, or ask your administrator how it is going.
    </p>
    <p><a href="/">Go to your organizations</a></p>
  </body>
</html>
`;

export const GET = () =>
  new Response(PAGE, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '60',
    },
  });
