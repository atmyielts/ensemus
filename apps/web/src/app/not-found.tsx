import Link from 'next/link';
import { Wordmark } from '@/components/ui';

export const metadata = { title: 'Not found | Ensemus' };

// The same page for "does not exist" and "you may not see this", so neither one leaks the other. Its
// title, sentence and link are copied into the no-JavaScript fallback (no-script-not-found.mjs).
export default function NotFound() {
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>Page not found</h1>
        <p className="lede">This page does not exist, or you do not have access to it.</p>
        <p>
          If someone sent you this link, check that it is complete, or ask them to share it with you
          again.
        </p>
        <div className="row gap-above-large">
          <Link className="button" href="/">
            Go to your home page
          </Link>
        </div>
      </div>
      <ul className="sheet-links" aria-label="More help">
        <li>
          Not signed in yet? <Link href="/sign-in">Sign in</Link> and try the link again.
        </li>
      </ul>
    </main>
  );
}
