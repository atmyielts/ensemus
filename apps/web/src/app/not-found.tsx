import Link from 'next/link';
import { Wordmark } from '@/components/ui';

export const metadata = { title: 'Not found | Ensemus' };

// The same page for "does not exist" and "you may not see this", so neither one leaks the other.
export default function NotFound() {
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>Page not found</h1>
        <p>This page does not exist, or you do not have access to it.</p>
        <Link className="button quiet" href="/">
          Go to your home page
        </Link>
      </div>
    </main>
  );
}
